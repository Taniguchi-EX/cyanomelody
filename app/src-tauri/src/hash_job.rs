//! 裏で行うハッシュ値と長さの計算（「ハッシュ値を使った機能」）

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::hashing;
use crate::state::AppState;

/// 裏で行うハッシュ値の計算の状態
#[derive(Default)]
pub struct HashJob {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub progress: Mutex<HashProgress>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashProgress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    /// 計算できなかった件数
    pub failed: usize,
    pub cancelled: bool,
}

/// 一度に計算して保存する件数。この単位で進み具合を通知し、中止を受け付ける
pub const HASH_BATCH: usize = 256;

/// 計算待ちのファイルのハッシュ値と長さを、別スレッドで計算する。
/// 進み具合はイベント "hash-progress" で画面に知らせる。
pub fn run_hashing(app: AppHandle, job: Arc<HashJob>) {
    let state = app.state::<AppState>();
    let pending = match hashing::pending_files(&state.conn()) {
        Ok(p) => p,
        Err(e) => {
            log::error!("hashing: {e}");
            Vec::new()
        }
    };
    let mut progress = HashProgress { running: true, total: pending.len(), ..Default::default() };
    let notify = |p: &HashProgress| {
        *job.progress.lock().unwrap_or_else(|e| e.into_inner()) = p.clone();
        let _ = app.emit("hash-progress", p);
    };
    notify(&progress);
    for batch in pending.chunks(HASH_BATCH) {
        let results: Vec<_> = hashing::compute_parallel(batch, &job.cancel, hashing::analyze)
            .into_iter()
            .filter_map(|(id, r)| r.map(|r| (id, r)))
            .collect();
        progress.failed += results.iter().filter(|(_, r)| r.hash.is_err()).count();
        progress.done += results.len();
        if let Err(e) = hashing::save_analyses(&mut state.conn(), &results) {
            log::error!("hashing: {e}");
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
