//! ファイルの場所：Windows のパスか、Android の SAF の URI か。
//! ライブラリのファイルを読む所（ハッシュ値と長さ・曲名・ジャケット・タグ付け・エフェクト）は、この型から読む（`FileSource`）

use std::fs::File;
use std::io;
use std::path::PathBuf;

use crate::library::absolute_path;
use crate::saf;
use crate::source::FileSource;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    /// Windows のパス
    Path(PathBuf),
    /// SAF のファイル（FsUri の JSON）。name はファイル名（形式の手がかりの拡張子に使う）
    Saf { uri: String, name: String },
}

impl Location {
    /// ライブラリのファイルの場所。ファイルの URI（SAF のフォルダのファイルだけにある）があれば SAF、なければフォルダのパスと相対パスから
    pub fn of_file(folder: &str, rel_path: &str, uri: Option<String>) -> Location {
        match uri {
            Some(uri) => Location::Saf { uri, name: rel_path.rsplit('/').next().unwrap_or(rel_path).to_string() },
            None => Location::Path(absolute_path(folder, rel_path)),
        }
    }

    /// 画面に渡す場所：パスか、SAF の URI の JSON（画面は、JSON なら SAF のプロトコルで読む）
    pub fn to_display(&self) -> String {
        match self {
            Location::Path(p) => p.to_string_lossy().into_owned(),
            Location::Saf { uri, .. } => uri.clone(),
        }
    }

    /// パスの場所なら、そのパス
    pub fn as_path(&self) -> Option<&std::path::Path> {
        match self {
            Location::Path(p) => Some(p),
            Location::Saf { .. } => None,
        }
    }

    /// ファイルがあるか（SAF のファイルは、開けるか）
    pub fn exists(&self) -> bool {
        match self {
            Location::Path(p) => p.exists(),
            Location::Saf { uri, .. } => saf::open(uri).is_ok(),
        }
    }
}

impl FileSource for Location {
    fn open(&self) -> io::Result<File> {
        match self {
            Location::Path(p) => File::open(p),
            Location::Saf { uri, .. } => saf::open(uri),
        }
    }
    fn extension(&self) -> Option<String> {
        match self {
            Location::Path(p) => FileSource::extension(p),
            Location::Saf { name, .. } => FileSource::extension(std::path::Path::new(name)),
        }
    }
    fn identity(&self) -> String {
        self.to_display()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn location_of_file() {
        let path = Location::of_file("C:\\lib", "sub/a.wav", None);
        assert_eq!(path, Location::Path(PathBuf::from("C:\\lib").join("sub").join("a.wav")));
        let saf = Location::of_file("{\"uri\":\"content://x\"}", "sub/b.MP3", Some("{\"uri\":\"content://y\"}".into()));
        assert_eq!(saf.to_display(), "{\"uri\":\"content://y\"}");
        assert_eq!(saf.extension().as_deref(), Some("MP3"));
        assert!(saf.has_extension("mp3"));
    }
}
