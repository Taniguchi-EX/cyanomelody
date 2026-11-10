//! プレイリストのコマンド：プレイリストと項目の管理、選択と抽選、書き出し

use std::path::Path;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::Result;
use crate::export;
use crate::export_job::start_export_job;
use crate::playlists::{self, PlayEntry, PlayMode, PlaylistDetail, PlaylistNode};
use crate::state::{AppState, DrawState};
use crate::tree::MoveTarget;

#[tauri::command]
pub async fn list_playlists(state: State<'_, AppState>) -> Result<Vec<PlaylistNode>> {
    playlists::list_playlists(&state.conn())
}

#[tauri::command]
pub async fn get_playlist(state: State<'_, AppState>, id: i64) -> Result<PlaylistDetail> {
    playlists::get_playlist(&state.conn(), id)
}

/// parent を指定すると、その子として作る
#[tauri::command]
pub async fn create_playlist(state: State<'_, AppState>, name: String, parent: Option<i64>) -> Result<i64> {
    playlists::create_playlist(&mut state.conn(), &name, parent)
}

#[tauri::command]
pub async fn rename_playlist(state: State<'_, AppState>, id: i64, name: String) -> Result<()> {
    playlists::rename_playlist(&state.conn(), id, &name)
}

#[tauri::command]
pub async fn delete_playlist(state: State<'_, AppState>, id: i64) -> Result<()> {
    playlists::delete_playlist(&mut state.conn(), id)
}

#[tauri::command]
pub async fn move_playlist(state: State<'_, AppState>, id: i64, target: MoveTarget) -> Result<()> {
    playlists::move_playlist(&mut state.conn(), id, target)
}

#[tauri::command]
pub async fn add_playlist_files(state: State<'_, AppState>, id: i64, file_ids: Vec<i64>) -> Result<()> {
    playlists::add_files(&mut state.conn(), id, &file_ids)
}

#[tauri::command]
pub async fn add_playlist_tags(state: State<'_, AppState>, id: i64, tag_ids: Vec<i64>) -> Result<i64> {
    playlists::add_tags(&mut state.conn(), id, &tag_ids)
}

#[tauri::command]
pub async fn add_playlist_ref(state: State<'_, AppState>, id: i64, ref_id: i64) -> Result<i64> {
    playlists::add_playlist_ref(&mut state.conn(), id, ref_id)
}

#[tauri::command]
pub async fn remove_playlist_item(state: State<'_, AppState>, item_id: i64) -> Result<()> {
    playlists::remove_item(&mut state.conn(), item_id)
}

#[tauri::command]
pub async fn move_playlist_item(state: State<'_, AppState>, item_id: i64, index: usize) -> Result<()> {
    playlists::move_item(&mut state.conn(), item_id, index)
}

/// 項目の別名を変える。空なら外す
#[tauri::command]
pub async fn set_playlist_item_alias(state: State<'_, AppState>, item_id: i64, alias: String) -> Result<()> {
    playlists::set_item_alias(&state.conn(), item_id, &alias)
}

#[tauri::command]
pub async fn set_playlist_item_mode(state: State<'_, AppState>, item_id: i64, mode: PlayMode) -> Result<()> {
    playlists::set_item_mode(&state.conn(), item_id, mode)
}

#[tauri::command]
pub async fn expand_playlist_item(state: State<'_, AppState>, item_id: i64) -> Result<Vec<PlayEntry>> {
    playlists::expand_playlist_item(&state.conn(), item_id)
}

#[tauri::command]
pub async fn playlists_with_file(state: State<'_, AppState>, file_id: i64) -> Result<Vec<i64>> {
    playlists::playlists_with_file(&state.conn(), file_id)
}

/// 項目に入る曲をすべて（右の欄の曲のリスト）
#[tauri::command]
pub async fn playlist_item_files(state: State<'_, AppState>, item_id: i64) -> Result<Vec<PlayEntry>> {
    playlists::item_files(&state.conn(), item_id)
}

/// プレイリストから、ファイルの項目をまとめて外す（一括操作の欄）
#[tauri::command]
pub async fn remove_files_from_playlist(state: State<'_, AppState>, id: i64, file_ids: Vec<i64>) -> Result<usize> {
    playlists::remove_files_from_playlist(&state.conn(), id, &file_ids)
}

#[tauri::command]
pub async fn remove_file_from_playlist(state: State<'_, AppState>, id: i64, file_id: i64) -> Result<usize> {
    playlists::remove_file_from_playlist(&state.conn(), id, file_id)
}

