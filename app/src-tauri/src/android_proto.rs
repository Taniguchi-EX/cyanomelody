//! Android の試作（技術的に怪しい所の確認用。本実装では作り直す）。
//! Storage Access Framework（SAF）でフォルダを選び、権限を残し、中の音声ファイルを列挙・読み取り（ハッシュ値・長さ・曲名・ジャケット）する。
//! 読み取りは、SAF のファイルを開いた番号（ファイルディスクリプタ）を `/proc/self/fd/番号` のパスにして、今のパスで読む処理に渡す

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{Error, Result};

/// 選んだフォルダ（FsUri の JSON）と、アプリを起動し直しても読める権限が残っているか
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavedDir {
    pub uri: Option<String>,
    pub persisted: bool,
}

/// フォルダの中の音声ファイル（列挙の結果）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    /// フォルダの中の相対パス
    pub rel_path: String,
    /// ファイルの FsUri（JSON）
    pub uri: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub files: Vec<ScanEntry>,
    pub dirs: usize,
    pub elapsed_ms: u128,
}

/// 1つのファイルを読んだ結果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeReport {
    pub rel_path: String,
    pub hash: std::result::Result<String, String>,
    pub duration: Option<f64>,
    pub title: Option<String>,
    pub cover_bytes: Option<usize>,
    pub elapsed_ms: u128,
}

fn not_android() -> Error {
    Error::invalid("Android でだけ使えます")
}

#[tauri::command]
pub async fn proto_pick_dir(app: AppHandle) -> Result<SavedDir> {
    #[cfg(target_os = "android")]
    {
        imp::pick_dir(&app).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(not_android())
    }
}

#[tauri::command]
pub async fn proto_saved_dir(app: AppHandle) -> Result<SavedDir> {
    #[cfg(target_os = "android")]
    {
        imp::saved_dir(&app).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(not_android())
    }
}

#[tauri::command]
pub async fn proto_scan(app: AppHandle, dir: String) -> Result<ScanReport> {
    #[cfg(target_os = "android")]
    {
        imp::scan(&app, &dir).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, dir);
        Err(not_android())
    }
}

#[tauri::command]
pub async fn proto_analyze(app: AppHandle, uri: String, rel_path: String) -> Result<AnalyzeReport> {
    #[cfg(target_os = "android")]
    {
        imp::analyze(&app, &uri, rel_path).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, uri, rel_path);
        Err(not_android())
    }
}

#[cfg(target_os = "android")]
mod imp {
    use std::os::fd::AsRawFd;
    use std::path::PathBuf;
    use std::time::Instant;

    use tauri::{AppHandle, Manager};
    use tauri_plugin_android_fs::{AndroidFsExt, Entry, FsUri, UriPermission};

    use super::*;

    fn fs_error(e: impl std::fmt::Debug) -> Error {
        Error::invalid(format!("{e:?}"))
    }

    /// 選んだフォルダを覚えておくファイル
    fn saved_path(app: &AppHandle) -> Result<PathBuf> {
        let dir = app.path().app_data_dir().map_err(fs_error)?;
        std::fs::create_dir_all(&dir)?;
        Ok(dir.join("proto_dir.json"))
    }

    pub async fn pick_dir(app: &AppHandle) -> Result<SavedDir> {
        let api = app.android_fs_async();
        let Some(uri) = api.picker().pick_dir(None, false).await.map_err(fs_error)? else {
            return Ok(SavedDir::default());
        };
        // アプリを起動し直しても読めるように、権限を残す
        api.picker().persist_uri_permission(&uri).await.map_err(fs_error)?;
        let json = uri.to_json_string().map_err(fs_error)?;
        std::fs::write(saved_path(app)?, &json)?;
        saved_dir(app).await
    }

    pub async fn saved_dir(app: &AppHandle) -> Result<SavedDir> {
        let Ok(json) = std::fs::read_to_string(saved_path(app)?) else {
            return Ok(SavedDir::default());
        };
        let uri = FsUri::from_json_str(&json).map_err(fs_error)?;
        let persisted = app
            .android_fs_async()
            .picker()
            .check_persisted_uri_permission(&uri, UriPermission::Read)
            .await
            .map_err(fs_error)?;
        Ok(SavedDir { uri: Some(json), persisted })
    }

    const AUDIO_EXTENSIONS: [&str; 5] = ["mp3", "wav", "flac", "ogg", "m4a"];

    /// フォルダの中を（サブフォルダも）たどって、音声ファイルを集める
    pub async fn scan(app: &AppHandle, dir: &str) -> Result<ScanReport> {
        let started = Instant::now();
        let api = app.android_fs_async();
        let root = FsUri::from_json_str(dir).map_err(fs_error)?;
        let mut stack = vec![(root, String::new())];
        let mut files = Vec::new();
        let mut dirs = 0;
        while let Some((uri, prefix)) = stack.pop() {
            dirs += 1;
            for entry in api.read_dir(&uri).await.map_err(fs_error)? {
                match entry {
                    Entry::Dir { uri, name, .. } => stack.push((uri, format!("{prefix}{name}/"))),
                    Entry::File { uri, name, len, .. } => {
                        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
                        if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                            files.push(ScanEntry {
                                rel_path: format!("{prefix}{name}"),
                                uri: uri.to_json_string().map_err(fs_error)?,
                                size: len,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        Ok(ScanReport { files, dirs, elapsed_ms: started.elapsed().as_millis() })
    }

    /// SAF のファイルを開き、`/proc/self/fd/番号` のパスで、今の処理（ハッシュ値・長さ・曲名・ジャケット）に渡す
    pub async fn analyze(app: &AppHandle, uri: &str, rel_path: String) -> Result<AnalyzeReport> {
        let started = Instant::now();
        let uri = FsUri::from_json_str(uri).map_err(fs_error)?;
        let file = app.android_fs_async().open_file_readable(&uri).await.map_err(fs_error)?;
        let path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
        let report = tauri::async_runtime::spawn_blocking(move || {
            let analysis = crate::hashing::analyze(&path);
            let title = crate::metadata::track_title(&path);
            let cover = crate::metadata::track_cover(&path);
            // 読み終わるまで開いておく
            drop(file);
            AnalyzeReport {
                rel_path,
                hash: analysis.hash.map_err(|e| e.to_string()),
                duration: analysis.duration,
                title,
                cover_bytes: cover.map(|(data, _)| data.len()),
                elapsed_ms: started.elapsed().as_millis(),
            }
        })
        .await
        .map_err(fs_error)?;
        Ok(report)
    }
}
