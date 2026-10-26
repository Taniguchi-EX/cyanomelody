//! 音楽ソース。Google Drive やローカルのフォルダなど、曲の置き場所ごとの違いをこの窓口の裏に隠す。
//! ソースを足すときは `MusicSource` を実装する。

pub mod drive;
pub mod local;
pub mod tags;

use std::fmt;

use symphonia::core::io::MediaSource;

pub use tags::Tags;

/// 対応する音声形式の拡張子（小文字）。
pub const AUDIO_EXTENSIONS: [&str; 3] = ["mp3", "wav", "m4a"];

/// 曲の置き場所の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Local,
    Drive,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Drive => "drive",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "local" => Some(Self::Local),
            "drive" => Some(Self::Drive),
            _ => None,
        }
    }
}

impl fmt::Display for SourceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 指定フォルダの中の 1 ファイル。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    /// ソースの中で曲を見分ける値。ローカルは指定フォルダからの相対パス（`/` 区切り）、Drive はファイル ID
    pub key: String,
    /// 指定フォルダからの相対パス（`/` 区切り）。フォルダをたどる画面と、タグがないときの曲名に使う
    pub relative_path: String,
    pub size: u64,
    /// 更新日時（UNIX 時間の秒）。変わっていなければタグを読み直さない
    pub modified: Option<i64>,
}

impl FileEntry {
    /// 拡張子（小文字）。
    pub fn extension(&self) -> String {
        extension_of(&self.relative_path)
    }

    /// ファイル名から拡張子を除いたもの。タグに曲名がないときの曲名にする。
    pub fn file_stem(&self) -> &str {
        let name = self
            .relative_path
            .rsplit('/')
            .next()
            .unwrap_or(&self.relative_path);
        name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name)
    }
}

/// パスの拡張子（小文字）。
pub fn extension_of(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// 対応する音声形式か。
pub fn is_audio(path: &str) -> bool {
    AUDIO_EXTENSIONS.contains(&extension_of(path).as_str())
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SourceError {
    /// 指定フォルダがない、読めない
    #[error("フォルダを読めない: {0}")]
    Folder(String),
    /// 曲を開けない
    #[error("曲を開けない: {0}")]
    Open(String),
    /// タグを読めない
    #[error("タグを読めない: {0}")]
    Tags(String),
    /// 通信できない（Drive）
    #[error("通信できない: {0}")]
    Offline(String),
}

/// 音楽ソースの共通の窓口。複数のスレッドから同時に呼ばれる。
pub trait MusicSource: Send + Sync {
    fn kind(&self) -> SourceKind;

    /// 指定フォルダとサブフォルダの曲を一覧にする。
    fn list(&self) -> Result<Vec<FileEntry>, SourceError>;

    /// 曲のタグを読む。
    fn read_tags(&self, entry: &FileEntry) -> Result<Tags, SourceError>;

    /// 曲を開く。再生エンジンは、ここで返したものをデコードする。
    fn open(&self, key: &str) -> Result<Box<dyn MediaSource>, SourceError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_and_stem() {
        let e = FileEntry {
            key: "a".into(),
            relative_path: "サブ/曲名.テスト.MP3".into(),
            size: 0,
            modified: None,
        };
        assert_eq!(e.extension(), "mp3");
        assert_eq!(e.file_stem(), "曲名.テスト");
        assert!(is_audio("x/y.M4A"));
        assert!(!is_audio("x/y.flac"));
        assert!(!is_audio("noext"));
    }

    #[test]
    fn source_kind_round_trip() {
        for k in [SourceKind::Local, SourceKind::Drive] {
            assert_eq!(SourceKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(SourceKind::parse("x"), None);
    }
}
