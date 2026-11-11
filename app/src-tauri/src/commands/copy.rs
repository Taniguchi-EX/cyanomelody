//! Android：Windows からのコピーの取り込みのコマンド。
//! Windows がスマホへの直接コピーで写した cyanomelody 用のフォルダ（`Music/cyanomelody`）か、データのファイルだけを選び、
//! 見込みを出し、選んだ項目を Windows のとおりに置き換える。
//! cyanomelody 用のフォルダは最初に1回だけ選んで許可し、場所を設定に覚えておく（アプリを開いたときに新しいデータがあるかを見る）

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::library::AUDIO_EXTENSIONS;
use crate::saf;
use crate::settings::{self, COPY_FOLDER, COPY_IMPORTED_AT};
use crate::state::AppState;
use crate::transfer::{self, CopySource, PackageDir, PACKAGE_JSON};

/// 選んだもの（cyanomelody 用のフォルダか、データのファイル）のデータと、フォルダの中のフォルダ
fn read_source(source: &CopySource) -> Result<(transfer::DataFile, Vec<saf::ChildDir>)> {
    if source.is_dir() {
        let json = saf::resolve_file(&source.uri, PACKAGE_JSON).ok_or_else(|| {
            Error::invalid(format!(
                "cyanomelody 用のフォルダに {PACKAGE_JSON} がありません。Windows の設定画面の「データ」の「スマホへコピー」で写してください"
            ))
        })?;
        Ok((transfer::parse(&saf::read_text(&json)?)?, saf::child_dirs(&source.uri)?))
    } else {
        Ok((transfer::parse(&saf::read_text(&source.uri)?)?, vec![]))
    }
}

/// 選んだものの見込み
fn preview(state: &AppState, source: CopySource) -> Result<transfer::CopyPreview> {
    let (data, dirs) = read_source(&source)?;
    let package = dirs
        .into_iter()
        .map(|d| Ok(PackageDir { files: saf::list_files(&d.uri, AUDIO_EXTENSIONS)?, name: d.name, uri: d.uri }))
        .collect::<Result<Vec<_>>>()?;
    transfer::copy_preview(&state.conn(), &data, &source, &package)
}

/// cyanomelody 用のフォルダの状態
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFolderStatus {
    /// 設定したフォルダ（「Music/cyanomelody」など）。まだ設定していなければ None
    pub label: Option<String>,
    /// 権限が残っていて読めるか
    pub readable: bool,
    /// フォルダの中のデータを Windows で書き出した日時（データがなければ None）
    pub exported_at: Option<i64>,
    /// 前に取り込んだデータの、書き出した日時
    pub imported_at: Option<i64>,
}

/// cyanomelody 用のフォルダの状態（アプリを開いたときに、新しいデータがあるかを見る）
#[tauri::command]
pub async fn copy_folder_status(state: State<'_, AppState>) -> Result<CopyFolderStatus> {
    let (folder, imported_at) = {
        let conn = state.conn();
        (settings::get::<Option<String>>(&conn, COPY_FOLDER)?, settings::get::<Option<i64>>(&conn, COPY_IMPORTED_AT)?)
    };
    let Some(folder) = folder else { return Ok(CopyFolderStatus { imported_at, ..Default::default() }) };
    let readable = saf::readable(&folder);
    let exported_at = if readable {
        saf::resolve_file(&folder, PACKAGE_JSON)
            .and_then(|json| saf::read_text(&json).ok())
            .and_then(|text| transfer::parse(&text).ok())
            .map(|d| d.exported_at)
    } else {
        None
    };
    Ok(CopyFolderStatus { label: Some(saf::display_name(&folder)), readable, exported_at, imported_at })
}

/// cyanomelody 用のフォルダを選ぶ画面（`Music/cyanomelody` から始める。なければ作る）を出し、選んだフォルダを覚える。キャンセルしたら false
#[tauri::command]
pub async fn set_copy_folder(state: State<'_, AppState>) -> Result<bool> {
    // 選んでいる間（ユーザーの操作を待つ間）は、データベースを使わない
    let Some(dir) = saf::pick_app_dir()? else { return Ok(false) };
    settings::set(&state.conn(), COPY_FOLDER, &Some(dir.uri))?;
    Ok(true)
}

/// cyanomelody 用のフォルダの中のデータの見込み
#[tauri::command]
pub async fn inspect_copy_folder(state: State<'_, AppState>) -> Result<transfer::CopyPreview> {
    let folder: Option<String> = settings::get(&state.conn(), COPY_FOLDER)?;
    let folder = folder.ok_or_else(|| Error::invalid("cyanomelody 用のフォルダを設定してください"))?;
    preview(&state, CopySource { kind: "dir".into(), uri: folder })
}

/// データのファイル（JSON）だけを選ぶ画面を出し、コピーの見込みを返す。キャンセルしたら None
#[tauri::command]
pub async fn pick_copy_file(state: State<'_, AppState>) -> Result<Option<transfer::CopyPreview>> {
    let Some(uri) = saf::pick_json_file()? else { return Ok(None) };
    preview(&state, CopySource { kind: "file".into(), uri }).map(Some)
}

/// 選んだもの（見込みの source）から、選んだ項目を Windows のとおりに置き換える。
/// cyanomelody 用のフォルダなら、中のフォルダを登録してスキャンしてから曲を探し、取り込んだデータの日時を覚える。
/// remove_old なら、前に別の場所から写したフォルダの登録を外す
#[tauri::command]
pub async fn copy_from_windows(
    state: State<'_, AppState>,
    source: CopySource,
    sections: transfer::Sections,
    remove_old: bool,
) -> Result<transfer::ImportResult> {
    let (data, dirs) = read_source(&source)?;
    let has = data.sections;
    let sections = transfer::Sections {
        library: false,
        tags: sections.tags && has.tags,
        playlists: sections.playlists && has.playlists,
        credits: sections.credits && has.credits,
    };
    let mut conn = state.conn();
    let result = transfer::copy_into_library(&mut conn, &data, &source, &dirs, sections, remove_old)?;
    if source.is_dir() {
        settings::set(&conn, COPY_IMPORTED_AT, &Some(data.exported_at))?;
    }
    Ok(result)
}
