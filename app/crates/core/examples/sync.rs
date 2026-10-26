//! 本物の Google Drive で、プレイリストの作成、編集、別の接続からの読み直し、削除を確かめる確認用のプログラム。
//! 使い方: cargo run -p cyanomelody-core --example sync
//! - リフレッシュトークンは `secrets/google_token.sec.json` を使う（`examples/drive.rs` で作ったもの）
//! - マイドライブ直下に `cyanomelody/playlists/` を作り（なければ）、テスト用のプレイリストを作って最後にゴミ箱に移す

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use cyanomelody_core::drive::DriveClient;
use cyanomelody_core::drive::auth::{OAuthClient, RefreshingToken, TokenStore};
use cyanomelody_core::sync::{PlaylistItem, SyncStore};

fn secrets() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../secrets")
}

struct FileStore(PathBuf);

impl TokenStore for FileStore {
    fn load(&self) -> Option<String> {
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&self.0).ok()?).ok()?;
        json["refresh_token"].as_str().map(String::from)
    }

    fn save(&self, _: &str) -> Result<(), cyanomelody_core::drive::DriveError> {
        Ok(())
    }

    fn clear(&self) {}
}

fn store() -> SyncStore {
    let oauth = OAuthClient::from_json(
        &std::fs::read_to_string(secrets().join("google_oauth_desktop.sec.json")).unwrap(),
    )
    .unwrap();
    let tokens = Arc::new(RefreshingToken::new(
        oauth,
        Arc::new(FileStore(secrets().join("google_token.sec.json"))),
    ));
    SyncStore::new(DriveClient::new(tokens))
}

fn main() {
    let pc = store();
    let other = store();
    let t = Instant::now();
    let p = pc.create("cyanomelody の動作確認（消してよい）").unwrap();
    println!("作成: {} / {:.2}秒", p.id, t.elapsed().as_secs_f64());
    let t = Instant::now();
    pc.edit(&p.id, |p| {
        p.add((1..=3).map(|i| PlaylistItem {
            source: "drive".into(),
            key: format!("dummy{i}"),
            title: format!("曲{i}"),
            artist: None,
            device: None,
        }));
        p.favorite = true;
    })
    .unwrap();
    println!("編集（読み直して保存）: {:.2}秒", t.elapsed().as_secs_f64());
    let t = Instant::now();
    let seen = other.get(&p.id).unwrap();
    println!(
        "別の接続から読む: {} 曲、お気に入り={} / {:.2}秒",
        seen.items.len(),
        seen.favorite,
        t.elapsed().as_secs_f64()
    );
    let t = Instant::now();
    let list = other.list().unwrap();
    println!(
        "一覧: {} 件 / {:.2}秒",
        list.len(),
        t.elapsed().as_secs_f64()
    );
    for s in &list {
        println!(
            "  {}（{} 曲）{}",
            s.name,
            s.count,
            if s.favorite { " ★" } else { "" }
        );
    }
    other.delete(&p.id).unwrap();
    println!("ゴミ箱に移した。一覧: {} 件", pc.list().unwrap().len());
}
