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
    /// 書き出し先（作ったフォルダ。スマホへのコピーでは、端末の名前と写し先）
    folder: String,
    /// スマホへのコピーか（書き出し先をエクスプローラーで見せられない）
    phone: bool,
    /// 途中で続けられなくなったときのエラー（スマホが外れたなど）
    error: Option<String>,
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
    let folder = root.to_string_lossy().into_owned();
    let total = tasks.len() + skipped;
    spawn_steps(app, job, folder.clone(), false, total, skipped, move |step| {
        for task in &tasks {
            let result = export::run_task(task);
            if let Err(e) = &result {
                log::warn!("export: {}: {e}", task.source.display());
            }
            if !step(result.is_ok()) {
                break;
            }
        }
        Ok(())
    });
    folder
}

/// 1件ずつ進める仕事（work）を裏で行い、進み具合を "export-progress" で知らせる。job.running は呼び出し側で立てておく。
/// work は1件終えるたびに step(成功したか) を呼び、false が返ったら（中止されたら）やめる。続けられなくなったら Err を返す。
/// skipped は最初から失敗と分かっている数（done・failed に入れておく）
pub(crate) fn spawn_steps(
    app: AppHandle,
    job: Arc<ExportJob>,
    folder: String,
    phone: bool,
    total: usize,
    skipped: usize,
    work: impl FnOnce(&mut dyn FnMut(bool) -> bool) -> std::result::Result<(), String> + Send + 'static,
) {
    job.cancel.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let mut progress =
            ExportProgress { running: true, total, done: skipped, failed: skipped, folder, phone, ..Default::default() };
        let _ = app.emit("export-progress", &progress);
        let result = work(&mut |ok| {
            progress.done += 1;
            if !ok {
                progress.failed += 1;
            }
            let _ = app.emit("export-progress", &progress);
            if job.cancel.load(Ordering::Relaxed) {
                progress.cancelled = true;
                return false;
            }
            true
        });
        progress.error = result.err();
        progress.running = false;
        job.running.store(false, Ordering::SeqCst);
        let _ = app.emit("export-progress", &progress);
    });
}

#[cfg_attr(not(windows), allow(dead_code))]
/// 同時に1つだけの決まりで、書き出しの仕事を始める（始められないときはエラー）。始めたら、終わるまで job.running が立つ
pub(crate) fn claim(job: &ExportJob) -> Result<()> {
    if job.running.swap(true, Ordering::SeqCst) {
        return Err(Error::invalid("ほかの書き出しをしているところです"));
    }
    Ok(())
}

#[cfg_attr(not(windows), allow(dead_code))]
/// claim の後、仕事を始められなかったときに戻す
pub(crate) fn release(job: &ExportJob) {
    job.running.store(false, Ordering::SeqCst);
}

