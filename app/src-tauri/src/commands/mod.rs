//! 画面から呼ぶ Tauri のコマンド。役割ごとのファイルに分ける（中の処理は、各機能のモジュールにある）

pub mod app;
pub mod autotag;
pub mod copy;
pub mod credits;
pub mod data;
pub mod effects;
pub mod files;
pub mod library;
#[cfg(windows)]
pub mod phone;
pub mod playlists;
pub mod tags;
