//! アプリの中核の部品をまとめて持ち、画面からの操作を受ける。
//!
//! 曲を見分ける値は、再生エンジンとの間では頭に `drive:` か `local:` を付け、
//! どちらの音楽ソースから開くかを見分ける。

use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

use cyanomelody_core::cache::SongCache;
use cyanomelody_core::drive::{DriveClient, TokenProvider};
use cyanomelody_core::library::{DEFAULT_PARALLELISM, Library, RefreshReport};
use cyanomelody_core::playback::output::CpalOutput;
use cyanomelody_core::playback::{EventHandler, MediaSource, PlaybackError, Player, TrackOpener, TrackRef};
use cyanomelody_core::source::drive::DriveSource;
use cyanomelody_core::source::local::LocalSource;
use cyanomelody_core::source::{MusicSource, SourceKind, extension_of};
use cyanomelody_core::sync::{Playlist, PlaylistItem, PlaylistSummary, Settings, SyncStore};

use crate::local_store::{LocalConfig, LocalStore};
use crate::ui::{UiError, UiItem, UiListing, UiPlaylist, UiResult};

/// 再生エンジンが開く音楽ソース。設定が変わったら差し替える。
#[derive(Default)]
struct Sources {
    drive: Option<Arc<DriveSource>>,
    local: Option<Arc<LocalSource>>,
}

impl Sources {
    fn get(&self, kind: SourceKind) -> Option<Arc<dyn MusicSource>> {
        match kind {
            SourceKind::Drive => self.drive.clone().map(|s| s as Arc<dyn MusicSource>),
            SourceKind::Local => self.local.clone().map(|s| s as Arc<dyn MusicSource>),
        }
    }
}

/// 再生エンジンの曲（`drive:<ID>` や `local:<相対パス>`）を開く。
fn open_track(sources: &RwLock<Sources>, track: &TrackRef) -> Result<Box<dyn MediaSource>, PlaybackError> {
    let (kind, key) = track
        .key
        .split_once(':')
        .and_then(|(kind, key)| Some((SourceKind::parse(kind)?, key)))
        .ok_or_else(|| PlaybackError::Open(format!("曲を見分ける値が正しくない: {}", track.key)))?;
    // 曲を開く間（Drive では通信を待つ）に設定を変えられるよう、音楽ソースを取り出してから開く
    let source = sources
        .read()
        .unwrap()
        .get(kind)
        .ok_or_else(|| PlaybackError::Open(format!("{kind} の指定フォルダが設定されていない")))?;
    source.open(key).map_err(|e| PlaybackError::Open(e.to_string()))
}

fn cannot_login() -> UiError {
    UiError::new("login", "Google Drive にログインできない端末です")
}

fn source_kind(s: &str) -> UiResult<SourceKind> {
    SourceKind::parse(s).ok_or_else(|| UiError::error(format!("知らない音楽ソース: {s}")))
}

pub struct AppCore {
    pub device_id: String,
    pub library: Arc<Library>,
    pub cache: Arc<SongCache>,
    pub player: Player,
    sources: Arc<RwLock<Sources>>,
    /// Drive の呼び出し口（ログインできる端末だけ）
    drive_client: Option<DriveClient>,
    sync: Option<SyncStore>,
    /// 端末に保存するもの（端末の設定、最後に読んだ設定とプレイリスト）
    store: LocalStore,
    /// 再生中のプレイリスト
    pub playing: Mutex<Option<Playlist>>,
}

