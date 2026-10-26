//! 本物の Google Drive で、ライブラリの更新と再生を確かめる確認用のプログラム。
//!
//! 使い方: cargo run -p cyanomelody-core --example drive -- <Drive のフォルダのパス> [--play 秒]
//! - OAuth クライアントは `secrets/google_oauth_desktop.sec.json` から読む
//! - リフレッシュトークンは `secrets/google_token.sec.json` に保存する（なければブラウザでログインする）
//! - `--play` を付けると、各曲の 40% の位置から指定の秒数ずつ鳴らす
//! - `--cache <フォルダ>` を付けると、再生した曲をキャッシュに保存し、そろうまで待つ

use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use cyanomelody_core::cache::{DEFAULT_MAX_BYTES, SongCache};
use cyanomelody_core::drive::DriveClient;
use cyanomelody_core::drive::auth::{LoopbackLogin, OAuthClient, RefreshingToken, TokenStore};
use cyanomelody_core::library::{DEFAULT_PARALLELISM, Library};
use cyanomelody_core::playback::output::CpalOutput;
use cyanomelody_core::playback::{PlaybackError, Player, PlayerEvent, TrackOpener, TrackRef};
use cyanomelody_core::source::drive::DriveSource;
use cyanomelody_core::source::{MusicSource, SourceKind};

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

    fn save(&self, refresh_token: &str) -> Result<(), cyanomelody_core::drive::DriveError> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let json = serde_json::json!({ "refresh_token": refresh_token, "obtained_at": now });
        std::fs::write(&self.0, json.to_string())
            .map_err(|e| cyanomelody_core::drive::DriveError::Auth(e.to_string()))
    }

    fn clear(&self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let folder = args.first().cloned().unwrap_or_else(|| "music/cyanomelody_test".into());
    let play_seconds: Option<u64> =
        args.iter().position(|a| a == "--play").map(|i| args[i + 1].parse().unwrap());

    let cache_dir: Option<PathBuf> =
        args.iter().position(|a| a == "--cache").map(|i| PathBuf::from(&args[i + 1]));

    let client_json = std::fs::read_to_string(secrets().join("google_oauth_desktop.sec.json")).unwrap();
    let oauth = OAuthClient::from_json(&client_json).unwrap();
    let store = Arc::new(FileStore(secrets().join("google_token.sec.json")));
    if store.load().is_none() {
        let login = LoopbackLogin::start(&oauth).unwrap();
        println!("ブラウザで次の URL を開いてログインしてください:\n{}", login.url);
        store.save(&login.finish(Duration::from_secs(300)).unwrap()).unwrap();
    }
    let tokens = Arc::new(RefreshingToken::new(oauth, store));
    let client = DriveClient::new(tokens);

    let t = Instant::now();
    println!("アカウント: {}", client.account_email().unwrap());
    let folder_id = client.folder_by_path(&folder).unwrap();
    let cache = cache_dir.map(|dir| SongCache::open(&dir, DEFAULT_MAX_BYTES).unwrap());
    let mut source = DriveSource::new(client, folder_id);
    if let Some(cache) = &cache {
        source = source.with_cache(cache.clone());
    }
    let source = Arc::new(source);
    let library = Library::open_in_memory().unwrap();
    let report = library
        .refresh(source.as_ref(), DEFAULT_PARALLELISM, &|done, total| println!("  タグ {done}/{total}"))
        .unwrap();
    println!("手動更新: {report:?} / {:?}", t.elapsed());
    let songs = library.songs(SourceKind::Drive).unwrap();
    for s in &songs {
        println!("  {} / {} / {:?}", s.relative_path, s.title, s.artist);
    }

    let Some(seconds) = play_seconds else { return };
    let src = source.clone();
    let opener: TrackOpener = Arc::new(move |track: &TrackRef| {
        src.open(&track.key).map_err(|e| PlaybackError::Open(e.to_string()))
    });
    let (tx, rx) = mpsc::channel();
    let player = Player::new(|| Box::new(CpalOutput::default()), opener, Arc::new(move |e| drop(tx.send(e))));
    player.set_volume(0.3);
    let tracks: Vec<TrackRef> =
        songs.iter().map(|s| TrackRef { key: s.key.clone(), extension: s.extension() }).collect();
    for (i, song) in songs.iter().enumerate() {
        let t = Instant::now();
        player.jump_to(i);
        if i == 0 {
            player.load(tracks.clone(), 0);
        }
        // 曲が切り替わり、再生が始まる（位置が進み始める）まで待つ
        while (player.status().index != Some(i) || player.status().position <= 0.0)
            && t.elapsed() < Duration::from_secs(30)
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        let started = t.elapsed();
        let duration = player.status().duration.unwrap_or(0.0);
        let target = duration * 0.4;
        let t = Instant::now();
        player.seek(target);
        std::thread::sleep(Duration::from_millis(50));
        let base = player.status().position;
        while player.status().position <= base + 0.01 && t.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(20));
        }
        println!(
            "再生: {} / 最初の音まで {:.2}秒 / {:.0}秒へのシーク {:.2}秒",
            song.title,
            started.as_secs_f64(),
            target,
            t.elapsed().as_secs_f64()
        );
        std::thread::sleep(Duration::from_secs(seconds));
        while let Ok(e) = rx.try_recv() {
            if let PlayerEvent::TrackFailed { error, .. } = e {
                println!("  失敗: {error}");
            }
        }
    }
    player.stop();
    if let Some(cache) = cache {
        let t = Instant::now();
        while songs.iter().any(|s| !cache.is_cached(&s.key)) && t.elapsed() < Duration::from_secs(120) {
            std::thread::sleep(Duration::from_millis(200));
        }
        for s in &songs {
            println!(
                "キャッシュ: {} / {}",
                s.title,
                if cache.is_cached(&s.key) { "保存済み" } else { "未保存" }
            );
        }
        println!(
            "キャッシュの合計: {} バイト / そろうまで {:.1}秒",
            cache.used_bytes().unwrap(),
            t.elapsed().as_secs_f64()
        );
    }
}
