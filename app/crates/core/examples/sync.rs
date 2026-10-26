//! 本物の Google Drive で、プレイリストの作成、編集、別の接続からの読み直し、削除を確かめる確認用のプログラム。
//! 使い方: cargo run -p cyanomelody-core --example sync
//! - リフレッシュトークンは `secrets/google_token.sec.json` を使う（`examples/drive.rs` で作ったもの）
//! - マイドライブ直下に `cyanomelody/playlists/` を作り（なければ）、テスト用のプレイリストを作って最後にゴミ箱に移す

mod common;

use std::time::Instant;

use cyanomelody_core::sync::{PlaylistItem, SyncStore};

fn store() -> SyncStore {
    SyncStore::new(common::drive_client())
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
    println!("一覧: {} 件 / {:.2}秒", list.len(), t.elapsed().as_secs_f64());
    for s in &list {
        println!("  {}（{} 曲）{}", s.name, s.count, if s.favorite { " ★" } else { "" });
    }
    other.delete(&p.id).unwrap();
    println!("ゴミ箱に移した。一覧: {} 件", pc.list().unwrap().len());
}
