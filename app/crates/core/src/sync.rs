//! プレイリストと設定。Google Drive のマイドライブ直下の `cyanomelody` フォルダに JSON で保存し、
//! 全端末で共有する。
//!
//! ```text
//! cyanomelody/
//! ├── settings.json              設定（Drive の指定フォルダ、端末ごとのローカルの指定フォルダ）
//! └── playlists/<プレイリストID>.json   プレイリスト 1 つにつき 1 ファイル
//! ```
//!
//! 編集は、Drive から最新を読み直してから行い、そのまま保存する。複数の端末で同時に編集したときは、
//! 後から保存した方を正とする（一人で使うため、同時に編集することはほぼない）。

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::drive::{DriveClient, DriveError};
use crate::library::{Library, Song};
use crate::source::SourceKind;

pub const APP_FOLDER: &str = "cyanomelody";
pub const PLAYLIST_FOLDER: &str = "playlists";
pub const SETTINGS_FILE: &str = "settings.json";
const JSON_MIME: &str = "application/json";
/// JSON の形式の版。形を変えるときに上げ、古い版も読めるようにする。
pub const FORMAT_VERSION: u32 = 1;

fn format_version() -> u32 {
    FORMAT_VERSION
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    format!("{:016x}", fastrand::u64(..))
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SyncError {
    /// 通信できない。オフラインの間はプレイリストを編集できない
    #[error("通信できないため、プレイリストと設定を読み書きできない: {0}")]
    Offline(String),
    #[error(transparent)]
    Drive(DriveError),
    /// JSON を読めない
    #[error("プレイリストや設定の形式が正しくない: {0}")]
    Format(String),
    #[error("プレイリストが見つからない: {0}")]
    NotFound(String),
}

impl From<DriveError> for SyncError {
    fn from(e: DriveError) -> Self {
        match e {
            DriveError::Network(m) => Self::Offline(m),
            other => Self::Drive(other),
        }
    }
}

/// プレイリストの 1 曲。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistItem {
    /// `drive` または `local`
    pub source: String,
    /// 音楽ソースの中で曲を見分ける値（Drive はファイル ID、ローカルは指定フォルダからの相対パス）
    pub key: String,
    /// 追加したときの曲名。曲が見つからないときの表示に使う
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    /// ローカルの曲を追加した端末の ID。ほかの端末では再生できない（グレーアウトする）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

impl PlaylistItem {
    pub fn from_song(song: &Song, device_id: &str) -> Self {
        Self {
            source: song.source.as_str().to_string(),
            key: song.key.clone(),
            title: song.title.clone(),
            artist: song.artist.clone(),
            device: (song.source == SourceKind::Local).then(|| device_id.to_string()),
        }
    }

    pub fn source_kind(&self) -> Option<SourceKind> {
        SourceKind::parse(&self.source)
    }

    /// この端末で再生できるか。できなければ画面でグレーアウトする。
    /// - ローカルの曲は、追加した端末で、前回の手動更新で見つかったもの
    /// - Drive の曲は、前回の手動更新で見つかったもの
    pub fn is_available(&self, device_id: &str, library: &Library) -> bool {
        let Some(kind) = self.source_kind() else {
            return false;
        };
        if kind == SourceKind::Local && self.device.as_deref() != Some(device_id) {
            return false;
        }
        matches!(library.song(kind, &self.key), Ok(Some(song)) if !song.missing)
    }
}

/// プレイリスト。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Playlist {
    #[serde(default = "format_version")]
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub items: Vec<PlaylistItem>,
    /// 最後に保存した日時（UNIX 時間のミリ秒）
    #[serde(default)]
    pub updated_at: i64,
}

impl Playlist {
    pub fn new(name: &str) -> Self {
        Self {
            version: FORMAT_VERSION,
            id: new_id(),
            name: name.to_string(),
            favorite: false,
            items: Vec::new(),
            updated_at: now_millis(),
        }
    }

    /// 曲を末尾に追加する。同じ曲を複数回入れてもよい。
    pub fn add(&mut self, items: impl IntoIterator<Item = PlaylistItem>) {
        self.items.extend(items);
    }

    pub fn remove(&mut self, index: usize) -> Option<PlaylistItem> {
        (index < self.items.len()).then(|| self.items.remove(index))
    }

    /// `from` 番目の曲を `to` 番目に移す。
    pub fn move_item(&mut self, from: usize, to: usize) -> bool {
        if from >= self.items.len() || to >= self.items.len() {
            return false;
        }
        let item = self.items.remove(from);
        self.items.insert(to, item);
        true
    }
}

/// 一覧に出すための、プレイリストの要約。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistSummary {
    pub id: String,
    pub name: String,
    pub favorite: bool,
    pub count: usize,
}

