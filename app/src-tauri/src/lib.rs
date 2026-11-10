mod audio_hash;
mod autotag;
mod chains;
mod effect_cache;
mod credits;
mod db;
mod deleting;
mod effects;
mod error;
mod export;
mod export_job;
mod facets;
mod files;
mod fonts;
mod hashing;
mod library;
mod linking;
mod metadata;
mod names;
mod playlists;
mod recent;
mod romaji;
mod settings;
mod tags;
mod transfer;
mod tree;
mod update;

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
use export_job::{start_export_job, ExportJob};
use facets::Facets;
use files::{AudioFile, FileFilter};
use hashing::RelinkResult;
use library::{LibraryFolder, ScanResult};
use playlists::{PlayEntry, PlayMode, PlaylistDetail, PlaylistNode};
use tags::{RenameResult, Tag, TagSettings};
use tree::MoveTarget;

struct AppState {
    conn: Mutex<Connection>,
    hashing: Arc<HashJob>,
    /// エフェクトをかけた音の置き場所
    effect_cache: PathBuf,
    /// ファイルの中のジャケットを書き出しておく場所（グリッドのタイルに出す）
    cover_cache: PathBuf,
    export: Arc<ExportJob>,
    autotag: Arc<AutotagJob>,
    /// 選んでいるプレイリストと、抽選したときの中身の版（抽選した並びは DB の一時テーブルにある）
    draw: Mutex<Option<DrawState>>,
}

#[derive(Debug, Clone)]
struct DrawState {
    playlist_id: i64,
    version: String,
}

