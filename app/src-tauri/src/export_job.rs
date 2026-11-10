//! 書き出し（プレイリストの書出・選んだファイルの書出）を裏で行う仕組み。進み具合はイベント "export-progress" で知らせる

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::export;

/// 裏で行う書き出しの状態（プレイリストの書出と、選んだファイルの書出で共通。同時に1つだけ）
#[derive(Default)]
pub(crate) struct ExportJob {
    running: AtomicBool,
    pub(crate) cancel: AtomicBool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    running: bool,
    done: usize,
    total: usize,
    /// 書き出せなかった件数
    failed: usize,
    cancelled: bool,
    /// 書き出し先（作ったフォルダ）
    folder: String,
}

/// 書き出しを始める（プレイリストの書出と、選んだファイルの書出で共通）。同時に1つだけ。
/// prepare で書き出し先と書き出す一覧（と、最初から書き出せないと分かっている数）を決め、失敗したら始めない
pub(crate) fn start_export_job(
    app: AppHandle,
    job: Arc<ExportJob>,
    prepare: impl FnOnce() -> Result<(PathBuf, Vec<export::Task>, usize)>,
) -> Result<String> {
    if job.running.swap(true, Ordering::SeqCst) {
        return Err(Error::invalid("ほかの書き出しをしているところです"));
    }
    match prepare() {
        Ok((root, tasks, skipped)) => Ok(spawn_export(app, job, root, tasks, skipped)),
        Err(e) => {
            job.running.store(false, Ordering::SeqCst);
            Err(e)
        }
    }
}

/// 書き出しを裏で行う。skipped は最初から書き出せないと分かっている数。書き出し先のフォルダのパスを返す
fn spawn_export(app: AppHandle, job: Arc<ExportJob>, root: PathBuf, tasks: Vec<export::Task>, skipped: usize) -> String {
    job.cancel.store(false, Ordering::SeqCst);
    let folder = root.to_string_lossy().into_owned();
    let result = folder.clone();
    std::thread::spawn(move || {
        let mut progress = ExportProgress {
            running: true,
            total: tasks.len() + skipped,
            done: skipped,
            failed: skipped,
            folder,
            ..Default::default()
        };
        let _ = app.emit("export-progress", &progress);
        for task in &tasks {
            if job.cancel.load(Ordering::Relaxed) {
                progress.cancelled = true;
                break;
            }
            if let Err(e) = export::run_task(task) {
                log::warn!("export: {}: {e}", task.source.display());
                progress.failed += 1;
            }
            progress.done += 1;
            let _ = app.emit("export-progress", &progress);
        }
        progress.running = false;
        job.running.store(false, Ordering::SeqCst);
        let _ = app.emit("export-progress", &progress);
    });
    result
}

