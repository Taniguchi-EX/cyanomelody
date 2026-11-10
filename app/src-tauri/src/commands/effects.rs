//! エフェクトセットのコマンド：エフェクトセットの管理、項目への設定、エフェクトをかけた音（再生・試聴）

use tauri::State;

use crate::error::{Error, Result};
use crate::state::AppState;
use crate::chains::{self, EffectChain};
use crate::effect_cache;
use crate::effects::Effect;
use crate::library::file_path;

#[tauri::command]
pub async fn list_effect_chains(state: State<'_, AppState>) -> Result<Vec<EffectChain>> {
    chains::list_chains(&state.conn())
}

#[tauri::command]
pub async fn create_effect_chain(state: State<'_, AppState>, name: String) -> Result<i64> {
    chains::create_chain(&state.conn(), &name)
}

#[tauri::command]
pub async fn rename_effect_chain(state: State<'_, AppState>, id: i64, name: String) -> Result<()> {
    chains::rename_chain(&state.conn(), id, &name)
}

#[tauri::command]
pub async fn delete_effect_chain(state: State<'_, AppState>, id: i64) -> Result<()> {
    chains::delete_chain(&state.conn(), id)
}

#[tauri::command]
pub async fn set_effect_chain_effects(state: State<'_, AppState>, id: i64, effects: Vec<Effect>) -> Result<()> {
    chains::set_chain_effects(&mut state.conn(), id, &effects)
}

/// プレイリストの項目にエフェクトセットを結び付ける。null なら外す
#[tauri::command]
pub async fn set_playlist_item_chain(state: State<'_, AppState>, item_id: i64, chain_id: Option<i64>) -> Result<()> {
    chains::set_item_chain(&state.conn(), item_id, chain_id)
}

/// ファイルに、エフェクトセット（chain_ids の順）をかけた音を用意して、そのパスを返す。
/// 処理に時間がかかることがあるので、データベースを使うのは最初だけにする
#[tauri::command]
pub async fn render_effects(state: State<'_, AppState>, file_id: i64, chain_ids: Vec<i64>) -> Result<String> {
    let (source, effects) = {
        let conn = state.conn();
        let mut effects = Vec::new();
        for c in &chain_ids {
            effects.extend(chains::chain_effects(&conn, *c)?);
        }
        (file_path(&conn, file_id)?, effects)
    };
    let out = effect_cache::render(&state.effect_cache, &source, &effects).map_err(Error::invalid)?;
    Ok(out.to_string_lossy().into_owned())
}

/// 保存する前のエフェクトの並びを、ファイルにかけて試聴するための音を用意する
#[tauri::command]
pub async fn preview_effects(state: State<'_, AppState>, file_id: i64, effects: Vec<Effect>) -> Result<String> {
    let source = file_path(&state.conn(), file_id)?;
    let out = effect_cache::render(&state.effect_cache, &source, &effects).map_err(Error::invalid)?;
    Ok(out.to_string_lossy().into_owned())
}
