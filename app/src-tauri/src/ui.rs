//! 画面に返す値とエラーの形。

use cyanomelody_core::cache::CacheError;
use cyanomelody_core::drive::DriveError;
use cyanomelody_core::library::{FolderListing, LibraryError, Song};
use cyanomelody_core::source::SourceError;
use cyanomelody_core::sync::SyncError;
use serde::Serialize;

/// 画面に返すエラー。`kind` で画面の出し分けをする（`offline` ならオフライン、`login` ならログインが必要）。
#[derive(Debug, Clone, Serialize)]
pub struct UiError {
    pub kind: &'static str,
    pub message: String,
    /// オフラインのとき、代わりに表示できる端末に保存した内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<serde_json::Value>,
}

pub type UiResult<T> = Result<T, UiError>;

impl UiError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), cached: None }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self::new("error", message)
    }

    /// オフラインのエラーに、端末に保存した内容を添える。
    pub fn with_cached(mut self, cached: &impl Serialize) -> Self {
        if self.kind == "offline" {
            self.cached = serde_json::to_value(cached).ok();
        }
        self
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

impl From<LibraryError> for UiError {
    fn from(e: LibraryError) -> Self {
        let kind = match &e {
            LibraryError::Source(SourceError::Offline(_)) => "offline",
            _ => "error",
        };
        Self::new(kind, e.to_string())
    }
}

impl From<CacheError> for UiError {
    fn from(e: CacheError) -> Self {
        Self::error(e.to_string())
    }
}

/// プレイリストの曲。
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

/// ライブラリの曲（曲を選ぶ画面で使う）。
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

/// フォルダの直下のサブフォルダと曲。
#[derive(Debug, Clone, Serialize)]
pub struct UiListing {
    pub folders: Vec<String>,
    pub songs: Vec<UiSong>,
}

impl From<FolderListing> for UiListing {
    fn from(l: FolderListing) -> Self {
        Self { folders: l.folders, songs: l.songs.iter().map(UiSong::from).collect() }
    }
}
