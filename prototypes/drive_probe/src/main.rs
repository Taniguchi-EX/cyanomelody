//! C-1（デスクトップでのログイン）、C-3〜C-6（本物の Google Drive での一覧、タグ、ストリーミング再生）の検証。
//!
//! 使い方: drive_probe <Drive 上のフォルダのパス（例: music/cyanomelody_test）>
//! - 初回はブラウザでログインする（ループバックで認可コードを受け取る。PKCE 付き）
//! - 得たリフレッシュトークンを secrets/google_token.sec.json に保存し、2 回目以降はそれを使う（C-2 の確認にも使う）
//! - クライアントの情報は secrets/google_oauth_desktop.sec.json から読む

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use lofty::config::ParseOptions;
use lofty::prelude::*;
use lofty::probe::Probe;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

const SCOPES: &str = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
const DRIVE: &str = "https://www.googleapis.com/drive/v3";

/// 接続を使い回すための共有のエージェント。
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(ureq::Agent::new);

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn secrets_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../secrets")
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn random_b64(len: usize) -> String {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).unwrap();
    URL_SAFE_NO_PAD.encode(buf)
}

/// ブラウザでログインし、認可コードをループバックで受け取ってトークンに換える。
fn authorize(client: &Value) -> Res<Value> {
    let verifier = random_b64(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        client["auth_uri"].as_str().unwrap(),
        urlencoding::encode(client["client_id"].as_str().unwrap()),
        urlencoding::encode(&redirect),
        urlencoding::encode(SCOPES),
        challenge,
        state
    );
    println!("ブラウザで次の URL を開いてログインしてください:\nAUTH_URL {url}");
    io::stdout().flush()?;

    let (mut stream, _) = listener.accept()?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line)?;
    let query = line.split_whitespace().nth(1).and_then(|p| p.split_once('?')).map(|(_, q)| q).unwrap_or("");
    let params: HashMap<String, String> = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), urlencoding::decode(v).unwrap_or_default().into_owned()))
        .collect();
    let body = if params.contains_key("code") { "ログインできました。このタブは閉じてかまいません。" } else { "ログインに失敗しました。" };
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n\r\n{body}", body.len())?;
    if params.get("state") != Some(&state) {
        return Err(format!("state が一致しない: {params:?}").into());
    }
    let code = params.get("code").ok_or_else(|| format!("認可コードがない: {params:?}"))?;
    let token: Value = ureq::post(client["token_uri"].as_str().unwrap())
        .send_form(&[
            ("code", code),
            ("client_id", client["client_id"].as_str().unwrap()),
            ("client_secret", client["client_secret"].as_str().unwrap()),
            ("redirect_uri", &redirect),
            ("grant_type", "authorization_code"),
            ("code_verifier", &verifier),
        ])?
        .into_json()?;
    Ok(token)
}

/// 保存したリフレッシュトークンでアクセストークンを得る。なければログインする。
fn access_token() -> Res<String> {
    let client_file: Value = serde_json::from_str(&std::fs::read_to_string(secrets_dir().join("google_oauth_desktop.sec.json"))?)?;
    let client = &client_file["installed"];
    let token_path = secrets_dir().join("google_token.sec.json");
    if let Ok(saved) = std::fs::read_to_string(&token_path) {
        let saved: Value = serde_json::from_str(&saved)?;
        let days = (now() - saved["obtained_at"].as_u64().unwrap_or(0)) as f64 / 86400.0;
        println!("保存済みのリフレッシュトークンを使う（取得から {days:.2} 日）");
        let refreshed = ureq::post(client["token_uri"].as_str().unwrap()).send_form(&[
            ("refresh_token", saved["refresh_token"].as_str().unwrap()),
            ("client_id", client["client_id"].as_str().unwrap()),
            ("client_secret", client["client_secret"].as_str().unwrap()),
            ("grant_type", "refresh_token"),
        ]);
        match refreshed {
            Ok(resp) => {
                let token: Value = resp.into_json()?;
                println!("リフレッシュ成功: スコープ = {}", token["scope"]);
                return Ok(token["access_token"].as_str().unwrap().to_string());
            }
            Err(ureq::Error::Status(code, resp)) => {
                println!("リフレッシュ失敗（{code}）: {}", resp.into_string()?);
                println!("ログインし直す");
            }
            Err(e) => return Err(e.into()),
        }
    }
    let token = authorize(client)?;
    println!("ログイン成功: スコープ = {} / リフレッシュトークン = {}", token["scope"], if token["refresh_token"].is_string() { "あり" } else { "なし" });
    std::fs::write(
        &token_path,
        serde_json::to_string_pretty(&json!({ "refresh_token": token["refresh_token"], "scope": token["scope"], "obtained_at": now() }))?,
    )?;
    Ok(token["access_token"].as_str().unwrap().to_string())
}

