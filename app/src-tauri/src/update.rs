//! 自動アップデート。GitHub の最新の Release から新しい版を探して入れる。
//! - Windows：Release にある更新の情報（latest.json）を、tauri-plugin-updater で読んで入れる（入れた後、アプリを再起動する）。
//! - Android：Release の情報（GitHub の API）から Android の APK を探す。「はい」で APK をダウンロードし、Android のインストールの画面を出す
//!   （Android では、アプリが黙って自分を入れ替えることはできないので、最後の「更新」はユーザーが押す）。

#[cfg(not(target_os = "android"))]
use tauri::AppHandle;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

use crate::error::{Error, Result};

#[cfg(desktop)]
fn update_error(e: tauri_plugin_updater::Error) -> Error {
    Error::invalid(format!("更新できませんでした: {e}"))
}

/// 新しい版があれば、その版（"1.0.1" など）。探せなかったとき（オフラインなど）は None。
/// 開発用のビルドでは探さない。ただし画面テストのため、環境変数 CYANOMELODY_FAKE_UPDATE に版があれば、その版が見つかったことにする
#[cfg(desktop)]
pub async fn check(app: &AppHandle) -> Option<String> {
    if cfg!(debug_assertions) {
        return std::env::var("CYANOMELODY_FAKE_UPDATE").ok().filter(|v| !v.is_empty());
    }
    match app.updater().ok()?.check().await {
        Ok(update) => update.map(|u| u.version),
        Err(e) => {
            log::warn!("新しい版を探せませんでした: {e}");
            None
        }
    }
}

/// 新しい版をダウンロードしてインストールし、アプリを再起動する
#[cfg(desktop)]
pub async fn install(app: &AppHandle) -> Result<()> {
    let update = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?
        .ok_or_else(|| Error::invalid("新しい版が見つかりません"))?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(update_error)?;
    app.restart();
}

#[cfg(target_os = "android")]
pub use android::{check, install};

#[cfg(target_os = "android")]
mod android {
    use std::io::Write;
    use std::path::PathBuf;

    use tauri::{AppHandle, Manager};
    use tauri_plugin_android_fs::AndroidFsExt;

    use super::{newer, parse_latest, Error, Result};

    /// 最新の Release の情報（下書きは入らない）
    const LATEST: &str = "https://api.github.com/repos/Taniguchi-EX/cyanomelody/releases/latest";
    const APK_MIME: &str = "application/vnd.android.package-archive";

    fn http_error(e: impl std::fmt::Display) -> Error {
        Error::invalid(format!("新しい版を取得できませんでした: {e}"))
    }

    /// 最新の Release の版と、Android の APK のダウンロードの URL（APK がなければ None）
    fn latest() -> Result<Option<(String, String)>> {
        let text = ureq::get(LATEST)
            .header("User-Agent", "cyanomelody")
            .header("Accept", "application/vnd.github+json")
            .call()
            .map_err(http_error)?
            .body_mut()
            .read_to_string()
            .map_err(http_error)?;
        parse_latest(&text).map_err(http_error)
    }

    /// ダウンロードした APK を置く場所（インストールの画面に渡せるのは、この中だけ。tauri.conf.json の fileProvider の scope）
    fn update_dir(app: &AppHandle) -> Result<PathBuf> {
        Ok(app.path().app_cache_dir().map_err(|e| Error::invalid(e.to_string()))?.join("update"))
    }

    fn apk_path(app: &AppHandle, version: &str) -> Result<PathBuf> {
        Ok(update_dir(app)?.join(format!("cyanomelody-{version}.apk")))
    }

