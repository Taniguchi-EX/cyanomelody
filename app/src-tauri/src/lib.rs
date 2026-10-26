//! cyanomelody の Tauri アプリ。画面と中核（`cyanomelody-core`）をつなぐ。
//!
//! - `drive`：Google Drive へのログイン
//! - `core`：中核の部品をまとめた `AppCore`
//! - このファイル：画面から呼ぶコマンドと、画面に知らせるイベント（`player`、`library-progress`）

#[cfg(target_os = "android")]
mod android;
mod core;
mod drive;

use std::sync::{Arc, OnceLock};

use cyanomelody_core::playback::{PlayState, PlayerEvent};
use cyanomelody_core::sync::{DriveFolder, LocalFolder, PlaylistSummary};
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::core::{AppCore, UiError, UiListing, UiPlaylist, UiResult};

/// アプリ全体で共有する状態。
struct AppState {
    drive: Result<drive::DriveAuth, cyanomelody_core::drive::DriveError>,
    core: OnceLock<Arc<AppCore>>,
    /// Android のログイン（Google Identity Services）
    #[cfg(target_os = "android")]
    android: OnceLock<Arc<android::AndroidToken>>,
}

impl AppState {
    fn can_login(&self) -> bool {
        #[cfg(target_os = "android")]
        return self.android.get().is_some();
        #[cfg(not(target_os = "android"))]
        return self.drive.is_ok();
    }

    fn logged_in(&self) -> bool {
        #[cfg(target_os = "android")]
        return self.android.get().is_some_and(|a| a.is_logged_in());
        #[cfg(not(target_os = "android"))]
        return self.drive.as_ref().is_ok_and(|d| d.is_logged_in());
    }
}

fn core(app: &tauri::AppHandle) -> UiResult<Arc<AppCore>> {
    app.state::<AppState>()
        .core
        .get()
        .cloned()
        .ok_or_else(|| UiError::new("error", "起動の途中です"))
}

/// 通信を伴う処理を、画面を止めないよう別のスレッドで動かす。
async fn blocking<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&AppCore) -> UiResult<T> + Send + 'static,
) -> UiResult<T> {
    let c = core(&app)?;
    tauri::async_runtime::spawn_blocking(move || f(&c))
        .await
        .map_err(|e| UiError::new("error", e.to_string()))?
}

#[derive(Serialize)]
struct AppInfo {
    core_version: &'static str,
    device_id: String,
    /// `desktop` または `mobile`
    platform: &'static str,
    can_login: bool,
    logged_in: bool,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> UiResult<AppInfo> {
    Ok(AppInfo {
        core_version: cyanomelody_core::version(),
        device_id: core(&app)?.device_id.clone(),
        platform: if cfg!(desktop) { "desktop" } else { "mobile" },
        can_login: state.can_login(),
        logged_in: state.logged_in(),
    })
}

/// ブラウザを開いて Google Drive にログインする（Windows と Ubuntu）。
#[tauri::command]
async fn drive_login(app: tauri::AppHandle) -> UiResult<()> {
    #[cfg(desktop)]
    {
        use std::sync::Mutex;
        use tauri_plugin_opener::OpenerExt;
        // ログイン中に二重に始めないための印
        static RUNNING: Mutex<bool> = Mutex::new(false);
        {
            let mut running = RUNNING.lock().unwrap();
            if *running {
                return Err(UiError::new(
                    "error",
                    "ログインの途中です。ブラウザでの操作を終えてください",
                ));
            }
            *running = true;
        }
        let result = tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let drive = state
                .drive
                .as_ref()
                .map_err(|e| UiError::new("login", e.to_string()))?;
            drive
                .login(|url| {
                    app.opener()
                        .open_url(url, None::<&str>)
                        .map_err(|e| e.to_string())
                })
                .map_err(UiError::from)
        })
        .await
        .map_err(|e| UiError::new("error", e.to_string()))
        .and_then(|r| r);
        *RUNNING.lock().unwrap() = false;
        result
    }
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let token = state
                .android
                .get()
                .ok_or_else(|| UiError::new("login", "起動の途中です"))?;
            token.login().map_err(UiError::from)
        })
        .await
        .map_err(|e| UiError::new("error", e.to_string()))?
    }
    #[cfg(all(mobile, not(target_os = "android")))]
    {
        let _ = app;
        Err(UiError::new("login", "この端末ではログインできません"))
    }
}

