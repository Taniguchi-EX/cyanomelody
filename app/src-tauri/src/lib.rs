//! cyanomelody の Tauri アプリ。画面と中核（`cyanomelody-core`）をつなぐ。
//!
//! - `commands`：画面から呼ぶコマンドと、画面に知らせるイベント
//! - `core`：中核の部品をまとめた `AppCore`
//! - `ui`：画面に返す値とエラーの形
//! - `local_store`：端末に保存するもの（端末の設定、最後に読んだ設定とプレイリスト）
//! - `login`：Google Drive へのログイン（`drive` はデスクトップ、`android` は Android の実装）

#[cfg(target_os = "android")]
mod android;
mod commands;
mod core;
#[cfg(desktop)]
mod drive;
mod local_store;
mod login;
mod ui;

use std::sync::Arc;

use tauri::Manager;

use crate::commands::{account, library, player, playlist, settings};
use crate::core::AppCore;
use crate::login::Login;

/// アプリ全体で共有する状態。起動時に作る。
pub(crate) struct AppState {
    pub login: Login,
    pub core: Arc<AppCore>,
}

/// 端末のデータ領域とキャッシュ領域を用意して、中核の部品を作る。
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    let cache_dir = app.path().app_cache_dir()?.join("songs");
    std::fs::create_dir_all(&data_dir)?;
    let login = Login::new(&data_dir);
    let events = player::forward_player_events(app.handle().clone());
    let core = Arc::new(AppCore::new(&data_dir, &cache_dir, login.tokens(), events)?);
    #[cfg(target_os = "android")]
    let _ = android::CORE.set(core.clone());
    app.manage(AppState { login, core });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            account::app_info,
            account::drive_login,
            account::drive_logout,
            account::drive_account,
            settings::get_settings,
            settings::set_drive_folder,
            settings::set_local_folder,
            settings::set_cache_max,
            settings::drive_folders,
            settings::local_folders,
            library::refresh_library,
            library::browse,
            playlist::list_playlists,
            playlist::get_playlist,
            playlist::create_playlist,
            playlist::delete_playlist,
            playlist::rename_playlist,
            playlist::set_favorite,
            playlist::add_to_playlist,
            playlist::remove_from_playlist,
            playlist::move_in_playlist,
            player::play_playlist,
            player::player_command,
            player::player_seek,
            player::player_volume,
            player::player_shuffle,
            player::player_repeat,
            player::player_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
