//! ローカルの音楽ソース。端末の指定フォルダとサブフォルダの曲を読む。

use std::fs::File;
use std::io::BufReader;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use symphonia::core::io::MediaSource;

use super::{FileEntry, MusicSource, SourceError, SourceKind, Tags, is_audio, tags};

pub struct LocalSource {
    root: PathBuf,
}

impl LocalSource {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 相対パス（`/` 区切り）から実際のパスを作る。指定フォルダの外を指すものは受け付けない。
    fn resolve(&self, relative: &str) -> Result<PathBuf, SourceError> {
        let rel = Path::new(relative);
        if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err(SourceError::Open(format!(
                "指定フォルダの外のパス: {relative}"
            )));
        }
        Ok(self.root.join(rel))
    }

    fn walk(&self, dir: &Path, prefix: &str, out: &mut Vec<FileEntry>) -> Result<(), SourceError> {
        let entries = std::fs::read_dir(dir)
            .map_err(|e| SourceError::Folder(format!("{}: {e}", dir.display())))?;
        for entry in entries {
            let entry = entry.map_err(|e| SourceError::Folder(e.to_string()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = format!("{prefix}{name}");
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(e) => {
                    log::warn!("{relative} の情報を読めない: {e}");
                    continue;
                }
            };
            if meta.is_dir() {
                self.walk(&entry.path(), &format!("{relative}/"), out)?;
            } else if is_audio(&name) {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                out.push(FileEntry {
                    key: relative.clone(),
                    relative_path: relative,
                    size: meta.len(),
                    modified,
                });
            }
        }
        Ok(())
    }
}

impl MusicSource for LocalSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Local
    }

    fn list(&self) -> Result<Vec<FileEntry>, SourceError> {
        let mut out = Vec::new();
        self.walk(&self.root, "", &mut out)?;
        out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(out)
    }

    fn read_tags(&self, entry: &FileEntry) -> Result<Tags, SourceError> {
        let file =
            File::open(self.resolve(&entry.key)?).map_err(|e| SourceError::Open(e.to_string()))?;
        tags::read_tags(BufReader::new(file))
    }

    fn open(&self, key: &str) -> Result<Box<dyn MediaSource>, SourceError> {
        let file =
            File::open(self.resolve(key)?).map_err(|e| SourceError::Open(format!("{key}: {e}")))?;
        Ok(Box::new(file))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::playback::decode::tests::wav;
    use lofty::config::WriteOptions;
    use lofty::prelude::*;
    use lofty::tag::{Tag, TagType};

    /// テスト用の曲を置く。`title` があれば RIFF INFO のタグを付ける。
    pub(crate) fn put_song(root: &Path, relative: &str, title: Option<(&str, &str, &str)>) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, wav(8000, 0.1)).unwrap();
        if let Some((title, artist, album)) = title {
            let mut tagged = lofty::read_from_path(&path).unwrap();
            let mut tag = Tag::new(TagType::RiffInfo);
            tag.set_title(title.into());
            tag.set_artist(artist.into());
            tag.set_album(album.into());
            tagged.insert_tag(tag);
            tagged.save_to_path(&path, WriteOptions::default()).unwrap();
        }
    }

    #[test]
    fn lists_audio_in_subfolders_with_japanese_names() {
        let dir = tempfile::tempdir().unwrap();
        put_song(dir.path(), "チャイム.wav", None);
        put_song(dir.path(), "サブフォルダ/深い/曲.WAV", None);
        std::fs::write(dir.path().join("メモ.txt"), "x").unwrap();
        let source = LocalSource::new(dir.path());
        let keys: Vec<String> = source.list().unwrap().into_iter().map(|e| e.key).collect();
        assert_eq!(keys, vec!["サブフォルダ/深い/曲.WAV", "チャイム.wav"]);
    }

    #[test]
    fn reads_tags_and_handles_missing_tags() {
        let dir = tempfile::tempdir().unwrap();
        put_song(
            dir.path(),
            "a.wav",
            Some(("叢", "虻瀬犬", "カルマーダルマ")),
        );
        put_song(dir.path(), "b.wav", None);
        let source = LocalSource::new(dir.path());
        let entries = source.list().unwrap();
        let tagged = source.read_tags(&entries[0]).unwrap();
        assert_eq!(tagged.title.as_deref(), Some("叢"));
        assert_eq!(tagged.artist.as_deref(), Some("虻瀬犬"));
        assert_eq!(tagged.album.as_deref(), Some("カルマーダルマ"));
        assert_eq!(source.read_tags(&entries[1]).unwrap(), Tags::default());
    }

    #[test]
    fn opens_songs_but_not_outside_root() {
        let dir = tempfile::tempdir().unwrap();
        put_song(dir.path(), "a.wav", None);
        let source = LocalSource::new(dir.path());
        assert!(source.open("a.wav").is_ok());
        assert!(source.open("../a.wav").is_err());
        assert!(source.open("missing.wav").is_err());
    }

    #[test]
    fn missing_root_is_an_error() {
        let source = LocalSource::new("Z:/存在しないフォルダ/cyanomelody");
        assert!(matches!(source.list(), Err(SourceError::Folder(_))));
    }
}