#[tauri::command]
fn drive_logout(state: tauri::State<'_, AppState>) {
    if let Ok(d) = state.drive.as_ref() {
        d.logout();
    }
    #[cfg(target_os = "android")]
    if let Some(a) = state.android.get() {
        a.logout();
    }
}

/// ログインしているアカウント。通信できるかの確認も兼ねる。
#[tauri::command]
async fn drive_account(app: tauri::AppHandle) -> UiResult<String> {
    blocking(app, |c| Ok(c.drive_client()?.account_email()?)).await
}

#[derive(Serialize)]
struct UiFolder {
    id: String,
    name: String,
}

/// Drive の指定フォルダを選ぶための、フォルダの直下のフォルダ。
#[tauri::command]
async fn drive_folders(app: tauri::AppHandle, parent_id: String) -> UiResult<Vec<UiFolder>> {
    blocking(app, move |c| {
        let mut folders: Vec<UiFolder> = c
            .drive_client()?
            .list_children(&parent_id)?
            .into_iter()
            .filter(|f| f.is_folder())
            .map(|f| UiFolder {
                id: f.id,
                name: f.name,
            })
            .collect();
        folders.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(folders)
    })
    .await
}

#[derive(Serialize)]
struct UiSettings {
    drive_folder: Option<DriveFolder>,
    local_folder: Option<LocalFolder>,
    cache_max_bytes: u64,
    cache_used_bytes: u64,
    volume: f32,
}

fn ui_settings(c: &AppCore, settings: &cyanomelody_core::sync::Settings) -> UiSettings {
    let config = c.local_config();
    UiSettings {
        drive_folder: settings.drive_folder.clone(),
        local_folder: settings.local_folder(&c.device_id).cloned(),
        cache_max_bytes: config.cache_max_bytes,
        cache_used_bytes: c.cache.used_bytes().unwrap_or(0),
        volume: config.volume,
    }
}

#[tauri::command]
async fn get_settings(app: tauri::AppHandle) -> UiResult<UiSettings> {
    blocking(app, |c| {
        let settings = c.load_settings()?;
        Ok(ui_settings(c, &settings))
    })
    .await
}

#[tauri::command]
async fn set_drive_folder(app: tauri::AppHandle, id: String, path: String) -> UiResult<UiSettings> {
    blocking(app, move |c| {
        let settings = c.edit_settings(|s| s.drive_folder = Some(DriveFolder { id, path }))?;
        Ok(ui_settings(c, &settings))
    })
    .await
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| {
            if cfg!(mobile) {
                "Android".into()
            } else {
                "PC".into()
            }
        })
}

#[tauri::command]
async fn set_local_folder(app: tauri::AppHandle, path: String) -> UiResult<UiSettings> {
    blocking(app, move |c| {
        let device = c.device_id.clone();
        let settings = c.edit_settings(|s| {
            s.set_local_folder(
                &device,
                LocalFolder {
                    path,
                    device_name: device_name(),
                },
            )
        })?;
        Ok(ui_settings(c, &settings))
    })
    .await
}

#[tauri::command]
fn set_cache_max(app: tauri::AppHandle, bytes: u64) -> UiResult<()> {
    core(&app)?.set_cache_max(bytes)
}

#[derive(Clone, Serialize)]
struct LibraryProgress {
    source: String,
    done: usize,
    total: usize,
}

#[derive(Serialize)]
struct UiReport {
    source: String,
    added: usize,
    updated: usize,
    unchanged: usize,
    missing: usize,
}

/// 指定フォルダの曲を読み直す（手動更新）。進み具合は `library-progress` イベントで知らせる。
#[tauri::command]
async fn refresh_library(app: tauri::AppHandle) -> UiResult<Vec<UiReport>> {
    let emitter = app.clone();
    blocking(app, move |c| {
        let reports = c.refresh_library(&|source, done, total| {
            let _ = emitter.emit(
                "library-progress",
                LibraryProgress {
                    source: source.into(),
                    done,
                    total,
                },
            );
        })?;
        Ok(reports
            .into_iter()
            .map(|(source, r)| UiReport {
                source,
                added: r.added,
                updated: r.updated,
                unchanged: r.unchanged,
                missing: r.missing,
            })
            .collect())
    })
    .await
}

