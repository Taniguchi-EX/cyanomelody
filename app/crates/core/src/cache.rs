//! 曲のキャッシュ。Google Drive の曲を、再生しながら端末に保存する。
//!
//! - 再生のために取得した部分（`RangeReader` が取得したもの）を、そのままファイルに書く
//! - 足りない部分は裏で取得して埋め、全体がそろったらキャッシュとして登録する
//! - 次からは端末のファイルから再生する（通信がなくても再生できる）
//! - 最大容量を超えたら、最後に再生されてから最も時間がたった曲から消す

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};

/// 最大容量の既定値（2GB）。
pub const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CacheError {
    #[error("キャッシュを読み書きできない: {0}")]
    Io(String),
    #[error("キャッシュの索引のエラー: {0}")]
    Database(String),
}

impl From<std::io::Error> for CacheError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<rusqlite::Error> for CacheError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e.to_string())
    }
}

/// 今の日時（UNIX 時間のミリ秒）。同じ秒の中でも、再生した順が分かるようにする。
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct SongCache {
    dir: PathBuf,
    conn: Mutex<Connection>,
    max_bytes: AtomicU64,
    /// 書き込み中のファイル（同じ曲を二重に書かないため）
    writing: Mutex<HashMap<String, Weak<CacheFile>>>,
}

impl SongCache {
    /// `dir` のキャッシュを開く。前回の書きかけのファイルは消す。
    pub fn open(dir: &Path, max_bytes: u64) -> Result<Arc<Self>, CacheError> {
        std::fs::create_dir_all(dir)?;
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "part") {
                let _ = std::fs::remove_file(path);
            }
        }
        let conn = Connection::open(dir.join("cache.sqlite"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS songs (
                key         TEXT PRIMARY KEY,
                size        INTEGER NOT NULL,
                last_played INTEGER NOT NULL
            );",
        )?;
        let cache = Arc::new(Self {
            dir: dir.to_path_buf(),
            conn: Mutex::new(conn),
            max_bytes: AtomicU64::new(max_bytes),
            writing: Mutex::new(HashMap::new()),
        });
        cache.forget_missing_files()?;
        Ok(cache)
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{}.bin", sanitize(key)))
    }

    /// 索引にあるのにファイルがないもの（手で消された）を、索引から除く。
    fn forget_missing_files(&self) -> Result<(), CacheError> {
        let conn = self.conn.lock().unwrap();
        let keys: Vec<String> = conn
            .prepare("SELECT key FROM songs")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for key in keys {
            if !self.path(&key).exists() {
                conn.execute("DELETE FROM songs WHERE key = ?1", params![key])?;
            }
        }
        Ok(())
    }

    /// キャッシュ済みなら、ファイルを開いて返す（最後に再生した日時を更新する）。
    pub fn open_cached(&self, key: &str) -> Option<File> {
        let conn = self.conn.lock().unwrap();
        let size: Option<i64> = conn
            .query_row("SELECT size FROM songs WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten();
        let size = size?;
        let file = File::open(self.path(key)).ok()?;
        if file.metadata().ok()?.len() != size as u64 {
            return None;
        }
        let _ = conn.execute(
            "UPDATE songs SET last_played = ?2 WHERE key = ?1",
            params![key, now()],
        );
        Some(file)
    }

    pub fn is_cached(&self, key: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1 FROM songs WHERE key = ?1", params![key], |_| {
            Ok(())
        })
        .optional()
        .ok()
        .flatten()
        .is_some()
    }

    /// 書き込みを始める。同じ曲を書き込み中なら、それを返す。
    pub fn begin(self: &Arc<Self>, key: &str, len: u64) -> Result<Arc<CacheFile>, CacheError> {
        let mut writing = self.writing.lock().unwrap();
        if let Some(existing) = writing.get(key).and_then(Weak::upgrade) {
            return Ok(existing);
        }
        let part = self.dir.join(format!("{}.part", sanitize(key)));
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&part)?;
        file.set_len(len)?;
        let cf = Arc::new(CacheFile {
            cache: Arc::downgrade(self),
            key: key.to_string(),
            len,
            part,
            inner: Mutex::new(Inner {
                file,
                covered: Vec::new(),
                done: false,
            }),
        });
        writing.insert(key.to_string(), Arc::downgrade(&cf));
        Ok(cf)
    }

    /// 全体がそろったファイルを登録し、最大容量に収める。
    fn finish(&self, key: &str, part: &Path, len: u64) -> Result<(), CacheError> {
        std::fs::rename(part, self.path(key))?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO songs (key, size, last_played) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET size = excluded.size, last_played = excluded.last_played",
            params![key, len as i64, now()],
        )?;
        self.writing.lock().unwrap().remove(key);
        log::info!("キャッシュに保存した: {key}（{len} バイト）");
        self.evict(Some(key))
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes.load(Ordering::Relaxed)
    }

    /// 最大容量を変え、超えていれば消す。
    pub fn set_max_bytes(&self, max_bytes: u64) -> Result<(), CacheError> {
        self.max_bytes.store(max_bytes, Ordering::Relaxed);
        self.evict(None)
    }

    /// キャッシュ済みの曲の合計の大きさ。
    pub fn used_bytes(&self) -> Result<u64, CacheError> {
        let conn = self.conn.lock().unwrap();
        Ok(
            conn.query_row("SELECT COALESCE(SUM(size), 0) FROM songs", [], |r| {
                r.get::<_, i64>(0)
            })? as u64,
        )
    }

    /// 最大容量を超えていれば、最後に再生されてから最も時間がたった曲から消す。`keep` は消さない。
    fn evict(&self, keep: Option<&str>) -> Result<(), CacheError> {
        let max = self.max_bytes();
        let conn = self.conn.lock().unwrap();
        let mut used: i64 =
            conn.query_row("SELECT COALESCE(SUM(size), 0) FROM songs", [], |r| r.get(0))?;
        let victims: Vec<(String, i64)> = conn
            .prepare("SELECT key, size FROM songs ORDER BY last_played ASC, rowid ASC")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (key, size) in victims {
            if used as u64 <= max {
                break;
            }
            if Some(key.as_str()) == keep {
                continue;
            }
            let _ = std::fs::remove_file(self.path(&key));
            conn.execute("DELETE FROM songs WHERE key = ?1", params![key])?;
            used -= size;
            log::info!("キャッシュから消した: {key}");
        }
        Ok(())
    }
}

