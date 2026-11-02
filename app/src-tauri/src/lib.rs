mod audio_hash;
mod chains;
mod effect_cache;
mod credits;
mod db;
mod effects;
mod error;
mod export;
mod facets;
mod files;
mod hashing;
mod library;
mod playlists;
mod tags;
mod tree;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use credits::{Credit, CreditInput, CreditKind, LicenseType};
use chains::EffectChain;
use effects::Effect;
use error::Result;
use error::Error;
use facets::Facets;
use files::{AudioFile, FileFilter, FileSummary};
use hashing::RelinkResult;
use library::{LibraryFolder, ScanResult};
use playlists::{PlayEntry, PlayMode, PlaylistDetail, PlaylistNode};
use tags::{RenameResult, Tag};
use tree::MoveTarget;

struct AppState {
    conn: Mutex<Connection>,
    hashing: Arc<HashJob>,
    /// エフェクトをかけた音の置き場所
    effect_cache: PathBuf,
    export: Arc<ExportJob>,
}

/// 裏で行うプレイリストの出力の状態
#[derive(Default)]
struct ExportJob {
    running: AtomicBool,
    cancel: AtomicBool,
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

/// 裏で行うハッシュ値の計算の状態
#[derive(Default)]
struct HashJob {
    running: AtomicBool,
    cancel: AtomicBool,
    progress: Mutex<HashProgress>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct HashProgress {
    running: bool,
    done: usize,
    total: usize,
    /// 計算できなかった件数
    failed: usize,
    cancelled: bool,
}

/// 一度に計算して保存する件数。この単位で進み具合を通知し、中止を受け付ける
const HASH_BATCH: usize = 256;

impl AppState {
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // 前の処理がパニックしても、DBの状態はトランザクションで守られているので使い続ける
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 試聴のため、ライブラリフォルダの中のファイルを画面から読めるようにする
fn allow_asset_dir(app: &AppHandle, path: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(path, true) {
        log::warn!("asset scope: {e}");
    }
}

/// 計算待ちのファイルのハッシュ値を、別スレッドで計算する。
/// 進み具合はイベント "hash-progress" で画面に知らせる。
fn run_hashing(app: AppHandle, job: Arc<HashJob>) {
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
        let results: Vec<_> = hashing::compute_parallel(batch, &job.cancel)
            .into_iter()
            .filter_map(|(id, r)| r.map(|r| (id, r)))
            .collect();
        progress.failed += results.iter().filter(|(_, r)| r.is_err()).count();
        progress.done += results.len();
        if let Err(e) = hashing::save_hashes(&mut state.conn(), &results) {
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

// Tauriのコマンドは、async にすると画面のスレッドを止めずに別スレッドで動く

/// ハッシュ値の計算を始める。既に計算中なら何もしない。
#[tauri::command]
async fn start_hashing(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let job = state.hashing.clone();
    if job.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    job.cancel.store(false, Ordering::SeqCst);
    std::thread::spawn(move || run_hashing(app, job));
    Ok(())
}

#[tauri::command]
async fn cancel_hashing(state: State<'_, AppState>) -> Result<()> {
    state.hashing.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn hashing_progress(state: State<'_, AppState>) -> Result<HashProgress> {
    Ok(state.hashing.progress.lock().unwrap_or_else(|e| e.into_inner()).clone())
}

/// 任意のファイル（ライブラリ外でもよい）のハッシュ値を計算する
#[tauri::command]
async fn hash_file(path: String) -> Result<String> {
    audio_hash::audio_hash(Path::new(&path))
        .map_err(|e| Error::invalid(format!("ハッシュ値を計算できませんでした: {e}")))
}

#[tauri::command]
async fn relink_files(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<RelinkResult> {
    hashing::relink(&mut state.conn(), &file_ids)
}


#[tauri::command]
async fn list_folders(state: State<'_, AppState>) -> Result<Vec<LibraryFolder>> {
    library::list_folders(&state.conn())
}

#[tauri::command]
async fn add_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ScanResult> {
    let mut conn = state.conn();
    let id = library::add_folder(&conn, Path::new(&path))?;
    allow_asset_dir(&app, &library::folder_path(&conn, id)?);
    library::scan_folder(&mut conn, id)
}

#[tauri::command]
async fn remove_folder(state: State<'_, AppState>, folder_id: i64) -> Result<()> {
    library::remove_folder(&state.conn(), folder_id)
}

#[tauri::command]
async fn scan_folder(state: State<'_, AppState>, folder_id: i64) -> Result<ScanResult> {
    library::scan_folder(&mut state.conn(), folder_id)
}

#[tauri::command]
async fn list_files(state: State<'_, AppState>, filter: FileFilter) -> Result<Vec<AudioFile>> {
    files::list_files(&state.conn(), &filter)
}

/// 絞り込みの各項目を選んだときの件数
#[tauri::command]
async fn facet_counts(state: State<'_, AppState>, filter: FileFilter) -> Result<Facets> {
    facets::facet_counts(&state.conn(), &filter)
}

#[tauri::command]
async fn summarize_files(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<FileSummary> {
    files::summarize_files(&state.conn(), &file_ids)
}

#[tauri::command]
async fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>> {
    tags::list_tags(&state.conn())
}

#[tauri::command]
async fn create_tag(state: State<'_, AppState>, name: String) -> Result<i64> {
    tags::create_tag(&state.conn(), &name)
}

#[tauri::command]
async fn rename_tag(
    state: State<'_, AppState>,
    tag_id: i64,
    name: String,
    merge: bool,
) -> Result<RenameResult> {
    tags::rename_tag(&mut state.conn(), tag_id, &name, merge)
}

#[tauri::command]
async fn delete_tag(state: State<'_, AppState>, tag_id: i64) -> Result<()> {
    tags::delete_tag(&mut state.conn(), tag_id)
}

#[tauri::command]
async fn move_tag(state: State<'_, AppState>, tag_id: i64, target: MoveTarget) -> Result<()> {
    tags::move_tag(&mut state.conn(), tag_id, target)
}

#[tauri::command]
async fn delete_unused_tags(state: State<'_, AppState>) -> Result<usize> {
    tags::delete_unused_tags(&state.conn())
}

#[tauri::command]
async fn add_tag(state: State<'_, AppState>, file_ids: Vec<i64>, name: String) -> Result<i64> {
    files::add_tag(&mut state.conn(), &file_ids, &name)
}

#[tauri::command]
async fn remove_tag(state: State<'_, AppState>, file_ids: Vec<i64>, tag_id: i64) -> Result<()> {
    files::remove_tag(&mut state.conn(), &file_ids, tag_id)
}

#[tauri::command]
async fn remove_missing_files(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<usize> {
    files::remove_missing_files(&mut state.conn(), &file_ids)
}

#[tauri::command]
async fn license_types() -> Result<&'static [LicenseType]> {
    Ok(credits::LICENSE_TYPES)
}

#[tauri::command]
async fn list_credits(state: State<'_, AppState>, kind: CreditKind) -> Result<Vec<Credit>> {
    credits::list_credits(&state.conn(), kind)
}

#[tauri::command]
async fn create_credit(state: State<'_, AppState>, kind: CreditKind, input: CreditInput) -> Result<i64> {
    credits::create_credit(&state.conn(), kind, &input)
}

#[tauri::command]
async fn update_credit(state: State<'_, AppState>, kind: CreditKind, id: i64, input: CreditInput) -> Result<()> {
    credits::update_credit(&state.conn(), kind, id, &input)
}

#[tauri::command]
async fn delete_credit(state: State<'_, AppState>, kind: CreditKind, id: i64) -> Result<()> {
    credits::delete_credit(&state.conn(), kind, id)
}

/// 指定したファイルに出典・ライセンスを設定する。name が null なら外す
#[tauri::command]
async fn set_file_credit(
    state: State<'_, AppState>,
    kind: CreditKind,
    file_ids: Vec<i64>,
    name: Option<String>,
) -> Result<Option<i64>> {
    credits::set_file_credit(&mut state.conn(), kind, &file_ids, name.as_deref())
}

#[tauri::command]
async fn list_playlists(state: State<'_, AppState>) -> Result<Vec<PlaylistNode>> {
    playlists::list_playlists(&state.conn())
}

#[tauri::command]
async fn get_playlist(state: State<'_, AppState>, id: i64) -> Result<PlaylistDetail> {
    playlists::get_playlist(&state.conn(), id)
}

/// parent を指定すると、その子として作る
#[tauri::command]
async fn create_playlist(state: State<'_, AppState>, name: String, parent: Option<i64>) -> Result<i64> {
    playlists::create_playlist(&mut state.conn(), &name, parent)
}

#[tauri::command]
async fn rename_playlist(state: State<'_, AppState>, id: i64, name: String) -> Result<()> {
    playlists::rename_playlist(&state.conn(), id, &name)
}

#[tauri::command]
async fn delete_playlist(state: State<'_, AppState>, id: i64) -> Result<()> {
    playlists::delete_playlist(&mut state.conn(), id)
}

#[tauri::command]
async fn move_playlist(state: State<'_, AppState>, id: i64, target: MoveTarget) -> Result<()> {
    playlists::move_playlist(&mut state.conn(), id, target)
}

#[tauri::command]
async fn add_playlist_files(state: State<'_, AppState>, id: i64, file_ids: Vec<i64>) -> Result<()> {
    playlists::add_files(&mut state.conn(), id, &file_ids)
}

#[tauri::command]
async fn add_playlist_tags(state: State<'_, AppState>, id: i64, tag_ids: Vec<i64>) -> Result<i64> {
    playlists::add_tags(&mut state.conn(), id, &tag_ids)
}

#[tauri::command]
async fn add_playlist_ref(state: State<'_, AppState>, id: i64, ref_id: i64) -> Result<i64> {
    playlists::add_playlist_ref(&mut state.conn(), id, ref_id)
}

#[tauri::command]
async fn remove_playlist_item(state: State<'_, AppState>, item_id: i64) -> Result<()> {
    playlists::remove_item(&mut state.conn(), item_id)
}

#[tauri::command]
async fn move_playlist_item(state: State<'_, AppState>, item_id: i64, index: usize) -> Result<()> {
    playlists::move_item(&mut state.conn(), item_id, index)
}

/// 項目の別名を変える。空なら外す
#[tauri::command]
async fn set_playlist_item_alias(state: State<'_, AppState>, item_id: i64, alias: String) -> Result<()> {
    playlists::set_item_alias(&state.conn(), item_id, &alias)
}

#[tauri::command]
async fn set_playlist_item_mode(state: State<'_, AppState>, item_id: i64, mode: PlayMode) -> Result<()> {
    playlists::set_item_mode(&state.conn(), item_id, mode)
}

/// 再生順を決める
#[tauri::command]
async fn expand_playlist(state: State<'_, AppState>, id: i64, mode: PlayMode) -> Result<Vec<PlayEntry>> {
    playlists::expand_playlist(&state.conn(), id, mode)
}

#[tauri::command]
async fn expand_playlist_item(state: State<'_, AppState>, item_id: i64) -> Result<Vec<PlayEntry>> {
    playlists::expand_playlist_item(&state.conn(), item_id)
}

#[tauri::command]
async fn playlists_with_file(state: State<'_, AppState>, file_id: i64) -> Result<Vec<i64>> {
    playlists::playlists_with_file(&state.conn(), file_id)
}

#[tauri::command]
async fn list_effect_chains(state: State<'_, AppState>) -> Result<Vec<EffectChain>> {
    chains::list_chains(&state.conn())
}

#[tauri::command]
async fn create_effect_chain(state: State<'_, AppState>, name: String) -> Result<i64> {
    chains::create_chain(&state.conn(), &name)
}

#[tauri::command]
async fn rename_effect_chain(state: State<'_, AppState>, id: i64, name: String) -> Result<()> {
    chains::rename_chain(&state.conn(), id, &name)
}

#[tauri::command]
async fn delete_effect_chain(state: State<'_, AppState>, id: i64) -> Result<()> {
    chains::delete_chain(&state.conn(), id)
}

#[tauri::command]
async fn set_effect_chain_effects(state: State<'_, AppState>, id: i64, effects: Vec<Effect>) -> Result<()> {
    chains::set_chain_effects(&mut state.conn(), id, &effects)
}

/// プレイリストの項目にエフェクトのまとまりを結び付ける。null なら外す
#[tauri::command]
async fn set_playlist_item_chain(state: State<'_, AppState>, item_id: i64, chain_id: Option<i64>) -> Result<()> {
    chains::set_item_chain(&state.conn(), item_id, chain_id)
}

/// ファイルの絶対パス
fn file_path(conn: &Connection, file_id: i64) -> Result<PathBuf> {
    let (folder, rel): (String, String) = conn
        .query_row(
            "SELECT f.path, a.rel_path FROM audio_files a JOIN library_folders f ON f.id = a.folder_id WHERE a.id = ?1",
            [file_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| Error::invalid("ファイルが見つかりません"))?;
    Ok(library::absolute_path(&folder, &rel))
}

/// ファイルに、まとまり（chain_ids の順）をかけた音を用意して、そのパスを返す。
/// 処理に時間がかかることがあるので、データベースを使うのは最初だけにする
#[tauri::command]
async fn render_effects(state: State<'_, AppState>, file_id: i64, chain_ids: Vec<i64>) -> Result<String> {
    let (source, effects) = {
        let conn = state.conn();
        let mut effects = Vec::new();
        for c in &chain_ids {
            effects.extend(chains::chain_effects(&conn, *c)?);
        }
        (file_path(&conn, file_id)?, effects)
    };
    let out = effect_cache::render(&state.effect_cache, &source, &effects).map_err(Error::invalid)?;
    Ok(out.to_string_lossy().into_owned())
}

/// 保存する前のエフェクトの並びを、ファイルにかけて試聴するための音を用意する
#[tauri::command]
async fn preview_effects(state: State<'_, AppState>, file_id: i64, effects: Vec<Effect>) -> Result<String> {
    let source = file_path(&state.conn(), file_id)?;
    let out = effect_cache::render(&state.effect_cache, &source, &effects).map_err(Error::invalid)?;
    Ok(out.to_string_lossy().into_owned())
}

/// プレイリストを dest の中に書き出し始める。書き出し先のフォルダを作って、そのパスを返す。
/// ファイルの書き出しは裏で行い、進み具合はイベント "export-progress" で知らせる
#[tauri::command]
async fn start_export(app: AppHandle, state: State<'_, AppState>, id: i64, dest: String) -> Result<String> {
    let job = state.export.clone();
    if job.running.swap(true, Ordering::SeqCst) {
        return Err(Error::invalid("ほかのプレイリストを書き出しているところです"));
    }
    let prepared = export::prepare(&state.conn(), id, Path::new(dest.trim()));
    let (root, tasks) = match prepared {
        Ok(p) => p,
        Err(e) => {
            job.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    job.cancel.store(false, Ordering::SeqCst);
    let folder = root.to_string_lossy().into_owned();
    let result = folder.clone();
    std::thread::spawn(move || {
        let mut progress = ExportProgress { running: true, total: tasks.len(), folder, ..Default::default() };
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
    Ok(result)
}

#[tauri::command]
async fn cancel_export(state: State<'_, AppState>) -> Result<()> {
    state.export.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// データの置き場所。テストなどで分けたいときは環境変数 CYANOMELODY_DATA_DIR で変えられる。
fn data_dir(app: &AppHandle) -> std::result::Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(dir) = std::env::var_os("CYANOMELODY_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(app.path().app_data_dir()?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let dir = data_dir(app.handle())?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("cyanomelody.db"))?;
            for folder in library::list_folders(&conn)? {
                allow_asset_dir(app.handle(), Path::new(&folder.path));
            }
            let effect_cache = dir.join("effects-cache");
            std::fs::create_dir_all(&effect_cache)?;
            // エフェクトをかけた音を画面から鳴らせるようにする
            allow_asset_dir(app.handle(), &effect_cache);
            app.manage(AppState {
                conn: Mutex::new(conn),
                hashing: Arc::new(HashJob::default()),
                effect_cache,
                export: Arc::new(ExportJob::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_folders,
            add_folder,
            remove_folder,
            scan_folder,
            list_files,
            summarize_files,
            facet_counts,
            list_tags,
            create_tag,
            rename_tag,
            delete_tag,
            delete_unused_tags,
            move_tag,
            add_tag,
            remove_tag,
            remove_missing_files,
            start_hashing,
            cancel_hashing,
            hashing_progress,
            hash_file,
            relink_files,
            license_types,
            list_credits,
            create_credit,
            update_credit,
            delete_credit,
            set_file_credit,
            list_playlists,
            get_playlist,
            create_playlist,
            rename_playlist,
            delete_playlist,
            move_playlist,
            add_playlist_files,
            add_playlist_tags,
            add_playlist_ref,
            remove_playlist_item,
            move_playlist_item,
            set_playlist_item_mode,
            set_playlist_item_alias,
            list_effect_chains,
            create_effect_chain,
            rename_effect_chain,
            delete_effect_chain,
            set_effect_chain_effects,
            set_playlist_item_chain,
            render_effects,
            preview_effects,
            start_export,
            cancel_export,
            expand_playlist,
            expand_playlist_item,
            playlists_with_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
