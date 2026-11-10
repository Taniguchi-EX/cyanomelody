//! 裏で行う、たくさんのファイルの自動タグ付け（ファイルの中の情報からタグを付ける）

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::Result;
use crate::state::AppState;
use crate::{autotag, hashing, metadata};

/// 裏で行う自動タグ付け（ファイルの中の情報からタグを付ける）の状態
#[derive(Default)]
pub struct AutotagJob {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub progress: Mutex<AutotagProgress>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutotagProgress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    /// タグを新しく付けたファイルの数
    pub tagged: usize,
    /// 新しく作ったタグの数
    pub created: usize,
    /// 使える情報がなかったファイルの数
    pub no_info: usize,
    /// 読めなかったファイル（見つからないファイルを含む）の数
    pub failed: usize,
    pub cancelled: bool,
}

/// 自動タグ付けで一度に読んで保存する件数。この単位で進み具合を通知し、中止を受け付ける
pub const AUTOTAG_BATCH: usize = 32;

/// 対象のファイルに、ファイルの中の情報からタグを付ける（別スレッド）。進み具合はイベント "autotag-progress" で知らせる
pub fn run_autotag(app: AppHandle, job: Arc<AutotagJob>, file_ids: Vec<i64>, ignore: Vec<String>, separators: Vec<String>) {
    let state = app.state::<AppState>();
    let mut progress = AutotagProgress { running: true, total: file_ids.len(), ..Default::default() };
    let notify = |p: &AutotagProgress| {
        *job.progress.lock().unwrap_or_else(|e| e.into_inner()) = p.clone();
        let _ = app.emit("autotag-progress", p);
    };
    notify(&progress);
    for batch in file_ids.chunks(AUTOTAG_BATCH) {
        // パスを引く（見つからないファイルは読めない）
        let mut files = Vec::new();
        {
            let conn = state.conn();
            for &id in batch {
                match autotag::file_path(&conn, id) {
                    Ok(Some(path)) => files.push(hashing::PendingFile { id, path }),
                    _ => progress.failed += 1,
                }
            }
        }
        // ファイルを読むのはデータベースを使わずに並列で行い、付けるのは1つのまとまりで行う
        let metas = hashing::compute_parallel(&files, &job.cancel, metadata::file_meta);
        let mut conn = state.conn();
        let result = (|| -> Result<()> {
            let tx = conn.transaction()?;
            for (id, meta) in &metas {
                let Some(meta) = meta else { continue };
                progress.done += 1;
                let Some(meta) = meta else {
                    progress.failed += 1;
                    continue;
                };
                let applied = autotag::apply(&tx, *id, meta, &ignore, &separators)?;
                progress.created += applied.created;
                if !applied.added.is_empty() {
                    progress.tagged += 1;
                } else if !applied.has_info {
                    progress.no_info += 1;
                }
            }
            tx.commit()?;
            Ok(())
        })();
        drop(conn);
        progress.done += batch.len() - files.len();
        if let Err(e) = result {
            log::error!("autotag: {e}");
        }
        if job.cancel.load(Ordering::Relaxed) {
            progress.cancelled = true;
            break;
        }
        notify(&progress);
    }
    progress.running = false;
    job.running.store(false, Ordering::SeqCst);
    notify(&progress);
}
