//! 曲の一覧（ライブラリ）の手動更新と、フォルダをたどる画面。

use cyanomelody_core::library::RefreshReport;
use cyanomelody_core::source::SourceKind;
use serde::Serialize;
use tauri::Emitter;

use super::{blocking, core};
use crate::ui::{UiListing, UiResult};

/// `library-progress` イベントで知らせる、タグを読む進み具合。
#[derive(Clone, Serialize)]
struct LibraryProgress {
    source: &'static str,
    done: usize,
    total: usize,
}

#[derive(Serialize)]
pub struct UiReport {
    source: &'static str,
    added: usize,
    updated: usize,
    unchanged: usize,
    missing: usize,
}

impl UiReport {
    fn new(kind: SourceKind, r: RefreshReport) -> Self {
        Self {
            source: kind.as_str(),
            added: r.added,
            updated: r.updated,
            unchanged: r.unchanged,
            missing: r.missing,
        }
    }
}

/// 指定フォルダの曲を読み直す（手動更新）。進み具合は `library-progress` イベントで知らせる。
#[tauri::command]
pub async fn refresh_library(app: tauri::AppHandle) -> UiResult<Vec<UiReport>> {
    let emitter = app.clone();
    blocking(app, move |c| {
        let reports = c.refresh_library(&|kind, done, total| {
            let _ = emitter.emit("library-progress", LibraryProgress { source: kind.as_str(), done, total });
        })?;
        Ok(reports.into_iter().map(|(kind, r)| UiReport::new(kind, r)).collect())
    })
    .await
}

#[tauri::command]
pub fn browse(app: tauri::AppHandle, source: String, folder: String) -> UiResult<UiListing> {
    core(&app)?.browse(&source, &folder)
}
