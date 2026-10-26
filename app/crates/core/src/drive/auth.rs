//! ログインとアクセストークンの更新（Windows と Ubuntu）。
//!
//! ブラウザで同意してもらい、手元（`127.0.0.1`）で認可コードを受け取る（ループバック、PKCE 付き）。
//! 得たリフレッシュトークンは、呼び出し側が `TokenStore` で保存する。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{DriveError, SCOPES, TokenProvider};

/// Google Cloud の OAuth クライアント（デスクトップアプリ）。
#[derive(Debug, Clone, Deserialize)]
pub struct OAuthClient {
    pub client_id: String,
    pub client_secret: String,
    pub auth_uri: String,
    pub token_uri: String,
}

impl OAuthClient {
    /// Google Cloud からダウンロードした JSON（`{"installed": {...}}`）を読む。
    pub fn from_json(json: &str) -> Result<Self, DriveError> {
        #[derive(Deserialize)]
        struct File {
            installed: OAuthClient,
        }
        serde_json::from_str::<File>(json)
            .map(|f| f.installed)
            .map_err(|e| DriveError::Parse(format!("OAuth クライアントの JSON: {e}")))
    }
}

/// リフレッシュトークンの保存先。デスクトップでは OS の資格情報の保管庫に保存する。
pub trait TokenStore: Send + Sync {
    fn load(&self) -> Option<String>;
    fn save(&self, refresh_token: &str) -> Result<(), DriveError>;
    fn clear(&self);
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

fn random_b64(len: usize) -> String {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).expect("乱数を得られない");
    URL_SAFE_NO_PAD.encode(buf)
}

fn token_request(client: &OAuthClient, form: &[(&str, &str)]) -> Result<TokenResponse, DriveError> {
    match ureq::post(&client.token_uri).timeout(Duration::from_secs(30)).send_form(form) {
        Ok(resp) => resp.into_json().map_err(|e| DriveError::Parse(e.to_string())),
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            // invalid_grant はリフレッシュトークンが失効した（取り消された、期限が切れた）
            if status == 400 || status == 401 {
                Err(DriveError::Auth(body))
            } else {
                Err(DriveError::Http { status, message: body })
            }
        }
        Err(ureq::Error::Transport(t)) => Err(DriveError::Network(t.to_string())),
    }
}

/// ブラウザでのログインの途中の状態。`url` をブラウザで開き、`finish` で結果を待つ。
pub struct LoopbackLogin {
    client: OAuthClient,
    listener: TcpListener,
    redirect_uri: String,
    verifier: String,
    state: String,
    pub url: String,
}

impl LoopbackLogin {
    pub fn start(client: &OAuthClient) -> Result<Self, DriveError> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| DriveError::Network(e.to_string()))?;
        let port = listener.local_addr().map_err(|e| DriveError::Network(e.to_string()))?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}");
        let verifier = random_b64(48);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_b64(16);
        let url = format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={challenge}\
             &code_challenge_method=S256&state={state}&access_type=offline&prompt=consent",
            client.auth_uri,
            urlencoding::encode(&client.client_id),
            urlencoding::encode(&redirect_uri),
            urlencoding::encode(&SCOPES.join(" ")),
        );
        Ok(Self { client: client.clone(), listener, redirect_uri, verifier, state, url })
    }

    /// ブラウザから戻ってくるのを `timeout` まで待ち、リフレッシュトークンを返す。
    pub fn finish(self, timeout: Duration) -> Result<String, DriveError> {
        let deadline = Instant::now() + timeout;
        self.listener.set_nonblocking(true).map_err(|e| DriveError::Network(e.to_string()))?;
        let (mut stream, _) = loop {
            match self.listener.accept() {
                Ok(conn) => break conn,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() > deadline {
                        return Err(DriveError::Auth("ログインが時間内に終わらなかった".into()));
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(DriveError::Network(e.to_string())),
            }
        };
        stream.set_nonblocking(false).ok();
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).map_err(|e| DriveError::Network(e.to_string()))?;
        let params = parse_query(&line);
        let ok = params.contains_key("code") && params.get("state") == Some(&self.state);
        let body = if ok {
            "ログインできました。このタブを閉じて、cyanomelody に戻ってください。"
        } else {
            "ログインできませんでした。cyanomelody に戻って、もう一度お試しください。"
        };
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        if params.get("state") != Some(&self.state) {
            return Err(DriveError::Auth("ログインの応答が一致しない".into()));
        }
        let code = params.get("code").ok_or_else(|| {
            DriveError::Auth(format!(
                "同意されなかった: {}",
                params.get("error").cloned().unwrap_or_default()
            ))
        })?;
        let token = token_request(
            &self.client,
            &[
                ("code", code),
                ("client_id", &self.client.client_id),
                ("client_secret", &self.client.client_secret),
                ("redirect_uri", &self.redirect_uri),
                ("grant_type", "authorization_code"),
                ("code_verifier", &self.verifier),
            ],
        )?;
        token.refresh_token.ok_or_else(|| DriveError::Auth("リフレッシュトークンが返らなかった".into()))
    }
}

