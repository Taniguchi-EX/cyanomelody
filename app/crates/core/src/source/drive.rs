//! Google Drive の音楽ソース。指定フォルダとサブフォルダの曲を、ファイル ID で見分けて読む。

use std::sync::Arc;

use symphonia::core::io::MediaSource;

use super::{FileEntry, MusicSource, SourceError, SourceKind, Tags, is_audio, tags};
use crate::cache::{CacheFile, SongCache};
use crate::drive::{DriveClient, DriveError, DriveFile, RangeReader, parse_time};
use crate::parallel::map_parallel;

/// タグを読むときの取得の単位。タグは先頭か末尾の小さな範囲にあることが多い。
const TAG_CHUNK: u64 = 64 * 1024;
/// フォルダの一覧を並行して問い合わせる数。
const LIST_PARALLELISM: usize = 8;
/// 再生するときの取得の単位。
const PLAY_CHUNK: u64 = 256 * 1024;

/// キャッシュの足りない部分を裏で取得するときの単位。
const FILL_BYTES: u64 = 4 * 1024 * 1024;

pub struct DriveSource {
    client: DriveClient,
    folder_id: String,
    cache: Option<Arc<SongCache>>,
}

impl DriveSource {
    /// `folder_id` のフォルダを指定フォルダにする。
    pub fn new(client: DriveClient, folder_id: impl Into<String>) -> Self {
        Self { client, folder_id: folder_id.into(), cache: None }
    }

    /// 再生した曲を `cache` に保存し、次からはそこから再生する。
    pub fn with_cache(mut self, cache: Arc<SongCache>) -> Self {
        self.cache = Some(cache);
        self
    }
}

/// キャッシュの足りない部分を、裏で順に取得して埋める。
fn fill_in_background(client: DriveClient, key: String, file: Arc<CacheFile>) {
    std::thread::spawn(move || {
        for (start, end) in file.missing() {
            let mut pos = start;
            while pos < end {
                if file.is_complete() {
                    return;
                }
                let last = (pos + FILL_BYTES).min(end) - 1;
                match client.read_range(&key, pos, last) {
                    Ok(data) => file.write(pos, &data),
                    Err(e) => {
                        log::warn!("{key} のキャッシュを埋められない（次に再生したときにやり直す）: {e}");
                        return;
                    }
                }
                pos = last + 1;
            }
        }
    });
}

fn source_error(e: DriveError, open: bool) -> SourceError {
    match e {
        DriveError::Network(m) => SourceError::Offline(m),
        other if open => SourceError::Open(other.to_string()),
        other => SourceError::Folder(other.to_string()),
    }
}

fn file_entry(file: DriveFile, relative_path: String) -> FileEntry {
    FileEntry {
        modified: file.modified_time.as_deref().and_then(parse_time),
        size: file.size.unwrap_or(0),
        key: file.id,
        relative_path,
    }
}

impl MusicSource for DriveSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Drive
    }

    /// 指定フォルダとサブフォルダの曲。同じ深さのフォルダは並行して問い合わせる（1 回に約 0.3 秒かかるため）。
    fn list(&self) -> Result<Vec<FileEntry>, SourceError> {
        let mut out = Vec::new();
        let mut level = vec![(self.folder_id.clone(), String::new())];
        while !level.is_empty() {
            let children =
                map_parallel(&level, LIST_PARALLELISM, |(id, _)| self.client.list_children(id), |_, _| {});
            let mut next = Vec::new();
            for ((_, prefix), files) in level.iter().zip(children) {
                for file in files.map_err(|e| source_error(e, false))? {
                    let relative = format!("{prefix}{}", file.name);
                    if file.is_folder() {
                        next.push((file.id, format!("{relative}/")));
                    } else if is_audio(&file.name) {
                        out.push(file_entry(file, relative));
                    }
                }
            }
            level = next;
        }
        out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(out)
    }

    fn read_tags(&self, entry: &FileEntry) -> Result<Tags, SourceError> {
        tags::read_tags(RangeReader::new(self.client.clone(), &entry.key, entry.size, TAG_CHUNK))
    }

    fn open(&self, key: &str) -> Result<Box<dyn MediaSource>, SourceError> {
        if let Some(file) = self.cache.as_ref().and_then(|c| c.open_cached(key)) {
            return Ok(Box::new(file));
        }
        let file = self.client.file(key).map_err(|e| source_error(e, true))?;
        let len = file.size.ok_or_else(|| SourceError::Open(format!("{key} の大きさが分からない")))?;
        let reader = match &self.cache {
            Some(cache) => match cache.begin(key, len) {
                Ok(cache_file) => {
                    fill_in_background(self.client.clone(), key.to_string(), cache_file.clone());
                    RangeReader::with_cache(self.client.clone(), key, len, PLAY_CHUNK, cache_file)
                }
                Err(e) => {
                    log::warn!("キャッシュに書けないため、保存せずに再生する: {e}");
                    RangeReader::new(self.client.clone(), key, len, PLAY_CHUNK)
                }
            },
            None => RangeReader::new(self.client.clone(), key, len, PLAY_CHUNK),
        };
        Ok(Box::new(reader))
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
        let got: Vec<(&str, &str, u64)> =
            entries.iter().map(|e| (e.key.as_str(), e.relative_path.as_str(), e.size)).collect();
        assert_eq!(got, vec![(b.as_str(), "サブフォルダ/深い曲.m4a", 7), (a.as_str(), "曲.mp3", 5)]);
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
    fn caches_played_songs_and_plays_them_offline() {
        use crate::cache::{DEFAULT_MAX_BYTES, SongCache};
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};
        let dir = tempfile::tempdir().unwrap();
        let cache = SongCache::open(dir.path(), DEFAULT_MAX_BYTES).unwrap();
        let mock = MockDrive::start();
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 249) as u8).collect();
        let played = mock.add_file("root", "played.wav", data.clone());
        let unplayed = mock.add_file("root", "unplayed.wav", data.clone());
        let src = source(&mock, "root").with_cache(cache.clone());

        // 先頭だけ読んで閉じても、裏で残りを取得してキャッシュがそろう
        let mut head = vec![0u8; 1000];
        src.open(&played).unwrap().read_exact(&mut head).unwrap();
        let started = Instant::now();
        while !cache.is_cached(&played) && started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(cache.is_cached(&played));

        // 2 回目は通信せずにキャッシュから読む
        let before = mock.media_requests.load(Ordering::Relaxed);
        let mut out = Vec::new();
        src.open(&played).unwrap().read_to_end(&mut out).unwrap();
        assert_eq!(out, data);
        assert_eq!(mock.media_requests.load(Ordering::Relaxed), before);

        // 通信できないときは、キャッシュ済みの曲だけ開ける
        let offline = DriveSource::new(
            DriveClient::with_base("http://127.0.0.1:9", Arc::new(StaticToken("t".into()))),
            "root",
        )
        .with_cache(cache.clone());
        assert!(offline.open(&played).is_ok());
        assert!(matches!(offline.open(&unplayed), Err(SourceError::Offline(_))));
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
        assert!(lib.song(SourceKind::Drive, &id).unwrap().unwrap().missing, "消えた曲に印が付く");
    }
}
