//! Windows からのコピー（Android へ写す）のコマンド。
//! Windows：データと音声ファイルを、1つのフォルダ（書き出したフォルダ）に書き出す。
//! Android：書き出したフォルダ（またはデータのファイルだけ）を選び、見込みを出し、選んだ項目を Windows のとおりに置き換える

use std::path::Path;

use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::export::{self, sanitize};
use crate::export_job::start_export_job;
use crate::library::AUDIO_EXTENSIONS;
use crate::saf;
use crate::state::AppState;
use crate::transfer::{self, package, CopySource, PackageDir, PACKAGE_JSON};

use super::data::write_json;

// ---------------------------------------------------------------- Windows：書き出し

/// 音声ファイルも入れて書き出すときの、音声ファイルの数と合計の大きさ
#[tauri::command]
pub async fn estimate_package(app: AppHandle, state: State<'_, AppState>, sections: transfer::Sections) -> Result<package::PackageEstimate> {
    let conn = state.conn();
    let data = transfer::export(&conn, sections, &app.package_info().version.to_string(), None)?;
    let (files, missing) = package::package_files(&conn, &data)?;
    Ok(package::estimate(&files, missing))
}

/// dest の中に書き出したフォルダ（folder_name。同じ名前があれば「 (2)」などを付ける）を作り、データの JSON を書いて、音声ファイルのコピーを始める。
/// 作ったフォルダのパスを返す。進み具合はほかの書き出しと同じく "export-progress" で知らせる
#[tauri::command]
pub async fn export_package(
    app: AppHandle,
    state: State<'_, AppState>,
    dest: String,
    folder_name: String,
    sections: transfer::Sections,
    screen: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<String> {
    let version = app.package_info().version.to_string();
    let prepared = || {
        let dest = Path::new(dest.trim());
        if !dest.is_dir() {
            return Err(Error::invalid(format!("書き出し先のフォルダがありません: {}", dest.display())));
        }
        let conn = state.conn();
        let data = transfer::export(&conn, sections, &version, screen)?;
        let (files, _) = package::package_files(&conn, &data)?;
        let root = export::unique_dir(dest, &sanitize(&folder_name))?;
        write_json(&root.join(PACKAGE_JSON).to_string_lossy(), &data)?;
        let mut tasks = Vec::with_capacity(files.len());
        for f in files {
            let target = root.join(&f.dest);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            tasks.push(export::Task { source: f.source, effects: vec![], dest: target });
        }
        Ok((root, tasks, 0))
    };
    start_export_job(app, state.export.clone(), prepared)
}

// ---------------------------------------------------------------- Android：取り込み

/// 選んだもの（書き出したフォルダか、データのファイル）のデータと、書き出したフォルダの中のフォルダ
fn read_source(source: &CopySource) -> Result<(transfer::DataFile, Vec<saf::ChildDir>)> {
    if source.is_dir() {
        let json = saf::resolve_file(&source.uri, PACKAGE_JSON).ok_or_else(|| {
            Error::invalid(format!(
                "選んだフォルダに {PACKAGE_JSON} がありません。Windows で「音声ファイルも入れる」を選んで書き出したフォルダを選んでください"
            ))
        })?;
        Ok((transfer::parse(&saf::read_text(&json)?)?, saf::child_dirs(&source.uri)?))
    } else {
        Ok((transfer::parse(&saf::read_text(&source.uri)?)?, vec![]))
    }
}

/// 書き出したフォルダ（kind = "dir"）か、データのファイル（kind = "file"）を選ぶ画面を出し、コピーの見込みを返す。キャンセルしたら None
#[tauri::command]
pub async fn pick_copy_source(state: State<'_, AppState>, kind: String) -> Result<Option<transfer::CopyPreview>> {
    // 選んでいる間（ユーザーの操作を待つ間）は、データベースを使わない
    let uri = match kind.as_str() {
        "dir" => saf::pick_dir()?.map(|d| d.uri),
        "file" => saf::pick_json_file()?,
        _ => return Err(Error::invalid("選ぶものの種類が違います")),
    };
    let Some(uri) = uri else { return Ok(None) };
    let source = CopySource { kind, uri };
    let (data, dirs) = read_source(&source)?;
    let package = dirs
        .into_iter()
        .map(|d| Ok(PackageDir { files: saf::list_files(&d.uri, AUDIO_EXTENSIONS)?, name: d.name, uri: d.uri }))
        .collect::<Result<Vec<_>>>()?;
    transfer::copy_preview(&state.conn(), &data, &source, &package).map(Some)
}

/// 選んだもの（見込みの source）から、選んだ項目を Windows のとおりに置き換える。
/// 書き出したフォルダなら、中のフォルダを登録してスキャンしてから曲を探す。remove_old なら、前に別の場所から写したフォルダの登録を外す
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
    transfer::copy_into_library(&mut state.conn(), &data, &source, &dirs, sections, remove_old)
}
