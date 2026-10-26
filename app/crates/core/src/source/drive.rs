//! Google Drive の音楽ソース。指定フォルダとサブフォルダの曲を、ファイル ID で見分けて読む。

use symphonia::core::io::MediaSource;

use super::{FileEntry, MusicSource, SourceError, SourceKind, Tags, is_audio, tags};
use crate::drive::{DriveClient, DriveError, RangeReader, parse_time};

/// タグを読むときの取得の単位。タグは先頭か末尾の小さな範囲にあることが多い。
const TAG_CHUNK: u64 = 64 * 1024;
/// 再生するときの取得の単位。
const PLAY_CHUNK: u64 = 256 * 1024;

pub struct DriveSource {
    client: DriveClient,
    folder_id: String,
}

impl DriveSource {
    /// `folder_id` のフォルダを指定フォルダにする。
    pub fn new(client: DriveClient, folder_id: impl Into<String>) -> Self {
        Self {
            client,
            folder_id: folder_id.into(),
        }
    }
}

fn source_error(e: DriveError, open: bool) -> SourceError {
    match e {
        DriveError::Network(m) => SourceError::Offline(m),
        other if open => SourceError::Open(other.to_string()),
        other => SourceError::Folder(other.to_string()),
    }
}

impl MusicSource for DriveSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Drive
    }

    fn list(&self) -> Result<Vec<FileEntry>, SourceError> {
        let mut out = Vec::new();
        let mut folders = vec![(self.folder_id.clone(), String::new())];
        while let Some((id, prefix)) = folders.pop() {
            for file in self
                .client
                .list_children(&id)
                .map_err(|e| source_error(e, false))?
            {
                let relative = format!("{prefix}{}", file.name);
                if file.is_folder() {
                    folders.push((file.id, format!("{relative}/")));
                } else if is_audio(&file.name) {
                    out.push(FileEntry {
                        key: file.id,
                        relative_path: relative,
                        size: file.size.unwrap_or(0),
                        modified: file.modified_time.as_deref().and_then(parse_time),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(out)
    }

    fn read_tags(&self, entry: &FileEntry) -> Result<Tags, SourceError> {
        tags::read_tags(RangeReader::new(
            self.client.clone(),
            &entry.key,
            entry.size,
            TAG_CHUNK,
        ))
    }

    fn open(&self, key: &str) -> Result<Box<dyn MediaSource>, SourceError> {
        let file = self.client.file(key).map_err(|e| source_error(e, true))?;
        let len = file
            .size
            .ok_or_else(|| SourceError::Open(format!("{key} の大きさが分からない")))?;
        Ok(Box::new(RangeReader::new(
            self.client.clone(),
            key,
            len,
            PLAY_CHUNK,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive::StaticToken;
    use crate::drive::mock::MockDrive;
    use crate::library::Library;
    use crate::playback::decode::tests::wav;
    use std::io::Read;
    use std::sync::Arc;

    fn source(mock: &MockDrive, folder: &str) -> DriveSource {
        let client = DriveClient::with_base(&mock.base_url(), Arc::new(StaticToken("t".into())));
        DriveSource::new(client, folder)
    }

    #[test]
    fn lists_audio_recursively_with_relative_paths() {
        let mock = MockDrive::start();
        let root = mock.add_folder("root", "music");
        let sub = mock.add_folder(&root, "サブフォルダ");
        let a = mock.add_file(&root, "曲.mp3", vec![0; 5]);
        let b = mock.add_file(&sub, "深い曲.m4a", vec![0; 7]);
        mock.add_file(&root, "メモ.txt", vec![0; 1]);
        let entries = source(&mock, &root).list().unwrap();
        let got: Vec<(&str, &str, u64)> = entries
            .iter()
            .map(|e| (e.key.as_str(), e.relative_path.as_str(), e.size))
            .collect();
        assert_eq!(
            got,
            vec![
                (b.as_str(), "サブフォルダ/深い曲.m4a", 7),
                (a.as_str(), "曲.mp3", 5)
            ]
        );
        assert!(entries[0].modified.is_some());
    }

    #[test]
    fn opens_and_reads_tags_through_ranges() {
        let mock = MockDrive::start();
        let data = wav(8000, 1.0);
        let id = mock.add_file("root", "a.wav", data.clone());
        let src = source(&mock, "root");
        let mut out = Vec::new();
        src.open(&id).unwrap().read_to_end(&mut out).unwrap();
        assert_eq!(out, data);
        let entry = src.list().unwrap().remove(0);
        assert_eq!(src.read_tags(&entry).unwrap(), Tags::default());
    }

    #[test]
    fn offline_is_reported_and_library_is_kept() {
        let mock = MockDrive::start();
        let id = mock.add_file("root", "a.wav", wav(8000, 0.1));
        let lib = Library::open_in_memory().unwrap();
        lib.refresh(&source(&mock, "root"), 4, &|_, _| {}).unwrap();
        let offline = DriveSource::new(
            DriveClient::with_base("http://127.0.0.1:9", Arc::new(StaticToken("t".into()))),
            "root",
        );
        assert!(matches!(offline.list(), Err(SourceError::Offline(_))));
        assert!(lib.refresh(&offline, 4, &|_, _| {}).is_err());
        assert!(
            !lib.song(SourceKind::Drive, &id).unwrap().unwrap().missing,
            "通信できなくてもライブラリは変えない"
        );

        mock.remove(&id);
        lib.refresh(&source(&mock, "root"), 4, &|_, _| {}).unwrap();
        assert!(
            lib.song(SourceKind::Drive, &id).unwrap().unwrap().missing,
            "消えた曲に印が付く"
        );
    }
}
