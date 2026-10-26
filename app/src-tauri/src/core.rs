//! アプリの中核の部品をまとめて持ち、画面からの操作を受ける。
//!
//! 曲を見分ける値は、再生エンジンとの間では頭に `drive:` か `local:` を付け、
//! どちらの音楽ソースから開くかを見分ける。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use cyanomelody_core::cache::{DEFAULT_MAX_BYTES, SongCache};
use cyanomelody_core::drive::{DriveClient, DriveError, TokenProvider};
use cyanomelody_core::library::{DEFAULT_PARALLELISM, FolderListing, Library, RefreshReport, Song};
use cyanomelody_core::playback::output::CpalOutput;
use cyanomelody_core::playback::{EventHandler, PlaybackError, Player, TrackOpener, TrackRef};
use cyanomelody_core::source::drive::DriveSource;
use cyanomelody_core::source::local::LocalSource;
use cyanomelody_core::source::{MusicSource, SourceKind};
use cyanomelody_core::sync::{Playlist, PlaylistItem, Settings, SyncError, SyncStore};
use serde::{Deserialize, Serialize};

/// 画面に返すエラー。`kind` で画面の出し分けをする（`offline` ならオフラインの表示にする）。
#[derive(Debug, Clone, Serialize)]
pub struct UiError {
    pub kind: &'static str,
    pub message: String,
}

impl UiError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<SyncError> for UiError {
    fn from(e: SyncError) -> Self {
        let kind = match &e {
            SyncError::Offline(_) => "offline",
            SyncError::Drive(DriveError::Auth(_)) => "login",
            SyncError::NotFound(_) => "not_found",
            _ => "error",
        };
        Self::new(kind, e.to_string())
    }
}

impl From<DriveError> for UiError {
    fn from(e: DriveError) -> Self {
        let kind = match &e {
            DriveError::Network(_) => "offline",
            DriveError::Auth(_) => "login",
            _ => "error",
        };
        Self::new(kind, e.to_string())
    }
}

pub type UiResult<T> = Result<T, UiError>;

/// 端末だけで持つ設定（Drive で共有しないもの）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalConfig {
    pub cache_max_bytes: u64,
    pub volume: f32,
}

impl Default for LocalConfig {
    fn default() -> Self {
        Self {
            cache_max_bytes: DEFAULT_MAX_BYTES,
            volume: 0.8,
        }
    }
}

/// 再生エンジンが開く音楽ソース。設定が変わったら差し替える。
#[derive(Default)]
struct Sources {
    drive: Option<Arc<DriveSource>>,
    local: Option<Arc<LocalSource>>,
}