/// ファイル名に使えない文字を置き換える（Drive のファイル ID は英数字と `-`、`_` だけだが、念のため）。
fn sanitize(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 書き込み中の 1 曲。取得した範囲を記録し、全体がそろったらキャッシュに登録する。
pub struct CacheFile {
    cache: Weak<SongCache>,
    key: String,
    len: u64,
    part: PathBuf,
    inner: Mutex<Inner>,
}

struct Inner {
    file: File,
    /// 書き込んだ範囲（重ならず、昇順の `[start, end)`）
    covered: Vec<(u64, u64)>,
    done: bool,
}

impl Inner {
    fn add(&mut self, start: u64, end: u64) {
        self.covered.push((start, end));
        self.covered.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::with_capacity(self.covered.len());
        for &(s, e) in &self.covered {
            match merged.last_mut() {
                Some(last) if s <= last.1 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        self.covered = merged;
    }

    fn covers(&self, start: u64, end: u64) -> bool {
        self.covered.iter().any(|&(s, e)| s <= start && end <= e)
    }
}

impl CacheFile {
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn is_complete(&self) -> bool {
        self.inner.lock().unwrap().done
    }

    /// 取得した `data` を `start` の位置に書く。全体がそろったらキャッシュに登録する。
    pub fn write(&self, start: u64, data: &[u8]) {
        let complete = {
            let mut inner = self.inner.lock().unwrap();
            if inner.done || data.is_empty() {
                return;
            }
            let end = (start + data.len() as u64).min(self.len);
            if inner.covers(start, end) {
                return;
            }
            let ok = inner
                .file
                .seek(SeekFrom::Start(start))
                .and_then(|_| inner.file.write_all(&data[..(end - start) as usize]));
            if let Err(e) = ok {
                log::warn!("キャッシュに書けない: {e}");
                return;
            }
            inner.add(start, end);
            let complete = inner.covers(0, self.len);
            if complete {
                inner.done = true;
                let _ = inner.file.flush();
            }
            complete
        };
        if complete
            && let Some(cache) = self.cache.upgrade()
            && let Err(e) = cache.finish(&self.key, &self.part, self.len)
        {
            log::warn!("キャッシュに登録できない: {e}");
        }
    }

    /// `[start, start + buf.len())` を書き込み済みなら読んで真を返す。
    pub fn read(&self, start: u64, buf: &mut [u8]) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.done {
            // 登録済みのファイルは名前が変わっているため、書き込み中の印だけで判断できない
            return false;
        }
        if !inner.covers(start, start + buf.len() as u64) {
            return false;
        }
        inner
            .file
            .seek(SeekFrom::Start(start))
            .and_then(|_| inner.file.read_exact(buf))
            .is_ok()
    }

    /// まだ書いていない範囲（`[start, end)`）。
    pub fn missing(&self) -> Vec<(u64, u64)> {
        let inner = self.inner.lock().unwrap();
        let mut out = Vec::new();
        let mut pos = 0;
        for &(s, e) in &inner.covered {
            if s > pos {
                out.push((pos, s));
            }
            pos = pos.max(e);
        }
        if pos < self.len {
            out.push((pos, self.len));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn completes_when_every_range_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SongCache::open(dir.path(), DEFAULT_MAX_BYTES).unwrap();
        let data = bytes(1000);
        let cf = cache.begin("abc", 1000).unwrap();
        cf.write(500, &data[500..800]);
        cf.write(0, &data[0..300]);
        assert_eq!(cf.missing(), vec![(300, 500), (800, 1000)]);
        assert!(!cache.is_cached("abc"));
        let mut buf = [0u8; 100];
        assert!(cf.read(600, &mut buf), "書いた範囲は読める");
        assert_eq!(&buf[..], &data[600..700]);
        assert!(
            !cf.read(250, &mut buf),
            "まだ書いていない範囲を含むと読めない"
        );
        cf.write(300, &data[300..500]);
        cf.write(800, &data[800..1000]);
        assert!(cf.is_complete());
        let mut out = Vec::new();
        cache
            .open_cached("abc")
            .unwrap()
            .read_to_end(&mut out)
            .unwrap();
        assert_eq!(out, data);
    }

    #[test]
    fn evicts_least_recently_played() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SongCache::open(dir.path(), 2500).unwrap();
        for key in ["a", "b"] {
            cache.begin(key, 1000).unwrap().write(0, &bytes(1000));
        }
        // a を再生したので、b のほうが古くなる
        std::thread::sleep(std::time::Duration::from_millis(10));
        cache.open_cached("a").unwrap();
        cache.begin("c", 1000).unwrap().write(0, &bytes(1000));
        assert!(cache.is_cached("a"));
        assert!(
            !cache.is_cached("b"),
            "最後に再生されてから最も時間がたった曲が消える"
        );
        assert!(cache.is_cached("c"));
        assert_eq!(cache.used_bytes().unwrap(), 2000);
        cache.set_max_bytes(1000).unwrap();
        assert_eq!(
            cache.used_bytes().unwrap(),
            1000,
            "最大容量を下げると、超えたぶんを消す"
        );
    }

    #[test]
    fn survives_reopen_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        {
            let cache = SongCache::open(dir.path(), DEFAULT_MAX_BYTES).unwrap();
            cache.begin("done", 10).unwrap().write(0, &bytes(10));
            let half = cache.begin("half", 10).unwrap();
            half.write(0, &bytes(5));
            drop(half); // 書きかけのまま終わった（.part が残る）
        }
        assert!(dir.path().join("half.part").exists());
        let cache = SongCache::open(dir.path(), DEFAULT_MAX_BYTES).unwrap();
        assert!(cache.is_cached("done"), "開き直しても残る");
        assert!(!dir.path().join("half.part").exists(), "書きかけは消す");
        drop(cache);
        std::fs::remove_file(dir.path().join("done.bin")).unwrap();
        let cache = SongCache::open(dir.path(), DEFAULT_MAX_BYTES).unwrap();
        assert!(!cache.is_cached("done"), "ファイルがなければ索引から除く");
    }

    #[test]
    fn same_song_shares_one_writer() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SongCache::open(dir.path(), DEFAULT_MAX_BYTES).unwrap();
        let a = cache.begin("x", 10).unwrap();
        let b = cache.begin("x", 10).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
    }
}
