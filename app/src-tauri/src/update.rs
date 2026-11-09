//! 自動アップデート。GitHub の最新の Release にある更新の情報（latest.json）から、新しい版を探して入れる

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::error::{Error, Result};

fn update_error(e: tauri_plugin_updater::Error) -> Error {
    Error::invalid(format!("更新できませんでした: {e}"))
}

/// 新しい版があれば、その版（"1.0.1" など）。探せなかったとき（オフラインなど）は None。
/// 開発用のビルドでは探さない。ただし画面テストのため、環境変数 CYANOMELODY_FAKE_UPDATE に版があれば、その版が見つかったことにする
pub async fn check(app: &AppHandle) -> Option<String> {
    if cfg!(debug_assertions) {
        return std::env::var("CYANOMELODY_FAKE_UPDATE").ok().filter(|v| !v.is_empty());
    }
    match app.updater().ok()?.check().await {
        Ok(update) => update.map(|u| u.version),
        Err(e) => {
            log::warn!("新しい版を探せませんでした: {e}");
            None
        }
    }
}

/// 新しい版をダウンロードしてインストールし、アプリを再起動する
pub async fn install(app: &AppHandle) -> Result<()> {
    let update = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?
        .ok_or_else(|| Error::invalid("新しい版が見つかりません"))?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(update_error)?;
    app.restart();
}
