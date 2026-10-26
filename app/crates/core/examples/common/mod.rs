//! 確認用のプログラムで共通に使う、本物の Google Drive への接続の準備。
//! - OAuth クライアントは `secrets/google_oauth_desktop.sec.json` から読む
//! - リフレッシュトークンは `secrets/google_token.sec.json` に保存する（なければブラウザでログインする）

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cyanomelody_core::drive::auth::{LoopbackLogin, OAuthClient, RefreshingToken, TokenStore};
use cyanomelody_core::drive::{DriveClient, DriveError};

fn secrets() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../secrets")
}

/// 試作（prototypes/drive_probe）と同じ形式のファイルに保存する。
struct FileStore(PathBuf);

impl TokenStore for FileStore {
    fn load(&self) -> Option<String> {
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&self.0).ok()?).ok()?;
        json["refresh_token"].as_str().map(String::from)
    }

    fn save(&self, refresh_token: &str) -> Result<(), DriveError> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let json = serde_json::json!({ "refresh_token": refresh_token, "obtained_at": now });
        std::fs::write(&self.0, json.to_string()).map_err(|e| DriveError::Auth(e.to_string()))
    }

    fn clear(&self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// ログイン済みの Drive の呼び出し口。保存したトークンがなければ、ブラウザでのログインを待つ。
pub fn drive_client() -> DriveClient {
    let client_json = std::fs::read_to_string(secrets().join("google_oauth_desktop.sec.json"))
        .expect("secrets/google_oauth_desktop.sec.json がない");
    let oauth = OAuthClient::from_json(&client_json).unwrap();
    let store = Arc::new(FileStore(secrets().join("google_token.sec.json")));
    if store.load().is_none() {
        let login = LoopbackLogin::start(&oauth).unwrap();
        println!("ブラウザで次の URL を開いてログインしてください:\n{}", login.url);
        store.save(&login.finish(Duration::from_secs(300)).unwrap()).unwrap();
    }
    DriveClient::new(Arc::new(RefreshingToken::new(oauth, store)))
}
