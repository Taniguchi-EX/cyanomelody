//! cyanomelody の Tauri アプリ。画面と中核（`cyanomelody-core`）をつなぐ。

mod drive;

#[cfg(desktop)]
use std::sync::Mutex;

/// 中核のバージョンを返す（画面と中核がつながっているかの確認用）。
#[tauri::command]
fn core_version() -> &'static str {
    cyanomelody_core::version()
}

/// Google Drive にログインしているか。
#[tauri::command]
fn drive_logged_in(state: tauri::State<'_, AppState>) -> bool {
    state.drive.as_ref().is_ok_and(|d| d.is_logged_in())
}

/// ブラウザを開いて Google Drive にログインする（Windows と Ubuntu）。
#[tauri::command]
async fn drive_login(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri_plugin_opener::OpenerExt;
        // ログイン中に二重に始めないための印
        static RUNNING: Mutex<bool> = Mutex::new(false);
        {
            let mut running = RUNNING.lock().unwrap();
            if *running {
                return Err("ログインの途中です。ブラウザでの操作を終えてください".into());
            }
            *running = true;
        }
        let result = tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let drive = state.drive.as_ref().map_err(|e| e.to_string())?;
            drive
                .login(|url| {
                    app.opener()
                        .open_url(url, None::<&str>)
                        .map_err(|e| e.to_string())
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        *RUNNING.lock().unwrap() = false;
        result
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("Android のログインは未対応".into())
    }
}

#[tauri::command]
fn drive_logout(state: tauri::State<'_, AppState>) {
    if let Ok(d) = state.drive.as_ref() {
        d.logout();
    }
}

/// アプリ全体で共有する状態。
struct AppState {
    drive: Result<drive::DriveAuth, cyanomelody_core::drive::DriveError>,
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
        .manage(AppState { drive })
        .invoke_handler(tauri::generate_handler![
            core_version,
            drive_logged_in,
            drive_login,
            drive_logout
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
