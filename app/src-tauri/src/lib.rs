mod db;
mod error;
mod files;
mod library;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use error::Result;
use files::{AudioFile, FileFilter, Tag};
use library::{LibraryFolder, ScanResult};

struct AppState {
    conn: Mutex<Connection>,
}

impl AppState {
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // 前の処理がパニックしても、DBの状態はトランザクションで守られているので使い続ける
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 試聴のため、ライブラリフォルダの中のファイルを画面から読めるようにする
fn allow_asset_dir(app: &AppHandle, path: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(path, true) {
        log::warn!("asset scope: {e}");
    }
}

// Tauriのコマンドは、async にすると画面のスレッドを止めずに別スレッドで動く

#[tauri::command]
async fn list_folders(state: State<'_, AppState>) -> Result<Vec<LibraryFolder>> {
    library::list_folders(&state.conn())
}

#[tauri::command]
async fn add_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ScanResult> {
    let mut conn = state.conn();
    let id = library::add_folder(&conn, Path::new(&path))?;
    allow_asset_dir(&app, &library::folder_path(&conn, id)?);
    library::scan_folder(&mut conn, id)
}

#[tauri::command]
async fn remove_folder(state: State<'_, AppState>, folder_id: i64) -> Result<()> {
    library::remove_folder(&state.conn(), folder_id)
}

#[tauri::command]
async fn scan_folder(state: State<'_, AppState>, folder_id: i64) -> Result<ScanResult> {
    library::scan_folder(&mut state.conn(), folder_id)
}

#[tauri::command]
async fn list_files(state: State<'_, AppState>, filter: FileFilter) -> Result<Vec<AudioFile>> {
    files::list_files(&state.conn(), &filter)
}

#[tauri::command]
async fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>> {
    files::list_tags(&state.conn())
}

#[tauri::command]
async fn add_tag(state: State<'_, AppState>, file_ids: Vec<i64>, name: String) -> Result<i64> {
    files::add_tag(&mut state.conn(), &file_ids, &name)
}

#[tauri::command]
async fn remove_tag(state: State<'_, AppState>, file_ids: Vec<i64>, tag_id: i64) -> Result<()> {
    files::remove_tag(&mut state.conn(), &file_ids, tag_id)
}

#[tauri::command]
async fn remove_missing_files(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<usize> {
    files::remove_missing_files(&mut state.conn(), &file_ids)
}

/// データの置き場所。テストなどで分けたいときは環境変数 CYANOMELODY_DATA_DIR で変えられる。
fn data_dir(app: &AppHandle) -> std::result::Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(dir) = std::env::var_os("CYANOMELODY_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(app.path().app_data_dir()?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let dir = data_dir(app.handle())?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("cyanomelody.db"))?;
            for folder in library::list_folders(&conn)? {
                allow_asset_dir(app.handle(), Path::new(&folder.path));
            }
            app.manage(AppState {
                conn: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_folders,
            add_folder,
            remove_folder,
            scan_folder,
            list_files,
            list_tags,
            add_tag,
            remove_tag,
            remove_missing_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