/// 画面に返すプレイリストの曲。
#[derive(Debug, Clone, Serialize)]
pub struct UiItem {
    pub source: String,
    pub key: String,
    pub title: String,
    pub artist: Option<String>,
    /// この端末で再生できる（できなければグレーアウト）
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiPlaylist {
    pub id: String,
    pub name: String,
    pub favorite: bool,
    pub items: Vec<UiItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiSong {
    pub source: String,
    pub key: String,
    pub relative_path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
}

impl From<&Song> for UiSong {
    fn from(s: &Song) -> Self {
        Self {
            source: s.source.as_str().into(),
            key: s.key.clone(),
            relative_path: s.relative_path.clone(),
            title: s.title.clone(),
            artist: s.artist.clone(),
            album: s.album.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UiListing {
    pub folders: Vec<String>,
    pub songs: Vec<UiSong>,
}

impl From<FolderListing> for UiListing {
    fn from(l: FolderListing) -> Self {
        Self {
            folders: l.folders,
            songs: l.songs.iter().map(UiSong::from).collect(),
        }
    }
}

pub struct AppCore {
    pub device_id: String,
    data_dir: PathBuf,
    pub library: Arc<Library>,
    pub cache: Arc<SongCache>,
    pub player: Player,
    sources: Arc<RwLock<Sources>>,
    /// Drive の呼び出し口（ログインできる端末だけ）
    drive_client: Option<DriveClient>,
    sync: Option<SyncStore>,
    /// 最後に読んだプレイリスト（再生するときに使う。通信を減らすため）
    playlists: Mutex<HashMap<String, Playlist>>,
    /// 再生中のプレイリスト
    pub playing: Mutex<Option<Playlist>>,
    local_config: Mutex<LocalConfig>,
}

fn source_kind(s: &str) -> UiResult<SourceKind> {
    SourceKind::parse(s).ok_or_else(|| UiError::new("error", format!("知らない音楽ソース: {s}")))
}

impl AppCore {
    pub fn new(
        data_dir: &Path,
        cache_dir: &Path,
        tokens: Option<Arc<dyn TokenProvider>>,
        events: EventHandler,
    ) -> Result<Self, String> {
        let device_id =
            cyanomelody_core::device::load_or_create(data_dir).map_err(|e| e.to_string())?;
        let library =
            Arc::new(Library::open(&data_dir.join("library.sqlite")).map_err(|e| e.to_string())?);
        let local_config: LocalConfig = std::fs::read(data_dir.join("local.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let cache =
            SongCache::open(cache_dir, local_config.cache_max_bytes).map_err(|e| e.to_string())?;
        let sources: Arc<RwLock<Sources>> = Arc::default();
        let opener_sources = sources.clone();
        let opener: TrackOpener = Arc::new(move |track: &TrackRef| {
            let sources = opener_sources.read().unwrap();
            let (kind, key) = track
                .key
                .split_once(':')
                .ok_or_else(|| PlaybackError::Open(track.key.clone()))?;
            let source: Arc<dyn MusicSource> = match kind {
                "drive" => sources.drive.clone().map(|s| s as Arc<dyn MusicSource>),
                "local" => sources.local.clone().map(|s| s as Arc<dyn MusicSource>),
                _ => None,
            }
            .ok_or_else(|| {
                PlaybackError::Open(format!("{kind} の指定フォルダが設定されていない"))
            })?;
            drop(sources);
            source
                .open(key)
                .map_err(|e| PlaybackError::Open(e.to_string()))
        });
        let player = Player::new(|| Box::new(CpalOutput::default()), opener, events);
        // Android では OS の音量を使うため、アプリ内の音量は変えない
        if cfg!(desktop) {
            player.set_volume(local_config.volume);
        }
        let drive_client = tokens.map(DriveClient::new);
        let sync = drive_client.clone().map(SyncStore::new);
        Ok(Self {
            device_id,
            data_dir: data_dir.to_path_buf(),
            library,
            cache,
            player,
            sources,
            drive_client,
            sync,
            playlists: Mutex::default(),
            playing: Mutex::default(),
            local_config: Mutex::new(local_config),
        })
    }

    fn sync(&self) -> UiResult<&SyncStore> {
        self.sync
            .as_ref()
            .ok_or_else(|| UiError::new("login", "Google Drive にログインできない端末です"))
    }

    pub fn drive_client(&self) -> UiResult<&DriveClient> {
        self.drive_client
            .as_ref()
            .ok_or_else(|| UiError::new("login", "Google Drive にログインできない端末です"))
    }

    pub fn local_config(&self) -> LocalConfig {
        self.local_config.lock().unwrap().clone()
    }

    fn save_local_config(&self, config: &LocalConfig) {
        if let Err(e) = std::fs::write(
            self.data_dir.join("local.json"),
            serde_json::to_vec_pretty(config).unwrap(),
        ) {
            log::warn!("端末の設定を保存できない: {e}");
        }
    }

    pub fn set_volume(&self, volume: f32) {
        self.player.set_volume(volume);
        let mut config = self.local_config.lock().unwrap();
        config.volume = volume;
        self.save_local_config(&config);
    }

    pub fn set_cache_max(&self, bytes: u64) -> UiResult<()> {
        self.cache
            .set_max_bytes(bytes)
            .map_err(|e| UiError::new("error", e.to_string()))?;
        let mut config = self.local_config.lock().unwrap();
        config.cache_max_bytes = bytes;
        self.save_local_config(&config);
        Ok(())
    }

    /// 設定（Drive で共有）を読み、音楽ソースを差し替える。
    pub fn load_settings(&self) -> UiResult<Settings> {
        let settings = self.sync()?.settings()?;
        self.apply_settings(&settings);
        Ok(settings)
    }

    fn apply_settings(&self, settings: &Settings) {
        let mut sources = self.sources.write().unwrap();
        sources.drive = match (&settings.drive_folder, &self.drive_client) {
            (Some(folder), Some(client)) => Some(Arc::new(
                DriveSource::new(client.clone(), folder.id.clone()).with_cache(self.cache.clone()),
            )),
            _ => None,
        };
        sources.local = settings
            .local_folder(&self.device_id)
            .map(|f| Arc::new(LocalSource::new(&f.path)));
    }

    pub fn edit_settings(&self, edit: impl FnOnce(&mut Settings)) -> UiResult<Settings> {
        let settings = self.sync()?.edit_settings(edit)?;
        self.apply_settings(&settings);
        Ok(settings)
    }

    /// 指定フォルダの曲を読み直す（手動更新）。`progress` には (ソース, 読み終えた数, 合計) が渡される。
    pub fn refresh_library(
        &self,
        progress: &(dyn Fn(&str, usize, usize) + Sync),
    ) -> UiResult<Vec<(String, RefreshReport)>> {
        let (drive, local) = {
            let s = self.sources.read().unwrap();
            (s.drive.clone(), s.local.clone())
        };
        let mut reports = Vec::new();
        if let Some(local) = local {
            let report = self
                .library
                .refresh(local.as_ref(), DEFAULT_PARALLELISM, &|d, t| {
                    progress("local", d, t)
                })
                .map_err(|e| UiError::new("error", e.to_string()))?;
            reports.push(("local".to_string(), report));
        }
        if let Some(drive) = drive {
            let report = self
                .library
                .refresh(drive.as_ref(), DEFAULT_PARALLELISM, &|d, t| {
                    progress("drive", d, t)
                })
                .map_err(|e| {
                    let offline = e.to_string().contains("通信できない");
                    UiError::new(if offline { "offline" } else { "error" }, e.to_string())
                })?;
            reports.push(("drive".to_string(), report));
        }
        Ok(reports)
    }

    pub fn browse(&self, source: &str, folder: &str) -> UiResult<UiListing> {
        let listing = self
            .library
            .browse(source_kind(source)?, folder)
            .map_err(|e| UiError::new("error", e.to_string()))?;
        Ok(listing.into())
    }

    fn ui_playlist(&self, p: &Playlist) -> UiPlaylist {
        UiPlaylist {
            id: p.id.clone(),
            name: p.name.clone(),
            favorite: p.favorite,
            items: p
                .items
                .iter()
                .map(|i| UiItem {
                    source: i.source.clone(),
                    key: i.key.clone(),
                    title: i.title.clone(),
                    artist: i.artist.clone(),
                    available: i.is_available(&self.device_id, &self.library),
                })
                .collect(),
        }
    }

    fn remember(&self, p: &Playlist) -> UiPlaylist {
        self.playlists
            .lock()
            .unwrap()
            .insert(p.id.clone(), p.clone());
        self.ui_playlist(p)
    }

    pub fn list_playlists(&self) -> UiResult<Vec<cyanomelody_core::sync::PlaylistSummary>> {
        Ok(self.sync()?.list()?)
    }

    pub fn get_playlist(&self, id: &str) -> UiResult<UiPlaylist> {
        let p = self.sync()?.get(id)?;
        Ok(self.remember(&p))
    }

    pub fn create_playlist(&self, name: &str) -> UiResult<UiPlaylist> {
        let p = self.sync()?.create(name)?;
        Ok(self.remember(&p))
    }

    pub fn delete_playlist(&self, id: &str) -> UiResult<()> {
        self.sync()?.delete(id)?;
        self.playlists.lock().unwrap().remove(id);
        Ok(())
    }

    /// プレイリストを編集する（最新を読み直してから当てて保存する）。
    pub fn edit_playlist(
        &self,
        id: &str,
        edit: impl FnOnce(&mut Playlist),
    ) -> UiResult<UiPlaylist> {
        let p = self.sync()?.edit(id, edit)?;
        Ok(self.remember(&p))
    }

    /// フォルダ単位で追加するときの曲（サブフォルダの中も含む）、またはファイル単位の 1 曲。
    pub fn items_for(
        &self,
        source: &str,
        folder: Option<&str>,
        key: Option<&str>,
    ) -> UiResult<Vec<PlaylistItem>> {
        let kind = source_kind(source)?;
        let err = |e: cyanomelody_core::library::LibraryError| UiError::new("error", e.to_string());
        let songs = match (folder, key) {
            (Some(folder), _) => self.library.songs_under(kind, folder).map_err(err)?,
            (None, Some(key)) => self
                .library
                .song(kind, key)
                .map_err(err)?
                .into_iter()
                .collect(),
            (None, None) => Vec::new(),
        };
        Ok(songs
            .iter()
            .map(|s| PlaylistItem::from_song(s, &self.device_id))
            .collect())
    }

    /// プレイリストを `start` 番目の曲から再生する。最後に読んだ内容を使う。
    pub fn play_playlist(&self, id: &str, start: usize) -> UiResult<()> {
        let playlist = match self.playlists.lock().unwrap().get(id).cloned() {
            Some(p) => p,
            None => self.sync()?.get(id)?,
        };
        let tracks = playlist
            .items
            .iter()
            .map(|i| TrackRef {
                key: format!("{}:{}", i.source, i.key),
                extension: cyanomelody_core::source::extension_of(if i.source == "local" {
                    &i.key
                } else {
                    &i.title
                }),
            })
            .collect::<Vec<_>>();
        // Drive の曲は曲名から拡張子が分からないことがあるため、ライブラリの相対パスから求める
        let tracks = tracks
            .into_iter()
            .zip(&playlist.items)
            .map(|(mut t, i)| {
                if let Some(kind) = i.source_kind()
                    && let Ok(Some(song)) = self.library.song(kind, &i.key)
                {
                    t.extension = song.extension();
                }
                t
            })
            .collect();
        self.player.load(tracks, start);
        *self.playing.lock().unwrap() = Some(playlist);
        Ok(())
    }
}