/// `GET /?code=...&state=... HTTP/1.1` の問い合わせ部分を読む。
fn parse_query(request_line: &str) -> HashMap<String, String> {
    request_line
        .split_whitespace()
        .nth(1)
        .and_then(|p| p.split_once('?'))
        .map(|(_, q)| q)
        .unwrap_or("")
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), urlencoding::decode(v).unwrap_or_default().into_owned()))
        .collect()
}

/// リフレッシュトークンでアクセストークンを得て、期限の 1 分前まで使い回す。
pub struct RefreshingToken {
    client: OAuthClient,
    store: Arc<dyn TokenStore>,
    cached: Mutex<Option<(String, Instant)>>,
}

impl RefreshingToken {
    pub fn new(client: OAuthClient, store: Arc<dyn TokenStore>) -> Self {
        Self { client, store, cached: Mutex::new(None) }
    }

    pub fn is_logged_in(&self) -> bool {
        self.store.load().is_some()
    }
}

impl TokenProvider for RefreshingToken {
    fn access_token(&self) -> Result<String, DriveError> {
        let mut cached = self.cached.lock().unwrap();
        if let Some((token, expires)) = cached.as_ref()
            && Instant::now() < *expires
        {
            return Ok(token.clone());
        }
        let refresh = self.store.load().ok_or_else(|| DriveError::Auth("ログインしていない".into()))?;
        let resp = token_request(
            &self.client,
            &[
                ("refresh_token", &refresh),
                ("client_id", &self.client.client_id),
                ("client_secret", &self.client.client_secret),
                ("grant_type", "refresh_token"),
            ],
        );
        let token = match resp {
            Ok(t) => t,
            Err(DriveError::Auth(msg)) => {
                // 失効したリフレッシュトークンは消し、ログインし直してもらう
                log::warn!("リフレッシュトークンが失効した: {msg}");
                self.store.clear();
                return Err(DriveError::Auth(msg));
            }
            Err(e) => return Err(e),
        };
        let ttl = token.expires_in.unwrap_or(3600).saturating_sub(60);
        *cached = Some((token.access_token.clone(), Instant::now() + Duration::from_secs(ttl)));
        Ok(token.access_token)
    }

    fn invalidate(&self) {
        *self.cached.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_client_json() {
        let json = r#"{"installed":{"client_id":"id","project_id":"p","auth_uri":"https://a","token_uri":"https://t",
            "client_secret":"s","redirect_uris":["http://localhost"]}}"#;
        let c = OAuthClient::from_json(json).unwrap();
        assert_eq!((c.client_id.as_str(), c.client_secret.as_str()), ("id", "s"));
        assert!(OAuthClient::from_json("{}").is_err());
    }

    #[test]
    fn login_url_has_pkce_and_offline_access() {
        let client = OAuthClient {
            client_id: "id".into(),
            client_secret: "s".into(),
            auth_uri: "https://accounts.example/auth".into(),
            token_uri: "https://accounts.example/token".into(),
        };
        let login = LoopbackLogin::start(&client).unwrap();
        for part in
            ["code_challenge_method=S256", "access_type=offline", "drive.readonly", "drive.file", "127.0.0.1"]
        {
            assert!(login.url.contains(part), "{part} がない: {}", login.url);
        }
    }

    #[test]
    fn rejects_mismatched_state() {
        let client = OAuthClient {
            client_id: "id".into(),
            client_secret: "s".into(),
            auth_uri: "https://a".into(),
            token_uri: "http://127.0.0.1:9/token".into(),
        };
        let login = LoopbackLogin::start(&client).unwrap();
        let redirect = login.redirect_uri.clone();
        let handle = std::thread::spawn(move || login.finish(Duration::from_secs(5)));
        let _ = ureq::get(&format!("{redirect}/?code=abc&state=違う")).call();
        assert!(matches!(handle.join().unwrap(), Err(DriveError::Auth(_))));
    }

    #[test]
    fn parses_redirect_query() {
        let q = parse_query("GET /?state=x&code=4%2F0A&scope=a%20b HTTP/1.1");
        assert_eq!(q["code"], "4/0A");
        assert_eq!(q["scope"], "a b");
    }
}