/// Drive の指定フォルダ（全端末で共通）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveFolder {
    pub id: String,
    /// マイドライブからのパス（表示用）
    pub path: String,
}

/// ローカルの指定フォルダ（端末ごと）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFolder {
    pub path: String,
    /// 端末の名前（設定の画面で、どの端末の設定か分かるようにする）
    #[serde(default)]
    pub device_name: String,
}

/// 設定。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "format_version")]
    pub version: u32,
    #[serde(default)]
    pub drive_folder: Option<DriveFolder>,
    /// 端末 ID ごとのローカルの指定フォルダ
    #[serde(default)]
    pub local_folders: BTreeMap<String, LocalFolder>,
}

impl Settings {
    pub fn local_folder(&self, device_id: &str) -> Option<&LocalFolder> {
        self.local_folders.get(device_id)
    }

    pub fn set_local_folder(&mut self, device_id: &str, folder: LocalFolder) {
        self.local_folders.insert(device_id.to_string(), folder);
    }
}

#[derive(Clone)]
struct Folders {
    app: String,
    playlists: String,
}

/// プレイリストと設定の読み書き。
pub struct SyncStore {
    client: DriveClient,
    folders: Mutex<Option<Folders>>,
    /// プレイリスト ID から Drive のファイル ID への対応
    file_ids: Mutex<HashMap<String, String>>,
}

fn parse<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, SyncError> {
    serde_json::from_slice(bytes).map_err(|e| SyncError::Format(e.to_string()))
}

fn to_json<T: Serialize>(value: &T) -> Vec<u8> {
    serde_json::to_vec_pretty(value).expect("JSON にできない値はない")
}

impl SyncStore {
    pub fn new(client: DriveClient) -> Self {
        Self {
            client,
            folders: Mutex::new(None),
            file_ids: Mutex::new(HashMap::new()),
        }
    }

    /// `cyanomelody` と `playlists` のフォルダ。なければ作る。
    fn folders(&self) -> Result<Folders, SyncError> {
        if let Some(f) = self.folders.lock().unwrap().clone() {
            return Ok(f);
        }
        let app = match self.client.find_folder("root", APP_FOLDER)? {
            Some(f) => f.id,
            None => self.client.create_folder("root", APP_FOLDER)?.id,
        };
        let playlists = match self.client.find_folder(&app, PLAYLIST_FOLDER)? {
            Some(f) => f.id,
            None => self.client.create_folder(&app, PLAYLIST_FOLDER)?.id,
        };
        let folders = Folders { app, playlists };
        *self.folders.lock().unwrap() = Some(folders.clone());
        Ok(folders)
    }

    fn file_name(id: &str) -> String {
        format!("{id}.json")
    }

    /// プレイリストのファイル ID。
    fn file_id(&self, id: &str) -> Result<String, SyncError> {
        if let Some(f) = self.file_ids.lock().unwrap().get(id) {
            return Ok(f.clone());
        }
        let folders = self.folders()?;
        let file = self
            .client
            .find_file(&folders.playlists, &Self::file_name(id))?
            .ok_or_else(|| SyncError::NotFound(id.to_string()))?;
        self.file_ids
            .lock()
            .unwrap()
            .insert(id.to_string(), file.id.clone());
        Ok(file.id)
    }

