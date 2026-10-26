//! 再生の操作と状態。再生エンジンからの知らせは `player` イベントで画面に送る。

use std::sync::Arc;

use cyanomelody_core::playback::{EventHandler, PlayState, PlayerEvent};
use serde::Serialize;
use tauri::Emitter;

use super::{blocking, core};
use crate::ui::{UiError, UiResult};

#[tauri::command]
pub async fn play_playlist(app: tauri::AppHandle, id: String, start: usize) -> UiResult<()> {
    blocking(app, move |c| c.play_playlist(&id, start)).await
}

#[tauri::command]
pub fn player_command(app: tauri::AppHandle, command: String) -> UiResult<()> {
    let player = &core(&app)?.player;
    match command.as_str() {
        "play" => player.play(),
        "pause" => player.pause(),
        "stop" => player.stop(),
        "next" => player.next(),
        "prev" => player.prev(),
        other => return Err(UiError::error(format!("知らない操作: {other}"))),
    }
    Ok(())
}

#[tauri::command]
pub fn player_seek(app: tauri::AppHandle, seconds: f64) -> UiResult<()> {
    core(&app)?.player.seek(seconds);
    Ok(())
}

#[tauri::command]
pub fn player_volume(app: tauri::AppHandle, volume: f32) -> UiResult<()> {
    core(&app)?.set_volume(volume);
    Ok(())
}

#[tauri::command]
pub fn player_shuffle(app: tauri::AppHandle, shuffle: bool) -> UiResult<()> {
    core(&app)?.player.set_shuffle(shuffle);
    Ok(())
}

#[tauri::command]
pub fn player_repeat(app: tauri::AppHandle, repeat: bool) -> UiResult<()> {
    core(&app)?.player.set_repeat(repeat);
    Ok(())
}

#[derive(Serialize)]
pub struct UiStatus {
    state: &'static str,
    index: Option<usize>,
    position: f64,
    duration: Option<f64>,
    shuffle: bool,
    repeat: bool,
    volume: f32,
    playlist_id: Option<String>,
    playlist_name: Option<String>,
    title: Option<String>,
    artist: Option<String>,
}

fn state_name(s: PlayState) -> &'static str {
    match s {
        PlayState::Stopped => "stopped",
        PlayState::Playing => "playing",
        PlayState::Paused => "paused",
    }
}

#[tauri::command]
pub fn player_status(app: tauri::AppHandle) -> UiResult<UiStatus> {
    let c = core(&app)?;
    let s = c.player.status();
    let item = c.playing_item(s.index);
    let playing = c.playing.lock().unwrap();
    Ok(UiStatus {
        state: state_name(s.state),
        index: s.index,
        position: s.position,
        duration: s.duration,
        shuffle: s.shuffle,
        repeat: s.repeat,
        volume: s.volume,
        playlist_id: playing.as_ref().map(|p| p.id.clone()),
        playlist_name: playing.as_ref().map(|p| p.name.clone()),
        title: item.as_ref().map(|i| i.title.clone()),
        artist: item.and_then(|i| i.artist),
    })
}

/// 画面に送る `player` イベント。
#[derive(Clone, Serialize)]
struct UiPlayerEvent {
    /// `track`（曲が変わった）、`state`（再生・一時停止・停止）、`failed`（再生できず飛ばした）、`finished`
    kind: &'static str,
    index: Option<usize>,
    state: Option<&'static str>,
    error: Option<String>,
}

impl From<PlayerEvent> for UiPlayerEvent {
    fn from(event: PlayerEvent) -> Self {
        let (kind, index, state, error) = match event {
            PlayerEvent::TrackChanged { index } => ("track", Some(index), None, None),
            PlayerEvent::StateChanged(s) => ("state", None, Some(state_name(s)), None),
            PlayerEvent::TrackFailed { index, error } => {
                ("failed", Some(index), None, Some(error.to_string()))
            }
            PlayerEvent::Finished => ("finished", None, None, None),
        };
        Self { kind, index, state, error }
    }
}

/// 再生エンジンからの知らせを画面に送る。Android では、フォアグラウンドサービスと通知・ロック画面にも知らせる。
pub fn forward_player_events(app: tauri::AppHandle) -> EventHandler {
    Arc::new(move |event: PlayerEvent| {
        let _ = app.emit("player", UiPlayerEvent::from(event));
        #[cfg(target_os = "android")]
        if let Ok(c) = core(&app) {
            let s = c.player.status();
            let title = c.playing_item(s.index).map(|i| i.title).unwrap_or_default();
            crate::android::notify(&title, s.state == PlayState::Playing, s.state != PlayState::Stopped);
        }
    })
}