impl AppCore {
    pub fn new(
        data_dir: &Path,
        cache_dir: &Path,
        tokens: Option<Arc<dyn TokenProvider>>,
        events: EventHandler,
    ) -> Result<Self, String> {
        let device_id = cyanomelody_core::device::load_or_create(data_dir).map_err(|e| e.to_string())?;
        let library = Arc::new(Library::open(&data_dir.join("library.sqlite")).map_err(|e| e.to_string())?);
        let store = LocalStore::open(data_dir);
        let config = store.config();
        let cache = SongCache::open(cache_dir, config.cache_max_bytes).map_err(|e| e.to_string())?;
        let sources: Arc<RwLock<Sources>> = Arc::default();
        let opener_sources = sources.clone();
        let opener: TrackOpener = Arc::new(move |track: &TrackRef| open_track(&opener_sources, track));
        let player = Player::new(|| Box::new(CpalOutput::default()), opener, events);
        // Android では OS の音量を使うため、アプリ内の音量は変えない
        if cfg!(desktop) {
            player.set_volume(config.volume);
        }
        let drive_client = tokens.map(DriveClient::new);
        let core = Self {
            device_id,
            library,
            cache,
            player,
            sources,
            sync: drive_client.clone().map(SyncStore::new),
            drive_client,
            store,
            playing: Mutex::default(),
        };
        // オフラインで起動しても指定フォルダの曲を開けるよう、最後に読んだ設定を当てておく
        if let Some(settings) = core.store.settings() {
            core.apply_settings(&settings);
        }
        Ok(core)
    }

    fn sync(&self) -> UiResult<&SyncStore> {
        self.sync.as_ref().ok_or_else(cannot_login)
    }

    pub fn drive_client(&self) -> UiResult<&DriveClient> {
        self.drive_client.as_ref().ok_or_else(cannot_login)
    }

    pub fn local_config(&self) -> LocalConfig {
        self.store.config()
    }

    pub fn set_volume(&self, volume: f32) {
        self.player.set_volume(volume);
        self.store.edit_config(|c| c.volume = volume);
    }

    pub fn set_cache_max(&self, bytes: u64) -> UiResult<()> {
        self.cache.set_max_bytes(bytes)?;
        self.store.edit_config(|c| c.cache_max_bytes = bytes);
        Ok(())
    }

    /// 最後に読んだ設定（端末に保存したもの）。
    pub fn cached_settings(&self) -> Option<Settings> {
        self.store.settings()
    }

    /// 設定（Drive で共有）を読み、音楽ソースを差し替える。
    pub fn load_settings(&self) -> UiResult<Settings> {
        let settings = self.sync()?.settings()?;
        self.apply_settings(&settings);
        Ok(settings)
    }

    pub fn edit_settings(&self, edit: impl FnOnce(&mut Settings)) -> UiResult<Settings> {
        let settings = self.sync()?.edit_settings(edit)?;
        self.apply_settings(&settings);
        Ok(settings)
    }

    /// 設定に合わせて音楽ソースを差し替え、端末にも保存する。
    fn apply_settings(&self, settings: &Settings) {
        self.store.save_settings(settings);
        let drive = match (&settings.drive_folder, &self.drive_client) {
            (Some(folder), Some(client)) => Some(Arc::new(
                DriveSource::new(client.clone(), folder.id.clone()).with_cache(self.cache.clone()),
            )),
            _ => None,
        };
        let local = settings.local_folder(&self.device_id).map(|f| Arc::new(LocalSource::new(&f.path)));
        *self.sources.write().unwrap() = Sources { drive, local };
    }

    /// 指定フォルダの曲を読み直す（手動更新）。`progress` には (ソース, 読み終えた数, 合計) が渡される。
    pub fn refresh_library(
        &self,
        progress: &(dyn Fn(SourceKind, usize, usize) + Sync),
    ) -> UiResult<Vec<(SourceKind, RefreshReport)>> {
        let mut reports = Vec::new();
        for kind in [SourceKind::Local, SourceKind::Drive] {
            let Some(source) = self.sources.read().unwrap().get(kind) else { continue };
            let report =
                self.library.refresh(source.as_ref(), DEFAULT_PARALLELISM, &|d, t| progress(kind, d, t))?;
            reports.push((kind, report));
        }
        Ok(reports)
    }

    pub fn browse(&self, source: &str, folder: &str) -> UiResult<UiListing> {
        Ok(self.library.browse(source_kind(source)?, folder)?.into())
    }

