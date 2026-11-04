//! アプリの設定のうち、データベースに保存するもの（内部の処理で使うもの）。値は key ごとに JSON で持つ

use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use crate::error::{Error, Result};

/// 新しく作るタグの既定値（TagSettings）
pub const NEW_TAG: &str = "new_tag";

/// 設定を読む。まだ保存していないときは既定の値
pub fn get<T: DeserializeOwned + Default>(conn: &Connection, key: &str) -> Result<T> {
    let value: Option<String> =
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?;
    match value {
        Some(v) => serde_json::from_str(&v).map_err(|e| Error::invalid(format!("設定「{key}」を読めません: {e}"))),
        None => Ok(T::default()),
    }
}

/// 設定を保存する
pub fn set<T: Serialize>(conn: &Connection, key: &str, value: &T) -> Result<()> {
    let json = serde_json::to_string(value).map_err(|e| Error::invalid(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, json],
    )?;
    Ok(())
}
