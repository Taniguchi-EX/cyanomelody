//! ファイルの一覧のコマンド：一覧・件数、タグの付け外し、一括操作の内訳、再生の記録、曲名・ジャケット

use std::path::Path;

use tauri::State;

use crate::error::{Error, Result};
use crate::facets::{self, Facets};
use crate::files::{self, AudioFile, FileFilter};
use crate::library::file_location;
use crate::state::AppState;
use crate::{metadata, recent};

#[tauri::command]
pub async fn list_files(state: State<'_, AppState>, filter: FileFilter) -> Result<Vec<AudioFile>> {
    files::list_files(&state.conn(), &filter)
}

/// 絞り込みの各項目を選んだときの件数
#[tauri::command]
pub async fn facet_counts(state: State<'_, AppState>, filter: FileFilter) -> Result<Facets> {
    facets::facet_counts(&state.conn(), &filter)
}

/// 渡したファイルのうち、ライブラリにあるもの（消えたファイルを除く）
#[tauri::command]
pub async fn existing_file_ids(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<Vec<i64>> {
    files::existing_file_ids(&state.conn(), &file_ids)
}

#[tauri::command]
pub async fn add_tag(state: State<'_, AppState>, file_ids: Vec<i64>, name: String) -> Result<i64> {
    files::add_tag(&mut state.conn(), &file_ids, &name)
}

#[tauri::command]
pub async fn remove_tag(state: State<'_, AppState>, file_ids: Vec<i64>, tag_id: i64) -> Result<()> {
    files::remove_tag(&state.conn(), &file_ids, tag_id)
}

#[tauri::command]
pub async fn remove_missing_files(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<usize> {
    files::remove_missing_files(&state.conn(), &file_ids)
}

/// 一括操作の欄に出す、チェックしたファイルの内訳
#[tauri::command]
pub async fn bulk_summary(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<files::BulkSummary> {
    files::bulk_summary(&state.conn(), &file_ids)
}

/// ファイルを再生したことを記録する（「直近で再生したもの」）
#[tauri::command]
pub async fn record_play(state: State<'_, AppState>, file_id: i64) -> Result<()> {
    recent::record_play(&state.conn(), file_id)
}

/// 音声ファイルのトラック名（タグ情報のタイトル）。ないときは None
#[tauri::command]
pub async fn track_title(path: String) -> Result<Option<String>> {
    Ok(metadata::track_title(Path::new(&path)))
}

/// ファイルの中のジャケットの画像のパス（書き出しておいたもの）。ジャケットがなければ None。
/// ファイルの大きさ・更新日時が同じなら、前に書き出したものを使う（ないことも覚えておき、読み直さない）
#[tauri::command]
pub async fn track_cover(state: State<'_, AppState>, file_id: i64) -> Result<Option<String>> {
    let (path, size, modified): (_, i64, i64) = {
        let conn = state.conn();
        let (size, modified) = conn
            .query_row("SELECT size, modified_at FROM audio_files WHERE id = ?1", [file_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| Error::invalid("ファイルが見つかりません"))?;
        (file_location(&conn, file_id)?, size, modified)
    };
    let base = format!("{file_id}-{size}-{modified}");
    // 前に調べた結果（画像か、ないことの印）
    for ext in ["jpg", "png", "gif", "webp", "bmp"] {
        let p = state.cover_cache.join(format!("{base}.{ext}"));
        if p.exists() {
            return Ok(Some(p.to_string_lossy().into_owned()));
        }
    }
    let none_mark = state.cover_cache.join(format!("{base}.none"));
    if none_mark.exists() {
        return Ok(None);
    }
    match metadata::track_cover(&path) {
        Some((data, ext)) => {
            let out = state.cover_cache.join(format!("{base}.{ext}"));
            std::fs::write(&out, data)?;
            Ok(Some(out.to_string_lossy().into_owned()))
        }
        None => {
            // 見つからないファイル（読めない）では印を残さない（戻ってきたら読み直す）
            if path.exists() {
                std::fs::write(&none_mark, [])?;
            }
            Ok(None)
        }
    }
}