fn drive_get(token: &str, path: &str, query: &[(&str, &str)]) -> Res<Value> {
    let mut req = AGENT.get(&format!("{DRIVE}/{path}")).set("Authorization", &format!("Bearer {token}"));
    for (k, v) in query {
        req = req.query(k, v);
    }
    Ok(req.call()?.into_json()?)
}

/// 名前でたどってフォルダの ID を得る。
fn find_folder(token: &str, path: &str) -> Res<String> {
    let mut parent = "root".to_string();
    for name in path.split('/').filter(|s| !s.is_empty()) {
        let q = format!(
            "'{parent}' in parents and name = '{}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            name.replace('\'', "\\'")
        );
        let res = drive_get(token, "files", &[("q", &q), ("fields", "files(id,name)")])?;
        parent = res["files"][0]["id"].as_str().ok_or_else(|| format!("フォルダが見つからない: {name}"))?.to_string();
    }
    Ok(parent)
}

/// フォルダとサブフォルダのファイルを一覧にする（C-6）。
fn list_files(token: &str, folder: &str, prefix: &str, out: &mut Vec<(String, String, u64)>) -> Res<()> {
    let mut page_token = String::new();
    loop {
        let q = format!("'{folder}' in parents and trashed = false");
        let mut query = vec![("q", q.as_str()), ("fields", "nextPageToken,files(id,name,mimeType,size)"), ("pageSize", "1000")];
        if !page_token.is_empty() {
            query.push(("pageToken", &page_token));
        }
        let res = drive_get(token, "files", &query)?;
        for f in res["files"].as_array().unwrap() {
            let name = format!("{prefix}{}", f["name"].as_str().unwrap());
            if f["mimeType"] == "application/vnd.google-apps.folder" {
                list_files(token, f["id"].as_str().unwrap(), &format!("{name}/"), out)?;
            } else {
                out.push((name, f["id"].as_str().unwrap().into(), f["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0)));
            }
        }
        match res["nextPageToken"].as_str() {
            Some(t) => page_token = t.into(),
            None => return Ok(()),
        }
    }
}

#[derive(Default)]
struct Stats {
    requests: AtomicU64,
    bytes: AtomicU64,
    wait_ms: AtomicU64,
}

/// Drive のファイルを Range 指定で chunk 単位に取得する読み込み口（C-4）。
struct DriveSource {
    url: String,
    token: String,
    len: u64,
    pos: u64,
    chunk: u64,
    chunks: HashMap<u64, Vec<u8>>,
    /// 先読み：前回の取得の続きを読むときは、まとめて取得する chunk の数を倍々に増やす
    next_idx: u64,
    burst: u64,
    stats: Arc<Stats>,
}

/// 先読みでまとめて取得する上限（4MB）
const MAX_BURST_BYTES: u64 = 4 * 1024 * 1024;

impl DriveSource {
    fn new(token: &str, id: &str, len: u64, chunk_kb: u64, stats: Arc<Stats>) -> Self {
        Self {
            url: format!("{DRIVE}/files/{id}?alt=media"),
            token: token.into(),
            len,
            pos: 0,
            chunk: chunk_kb * 1024,
            chunks: HashMap::new(),
            next_idx: u64::MAX,
            burst: 1,
            stats,
        }
    }
}

impl Read for DriveSource {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || out.is_empty() {
            return Ok(0);
        }
        let idx = self.pos / self.chunk;
        if !self.chunks.contains_key(&idx) {
            self.burst = if idx == self.next_idx { (self.burst * 2).min(MAX_BURST_BYTES / self.chunk) } else { 1 };
            let start = idx * self.chunk;
            let end = (start + self.chunk * self.burst).min(self.len) - 1;
            let t = Instant::now();
            let resp = AGENT.get(&self.url)
                .set("Authorization", &format!("Bearer {}", self.token))
                .set("Range", &format!("bytes={start}-{end}"))
                .call()
                .map_err(io::Error::other)?;
            if resp.status() != 206 {
                return Err(io::Error::other(format!("Range に対応していない: {}", resp.status())));
            }
            let mut buf = Vec::new();
            resp.into_reader().read_to_end(&mut buf)?;
            self.stats.requests.fetch_add(1, Ordering::Relaxed);
            self.stats.bytes.fetch_add(buf.len() as u64, Ordering::Relaxed);
            self.stats.wait_ms.fetch_add(t.elapsed().as_millis() as u64, Ordering::Relaxed);
            for (i, part) in buf.chunks(self.chunk as usize).enumerate() {
                self.chunks.entry(idx + i as u64).or_insert_with(|| part.to_vec());
            }
            self.next_idx = idx + buf.len().div_ceil(self.chunk as usize) as u64;
        }
        let chunk = &self.chunks[&idx];
        let offset = (self.pos % self.chunk) as usize;
        let n = out.len().min(chunk.len() - offset);
        out[..n].copy_from_slice(&chunk[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for DriveSource {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let pos = match from {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::End(d) => self.len as i64 + d,
            SeekFrom::Current(d) => self.pos as i64 + d,
        };
        self.pos = pos.max(0) as u64;
        Ok(self.pos)
    }
}

impl MediaSource for DriveSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

fn kb(b: u64) -> String {
    format!("{:.0}KB", b as f64 / 1024.0)
}

/// タグを読む（C-5）。取得単位は 64KB。
fn check_tags(token: &str, id: &str, len: u64) -> Res<()> {
    let stats = Arc::new(Stats::default());
    let started = Instant::now();
    let tagged = Probe::new(DriveSource::new(token, id, len, 64, stats.clone()))
        .options(ParseOptions::new().read_properties(false))
        .guess_file_type()?
        .read()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let field = |f: Option<std::borrow::Cow<str>>| f.map(|s| s.into_owned()).unwrap_or_else(|| "(なし)".into());
    println!(
        "  タグ    : 曲名={} / アーティスト={} / アルバム={}",
        field(tag.and_then(|t| t.title())),
        field(tag.and_then(|t| t.artist())),
        field(tag.and_then(|t| t.album()))
    );
    println!(
        "            通信 {}回 {} / 所要 {:?}（うち通信待ち {}ms）",
        stats.requests.load(Ordering::Relaxed),
        kb(stats.bytes.load(Ordering::Relaxed)),
        started.elapsed(),
        stats.wait_ms.load(Ordering::Relaxed)
    );
    Ok(())
}

/// ストリーミングで再生を始め、シークする（C-4）。取得単位は 256KB。
fn check_stream(token: &str, id: &str, len: u64, ext: &str) -> Res<()> {
    let stats = Arc::new(Stats::default());
    let started = Instant::now();
    let mss = MediaSourceStream::new(Box::new(DriveSource::new(token, id, len, 256, stats.clone())), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let mut format = symphonia::default::get_probe().format(&hint, mss, &Default::default(), &Default::default())?.format;
    let track = format.default_track().ok_or("トラックがない")?.clone();
    let tb = track.codec_params.time_base.ok_or("time_base がない")?;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &Default::default())?;
    let to_sec = |ts: u64| {
        let t = tb.calc_time(ts);
        t.seconds as f64 + t.frac
    };
    let duration = track.codec_params.n_frames.map(to_sec).unwrap_or(0.0);
    decoder.decode(&format.next_packet()?)?;
    println!(
        "  再生開始: 長さ {:.1}秒 / 最初の音まで {:?} / 通信 {}回 {}",
        duration,
        started.elapsed(),
        stats.requests.load(Ordering::Relaxed),
        kb(stats.bytes.load(Ordering::Relaxed))
    );
    let target = (duration * 0.6).floor();
    let (req0, bytes0) = (stats.requests.load(Ordering::Relaxed), stats.bytes.load(Ordering::Relaxed));
    let t = Instant::now();
    let seeked = format.seek(SeekMode::Accurate, SeekTo::Time { time: Time::from(target), track_id: Some(track.id) })?;
    decoder.reset();
    loop {
        let p = format.next_packet()?;
        if p.track_id() == track.id {
            decoder.decode(&p)?;
            break;
        }
    }
    println!(
        "  シーク  : {target:.0}秒へ → 着地 {:.2}秒 / 所要 {:?} / 通信 {}回 {}",
        to_sec(seeked.actual_ts),
        t.elapsed(),
        stats.requests.load(Ordering::Relaxed) - req0,
        kb(stats.bytes.load(Ordering::Relaxed) - bytes0)
    );
    Ok(())
}

fn main() -> Res<()> {
    let folder_path = std::env::args().nth(1).unwrap_or_else(|| "music/cyanomelody_test".into());
    let token = access_token()?;

    let t = Instant::now();
    let about = drive_get(&token, "about", &[("fields", "user(emailAddress)")])?;
    println!("Drive のアカウント: {} / 1 回の通信 {:?}", about["user"]["emailAddress"], t.elapsed());

    let t = Instant::now();
    let folder = find_folder(&token, &folder_path)?;
    let mut files = Vec::new();
    list_files(&token, &folder, "", &mut files)?;
    println!("フォルダ {folder_path}: {}件 / 一覧の取得 {:?}", files.len(), t.elapsed());

    for (name, id, size) in &files {
        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "mp3" | "wav" | "m4a") {
            continue;
        }
        println!("■ {name}（{}、ID {id}）", kb(*size));
        if let Err(e) = check_tags(&token, id, *size) {
            println!("  タグ    : 失敗 {e}");
        }
        if let Err(e) = check_stream(&token, id, *size, &ext) {
            println!("  再生    : 失敗 {e}");
        }
    }
    Ok(())
}
