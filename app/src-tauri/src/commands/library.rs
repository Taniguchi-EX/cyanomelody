//! ライブラリのコマンド：フォルダの登録・解除・スキャン、ハッシュ値の計算、見つからないファイルのひも付け、ファイルの削除

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::hash_job::{run_hashing, HashProgress};
use crate::hashing::{self, RelinkResult};
use crate::library::{self, LibraryFolder, ScanResult};
use crate::state::{allow_asset_dir, AppState};
use crate::{deleting, linking};

// Tauriのコマンドは、async にすると画面のスレッドを止めずに別スレッドで動く

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> Result<Vec<LibraryFolder>> {
    library::list_folders(&state.conn())
}

#[tauri::command]
pub async fn add_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ScanResult> {
    let mut conn = state.conn();
    let id = library::add_folder(&conn, Path::new(&path))?;
    allow_asset_dir(&app, &library::folder_path(&conn, id)?);
    library::scan_folder(&mut conn, id)
}

#[tauri::command]
pub async fn remove_folder(state: State<'_, AppState>, folder_id: i64) -> Result<()> {
    library::remove_folder(&state.conn(), folder_id)
}

#[tauri::command]
pub async fn scan_folder(state: State<'_, AppState>, folder_id: i64) -> Result<ScanResult> {
    library::scan_folder(&mut state.conn(), folder_id)
}

/// ハッシュ値の計算を始める。既に計算中なら何もしない。
#[tauri::command]
pub async fn start_hashing(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let job = state.hashing.clone();
    if job.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    job.cancel.store(false, Ordering::SeqCst);
    std::thread::spawn(move || run_hashing(app, job));
    Ok(())
}

#[tauri::command]
pub async fn cancel_hashing(state: State<'_, AppState>) -> Result<()> {
    state.hashing.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn hashing_progress(state: State<'_, AppState>) -> Result<HashProgress> {
    Ok(state.hashing.progress.lock().unwrap_or_else(|e| e.into_inner()).clone())
}

#[tauri::command]
pub async fn relink_files(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<RelinkResult> {
    hashing::relink(&mut state.conn(), &file_ids)
}

/// ひも付けた結果。ライブラリに登録したフォルダがあれば、そのパス
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkOutcome {
    path: String,
    added_folder: Option<String>,
}

/// 見つからないファイルを path のファイルにひも付ける。path がライブラリの外なら add_root を登録する
pub fn link_missing(app: &AppHandle, conn: &mut Connection, missing: i64, path: &Path, add_root: &Path) -> Result<LinkOutcome> {
    let (target, added) = linking::ensure_in_library(conn, path, add_root)?;
    let added_folder = match added {
        Some(id) => {
            let folder = library::folder_path(conn, id)?;
            allow_asset_dir(app, &folder);
            Some(folder.to_string_lossy().into_owned())
        }
        None => None,
    };
    // 元の場所に戻っていたときは、スキャンで見つかったので、ひも付け直すものはない
    if target != missing {
        hashing::relink_to(conn, missing, target)?;
    }
    Ok(LinkOutcome { path: path.to_string_lossy().into_owned(), added_folder })
}

/// 見つからないファイルを、ユーザーが選んだファイルにひも付ける（ライブラリの外なら、そのファイルのフォルダを登録する）
#[tauri::command]
pub async fn link_missing_file(app: AppHandle, state: State<'_, AppState>, file_id: i64, path: String) -> Result<LinkOutcome> {
    let path = PathBuf::from(path);
    let parent = path.parent().ok_or_else(|| Error::invalid("フォルダが分かりません"))?.to_path_buf();
    link_missing(&app, &mut state.conn(), file_id, &path, &parent)
}

/// 見つからないファイルと同じ音声のファイルを folder の中から探し、見つかればひも付ける（ライブラリの外なら folder を登録する）。
/// 見つからなければ None
#[tauri::command]
pub async fn find_missing_in_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    file_id: i64,
    folder: String,
) -> Result<Option<LinkOutcome>> {
    let mut conn = state.conn();
    let folder = PathBuf::from(folder);
    match linking::find_in_folder(&conn, file_id, &folder)? {
        Some(found) => link_missing(&app, &mut conn, file_id, &found, &folder).map(Some),
        None => Ok(None),
    }
}

/// まとめて探した結果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindManyOutcome {
    linked: usize,
    not_found: usize,
    no_hash: usize,
    /// ライブラリに登録したフォルダ（ライブラリの外のフォルダから見つかったとき）
    added_folder: Option<String>,
}

/// 見つからないファイル（file_ids）それぞれと同じ音声のファイルを folder の中からまとめて探し、見つかったものをひも付ける
#[tauri::command]
pub async fn find_missing_in_folder_many(
    app: AppHandle,
    state: State<'_, AppState>,
    file_ids: Vec<i64>,
    folder: String,
) -> Result<FindManyOutcome> {
    let mut conn = state.conn();
    let folder = PathBuf::from(folder);
    let found = linking::find_many_in_folder(&conn, &file_ids, &folder)?;
    let mut outcome = FindManyOutcome { linked: 0, not_found: found.not_found, no_hash: found.no_hash, added_folder: None };
    for (id, path) in found.found {
        let r = link_missing(&app, &mut conn, id, &path, &folder)?;
        outcome.added_folder = outcome.added_folder.or(r.added_folder);
        outcome.linked += 1;
    }
    Ok(outcome)
}

/// ファイルを削除する（ごみ箱に移す。permanent なら完全に消す）。削除できたファイルはライブラリから外す。
/// 画面テストでは、環境変数 CYANOMELODY_TRASH_DIR のフォルダをごみ箱の代わりにする
#[tauri::command]
pub async fn delete_files(state: State<'_, AppState>, file_ids: Vec<i64>, permanent: bool) -> Result<deleting::DeleteResult> {
    let trash_dir = std::env::var_os("CYANOMELODY_TRASH_DIR").map(PathBuf::from);
    deleting::delete_files(&mut state.conn(), &file_ids, permanent, trash_dir.as_deref())
}
