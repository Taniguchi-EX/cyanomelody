//! Windows：USB でつないだスマホへの直接コピーのコマンド（中の処理は phone.rs）

use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::export_job::{claim, release, spawn_steps};
use crate::phone::{self, PhoneDevice, PhoneSummary};
use crate::state::AppState;
use crate::transfer;

/// 全項目（ライブラリを含めるので、全曲が入る）
const ALL: transfer::Sections = transfer::Sections { library: true, tags: true, playlists: true, credits: true };

/// つないでいる端末の一覧（スマホで「ファイル転送」を選んでいるものだけ）
#[tauri::command]
pub async fn phone_devices() -> Result<Vec<PhoneDevice>> {
    phone::list_devices()
}

/// スマホの中を調べ、写すものの数を返す（調べた結果は、写すときに使う）
#[tauri::command]
pub async fn phone_plan(app: AppHandle, state: State<'_, AppState>, device_id: String) -> Result<PhoneSummary> {
    let plan = {
        let conn = state.conn();
        let data = transfer::export(&conn, ALL, &app.package_info().version.to_string(), None)?;
        phone::plan(&conn, &device_id, &data)?
    };
    let summary = plan.summary.clone();
    *state.phone_plan.lock().unwrap_or_else(|e| e.into_inner()) = Some(plan);
    Ok(summary)
}

/// 調べた結果のとおりに写し始める。進み具合はほかの書き出しと同じく "export-progress" で知らせる。
/// screen は画面の設定（データに入れる）。写し先（端末の名前と場所）を返す
#[tauri::command]
pub async fn phone_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    screen: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<String> {
    let plan = state
        .phone_plan
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or_else(|| Error::invalid("先にスマホの中を調べてください"))?;
    claim(&state.export)?;
    let data = match transfer::export(&state.conn(), ALL, &app.package_info().version.to_string(), screen) {
        Ok(d) => d,
        Err(e) => {
            release(&state.export);
            return Err(e);
        }
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| Error::invalid(e.to_string()))?;
    let label = format!("{} の {}", plan.summary.device, phone::PHONE_DIR);
    let total = phone::total_steps(&plan);
    spawn_steps(app, state.export.clone(), label.clone(), true, total, 0, move |step| {
        phone::run(plan, json, step).map_err(|e| e.to_string())
    });
    Ok(label)
}
