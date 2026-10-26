//! プレイリストの読み書き。編集は、Drive から最新を読み直してから当てて保存する（`AppCore::edit_playlist`）。

use cyanomelody_core::sync::PlaylistSummary;

use super::blocking;
use crate::ui::{UiPlaylist, UiResult};

#[tauri::command]
pub async fn list_playlists(app: tauri::AppHandle) -> UiResult<Vec<PlaylistSummary>> {
    blocking(app, |c| c.list_playlists()).await
}

#[tauri::command]
pub async fn get_playlist(app: tauri::AppHandle, id: String) -> UiResult<UiPlaylist> {
    blocking(app, move |c| c.get_playlist(&id)).await
}

#[tauri::command]
pub async fn create_playlist(app: tauri::AppHandle, name: String) -> UiResult<UiPlaylist> {
    blocking(app, move |c| c.create_playlist(&name)).await
}

#[tauri::command]
pub async fn delete_playlist(app: tauri::AppHandle, id: String) -> UiResult<()> {
    blocking(app, move |c| c.delete_playlist(&id)).await
}

#[tauri::command]
pub async fn rename_playlist(app: tauri::AppHandle, id: String, name: String) -> UiResult<UiPlaylist> {
    blocking(app, move |c| c.edit_playlist(&id, |p| p.name = name)).await
}

#[tauri::command]
pub async fn set_favorite(app: tauri::AppHandle, id: String, favorite: bool) -> UiResult<UiPlaylist> {
    blocking(app, move |c| c.edit_playlist(&id, |p| p.favorite = favorite)).await
}

/// 曲を追加する。`folder` を渡すとフォルダ単位（サブフォルダの中も含む）、`key` を渡すとファイル単位。
#[tauri::command]
pub async fn add_to_playlist(
    app: tauri::AppHandle,
    id: String,
    source: String,
    folder: Option<String>,
    key: Option<String>,
) -> UiResult<UiPlaylist> {
    blocking(app, move |c| {
        let items = c.items_for(&source, folder.as_deref(), key.as_deref())?;
        c.edit_playlist(&id, |p| p.add(items))
    })
    .await
}

#[tauri::command]
pub async fn remove_from_playlist(app: tauri::AppHandle, id: String, index: usize) -> UiResult<UiPlaylist> {
    blocking(app, move |c| {
        c.edit_playlist(&id, |p| {
            p.remove(index);
        })
    })
    .await
}

#[tauri::command]
pub async fn move_in_playlist(
    app: tauri::AppHandle,
    id: String,
    from: usize,
    to: usize,
) -> UiResult<UiPlaylist> {
    blocking(app, move |c| {
        c.edit_playlist(&id, |p| {
            p.move_item(from, to);
        })
    })
    .await
}
