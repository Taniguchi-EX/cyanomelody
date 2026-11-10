//! アプリ全体のコマンド：アップデート、フォントの一覧

use tauri::AppHandle;

use crate::error::Result;
use crate::{fonts, update};

/// 新しい版があれば、その版。開発用のビルドや、探せなかったときは None
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<String>> {
    Ok(update::check(&app).await)
}

/// 新しい版をダウンロードしてインストールし、アプリを再起動する
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<()> {
    update::install(&app).await
}

/// OS にインストールされているフォントのファミリの一覧（設定画面の「表示」）
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<fonts::FontFamily>> {
    Ok(fonts::installed_fonts())
}