    fn ui_playlist(&self, p: &Playlist) -> UiPlaylist {
        let items = p
            .items
            .iter()
            .map(|i| UiItem {
                source: i.source.clone(),
                key: i.key.clone(),
                title: i.title.clone(),
                artist: i.artist.clone(),
                available: i.is_available(&self.device_id, &self.library),
            })
            .collect();
        UiPlaylist { id: p.id.clone(), name: p.name.clone(), favorite: p.favorite, items }
    }

    /// Drive から読んだプレイリストを端末にも保存し、画面に返す形にする。
    fn remember(&self, p: &Playlist) -> UiPlaylist {
        self.store.save_playlist(p);
        self.ui_playlist(p)
    }

    /// プレイリストの一覧。オフラインのときは、端末に保存したものをエラーに添える。
    pub fn list_playlists(&self) -> UiResult<Vec<PlaylistSummary>> {
        match self.sync()?.list() {
            Ok(list) => {
                self.store.keep_playlists(&list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>());
                Ok(list)
            }
            Err(e) => Err(UiError::from(e).with_cached(&self.store.playlist_summaries())),
        }
    }

    /// プレイリストを Drive から読む。オフラインのときは、端末に保存したものをエラーに添える。
    pub fn get_playlist(&self, id: &str) -> UiResult<UiPlaylist> {
        match self.sync()?.get(id) {
            Ok(p) => Ok(self.remember(&p)),
            Err(e) => {
                Err(UiError::from(e).with_cached(&self.store.playlist(id).map(|p| self.ui_playlist(&p))))
            }
        }
    }

    pub fn create_playlist(&self, name: &str) -> UiResult<UiPlaylist> {
        let p = self.sync()?.create(name)?;
        Ok(self.remember(&p))
    }

    pub fn delete_playlist(&self, id: &str) -> UiResult<()> {
        self.sync()?.delete(id)?;
        self.store.remove_playlist(id);
        Ok(())
    }

    /// プレイリストを編集する（最新を読み直してから当てて保存する）。
    pub fn edit_playlist(&self, id: &str, edit: impl FnOnce(&mut Playlist)) -> UiResult<UiPlaylist> {
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
        let songs = match (folder, key) {
            (Some(folder), _) => self.library.songs_under(kind, folder)?,
            (None, Some(key)) => self.library.song(kind, key)?.into_iter().collect(),
            (None, None) => return Err(UiError::error("追加するフォルダか曲を指定してください")),
        };
        Ok(songs.iter().map(|s| PlaylistItem::from_song(s, &self.device_id)).collect())
    }

    /// 形式の推定の手がかりにする拡張子。ライブラリの相対パスから求める。ライブラリにないときは、
    /// ローカルの曲なら曲を見分ける値（相対パス）から求め、Drive の曲なら空にする（中身から推定させる）。
    fn extension_of_item(&self, item: &PlaylistItem) -> String {
        let kind = item.source_kind();
        match kind.and_then(|k| self.library.song(k, &item.key).ok().flatten()) {
            Some(song) => song.extension(),
            None if kind == Some(SourceKind::Local) => extension_of(&item.key),
            None => String::new(),
        }
    }

    /// プレイリストを `start` 番目の曲から再生する。最後に読んだ内容を使う（オフラインでも再生できる）。
    pub fn play_playlist(&self, id: &str, start: usize) -> UiResult<()> {
        let playlist = match self.store.playlist(id) {
            Some(p) => p,
            None => self.sync()?.get(id)?,
        };
        let tracks = playlist
            .items
            .iter()
            .map(|i| TrackRef {
                key: format!("{}:{}", i.source, i.key),
                extension: self.extension_of_item(i),
            })
            .collect();
        self.player.load(tracks, start);
        *self.playing.lock().unwrap() = Some(playlist);
        Ok(())
    }

    /// 再生中の曲（プレイリストの `index` 番目）の曲名とアーティスト。
    pub fn playing_item(&self, index: Option<usize>) -> Option<PlaylistItem> {
        self.playing.lock().unwrap().as_ref()?.items.get(index?).cloned()
    }
}
