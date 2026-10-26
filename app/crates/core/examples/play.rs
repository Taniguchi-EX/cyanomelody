//! 再生エンジンを実際の出力先で鳴らす確認用のプログラム。
//! 使い方: cargo run -p cyanomelody-core --example play -- [--volume 0.5] <ファイル>...

use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use cyanomelody_core::playback::output::CpalOutput;
use cyanomelody_core::playback::{PlayState, Player, PlayerEvent, TrackOpener, TrackRef};
use symphonia::core::io::MediaSource;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut volume = 0.5;
    if let Some(i) = args.iter().position(|a| a == "--volume") {
        volume = args[i + 1].parse().expect("音量は 0.0〜1.0");
        args.drain(i..=i + 1);
    }
    let tracks: Vec<TrackRef> = args
        .iter()
        .map(|path| TrackRef {
            key: path.clone(),
            extension: path.rsplit('.').next().unwrap_or("").to_ascii_lowercase(),
        })
        .collect();

    let opener: TrackOpener = Arc::new(|track: &TrackRef| {
        let file = std::fs::File::open(&track.key)
            .map_err(|e| cyanomelody_core::playback::PlaybackError::Open(e.to_string()))?;
        Ok(Box::new(file) as Box<dyn MediaSource>)
    });
    let (tx, rx) = mpsc::channel();
    let player = Player::new(
        || Box::new(CpalOutput::default()),
        opener,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    player.set_volume(volume);
    player.load(tracks.clone(), 0);

    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(PlayerEvent::TrackChanged { index }) => println!("再生: {}", tracks[index].key),
            Ok(PlayerEvent::TrackFailed { index, error }) => {
                println!("飛ばした: {} / {error}", tracks[index].key)
            }
            Ok(PlayerEvent::StateChanged(state)) => println!("状態: {state:?}"),
            Ok(PlayerEvent::Finished) => {
                println!("最後まで再生した");
                break;
            }
            Err(_) => {
                let s = player.status();
                if s.state == PlayState::Playing {
                    println!("  位置 {:.1}秒 / 長さ {:.1}秒", s.position, s.duration.unwrap_or(0.0));
                }
            }
        }
    }
}
