//! 試作（一時的）：Windows からのコピーで使う SAF の操作を、実機で確かめる。本実装に入るときに外す

use std::io::Read;
use std::time::Instant;

use tauri::State;
use tauri_plugin_android_fs::{AndroidFsExt, Entry, FsUri, UriPermission};

use crate::error::{Error, Result};
use crate::library;
use crate::state::AppState;

fn fs_error(e: impl std::fmt::Debug) -> Error {
    Error::invalid(format!("{e:?}"))
}

fn read_text(app: &tauri::AppHandle, uri: &FsUri) -> Result<String> {
    let mut s = String::new();
    app.android_fs().open_file_readable(uri).map_err(fs_error)?.read_to_string(&mut s)?;
    Ok(s)
}

fn describe_json(text: &str) -> String {
    match crate::transfer::parse(text) {
        Ok(d) => format!("JSON OK: {} bytes, files {}, tags {}, playlists {}", text.len(), d.files.len(), d.tags.len(), d.playlists.len()),
        Err(e) => format!("JSON NG: {e}"),
    }
}

/// JSON のファイルを選んで読む
#[tauri::command]
pub async fn proto_copy_pick_file(app: tauri::AppHandle) -> Result<String> {
    let t = Instant::now();
    let Some(uri) = app.android_fs().picker().pick_file(None, &["application/json"], false).map_err(fs_error)? else {
        return Ok("キャンセル".into());
    };
    let picked = t.elapsed().as_millis();
    let t = Instant::now();
    let text = read_text(&app, &uri)?;
    Ok(format!("uri={} / 選ぶ{}ms / 読む{}ms / {}", uri.to_json_string().unwrap_or_default(), picked, t.elapsed().as_millis(), describe_json(&text)))
}

/// 書き出したフォルダを選び、中の JSON を読み、中のフォルダをライブラリに登録してスキャンする
#[tauri::command]
pub async fn proto_copy_pick_dir(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String> {
    let fs = app.android_fs();
    let Some(dir) = fs.picker().pick_dir(None, false).map_err(fs_error)? else { return Ok("キャンセル".into()) };
    fs.picker().persist_uri_permission(&dir).map_err(fs_error)?;
    let mut log = vec![format!("dir={}", dir.to_json_string().unwrap_or_default())];
    let t = Instant::now();
    let entries = fs.read_dir(&dir).map_err(fs_error)?;
    log.push(format!("read_dir {}件 {}ms", entries.len(), t.elapsed().as_millis()));
    // 名前でファイルを引けるか
    match fs.resolve_file_uri(&dir, "cyanomelody.json") {
        Ok(uri) => log.push(format!("resolve_file_uri: {}", describe_json(&read_text(&app, &uri)?))),
        Err(e) => log.push(format!("resolve_file_uri NG: {e:?}")),
    }
    for entry in entries {
        if let Entry::Dir { uri, name, .. } = entry {
            let json = uri.to_json_string().map_err(fs_error)?;
            log.push(format!("子 {name}: {json} / readable(persisted)={}", crate::saf::readable(&json)));
            let mut conn = state.conn();
            match library::add_saf_folder(&conn, &json) {
                Ok(id) => {
                    let t = Instant::now();
                    match library::scan_folder(&mut conn, id) {
                        Ok(r) => log.push(format!("  登録・スキャン：{}件 {}ms", r.found, t.elapsed().as_millis())),
                        Err(e) => log.push(format!("  スキャン NG: {e}")),
                    }
                }
                Err(e) => log.push(format!("  登録 NG: {e}")),
            }
        }
    }
    Ok(log.join("\n"))
}

/// 登録した SAF のフォルダが、今も読めるか（アプリの起動し直しの後に見る）
#[tauri::command]
pub async fn proto_copy_check(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String> {
    let folders = library::list_folders(&state.conn())?;
    let persisted = app.android_fs().picker().get_all_persisted_uri_permissions().map_err(fs_error)?;
    let mut log = vec![format!("残っている権限 {}件", persisted.len())];
    for f in folders {
        let ok = FsUri::from_json_str(&f.path)
            .ok()
            .and_then(|u| app.android_fs().picker().check_persisted_uri_permission(&u, UriPermission::Read).ok());
        log.push(format!("{}: readable={:?}", f.label, ok));
    }
    Ok(log.join("\n"))
}
