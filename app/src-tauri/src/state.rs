//! アプリの状態（Tauri に預け、コマンドから State で受け取る）

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::autotag_job::AutotagJob;
use crate::export_job::ExportJob;
use crate::hash_job::HashJob;

pub struct AppState {
    pub conn: Mutex<Connection>,
    pub hashing: Arc<HashJob>,
    /// エフェクトをかけた音の置き場所
    pub effect_cache: PathBuf,
    /// ファイルの中のジャケットを書き出しておく場所（グリッドのタイルに出す）
    pub cover_cache: PathBuf,
    pub export: Arc<ExportJob>,
    pub autotag: Arc<AutotagJob>,
    /// 選んでいるプレイリストと、抽選したときの中身の版（抽選した並びは DB の一時テーブルにある）
    pub draw: Mutex<Option<DrawState>>,
}

#[derive(Debug, Clone)]
pub struct DrawState {
    pub playlist_id: i64,
    pub version: String,
}

impl AppState {
    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        // 前の処理がパニックしても、DBの状態はトランザクションで守られているので使い続ける
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 選んでいるプレイリスト（DB の後にロックする）
    pub fn draw(&self) -> MutexGuard<'_, Option<DrawState>> {
        self.draw.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 試聴のため、ライブラリフォルダの中のファイルを画面から読めるようにする
pub fn allow_asset_dir(app: &AppHandle, path: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(path, true) {
        log::warn!("asset scope: {e}");
    }
}
