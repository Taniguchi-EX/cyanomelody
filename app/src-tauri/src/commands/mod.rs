//! 画面から呼ぶコマンド。種類ごとにファイルを分ける。
//!
//! - `account`：アプリの情報、Google Drive へのログイン
//! - `settings`：指定フォルダ、キャッシュ
//! - `library`：曲の一覧の手動更新、フォルダをたどる
//! - `playlist`：プレイリストの読み書き
//! - `player`：再生の操作と状態、再生エンジンからのイベント

pub mod account;
pub mod library;
pub mod player;
pub mod playlist;
pub mod settings;

use std::sync::Arc;

use tauri::Manager;

use crate::AppState;
use crate::core::AppCore;
use crate::ui::{UiError, UiResult};

pub(crate) fn core(app: &tauri::AppHandle) -> UiResult<Arc<AppCore>> {
    app.try_state::<AppState>().map(|s| s.core.clone()).ok_or_else(|| UiError::error("起動の途中です"))
}

/// 通信を伴う処理を、画面を止めないよう別のスレッドで動かす。
pub(crate) async fn blocking<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&AppCore) -> UiResult<T> + Send + 'static,
) -> UiResult<T> {
    let c = core(&app)?;
    tauri::async_runtime::spawn_blocking(move || f(&c)).await.map_err(|e| UiError::error(e.to_string()))?
}
