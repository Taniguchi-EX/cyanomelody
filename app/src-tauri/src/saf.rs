//! Android の Storage Access Framework（SAF）：フォルダを選んで権限を残す、フォルダの中をたどる、ファイルを開く。
//! フォルダ・ファイルは FsUri（content:// の URI）の JSON で表す。Android 以外では、どれも「使えない」のエラーになる

use std::fs::File;
use std::io;

use crate::error::{Error, Result};

/// フォルダの中で見つかったファイル（スキャンに使う）
#[derive(Debug, Clone)]
pub struct TreeFile {
    /// フォルダの中の相対パス（区切りは `/`）
    pub rel_path: String,
    /// ファイルの FsUri の JSON
    pub uri: String,
    pub size: i64,
    /// 更新日時（UNIX 時間の秒）
    pub modified_at: i64,
}

/// 選んだフォルダ
#[derive(Debug, Clone)]
pub struct PickedDir {
    /// フォルダの FsUri の JSON
    pub uri: String,
}

#[cfg(not(target_os = "android"))]
fn unsupported() -> Error {
    Error::invalid("この端末では使えません（Android だけ）")
}

#[cfg(target_os = "android")]
pub use imp::{init, list_files, open, pick_dir, readable};

#[cfg(not(target_os = "android"))]
pub fn open(_uri: &str) -> io::Result<File> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "SAF は Android だけで使えます"))
}

#[cfg(not(target_os = "android"))]
pub fn pick_dir() -> Result<Option<PickedDir>> {
    Err(unsupported())
}

#[cfg(not(target_os = "android"))]
pub fn list_files(_dir: &str, _extensions: &[&str]) -> Result<Vec<TreeFile>> {
    Err(unsupported())
}

#[cfg(not(target_os = "android"))]
pub fn readable(_dir: &str) -> bool {
    false
}

/// SAF のフォルダの URI の JSON から、フォルダの場所の名前（「primary:Music/効果音」など。ボリュームとその中のパス）を作る。
/// content://…/tree/primary%3AMusic%2F効果音/document/… の、document の後ろ（なければ tree の後ろ）。読めなければ None
pub fn document_id(uri_json: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(uri_json).ok()?;
    let uri = value.get("uri")?.as_str()?;
    Some(percent_decode(uri.rsplit('/').next().unwrap_or(uri)))
}

/// SAF のフォルダの URI の JSON から、画面に出す名前（「Music/効果音」など）を作る。読めなければ JSON のまま
pub fn display_name(uri_json: &str) -> String {
    let Some(decoded) = document_id(uri_json) else { return uri_json.to_string() };
    match decoded.split_once(':') {
        Some((volume, path)) if volume == "primary" => path.to_string(),
        Some((volume, path)) => format!("{volume}:{path}"),
        None => decoded,
    }
}

/// %XX をもとの文字に戻す（UTF-8 として読めなければ、読めない部分は「�」）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(target_os = "android")]
mod imp {
    use std::sync::OnceLock;
    use std::time::UNIX_EPOCH;

    use tauri::AppHandle;
    use tauri_plugin_android_fs::{AndroidFsExt, Entry, FsUri, UriPermission};

    use super::*;

    /// SAF のプラグインを使うためのアプリ（起動したときに覚える）
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
    }

    fn app() -> Result<&'static AppHandle> {
        APP.get().ok_or_else(|| Error::invalid("SAF の準備ができていません"))
    }

    fn fs_error(e: impl std::fmt::Debug) -> Error {
        Error::invalid(format!("{e:?}"))
    }

    fn parse(uri: &str) -> Result<FsUri> {
        FsUri::from_json_str(uri).map_err(fs_error)
    }

    /// ファイルを読むために開く
    pub fn open(uri: &str) -> io::Result<File> {
        let to_io = |e: Error| io::Error::other(e.to_string());
        let uri = parse(uri).map_err(to_io)?;
        app().map_err(to_io)?.android_fs().open_file_readable(&uri).map_err(|e| io::Error::other(format!("{e:?}")))
    }

    /// フォルダを選ぶ画面を出し、選んだフォルダの権限を残す（アプリを起動し直しても読める）。キャンセルしたら None
    pub fn pick_dir() -> Result<Option<PickedDir>> {
        let fs = app()?.android_fs();
        let Some(uri) = fs.picker().pick_dir(None, false).map_err(fs_error)? else { return Ok(None) };
        fs.picker().persist_uri_permission(&uri).map_err(fs_error)?;
        Ok(Some(PickedDir { uri: uri.to_json_string().map_err(fs_error)? }))
    }

    /// フォルダを読める（権限が残っている）か
    pub fn readable(dir: &str) -> bool {
        let Ok(uri) = parse(dir) else { return false };
        let Ok(app) = app() else { return false };
        app.android_fs().picker().check_persisted_uri_permission(&uri, UriPermission::Read).unwrap_or(false)
    }

    /// フォルダの中（サブフォルダも）の、拡張子が extensions のどれかのファイル。読めないサブフォルダは飛ばす
    pub fn list_files(dir: &str, extensions: &[&str]) -> Result<Vec<TreeFile>> {
        let fs = app()?.android_fs();
        let mut stack = vec![(parse(dir)?, String::new())];
        let mut files = Vec::new();
        let mut first = true;
        while let Some((uri, prefix)) = stack.pop() {
            let entries = match fs.read_dir(&uri) {
                Ok(e) => e,
                // 一番上のフォルダが読めないのはエラー、サブフォルダは飛ばす
                Err(e) if first => return Err(fs_error(e)),
                Err(_) => continue,
            };
            first = false;
            for entry in entries {
                match entry {
                    Entry::Dir { uri, name, .. } => stack.push((uri, format!("{prefix}{name}/"))),
                    Entry::File { uri, name, len, last_modified, .. } => {
                        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
                        if !extensions.iter().any(|x| x.eq_ignore_ascii_case(&ext)) {
                            continue;
                        }
                        let modified_at =
                            last_modified.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
                        files.push(TreeFile {
                            rel_path: format!("{prefix}{name}"),
                            uri: uri.to_json_string().map_err(fs_error)?,
                            size: len as i64,
                            modified_at,
                        });
                    }
                    _ => {}
                }
            }
        }
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_of_tree_uri() {
        let json = r#"{"uri":"content://com.android.externalstorage.documents/tree/primary%3AMusic%2F%E5%8A%B9%E6%9E%9C%E9%9F%B3/document/primary%3AMusic%2F%E5%8A%B9%E6%9E%9C%E9%9F%B3","documentTopTreeUri":null}"#;
        assert_eq!(display_name(json), "Music/効果音");
        // SD カードなど、primary でないボリュームは名前を残す
        let sd = r#"{"uri":"content://com.android.externalstorage.documents/tree/1234-ABCD%3ASounds","documentTopTreeUri":null}"#;
        assert_eq!(display_name(sd), "1234-ABCD:Sounds");
        assert_eq!(display_name("C:\\lib"), "C:\\lib");
    }
}