/// データを読み直したときの、抽選した並びの扱い
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DrawRefresh {
    /// プレイリストを選んでいない、または中身が変わっていない
    Unchanged,
    /// 中身が変わったので抽選し直した
    Redrawn,
    /// プレイリストが消えたので、選択を外した
    Cleared,
}

/// プレイリストを選び、抽選する（選んでいたものは外れる）
#[tauri::command]
pub async fn select_playlist(state: State<'_, AppState>, id: i64) -> Result<()> {
    let conn = state.conn();
    let version = playlists::draw::draw(&conn, id)?;
    *state.draw() = Some(DrawState { playlist_id: id, version });
    Ok(())
}

/// プレイリストの選択を外す
#[tauri::command]
pub async fn clear_playlist_selection(state: State<'_, AppState>) -> Result<()> {
    let conn = state.conn();
    playlists::draw::clear(&conn)?;
    *state.draw() = None;
    Ok(())
}

/// 選んでいるプレイリストを抽選し直す（最後まで再生した後に、もう一度再生するとき）
#[tauri::command]
pub async fn redraw_playlist(state: State<'_, AppState>) -> Result<()> {
    let conn = state.conn();
    let mut draw = state.draw();
    if let Some(d) = draw.as_mut() {
        d.version = playlists::draw::draw(&conn, d.playlist_id)?;
    }
    Ok(())
}

/// データを読み直すときに呼ぶ。選んでいるプレイリストの中身の版が変わっていれば抽選し直し、消えていれば選択を外す
#[tauri::command]
pub async fn refresh_draw(state: State<'_, AppState>) -> Result<DrawRefresh> {
    let conn = state.conn();
    let mut draw = state.draw();
    let Some(d) = draw.as_mut() else { return Ok(DrawRefresh::Unchanged) };
    match playlists::draw::version(&conn, d.playlist_id)? {
        None => {
            playlists::draw::clear(&conn)?;
            *draw = None;
            Ok(DrawRefresh::Cleared)
        }
        Some(v) if v == d.version => Ok(DrawRefresh::Unchanged),
        Some(_) => {
            d.version = playlists::draw::draw(&conn, d.playlist_id)?;
            Ok(DrawRefresh::Redrawn)
        }
    }
}

/// プレイリストを書き出し始める。items は書き出す項目（プレイリストの直下。空ならすべて）。🎲・🔀の項目は抽選し直す
#[tauri::command]
pub async fn start_export(app: AppHandle, state: State<'_, AppState>, id: i64, items: Vec<i64>, dest: String) -> Result<String> {
    let prepared = || export::prepare(&state.conn(), id, &items, Path::new(dest.trim())).map(|(root, tasks)| (root, tasks, 0));
    start_export_job(app, state.export.clone(), prepared)
}

/// プレイリストを抽選し直し、items の項目（直下。空ならすべて）から来るファイル（重なりを除き、出てくる順）を返す。
/// プレイリストのメタデータの書き出しの対象に使う（中央の一覧の抽選した並びは変えない）
#[tauri::command]
pub fn draw_item_files(state: State<'_, AppState>, id: i64, items: Vec<i64>) -> Result<Vec<i64>> {
    let mut seen = std::collections::HashSet::new();
    Ok(playlists::draw::draw_items(&state.conn(), id, &items)?
        .into_iter()
        .map(|t| t.file_id)
        .filter(|f| seen.insert(*f))
        .collect())
}

/// 選んだファイル（一括操作の対象）を、dest の中に作るフォルダ（folder_name）へ、そのままコピーし始める。
/// 進み具合はプレイリストの書出と同じく "export-progress" で知らせる。見つからないファイルは「書き出せなかった」に数える
#[tauri::command]
pub async fn start_export_files(
    app: AppHandle,
    state: State<'_, AppState>,
    file_ids: Vec<i64>,
    dest: String,
    folder_name: String,
) -> Result<String> {
    let prepared = || {
        export::prepare_files(&state.conn(), &file_ids, Path::new(dest.trim()), &folder_name).map(|(root, tasks)| {
            // 見つからないファイルは書き出す一覧に入らないので、書き出せなかった数として数える
            let skipped = file_ids.len().saturating_sub(tasks.len());
            (root, tasks, skipped)
        })
    };
    start_export_job(app, state.export.clone(), prepared)
}

#[tauri::command]
pub async fn cancel_export(state: State<'_, AppState>) -> Result<()> {
    state.export.cancel.store(true, Ordering::SeqCst);
    Ok(())
}
