//! 指定フォルダ（Drive は全端末共通、端末のフォルダは端末ごと）とキャッシュの設定。

use cyanomelody_core::sync::{DriveFolder, LocalFolder, Settings};
use serde::Serialize;

use super::{blocking, core};
use crate::core::AppCore;
use crate::ui::{UiError, UiResult};

#[derive(Serialize)]
pub struct UiSettings {
    drive_folder: Option<DriveFolder>,
    local_folder: Option<LocalFolder>,
    cache_max_bytes: u64,
    cache_used_bytes: u64,
    volume: f32,
}

fn ui_settings(c: &AppCore, settings: &Settings) -> UiSettings {
    let config = c.local_config();
    UiSettings {
        drive_folder: settings.drive_folder.clone(),
        local_folder: settings.local_folder(&c.device_id).cloned(),
        cache_max_bytes: config.cache_max_bytes,
        cache_used_bytes: c.cache.used_bytes().unwrap_or(0),
        volume: config.volume,
    }
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> UiResult<UiSettings> {
    blocking(app, |c| match c.load_settings() {
        Ok(settings) => Ok(ui_settings(c, &settings)),
        // オフラインのときは、端末に保存した設定を添える
        Err(e) => Err(match c.cached_settings() {
            Some(settings) => e.with_cached(&ui_settings(c, &settings)),
            None => e,
        }),
    })
    .await
}

#[tauri::command]
pub async fn set_drive_folder(app: tauri::AppHandle, id: String, path: String) -> UiResult<UiSettings> {
    blocking(app, move |c| {
        let settings = c.edit_settings(|s| s.drive_folder = Some(DriveFolder { id, path }))?;
        Ok(ui_settings(c, &settings))
    })
    .await
}

/// 設定の画面で、どの端末の設定か分かるようにする名前。
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| if cfg!(mobile) { "Android" } else { "PC" }.into())
}

#[tauri::command]
pub async fn set_local_folder(app: tauri::AppHandle, path: String) -> UiResult<UiSettings> {
    blocking(app, move |c| {
        let device = c.device_id.clone();
        let folder = LocalFolder { path, device_name: device_name() };
        let settings = c.edit_settings(|s| s.set_local_folder(&device, folder))?;
        Ok(ui_settings(c, &settings))
    })
    .await
}

#[tauri::command]
pub fn set_cache_max(app: tauri::AppHandle, bytes: u64) -> UiResult<()> {
    core(&app)?.set_cache_max(bytes)
}

#[derive(Serialize)]
pub struct UiFolder {
    id: String,
    name: String,
}

/// Drive の指定フォルダを選ぶための、フォルダの直下のフォルダ。
#[tauri::command]
pub async fn drive_folders(app: tauri::AppHandle, parent_id: String) -> UiResult<Vec<UiFolder>> {
    blocking(app, move |c| {
        let children = c.drive_client()?.list_children(&parent_id)?;
        let mut folders: Vec<UiFolder> = children
            .into_iter()
            .filter(|f| f.is_folder())
            .map(|f| UiFolder { id: f.id, name: f.name })
            .collect();
        folders.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(folders)
    })
    .await
}

/// この端末のフォルダを選ぶための、フォルダの直下のフォルダの名前（Android では入力の代わりにたどって選ぶ）。
/// 隠しフォルダ（`.` で始まるもの）は出さない。
#[tauri::command]
pub fn local_folders(path: String) -> UiResult<Vec<String>> {
    let entries = std::fs::read_dir(&path).map_err(|e| UiError::error(format!("{path}: {e}")))?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    Ok(names)
}
