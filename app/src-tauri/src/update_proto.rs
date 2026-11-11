//! 試作（一時的）：Android で、新しい版の APK をダウンロードし、インストールの画面を出す
use std::io::Write;
use tauri::{AppHandle, Manager};
use tauri_plugin_android_fs::AndroidFsExt;

use crate::error::{Error, Result};

#[tauri::command]
pub async fn proto_update(app: AppHandle, url: String) -> Result<String> {
    let dir = app.path().app_cache_dir().map_err(|e| Error::invalid(e.to_string()))?.join("update");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("cyanomelody.apk");
    let t = std::time::Instant::now();
    let mut body = ureq::get(&url).call().map_err(|e| Error::invalid(e.to_string()))?.into_body();
    let mut file = std::fs::File::create(&path)?;
    let n = std::io::copy(&mut body.as_reader(), &mut file)?;
    file.flush()?;
    let dl = t.elapsed().as_millis();
    let fs = app.android_fs();
    let uri = fs.get_uri_for_file_path(&path, Some("application/vnd.android.package-archive")).map_err(|e| Error::invalid(format!("{e:?}")))?;
    fs.opener().open_file(&uri).map_err(|e| Error::invalid(format!("{e:?}")))?;
    Ok(format!("{n} bytes {dl}ms uri={}", uri.to_json_string().unwrap_or_default()))
}