    /// プレイリストの一覧。お気に入りを先に、それぞれ名前の順に並べる。
    pub fn list(&self) -> Result<Vec<PlaylistSummary>, SyncError> {
        let folders = self.folders()?;
        let files: Vec<_> = self
            .client
            .list_children(&folders.playlists)?
            .into_iter()
            .filter(|f| f.name.ends_with(".json"))
            .collect();
        // 1 ファイルずつ読むと遅いため、並行して読む
        let next = AtomicUsize::new(0);
        let results: Vec<Mutex<Option<Result<Playlist, SyncError>>>> =
            files.iter().map(|_| Mutex::new(None)).collect();
        std::thread::scope(|scope| {
            for _ in 0..files.len().min(8) {
                scope.spawn(|| {
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= files.len() {
                            break;
                        }
                        let result = self
                            .client
                            .download(&files[i].id)
                            .map_err(SyncError::from)
                            .and_then(|b| parse(&b));
                        *results[i].lock().unwrap() = Some(result);
                    }
                });
            }
        });
        let mut out = Vec::new();
        let mut ids = self.file_ids.lock().unwrap();
        for (file, result) in files.iter().zip(results) {
            match result.into_inner().unwrap() {
                Some(Ok(p)) => {
                    ids.insert(p.id.clone(), file.id.clone());
                    out.push(PlaylistSummary {
                        id: p.id,
                        name: p.name,
                        favorite: p.favorite,
                        count: p.items.len(),
                    });
                }
                Some(Err(SyncError::Offline(m))) => return Err(SyncError::Offline(m)),
                Some(Err(e)) => log::warn!("プレイリスト {} を読めない: {e}", file.name),
                None => {}
            }
        }
        out.sort_by(|a, b| {
            b.favorite
                .cmp(&a.favorite)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(out)
    }

    /// プレイリストを Drive から読む（常に最新を読む）。
    pub fn get(&self, id: &str) -> Result<Playlist, SyncError> {
        let file_id = self.file_id(id)?;
        match self.client.download(&file_id) {
            Ok(bytes) => parse(&bytes),
            Err(DriveError::NotFound(_)) => {
                self.file_ids.lock().unwrap().remove(id);
                Err(SyncError::NotFound(id.to_string()))
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn create(&self, name: &str) -> Result<Playlist, SyncError> {
        let folders = self.folders()?;
        let playlist = Playlist::new(name);
        let file = self.client.create_file(
            &folders.playlists,
            &Self::file_name(&playlist.id),
            JSON_MIME,
            &to_json(&playlist),
        )?;
        self.file_ids
            .lock()
            .unwrap()
            .insert(playlist.id.clone(), file.id);
        Ok(playlist)
    }

    /// 最新を読み直してから `edit` を当てて保存する。
    pub fn edit(&self, id: &str, edit: impl FnOnce(&mut Playlist)) -> Result<Playlist, SyncError> {
        let mut playlist = self.get(id)?;
        edit(&mut playlist);
        playlist.version = FORMAT_VERSION;
        playlist.updated_at = now_millis();
        self.client
            .update_file(&self.file_id(id)?, JSON_MIME, &to_json(&playlist))?;
        Ok(playlist)
    }

    /// プレイリストを消す（Drive のゴミ箱に移すので、Drive 側で戻せる）。
    pub fn delete(&self, id: &str) -> Result<(), SyncError> {
        let file_id = self.file_id(id)?;
        self.client.trash(&file_id)?;
        self.file_ids.lock().unwrap().remove(id);
        Ok(())
    }

    /// 設定を読む。まだなければ既定値。
    pub fn settings(&self) -> Result<Settings, SyncError> {
        let folders = self.folders()?;
        match self.client.find_file(&folders.app, SETTINGS_FILE)? {
            Some(f) => parse(&self.client.download(&f.id)?),
            None => Ok(Settings {
                version: FORMAT_VERSION,
                ..Default::default()
            }),
        }
    }

    /// 最新を読み直してから `edit` を当てて保存する。
    pub fn edit_settings(&self, edit: impl FnOnce(&mut Settings)) -> Result<Settings, SyncError> {
        let folders = self.folders()?;
        let existing = self.client.find_file(&folders.app, SETTINGS_FILE)?;
        let mut settings = match &existing {
            Some(f) => parse(&self.client.download(&f.id)?)?,
            None => Settings::default(),
        };
        edit(&mut settings);
        settings.version = FORMAT_VERSION;
        let json = to_json(&settings);
        match existing {
            Some(f) => self.client.update_file(&f.id, JSON_MIME, &json)?,
            None => self
                .client
                .create_file(&folders.app, SETTINGS_FILE, JSON_MIME, &json)?,
        };
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive::StaticToken;
    use crate::drive::mock::MockDrive;
    use crate::source::local::LocalSource;
    use crate::source::local::tests::put_song;
    use std::sync::Arc;

    fn store(mock: &MockDrive) -> SyncStore {
        SyncStore::new(DriveClient::with_base(
            &mock.base_url(),
            Arc::new(StaticToken("t".into())),
        ))
    }

    fn item(key: &str) -> PlaylistItem {
        PlaylistItem {
            source: "drive".into(),
            key: key.into(),
            title: key.into(),
            artist: None,
            device: None,
        }
    }

    #[test]
    fn creates_folders_and_lists_favorites_first() {
        let mock = MockDrive::start();
        let s = store(&mock);
        let b = s.create("B のリスト").unwrap();
        let a = s.create("A のリスト").unwrap();
        let z = s.create("Z のリスト").unwrap();
        s.edit(&z.id, |p| p.favorite = true).unwrap();
        assert_eq!(mock.names("root"), vec![APP_FOLDER]);
        let names: Vec<String> = s.list().unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(
            names,
            vec!["Z のリスト", "A のリスト", "B のリスト"],
            "お気に入りが先、あとは名前の順"
        );
        let _ = (a, b);
    }

    #[test]
    fn edits_are_shared_between_devices_and_last_write_wins() {
        let mock = MockDrive::start();
        let pc = store(&mock);
        let phone = store(&mock);
        let p = pc.create("通勤").unwrap();
        pc.edit(&p.id, |p| p.add([item("x"), item("y"), item("x")]))
            .unwrap();
        let seen = phone.get(&p.id).unwrap();
        assert_eq!(
            seen.items.len(),
            3,
            "別の端末からも見える。同じ曲を複数回入れられる"
        );

        // 別々の端末で順に編集しても、編集の直前に読み直すので両方の変更が残る
        phone
            .edit(&p.id, |p| p.move_item(2, 0).then_some(()).unwrap())
            .unwrap();
        pc.edit(&p.id, |p| p.name = "通勤（改）".into()).unwrap();
        let latest = phone.get(&p.id).unwrap();
        assert_eq!(latest.name, "通勤（改）");
        assert_eq!(latest.items[0].key, "x");

        // 同時に編集した場合は、後から保存した方になる
        let mut stale = pc.get(&p.id).unwrap();
        phone
            .edit(&p.id, |p| p.name = "スマホで変えた".into())
            .unwrap();
        stale.name = "PC で変えた".into();
        pc.edit(&p.id, |p| *p = stale.clone()).unwrap();
        assert_eq!(phone.get(&p.id).unwrap().name, "PC で変えた");
    }

    #[test]
    fn delete_moves_to_trash() {
        let mock = MockDrive::start();
        let s = store(&mock);
        let p = s.create("消す").unwrap();
        s.delete(&p.id).unwrap();
        assert!(s.list().unwrap().is_empty());
        assert!(matches!(
            store(&mock).get(&p.id),
            Err(SyncError::NotFound(_))
        ));
    }

    #[test]
    fn settings_have_shared_drive_folder_and_per_device_local_folders() {
        let mock = MockDrive::start();
        let pc = store(&mock);
        let phone = store(&mock);
        assert_eq!(
            pc.settings().unwrap(),
            Settings {
                version: FORMAT_VERSION,
                ..Default::default()
            }
        );
        pc.edit_settings(|s| {
            s.drive_folder = Some(DriveFolder {
                id: "f1".into(),
                path: "music".into(),
            });
            s.set_local_folder(
                "pc",
                LocalFolder {
                    path: "C:\\Music".into(),
                    device_name: "PC".into(),
                },
            );
        })
        .unwrap();
        phone
            .edit_settings(|s| {
                s.set_local_folder(
                    "phone",
                    LocalFolder {
                        path: "/storage/emulated/0/Music".into(),
                        device_name: "Pixel".into(),
                    },
                )
            })
            .unwrap();
        let settings = pc.settings().unwrap();
        assert_eq!(settings.drive_folder.as_ref().unwrap().path, "music");
        assert_eq!(settings.local_folder("pc").unwrap().path, "C:\\Music");
        assert_eq!(
            settings.local_folder("phone").unwrap().path,
            "/storage/emulated/0/Music"
        );
    }

    #[test]
    fn reads_older_and_newer_json() {
        let old: Playlist = serde_json::from_str(
            r#"{"id":"1","name":"古い形式","items":[{"source":"drive","key":"k","title":"t"}]}"#,
        )
        .unwrap();
        assert_eq!(old.version, FORMAT_VERSION);
        assert!(!old.favorite);
        let newer: Settings =
            serde_json::from_str(r#"{"version":2,"theme":"dark","local_folders":{}}"#).unwrap();
        assert_eq!(newer.version, 2, "知らない項目は無視して読む");
    }

    #[test]
    fn offline_is_reported() {
        let s = SyncStore::new(DriveClient::with_base(
            "http://127.0.0.1:9",
            Arc::new(StaticToken("t".into())),
        ));
        assert!(matches!(s.list(), Err(SyncError::Offline(_))));
        assert!(matches!(s.create("x"), Err(SyncError::Offline(_))));
    }

    #[test]
    fn availability_depends_on_device_and_library() {
        let dir = tempfile::tempdir().unwrap();
        put_song(dir.path(), "a.wav", None);
        let library = Library::open_in_memory().unwrap();
        library
            .refresh(&LocalSource::new(dir.path()), 1, &|_, _| {})
            .unwrap();
        let song = library.song(SourceKind::Local, "a.wav").unwrap().unwrap();
        let mine = PlaylistItem::from_song(&song, "pc");
        assert_eq!(mine.device.as_deref(), Some("pc"));
        assert!(mine.is_available("pc", &library));
        assert!(
            !mine.is_available("phone", &library),
            "ほかの端末のローカルの曲はグレーアウト"
        );
        std::fs::remove_file(dir.path().join("a.wav")).unwrap();
        library
            .refresh(&LocalSource::new(dir.path()), 1, &|_, _| {})
            .unwrap();
        assert!(
            !mine.is_available("pc", &library),
            "見つからなくなった曲はグレーアウト"
        );
        assert!(!item("drive-unknown").is_available("pc", &library));
    }
}
