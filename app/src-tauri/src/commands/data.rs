//! データのエクスポート・インポートと、選んだファイルのメタデータの書き出しのコマンド

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::library;
use crate::state::{allow_asset_dir, AppState};
use crate::transfer;

/// エクスポートで書き出した件数
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    folders: usize,
    files: usize,
    tags: usize,
    playlists: usize,
    effect_chains: usize,
    sources: usize,
    licenses: usize,
}

/// データ（エクスポートの JSON）を path に書く
pub fn write_json(path: &str, data: &transfer::DataFile) -> Result<()> {
    let json = serde_json::to_string_pretty(data).map_err(|e| Error::invalid(e.to_string()))?;
    std::fs::write(path, json)?;
    Ok(())
}

/// 選んだファイル（一括操作の対象）のメタデータを、データのエクスポートと同じ形で path に書き出す。書き出した曲の数を返す
#[tauri::command]
pub async fn export_metadata(app: AppHandle, state: State<'_, AppState>, path: String, file_ids: Vec<i64>) -> Result<usize> {
    let data = transfer::export_metadata(&state.conn(), &file_ids, &app.package_info().version.to_string())?;
    write_json(&path, &data)?;
    Ok(data.files.len())
}

#[tauri::command]
pub async fn export_data(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    sections: transfer::Sections,
    screen: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<ExportSummary> {
    let data = transfer::export(&state.conn(), sections, &app.package_info().version.to_string(), screen)?;
    write_json(&path, &data)?;
    Ok(ExportSummary {
        folders: data.folders.len(),
        files: data.files.len(),
        tags: data.tags.len(),
        playlists: data.playlists.len(),
        effect_chains: data.effect_chains.len(),
        sources: data.sources.len(),
        licenses: data.licenses.len(),
    })
}

pub fn read_data_file(path: &str) -> Result<transfer::DataFile> {
    transfer::parse(&std::fs::read_to_string(path)?)
}

/// インポートの見込み（中身の件数、見つかる曲の数、置き換えで消える件数）
#[tauri::command]
pub async fn inspect_import(state: State<'_, AppState>, path: String) -> Result<transfer::ImportPreview> {
    let data = read_data_file(&path)?;
    transfer::preview(&state.conn(), &data)
}

/// データのインポート：ファイルに入っている項目のうち、選んだものを取り込む。replace なら、選んだ項目の今のデータを置き換える
#[tauri::command]
pub async fn import_data(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    sections: transfer::Sections,
    replace: bool,
) -> Result<transfer::ImportResult> {
    let data = read_data_file(&path)?;
    let has = data.sections;
    let sections = transfer::Sections {
        library: sections.library && has.library,
        tags: sections.tags && has.tags,
        playlists: sections.playlists && has.playlists,
        credits: sections.credits && has.credits,
    };
    let mut result = transfer::ImportResult::default();
    let mut conn = state.conn();
    // フォルダを登録してスキャンしてから、曲を見分ける
    if sections.library {
        transfer::import_folders(&conn, &data, replace, &mut result)?;
        for &id in &result.folders_added {
            allow_asset_dir(&app, &library::folder_path(&conn, id)?);
            library::scan_folder(&mut conn, id)?;
        }
    }
    transfer::import_data(&mut conn, &data, sections, replace, &mut result)?;
    Ok(result)
}