    /// 新しい版があれば、その版。探せなかったとき（オフラインなど）は None。開発用のビルド（デバッグ版）では探さない。
    /// 前にダウンロードした APK のうち、最新の版のもの以外は消す（入れ終わったもの・古くなったもの）
    pub async fn check(app: &AppHandle) -> Option<String> {
        if cfg!(debug_assertions) {
            return None;
        }
        let found = match latest() {
            Ok(found) => found,
            Err(e) => {
                log::warn!("{e}");
                return None;
            }
        };
        let current = app.package_info().version.to_string();
        let new = found.map(|(v, _)| v).filter(|v| newer(v, &current));
        if let Ok(dir) = update_dir(app) {
            let keep = new.as_deref().and_then(|v| apk_path(app, v).ok());
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                if Some(entry.path()) != keep {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        new
    }

    /// 新しい版の APK をダウンロードし（ダウンロード済みならそれを使う）、Android のインストールの画面を出す。
    /// 画面を出したら返る（インストールはユーザーが「更新」を押して行う）
    pub async fn install(app: &AppHandle) -> Result<()> {
        let (version, url) = latest()?.ok_or_else(|| Error::invalid("新しい版の Android のアプリが見つかりません"))?;
        let path = apk_path(app, &version)?;
        if !path.exists() {
            std::fs::create_dir_all(update_dir(app)?)?;
            // 途中で切れたファイルを使わないよう、別の名前で書いてから名前を変える
            let part = path.with_extension("part");
            let mut response = ureq::get(&url).header("User-Agent", "cyanomelody").call().map_err(http_error)?;
            let mut file = std::fs::File::create(&part)?;
            std::io::copy(&mut response.body_mut().as_reader(), &mut file)?;
            file.flush()?;
            drop(file);
            std::fs::rename(&part, &path)?;
        }
        let fs = app.android_fs();
        let uri = fs.get_uri_for_file_path(&path, Some(APK_MIME)).map_err(|e| Error::invalid(format!("{e:?}")))?;
        fs.opener().open_file(&uri).map_err(|e| Error::invalid(format!("インストールの画面を開けませんでした: {e:?}")))
    }
}

/// Release に付ける Android の APK の名前の終わり（`cyanomelody_1.3.0_android-arm64.apk`）
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const APK_SUFFIX: &str = "_android-arm64.apk";

/// 最新の Release の情報（GitHub の API の JSON）から、版（"1.3.0"）と Android の APK のダウンロードの URL を取り出す。APK がなければ None
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn parse_latest(text: &str) -> std::result::Result<Option<(String, String)>, serde_json::Error> {
    let json: serde_json::Value = serde_json::from_str(text)?;
    let version = json["tag_name"].as_str().unwrap_or_default().trim_start_matches('v').to_string();
    let url = json["assets"].as_array().into_iter().flatten().find_map(|a| {
        let name = a["name"].as_str()?;
        name.ends_with(APK_SUFFIX).then(|| a["browser_download_url"].as_str().map(str::to_string)).flatten()
    });
    Ok(url.map(|u| (version, u)))
}

/// a が b より新しい版か（"1.10.0" と "1.9.0" のように、数の並びとして比べる）
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(a) > parse(b)
}

#[cfg(all(mobile, not(target_os = "android")))]
pub async fn check(_app: &AppHandle) -> Option<String> {
    None
}

#[cfg(all(mobile, not(target_os = "android")))]
pub async fn install(_app: &AppHandle) -> Result<()> {
    Err(Error::invalid("この端末では、アプリの中から更新できません"))
}

#[cfg(test)]
mod tests {
    use super::{newer, parse_latest};

    #[test]
    fn finds_android_apk_in_latest_release() {
        let json = r#"{"tag_name":"v1.3.1","draft":false,"assets":[
            {"name":"cyanomelody_1.3.1_x64-setup.exe","browser_download_url":"https://example.com/setup.exe"},
            {"name":"latest.json","browser_download_url":"https://example.com/latest.json"},
            {"name":"cyanomelody_1.3.1_android-arm64.apk","browser_download_url":"https://example.com/app.apk"}]}"#;
        assert_eq!(parse_latest(json).unwrap(), Some(("1.3.1".to_string(), "https://example.com/app.apk".to_string())));
        // APK のない Release（Android 版を配る前の版）
        let old = r#"{"tag_name":"v1.2.0","assets":[{"name":"latest.json","browser_download_url":"x"}]}"#;
        assert_eq!(parse_latest(old).unwrap(), None);
        assert!(parse_latest("not json").is_err());
    }

    #[test]
    fn compares_versions_as_numbers() {
        assert!(newer("1.3.0", "1.2.0"));
        assert!(newer("1.10.0", "1.9.0"));
        assert!(newer("2.0.0", "1.99.99"));
        assert!(!newer("1.3.0", "1.3.0"));
        assert!(!newer("1.2.9", "1.3.0"));
    }
}