#[tauri::command]
fn browse(app: tauri::AppHandle, source: String, folder: String) -> UiResult<UiListing> {
    core(&app)?.browse(&source, &folder)
}

#[derive(Serialize)]
struct UiSummary {
    id: String,
    name: String,
    favorite: bool,
    count: usize,
}

impl From<PlaylistSummary> for UiSummary {
    fn from(s: PlaylistSummary) -> Self {
        Self {
            id: s.id,
            name: s.name,
            favorite: s.favorite,
            count: s.count,
        }
    }
}

#[tauri::command]
async fn list_playlists(app: tauri::AppHandle) -> UiResult<Vec<UiSummary>> {
    blocking(app, |c| {
        Ok(c.list_playlists()?
            .into_iter()
            .map(UiSummary::from)
            .collect())
    })
    .await
}

#[tauri::command]
async fn get_playlist(app: tauri::AppHandle, id: String) -> UiResult<UiPlaylist> {
    blocking(app, move |c| c.get_playlist(&id)).await
}

#[tauri::command]
async fn create_playlist(app: tauri::AppHandle, name: String) -> UiResult<UiPlaylist> {
    blocking(app, move |c| c.create_playlist(&name)).await
}

#[tauri::command]
async fn delete_playlist(app: tauri::AppHandle, id: String) -> UiResult<()> {
    blocking(app, move |c| c.delete_playlist(&id)).await
}

#[tauri::command]
async fn rename_playlist(app: tauri::AppHandle, id: String, name: String) -> UiResult<UiPlaylist> {
    blocking(app, move |c| c.edit_playlist(&id, |p| p.name = name)).await
}

#[tauri::command]
async fn set_favorite(app: tauri::AppHandle, id: String, favorite: bool) -> UiResult<UiPlaylist> {
    blocking(app, move |c| {
        c.edit_playlist(&id, |p| p.favorite = favorite)
    })
    .await
}

/// 曲を追加する。`folder` を渡すとフォルダ単位（サブフォルダの中も含む）、`key` を渡すとファイル単位。
#[tauri::command]
async fn add_to_playlist(
    app: tauri::AppHandle,
    id: String,
    source: String,
    folder: Option<String>,
    key: Option<String>,
) -> UiResult<UiPlaylist> {
    blocking(app, move |c| {
        let items = c.items_for(&source, folder.as_deref(), key.as_deref())?;
        c.edit_playlist(&id, |p| p.add(items))
    })
    .await
}

#[tauri::command]
async fn remove_from_playlist(
    app: tauri::AppHandle,
    id: String,
    index: usize,
) -> UiResult<UiPlaylist> {
    blocking(app, move |c| {
        c.edit_playlist(&id, |p| {
            p.remove(index);
        })
    })
    .await
}

#[tauri::command]
async fn move_in_playlist(
    app: tauri::AppHandle,
    id: String,
    from: usize,
    to: usize,
) -> UiResult<UiPlaylist> {
    blocking(app, move |c| {
        c.edit_playlist(&id, |p| {
            p.move_item(from, to);
        })
    })
    .await
}

#[tauri::command]
async fn play_playlist(app: tauri::AppHandle, id: String, start: usize) -> UiResult<()> {
    blocking(app, move |c| c.play_playlist(&id, start)).await
}

#[tauri::command]
fn player_command(app: tauri::AppHandle, command: String) -> UiResult<()> {
    let c = core(&app)?;
    match command.as_str() {
        "play" => c.player.play(),
        "pause" => c.player.pause(),
        "stop" => c.player.stop(),
        "next" => c.player.next(),
        "prev" => c.player.prev(),
        other => return Err(UiError::new("error", format!("知らない操作: {other}"))),
    }
    Ok(())
}

#[tauri::command]
fn player_seek(app: tauri::AppHandle, seconds: f64) -> UiResult<()> {
    core(&app)?.player.seek(seconds);
    Ok(())
}

#[tauri::command]
fn player_volume(app: tauri::AppHandle, volume: f32) -> UiResult<()> {
    core(&app)?.set_volume(volume);
    Ok(())
}

