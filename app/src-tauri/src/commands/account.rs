//! アプリの情報と、Google Drive へのログイン。

use serde::Serialize;
use tauri::Manager;

use super::{blocking, core};
use crate::AppState;
use crate::ui::{UiError, UiResult};

#[derive(Serialize)]
pub struct AppInfo {
    core_version: &'static str,
    device_id: String,
    /// `desktop` または `mobile`
    platform: &'static str,
    can_login: bool,
    logged_in: bool,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> UiResult<AppInfo> {
    Ok(AppInfo {
        core_version: cyanomelody_core::version(),
        device_id: core(&app)?.device_id.clone(),
        platform: if cfg!(desktop) { "desktop" } else { "mobile" },
        can_login: state.login.can_login(),
        logged_in: state.login.logged_in(),
    })
}

/// Google Drive にログインする。Windows と Ubuntu はブラウザ、Android は Google のログインの画面で同意する。
#[tauri::command]
pub async fn drive_login(app: tauri::AppHandle) -> UiResult<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    // ブラウザでの操作を待っている間に、二重に始めないための印
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err(UiError::error("ログインの途中です。同意の操作を終えてください"));
    }
    let result = tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().login.login(&app))
        .await
        .map_err(|e| UiError::error(e.to_string()))
        .and_then(|r| r);
    RUNNING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub fn drive_logout(state: tauri::State<'_, AppState>) {
    state.login.logout();
}

/// ログインしているアカウント。通信できるかの確認も兼ねる。
#[tauri::command]
pub async fn drive_account(app: tauri::AppHandle) -> UiResult<String> {
    blocking(app, |c| Ok(c.drive_client()?.account_email()?)).await
}
