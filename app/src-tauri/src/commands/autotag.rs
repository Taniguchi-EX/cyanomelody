//! ファイルの情報からのタグ付けのコマンド：1件ずつ、裏でまとめて、無視する値・区切り文字の設定

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::autotag;
use crate::autotag_job::run_autotag;
use crate::error::{Error, Result};
use crate::metadata;
use crate::state::AppState;

/// 自動タグ付けで無視する値の一覧
#[tauri::command]
pub async fn meta_ignore_values(state: State<'_, AppState>) -> Result<Vec<String>> {
    autotag::ignore_values(&state.conn())
}

#[tauri::command]
pub async fn set_meta_ignore_values(state: State<'_, AppState>, values: Vec<String>) -> Result<()> {
    autotag::set_ignore_values(&state.conn(), &values)
}

/// 自動タグ付けの区切り文字の一覧
#[tauri::command]
pub async fn meta_separators(state: State<'_, AppState>) -> Result<Vec<String>> {
    autotag::separators(&state.conn())
}

#[tauri::command]
pub async fn set_meta_separators(state: State<'_, AppState>, values: Vec<String>) -> Result<()> {
    autotag::set_separators(&state.conn(), &values)
}

/// ファイル1件の自動タグ付けの結果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutotagFileResult {
    /// ファイルを読めたか
    readable: bool,
    #[serde(flatten)]
    applied: autotag::Applied,
}

/// ファイル1件に、ファイルの中の情報からタグを付ける。ignore なら、無視する値の一覧の値は使わない。
/// split なら、アーティスト・作曲者を区切り文字の一覧で分ける
#[tauri::command]
pub async fn autotag_file(state: State<'_, AppState>, file_id: i64, ignore: bool, split: bool) -> Result<AutotagFileResult> {
    let (path, ignore_list, separators) = {
        let conn = state.conn();
        let path = autotag::file_path(&conn, file_id)?.ok_or_else(|| Error::invalid("見つからないファイルは読めません"))?;
        (
            path,
            if ignore { autotag::ignore_values(&conn)? } else { vec![] },
            if split { autotag::separators(&conn)? } else { vec![] },
        )
    };
    let Some(meta) = metadata::file_meta(&path) else {
        return Ok(AutotagFileResult { readable: false, applied: Default::default() });
    };
    let mut conn = state.conn();
    let tx = conn.transaction()?;
    let applied = autotag::apply(&tx, file_id, &meta, &ignore_list, &separators)?;
    tx.commit()?;
    Ok(AutotagFileResult { readable: true, applied })
}

/// たくさんのファイルの自動タグ付けを、裏で始める。既に行っている間は始めない
#[tauri::command]
pub async fn start_autotag(app: AppHandle, state: State<'_, AppState>, file_ids: Vec<i64>, ignore: bool, split: bool) -> Result<()> {
    let job = state.autotag.clone();
    if job.running.swap(true, Ordering::SeqCst) {
        return Err(Error::invalid("ファイルの情報からタグを付けている途中です"));
    }
    job.cancel.store(false, Ordering::SeqCst);
    let ignore_list = if ignore { autotag::ignore_values(&state.conn())? } else { vec![] };
    let separators = if split { autotag::separators(&state.conn())? } else { vec![] };
    std::thread::spawn(move || run_autotag(app, job, file_ids, ignore_list, separators));
    Ok(())
}

#[tauri::command]
pub async fn cancel_autotag(state: State<'_, AppState>) -> Result<()> {
    state.autotag.cancel.store(true, Ordering::SeqCst);
    Ok(())
}
