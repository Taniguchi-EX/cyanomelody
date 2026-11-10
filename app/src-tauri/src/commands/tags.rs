//! タグのコマンド：タグ自体の管理と、新しく作るタグの既定値

use tauri::State;

use crate::error::Result;
use crate::state::AppState;
use crate::tags::{self, RenameResult, Tag, TagSettings};
use crate::tree::MoveTarget;

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>> {
    tags::list_tags(&state.conn())
}

#[tauri::command]
pub async fn create_tag(state: State<'_, AppState>, name: String) -> Result<i64> {
    tags::create_tag(&state.conn(), &name)
}

#[tauri::command]
pub async fn rename_tag(
    state: State<'_, AppState>,
    tag_id: i64,
    name: String,
    merge: bool,
) -> Result<RenameResult> {
    tags::rename_tag(&mut state.conn(), tag_id, &name, merge)
}

/// タグのシノニムを置き換える。name はこれから付けるタグの名前（同じものは入れない）
#[tauri::command]
pub async fn set_tag_synonyms(state: State<'_, AppState>, tag_id: i64, synonyms: Vec<String>, name: String) -> Result<()> {
    tags::set_tag_synonyms(&mut state.conn(), tag_id, &synonyms, &name)
}

#[tauri::command]
pub async fn set_tag_settings(state: State<'_, AppState>, tag_id: i64, settings: TagSettings) -> Result<()> {
    tags::set_tag_settings(&state.conn(), tag_id, &settings)
}

/// 新しく作るタグの既定値（設定画面の「一般」）
#[tauri::command]
pub async fn new_tag_settings(state: State<'_, AppState>) -> Result<TagSettings> {
    tags::new_tag_settings(&state.conn())
}

#[tauri::command]
pub async fn set_new_tag_settings(state: State<'_, AppState>, settings: TagSettings) -> Result<()> {
    tags::set_new_tag_settings(&state.conn(), &settings)
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, tag_id: i64) -> Result<()> {
    tags::delete_tag(&mut state.conn(), tag_id)
}

#[tauri::command]
pub async fn move_tag(state: State<'_, AppState>, tag_id: i64, target: MoveTarget) -> Result<()> {
    tags::move_tag(&mut state.conn(), tag_id, target)
}