/// データを読み直したときの、抽選した並びの扱い
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DrawRefresh {
    /// プレイリストを選んでいない、または中身が変わっていない
    Unchanged,
    /// 中身が変わったので抽選し直した
    Redrawn,
    /// プレイリストが消えたので、選択を外した
    Cleared,
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

/// 裏で行う自動タグ付け（ファイルの中の情報からタグを付ける）の状態
#[derive(Default)]
struct AutotagJob {
    running: AtomicBool,
    cancel: AtomicBool,
    progress: Mutex<AutotagProgress>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutotagProgress {
    running: bool,
    done: usize,
    total: usize,
    /// タグを新しく付けたファイルの数
    tagged: usize,
    /// 新しく作ったタグの数
    created: usize,
    /// 使える情報がなかったファイルの数
    no_info: usize,
    /// 読めなかったファイル（見つからないファイルを含む）の数
    failed: usize,
    cancelled: bool,
}

/// 自動タグ付けで一度に読んで保存する件数。この単位で進み具合を通知し、中止を受け付ける
const AUTOTAG_BATCH: usize = 32;

impl AppState {
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // 前の処理がパニックしても、DBの状態はトランザクションで守られているので使い続ける
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 選んでいるプレイリスト（DB の後にロックする）
    fn draw(&self) -> std::sync::MutexGuard<'_, Option<DrawState>> {
        self.draw.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 試聴のため、ライブラリフォルダの中のファイルを画面から読めるようにする
fn allow_asset_dir(app: &AppHandle, path: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(path, true) {
        log::warn!("asset scope: {e}");
    }
}

/// 計算待ちのファイルのハッシュ値と長さを、別スレッドで計算する。
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

/// 対象のファイルに、ファイルの中の情報からタグを付ける（別スレッド）。進み具合はイベント "autotag-progress" で知らせる
fn run_autotag(app: AppHandle, job: Arc<AutotagJob>, file_ids: Vec<i64>, ignore: Vec<String>, separators: Vec<String>) {
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

/// ファイルを削除する（ごみ箱に移す。permanent なら完全に消す）。削除できたファイルはライブラリから外す。
/// 画面テストでは、環境変数 CYANOMELODY_TRASH_DIR のフォルダをごみ箱の代わりにする
#[tauri::command]
async fn delete_files(state: State<'_, AppState>, file_ids: Vec<i64>, permanent: bool) -> Result<deleting::DeleteResult> {
    let trash_dir = std::env::var_os("CYANOMELODY_TRASH_DIR").map(PathBuf::from);
    deleting::delete_files(&mut state.conn(), &file_ids, permanent, trash_dir.as_deref())
}

/// 自動タグ付けで無視する値の一覧
#[tauri::command]
async fn meta_ignore_values(state: State<'_, AppState>) -> Result<Vec<String>> {
    autotag::ignore_values(&state.conn())
}

#[tauri::command]
async fn set_meta_ignore_values(state: State<'_, AppState>, values: Vec<String>) -> Result<()> {
    autotag::set_ignore_values(&state.conn(), &values)
}

/// 自動タグ付けの区切り文字の一覧
#[tauri::command]
async fn meta_separators(state: State<'_, AppState>) -> Result<Vec<String>> {
    autotag::separators(&state.conn())
}

#[tauri::command]
async fn set_meta_separators(state: State<'_, AppState>, values: Vec<String>) -> Result<()> {
    autotag::set_separators(&state.conn(), &values)
}

/// ファイル1件の自動タグ付けの結果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutotagFileResult {
    /// ファイルを読めたか
    readable: bool,
    #[serde(flatten)]
    applied: autotag::Applied,
}

/// ファイル1件に、ファイルの中の情報からタグを付ける。ignore なら、無視する値の一覧の値は使わない。
/// split なら、アーティスト・作曲者を区切り文字の一覧で分ける
#[tauri::command]
async fn autotag_file(state: State<'_, AppState>, file_id: i64, ignore: bool, split: bool) -> Result<AutotagFileResult> {
    let (path, ignore_list, separators) = {
        let conn = state.conn();
        let path = autotag::file_path(&conn, file_id)?.ok_or_else(|| Error::invalid("見つからないファイルは読めません"))?;
        (
            path,
            if ignore { autotag::ignore_values(&conn)? } else { vec![] },
            if split { autotag::separators(&conn)? } else { vec![] },
        )
    };
    let Some(meta) = metadata::file_meta(&path) else {
        return Ok(AutotagFileResult { readable: false, applied: Default::default() });
    };
    let mut conn = state.conn();
    let tx = conn.transaction()?;
    let applied = autotag::apply(&tx, file_id, &meta, &ignore_list, &separators)?;
    tx.commit()?;
    Ok(AutotagFileResult { readable: true, applied })
}

/// たくさんのファイルの自動タグ付けを、裏で始める。既に行っている間は始めない
#[tauri::command]
async fn start_autotag(app: AppHandle, state: State<'_, AppState>, file_ids: Vec<i64>, ignore: bool, split: bool) -> Result<()> {
    let job = state.autotag.clone();
    if job.running.swap(true, Ordering::SeqCst) {
        return Err(Error::invalid("ファイルの情報からタグを付けている途中です"));
    }
    job.cancel.store(false, Ordering::SeqCst);
    let ignore_list = if ignore { autotag::ignore_values(&state.conn())? } else { vec![] };
    let separators = if split { autotag::separators(&state.conn())? } else { vec![] };
    std::thread::spawn(move || run_autotag(app, job, file_ids, ignore_list, separators));
    Ok(())
}

#[tauri::command]
async fn cancel_autotag(state: State<'_, AppState>) -> Result<()> {
    state.autotag.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// 新しい版があれば、その版。開発用のビルドや、探せなかったときは None
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>> {
    Ok(update::check(&app).await)
}

/// 新しい版をダウンロードしてインストールし、アプリを再起動する
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<()> {
    update::install(&app).await
}

/// 音声ファイルのトラック名（タグ情報のタイトル）。ないときは None
#[tauri::command]
async fn track_title(path: String) -> Result<Option<String>> {
    Ok(metadata::track_title(Path::new(&path)))
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

/// ひも付けた結果。ライブラリに登録したフォルダがあれば、そのパス
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkOutcome {
    path: String,
    added_folder: Option<String>,
}

/// 見つからないファイルを path のファイルにひも付ける。path がライブラリの外なら add_root を登録する
fn link_missing(app: &AppHandle, conn: &mut Connection, missing: i64, path: &Path, add_root: &Path) -> Result<LinkOutcome> {
    let (target, added) = linking::ensure_in_library(conn, path, add_root)?;
    let added_folder = match added {
        Some(id) => {
            let folder = library::folder_path(conn, id)?;
            allow_asset_dir(app, &folder);
            Some(folder.to_string_lossy().into_owned())
        }
        None => None,
    };
    // 元の場所に戻っていたときは、スキャンで見つかったので、ひも付け直すものはない
    if target != missing {
        hashing::relink_to(conn, missing, target)?;
    }
    Ok(LinkOutcome { path: path.to_string_lossy().into_owned(), added_folder })
}

/// 見つからないファイルを、ユーザーが選んだファイルにひも付ける（ライブラリの外なら、そのファイルのフォルダを登録する）
#[tauri::command]
async fn link_missing_file(app: AppHandle, state: State<'_, AppState>, file_id: i64, path: String) -> Result<LinkOutcome> {
    let path = PathBuf::from(path);
    let parent = path.parent().ok_or_else(|| Error::invalid("フォルダが分かりません"))?.to_path_buf();
    link_missing(&app, &mut state.conn(), file_id, &path, &parent)
}

/// 見つからないファイルと同じ音声のファイルを folder の中から探し、見つかればひも付ける（ライブラリの外なら folder を登録する）。
/// 見つからなければ None
#[tauri::command]
async fn find_missing_in_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    file_id: i64,
    folder: String,
) -> Result<Option<LinkOutcome>> {
    let mut conn = state.conn();
    let folder = PathBuf::from(folder);
    match linking::find_in_folder(&conn, file_id, &folder)? {
        Some(found) => link_missing(&app, &mut conn, file_id, &found, &folder).map(Some),
        None => Ok(None),
    }
}

/// まとめて探した結果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FindManyOutcome {
    linked: usize,
    not_found: usize,
    no_hash: usize,
    /// ライブラリに登録したフォルダ（ライブラリの外のフォルダから見つかったとき）
    added_folder: Option<String>,
}

/// 見つからないファイル（file_ids）それぞれと同じ音声のファイルを folder の中からまとめて探し、見つかったものをひも付ける
#[tauri::command]
async fn find_missing_in_folder_many(
    app: AppHandle,
    state: State<'_, AppState>,
    file_ids: Vec<i64>,
    folder: String,
) -> Result<FindManyOutcome> {
    let mut conn = state.conn();
    let folder = PathBuf::from(folder);
    let found = linking::find_many_in_folder(&conn, &file_ids, &folder)?;
    let mut outcome = FindManyOutcome { linked: 0, not_found: found.not_found, no_hash: found.no_hash, added_folder: None };
    for (id, path) in found.found {
        let r = link_missing(&app, &mut conn, id, &path, &folder)?;
        outcome.added_folder = outcome.added_folder.or(r.added_folder);
        outcome.linked += 1;
    }
    Ok(outcome)
}

/// ファイルを再生したことを記録する（「直近で再生したもの」）
#[tauri::command]
async fn record_play(state: State<'_, AppState>, file_id: i64) -> Result<()> {
    recent::record_play(&state.conn(), file_id)
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

/// タグのシノニムを置き換える。name はこれから付けるタグの名前（同じものは入れない）
#[tauri::command]
async fn set_tag_synonyms(state: State<'_, AppState>, tag_id: i64, synonyms: Vec<String>, name: String) -> Result<()> {
    tags::set_tag_synonyms(&mut state.conn(), tag_id, &synonyms, &name)
}

#[tauri::command]
async fn set_tag_settings(state: State<'_, AppState>, tag_id: i64, settings: TagSettings) -> Result<()> {
    tags::set_tag_settings(&state.conn(), tag_id, &settings)
}

/// エクスポートで書き出した件数
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportSummary {
    folders: usize,
    files: usize,
    tags: usize,
    playlists: usize,
    effect_chains: usize,
    sources: usize,
    licenses: usize,
}

/// データのエクスポート：選んだ項目を path に JSON で書き出す。screen は画面の設定
/// データ（エクスポートの JSON）を path に書く
fn write_json(path: &str, data: &transfer::DataFile) -> Result<()> {
    let json = serde_json::to_string_pretty(data).map_err(|e| Error::invalid(e.to_string()))?;
    std::fs::write(path, json)?;
    Ok(())
}

/// 選んだファイル（一括操作の対象）のメタデータを、データのエクスポートと同じ形で path に書き出す。書き出した曲の数を返す
#[tauri::command]
async fn export_metadata(app: AppHandle, state: State<'_, AppState>, path: String, file_ids: Vec<i64>) -> Result<usize> {
    let data = transfer::export_metadata(&state.conn(), &file_ids, &app.package_info().version.to_string())?;
    write_json(&path, &data)?;
    Ok(data.files.len())
}

#[tauri::command]
async fn export_data(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    sections: transfer::Sections,
    screen: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<ExportSummary> {
    let data = transfer::export(&state.conn(), sections, &app.package_info().version.to_string(), screen)?;
    write_json(&path, &data)?;
    Ok(ExportSummary {
        folders: data.folders.len(),
        files: data.files.len(),
        tags: data.tags.len(),
        playlists: data.playlists.len(),
        effect_chains: data.effect_chains.len(),
        sources: data.sources.len(),
        licenses: data.licenses.len(),
    })
}

fn read_data_file(path: &str) -> Result<transfer::DataFile> {
    transfer::parse(&std::fs::read_to_string(path)?)
}

/// インポートの見込み（中身の件数、見つかる曲の数、置き換えで消える件数）
#[tauri::command]
async fn inspect_import(state: State<'_, AppState>, path: String) -> Result<transfer::ImportPreview> {
    let data = read_data_file(&path)?;
    transfer::preview(&state.conn(), &data)
}

/// データのインポート：ファイルに入っている項目のうち、選んだものを取り込む。replace なら、選んだ項目の今のデータを置き換える
#[tauri::command]
async fn import_data(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    sections: transfer::Sections,
    replace: bool,
) -> Result<transfer::ImportResult> {
    let data = read_data_file(&path)?;
    let has = data.sections;
    let sections = transfer::Sections {
        library: sections.library && has.library,
        tags: sections.tags && has.tags,
        playlists: sections.playlists && has.playlists,
        credits: sections.credits && has.credits,
    };
    let mut result = transfer::ImportResult::default();
    let mut conn = state.conn();
    // フォルダを登録してスキャンしてから、曲を見分ける
    if sections.library {
        transfer::import_folders(&conn, &data, replace, &mut result)?;
        for &id in &result.folders_added {
            allow_asset_dir(&app, &library::folder_path(&conn, id)?);
            library::scan_folder(&mut conn, id)?;
        }
    }
    transfer::import_data(&mut conn, &data, sections, replace, &mut result)?;
    Ok(result)
}

/// 新しく作るタグの既定値（設定画面の「一般」）
#[tauri::command]
async fn new_tag_settings(state: State<'_, AppState>) -> Result<TagSettings> {
    tags::new_tag_settings(&state.conn())
}

#[tauri::command]
async fn set_new_tag_settings(state: State<'_, AppState>, settings: TagSettings) -> Result<()> {
    tags::set_new_tag_settings(&state.conn(), &settings)
}

#[tauri::command]
async fn delete_tag(state: State<'_, AppState>, tag_id: i64) -> Result<()> {
    tags::delete_tag(&mut state.conn(), tag_id)
}

#[tauri::command]
async fn move_tag(state: State<'_, AppState>, tag_id: i64, target: MoveTarget) -> Result<()> {
    tags::move_tag(&mut state.conn(), tag_id, target)
}

/// チェックしたファイルのタグの内訳（タグと、付いているファイルの数）
#[tauri::command]
async fn existing_file_ids(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<Vec<i64>> {
    files::existing_file_ids(&state.conn(), &file_ids)
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
async fn move_credit(state: State<'_, AppState>, kind: CreditKind, id: i64, target: MoveTarget) -> Result<()> {
    credits::move_credit(&mut state.conn(), kind, id, target)
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

#[tauri::command]
async fn expand_playlist_item(state: State<'_, AppState>, item_id: i64) -> Result<Vec<PlayEntry>> {
    playlists::expand_playlist_item(&state.conn(), item_id)
}

#[tauri::command]
async fn playlists_with_file(state: State<'_, AppState>, file_id: i64) -> Result<Vec<i64>> {
    playlists::playlists_with_file(&state.conn(), file_id)
}

/// 項目に入る曲をすべて（右の欄の曲のリスト）
#[tauri::command]
async fn playlist_item_files(state: State<'_, AppState>, item_id: i64) -> Result<Vec<PlayEntry>> {
    playlists::item_files(&state.conn(), item_id)
}

/// プレイリストから、ファイルの項目をまとめて外す（一括操作の欄）
#[tauri::command]
async fn remove_files_from_playlist(state: State<'_, AppState>, id: i64, file_ids: Vec<i64>) -> Result<usize> {
    playlists::remove_files_from_playlist(&state.conn(), id, &file_ids)
}

/// 一括操作の欄に出す、チェックしたファイルの内訳
#[tauri::command]
async fn bulk_summary(state: State<'_, AppState>, file_ids: Vec<i64>) -> Result<files::BulkSummary> {
    files::bulk_summary(&state.conn(), &file_ids)
}

#[tauri::command]
async fn remove_file_from_playlist(state: State<'_, AppState>, id: i64, file_id: i64) -> Result<usize> {
    playlists::remove_file_from_playlist(&state.conn(), id, file_id)
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

/// プレイリストの項目にエフェクトセットを結び付ける。null なら外す
#[tauri::command]
async fn set_playlist_item_chain(state: State<'_, AppState>, item_id: i64, chain_id: Option<i64>) -> Result<()> {
    chains::set_item_chain(&state.conn(), item_id, chain_id)
}

/// ファイルの絶対パス
/// OS にインストールされているフォントのファミリの一覧（設定画面の「表示」）
#[tauri::command]
async fn list_fonts() -> Result<Vec<fonts::FontFamily>> {
    Ok(fonts::installed_fonts())
}

/// ファイルの中のジャケットの画像のパス（書き出しておいたもの）。ジャケットがなければ None。
/// ファイルの大きさ・更新日時が同じなら、前に書き出したものを使う（ないことも覚えておき、読み直さない）
#[tauri::command]
async fn track_cover(state: State<'_, AppState>, file_id: i64) -> Result<Option<String>> {
    let (path, size, modified): (PathBuf, i64, i64) = {
        let conn = state.conn();
        let (size, modified) = conn
            .query_row("SELECT size, modified_at FROM audio_files WHERE id = ?1", [file_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| Error::invalid("ファイルが見つかりません"))?;
        (file_path(&conn, file_id)?, size, modified)
    };
    let base = format!("{file_id}-{size}-{modified}");
    // 前に調べた結果（画像か、ないことの印）
    for ext in ["jpg", "png", "gif", "webp", "bmp"] {
        let p = state.cover_cache.join(format!("{base}.{ext}"));
        if p.exists() {
            return Ok(Some(p.to_string_lossy().into_owned()));
        }
    }
    let none_mark = state.cover_cache.join(format!("{base}.none"));
    if none_mark.exists() {
        return Ok(None);
    }
    match metadata::track_cover(&path) {
        Some((data, ext)) => {
            let out = state.cover_cache.join(format!("{base}.{ext}"));
            std::fs::write(&out, data)?;
            Ok(Some(out.to_string_lossy().into_owned()))
        }
        None => {
            // 見つからないファイル（読めない）では印を残さない（戻ってきたら読み直す）
            if path.exists() {
                std::fs::write(&none_mark, [])?;
            }
            Ok(None)
        }
    }
}

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

/// ファイルに、エフェクトセット（chain_ids の順）をかけた音を用意して、そのパスを返す。
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
/// プレイリストを選び、抽選する（選んでいたものは外れる）
#[tauri::command]
async fn select_playlist(state: State<'_, AppState>, id: i64) -> Result<()> {
    let conn = state.conn();
    let version = playlists::draw::draw(&conn, id)?;
    *state.draw() = Some(DrawState { playlist_id: id, version });
    Ok(())
}

/// プレイリストの選択を外す
#[tauri::command]
async fn clear_playlist_selection(state: State<'_, AppState>) -> Result<()> {
    let conn = state.conn();
    playlists::draw::clear(&conn)?;
    *state.draw() = None;
    Ok(())
}

/// 選んでいるプレイリストを抽選し直す（最後まで再生した後に、もう一度再生するとき）
#[tauri::command]
async fn redraw_playlist(state: State<'_, AppState>) -> Result<()> {
    let conn = state.conn();
    let mut draw = state.draw();
    if let Some(d) = draw.as_mut() {
        d.version = playlists::draw::draw(&conn, d.playlist_id)?;
    }
    Ok(())
}

/// データを読み直すときに呼ぶ。選んでいるプレイリストの中身の版が変わっていれば抽選し直し、消えていれば選択を外す
#[tauri::command]
async fn refresh_draw(state: State<'_, AppState>) -> Result<DrawRefresh> {
    let conn = state.conn();
    let mut draw = state.draw();
    let Some(d) = draw.as_mut() else { return Ok(DrawRefresh::Unchanged) };
    match playlists::draw::version(&conn, d.playlist_id)? {
        None => {
            playlists::draw::clear(&conn)?;
            *draw = None;
            Ok(DrawRefresh::Cleared)
        }
        Some(v) if v == d.version => Ok(DrawRefresh::Unchanged),
        Some(_) => {
            d.version = playlists::draw::draw(&conn, d.playlist_id)?;
            Ok(DrawRefresh::Redrawn)
        }
    }
}

/// プレイリストを書き出し始める。items は書き出す項目（プレイリストの直下。空ならすべて）。🎲・🔀の項目は抽選し直す
#[tauri::command]
async fn start_export(app: AppHandle, state: State<'_, AppState>, id: i64, items: Vec<i64>, dest: String) -> Result<String> {
    let prepared = || export::prepare(&state.conn(), id, &items, Path::new(dest.trim())).map(|(root, tasks)| (root, tasks, 0));
    start_export_job(app, state.export.clone(), prepared)
}

/// プレイリストを抽選し直し、items の項目（直下。空ならすべて）から来るファイル（重なりを除き、出てくる順）を返す。
/// プレイリストのメタデータの書き出しの対象に使う（中央の一覧の抽選した並びは変えない）
#[tauri::command]
fn draw_item_files(state: State<'_, AppState>, id: i64, items: Vec<i64>) -> Result<Vec<i64>> {
    let mut seen = std::collections::HashSet::new();
    Ok(playlists::draw::draw_items(&state.conn(), id, &items)?
        .into_iter()
        .map(|t| t.file_id)
        .filter(|f| seen.insert(*f))
        .collect())
}

/// 選んだファイル（一括操作の対象）を、dest の中に作るフォルダ（folder_name）へ、そのままコピーし始める。
/// 進み具合はプレイリストの書出と同じく "export-progress" で知らせる。見つからないファイルは「書き出せなかった」に数える
#[tauri::command]
async fn start_export_files(
    app: AppHandle,
    state: State<'_, AppState>,
    file_ids: Vec<i64>,
    dest: String,
    folder_name: String,
) -> Result<String> {
    let prepared = || {
        export::prepare_files(&state.conn(), &file_ids, Path::new(dest.trim()), &folder_name).map(|(root, tasks)| {
            // 見つからないファイルは書き出す一覧に入らないので、書き出せなかった数として数える
            let skipped = file_ids.len().saturating_sub(tasks.len());
            (root, tasks, skipped)
        })
    };
    start_export_job(app, state.export.clone(), prepared)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            let cover_cache = dir.join("covers");
            std::fs::create_dir_all(&cover_cache)?;
            // ジャケットの画像を画面から出せるようにする
            allow_asset_dir(app.handle(), &cover_cache);
            app.manage(AppState {
                conn: Mutex::new(conn),
                hashing: Arc::new(HashJob::default()),
                effect_cache,
                cover_cache,
                export: Arc::new(ExportJob::default()),
                autotag: Arc::new(AutotagJob::default()),
                draw: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_folders,
            add_folder,
            remove_folder,
            scan_folder,
            list_files,
            select_playlist,
            clear_playlist_selection,
            redraw_playlist,
            refresh_draw,
            facet_counts,
            list_tags,
            create_tag,
            rename_tag,
            set_tag_settings,
            set_tag_synonyms,
            new_tag_settings,
            export_data,
            export_metadata,
            inspect_import,
            import_data,
            set_new_tag_settings,
            delete_tag,
            move_tag,
            add_tag,
            remove_tag,
            remove_missing_files,
            start_hashing,
            cancel_hashing,
            hashing_progress,
            track_title,
            track_cover,
            list_fonts,
            check_update,
            meta_ignore_values,
            delete_files,
            set_meta_ignore_values,
            meta_separators,
            set_meta_separators,
            autotag_file,
            start_autotag,
            cancel_autotag,
            install_update,
            relink_files,
            license_types,
            list_credits,
            move_credit,
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
            start_export_files,
            draw_item_files,
            cancel_export,
            expand_playlist_item,
            playlists_with_file,
            existing_file_ids,
            link_missing_file,
            find_missing_in_folder,
            find_missing_in_folder_many,
            record_play,
            remove_file_from_playlist,
            remove_files_from_playlist,
            bulk_summary,
            playlist_item_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