#[tauri::command]
fn player_shuffle(app: tauri::AppHandle, shuffle: bool) -> UiResult<()> {
    core(&app)?.player.set_shuffle(shuffle);
    Ok(())
}

#[tauri::command]
fn player_repeat(app: tauri::AppHandle, repeat: bool) -> UiResult<()> {
    core(&app)?.player.set_repeat(repeat);
    Ok(())
}

#[derive(Serialize)]
struct UiStatus {
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
fn player_status(app: tauri::AppHandle) -> UiResult<UiStatus> {
    let c = core(&app)?;
    let s = c.player.status();
    let playing = c.playing.lock().unwrap();
    let item = s.index.and_then(|i| playing.as_ref()?.items.get(i));
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
        title: item.map(|i| i.title.clone()),
        artist: item.and_then(|i| i.artist.clone()),
    })
}

/// 再生エンジンからの知らせを、画面に `player` イベントとして送る。
#[derive(Clone, Serialize)]
struct UiPlayerEvent {
    kind: &'static str,
    index: Option<usize>,
    state: Option<&'static str>,
    error: Option<String>,
}

fn forward_player_events(app: tauri::AppHandle) -> cyanomelody_core::playback::EventHandler {
    Arc::new(move |event: PlayerEvent| {
        let payload = match event {
            PlayerEvent::TrackChanged { index } => UiPlayerEvent {
                kind: "track",
                index: Some(index),
                state: None,
                error: None,
            },
            PlayerEvent::StateChanged(s) => UiPlayerEvent {
                kind: "state",
                index: None,
                state: Some(state_name(s)),
                error: None,
            },
            PlayerEvent::TrackFailed { index, error } => UiPlayerEvent {
                kind: "failed",
                index: Some(index),
                state: None,
                error: Some(error.to_string()),
            },
            PlayerEvent::Finished => UiPlayerEvent {
                kind: "finished",
                index: None,
                state: None,
                error: None,
            },
        };
        let _ = app.emit("player", payload);
        // Android では、フォアグラウンドサービスと通知・ロック画面に知らせる
        #[cfg(target_os = "android")]
        if let Ok(c) = core(&app) {
            let s = c.player.status();
            let title = c
                .playing
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|p| p.items.get(s.index?).map(|i| i.title.clone()))
                .unwrap_or_default();
            android::notify(
                &title,
                s.state == PlayState::Playing,
                s.state != PlayState::Stopped,
            );
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    let drive = drive::DriveAuth::new();
    #[cfg(mobile)]
    let drive = Err(cyanomelody_core::drive::DriveError::Auth(
        "Android のログインは未対応".into(),
    ));
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            drive,
            core: OnceLock::new(),
            #[cfg(target_os = "android")]
            android: OnceLock::new(),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?.join("songs");
            let state = app.state::<AppState>();
            #[cfg(not(target_os = "android"))]
            let tokens = state
                .drive
                .as_ref()
                .ok()
                .map(|d| d.tokens.clone() as Arc<dyn cyanomelody_core::drive::TokenProvider>);
            #[cfg(target_os = "android")]
            let tokens = {
                std::fs::create_dir_all(&data_dir)?;
                let token = Arc::new(android::AndroidToken::new(&data_dir));
                let _ = state.android.set(token.clone());
                Some(token as Arc<dyn cyanomelody_core::drive::TokenProvider>)
            };
            let core = Arc::new(AppCore::new(
                &data_dir,
                &cache_dir,
                tokens,
                forward_player_events(handle),
            )?);
            #[cfg(target_os = "android")]
            let _ = android::CORE.set(core.clone());
            let _ = state.core.set(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            drive_login,
            drive_logout,
            drive_account,
            drive_folders,
            get_settings,
            set_drive_folder,
            set_local_folder,
            set_cache_max,
            refresh_library,
            browse,
            list_playlists,
            get_playlist,
            create_playlist,
            delete_playlist,
            rename_playlist,
            set_favorite,
            add_to_playlist,
            remove_from_playlist,
            move_in_playlist,
            play_playlist,
            player_command,
            player_seek,
            player_volume,
            player_shuffle,
            player_repeat,
            player_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
