//! 出典・ライセンスのコマンド

use tauri::State;

use crate::error::Result;
use crate::state::AppState;
use crate::credits::{self, Credit, CreditInput, CreditKind, LicenseType};
use crate::tree::MoveTarget;

#[tauri::command]
pub async fn license_types() -> Result<&'static [LicenseType]> {
    Ok(credits::LICENSE_TYPES)
}

#[tauri::command]
pub async fn list_credits(state: State<'_, AppState>, kind: CreditKind) -> Result<Vec<Credit>> {
    credits::list_credits(&state.conn(), kind)
}

#[tauri::command]
pub async fn move_credit(state: State<'_, AppState>, kind: CreditKind, id: i64, target: MoveTarget) -> Result<()> {
    credits::move_credit(&mut state.conn(), kind, id, target)
}

#[tauri::command]
pub async fn create_credit(state: State<'_, AppState>, kind: CreditKind, input: CreditInput) -> Result<i64> {
    credits::create_credit(&state.conn(), kind, &input)
}

#[tauri::command]
pub async fn update_credit(state: State<'_, AppState>, kind: CreditKind, id: i64, input: CreditInput) -> Result<()> {
    credits::update_credit(&state.conn(), kind, id, &input)
}

#[tauri::command]
pub async fn delete_credit(state: State<'_, AppState>, kind: CreditKind, id: i64) -> Result<()> {
    credits::delete_credit(&state.conn(), kind, id)
}

/// 指定したファイルに出典・ライセンスを設定する。name が null なら外す
#[tauri::command]
pub async fn set_file_credit(
    state: State<'_, AppState>,
    kind: CreditKind,
    file_ids: Vec<i64>,
    name: Option<String>,
) -> Result<Option<i64>> {
    credits::set_file_credit(&mut state.conn(), kind, &file_ids, name.as_deref())
}
