//! ライブラリ。音楽ソースの曲の一覧とタグ情報を、端末の SQLite にキャッシュする。
//! 手動更新（`refresh`）で読み直し、見つからなくなった曲には印（`missing`）を付ける。

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};

use crate::parallel::map_parallel;
use crate::source::{MusicSource, SourceError, SourceKind, Tags, extension_of};

/// タグを並行して読む数の既定値。
pub const DEFAULT_PARALLELISM: usize = 8;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS songs (
    source        TEXT    NOT NULL,
    key           TEXT    NOT NULL,
    relative_path TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    artist        TEXT,
    album         TEXT,
    size          INTEGER NOT NULL,
    modified      INTEGER,
    -- 前回の手動更新で見つからなかった
    missing       INTEGER NOT NULL DEFAULT 0,
    -- タグを読めた（読めなかった曲は次の手動更新で読み直す）
    tags_read     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, key)
);
";

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LibraryError {
    #[error("ライブラリのデータベースのエラー: {0}")]
    Database(String),
    #[error(transparent)]
    Source(#[from] SourceError),
}

impl From<rusqlite::Error> for LibraryError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e.to_string())
    }
}

/// ライブラリの 1 曲。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Song {
    pub source: SourceKind,
    pub key: String,
    pub relative_path: String,
    /// タグの曲名。タグがなければファイル名（拡張子を除く）
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// 前回の手動更新で見つからなかった
    pub missing: bool,
}

impl Song {
    pub fn extension(&self) -> String {
        extension_of(&self.relative_path)
    }
}

/// 手動更新の結果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RefreshReport {
    /// 新しく見つかった曲
    pub added: usize,
    /// 更新日時や大きさが変わり、タグを読み直した曲
    pub updated: usize,
    /// 変わらなかった曲
    pub unchanged: usize,
    /// 見つからなくなった曲
    pub missing: usize,
    /// タグを読めなかった曲（ファイル名を曲名にした）
    pub tag_failures: usize,
}

/// フォルダをたどる画面のための、あるフォルダの直下の中身。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderListing {
    /// サブフォルダの名前
    pub folders: Vec<String>,
    pub songs: Vec<Song>,
}

pub struct Library {
    conn: Mutex<Connection>,
}

impl Library {
    /// `path` のデータベースを開く（なければ作る）。
    pub fn open(path: &Path) -> Result<Self, LibraryError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| LibraryError::Database(e.to_string()))?;
        }
        Self::init(Connection::open(path)?)
    }

    /// メモリ上のデータベース（テスト用）。
    pub fn open_in_memory() -> Result<Self, LibraryError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, LibraryError> {
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 音楽ソースの曲を読み直す。新しい曲と変わった曲だけ、タグを `parallelism` 件ずつ並行して読む。
    /// `progress` には、タグを読み終えた数と読む数の合計が渡される。
    pub fn refresh(
        &self,
        source: &dyn MusicSource,
        parallelism: usize,
        progress: &(dyn Fn(usize, usize) + Sync),
    ) -> Result<RefreshReport, LibraryError> {
        // 一覧を取れないとき（フォルダがない、通信できない）は、ライブラリを変えずにエラーを返す
        let entries = source.list()?;
        let kind = source.kind();
        let known = self.known(kind)?;

        let mut report = RefreshReport::default();
        let mut to_read = Vec::new();
        for entry in &entries {
            match known.get(&entry.key) {
                None => {
                    report.added += 1;
                    to_read.push(entry);
                }
                Some(k) if k.size != entry.size as i64 || k.modified != entry.modified || !k.tags_read => {
                    report.updated += 1;
                    to_read.push(entry);
                }
                Some(_) => report.unchanged += 1,
            }
        }

        let tags = map_parallel(&to_read, parallelism, |e| source.read_tags(e), progress);

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("UPDATE songs SET missing = 1 WHERE source = ?1", params![kind.as_str()])?;
        for (entry, result) in to_read.iter().zip(tags) {
            let (tags, tags_read) = match result {
                Ok(t) => (t, true),
                Err(e) => {
                    log::warn!("{} のタグを読めない: {e}", entry.relative_path);
                    report.tag_failures += 1;
                    (Tags::default(), false)
                }
            };
            tx.execute(
                "INSERT INTO songs (source, key, relative_path, title, artist, album, size, modified, missing, tags_read)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)
                 ON CONFLICT (source, key) DO UPDATE SET
                   relative_path = excluded.relative_path, title = excluded.title, artist = excluded.artist,
                   album = excluded.album, size = excluded.size, modified = excluded.modified,
                   missing = 0, tags_read = excluded.tags_read",
                params![
                    kind.as_str(),
                    entry.key,
                    entry.relative_path,
                    tags.title.unwrap_or_else(|| entry.file_stem().to_string()),
                    tags.artist,
                    tags.album,
                    entry.size as i64,
                    entry.modified,
                    tags_read,
                ],
            )?;
        }
        // 変わらなかった曲は、相対パス（Drive ではフォルダの移動で変わる）だけ更新する
        let read_keys: HashSet<&str> = to_read.iter().map(|e| e.key.as_str()).collect();
        for entry in entries.iter().filter(|e| !read_keys.contains(e.key.as_str())) {
            tx.execute(
                "UPDATE songs SET missing = 0, relative_path = ?3 WHERE source = ?1 AND key = ?2",
                params![kind.as_str(), entry.key, entry.relative_path],
            )?;
        }
        report.missing = tx.query_row(
            "SELECT COUNT(*) FROM songs WHERE source = ?1 AND missing = 1",
            params![kind.as_str()],
            |r| r.get::<_, i64>(0),
        )? as usize;
        tx.commit()?;
        Ok(report)
    }

    fn known(&self, kind: SourceKind) -> Result<HashMap<String, Known>, LibraryError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, size, modified, tags_read FROM songs WHERE source = ?1")?;
        let rows = stmt.query_map(params![kind.as_str()], |r| {
            Ok((r.get::<_, String>(0)?, Known { size: r.get(1)?, modified: r.get(2)?, tags_read: r.get(3)? }))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// ソースの曲をすべて、相対パスの順に返す（見つからなくなった曲も含む）。
    pub fn songs(&self, kind: SourceKind) -> Result<Vec<Song>, LibraryError> {
        self.query("WHERE source = ?1 ORDER BY relative_path", params![kind.as_str()])
    }

    pub fn song(&self, kind: SourceKind, key: &str) -> Result<Option<Song>, LibraryError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                &format!("{SELECT_SONG} WHERE source = ?1 AND key = ?2"),
                params![kind.as_str(), key],
                row_to_song,
            )
            .optional()?)
    }

    /// `folder`（`""` は指定フォルダそのもの、`"a/b"` のように `/` 区切り）の直下のサブフォルダと曲。
    /// 見つからなくなった曲は含めない。
    pub fn browse(&self, kind: SourceKind, folder: &str) -> Result<FolderListing, LibraryError> {
        let prefix = folder_prefix(folder);
        let mut folders = BTreeSet::new();
        let mut songs = Vec::new();
        for song in self.songs_under(kind, folder)? {
            match song.relative_path[prefix.len()..].split_once('/') {
                Some((sub, _)) => {
                    folders.insert(sub.to_string());
                }
                None => songs.push(song),
            }
        }
        Ok(FolderListing { folders: folders.into_iter().collect(), songs })
    }

    /// `folder` とそのサブフォルダの曲（フォルダ単位でプレイリストに追加するとき用）。見つからなくなった曲は含めない。
    /// 絞り込みは SQLite で行い、ほかのフォルダの曲は読まない。
    pub fn songs_under(&self, kind: SourceKind, folder: &str) -> Result<Vec<Song>, LibraryError> {
        let prefix = folder_prefix(folder);
        self.query(
            "WHERE source = ?1 AND missing = 0 AND substr(relative_path, 1, length(?2)) = ?2 ORDER BY relative_path",
            params![kind.as_str(), prefix],
        )
    }

    fn query(&self, clause: &str, params: impl rusqlite::Params) -> Result<Vec<Song>, LibraryError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{SELECT_SONG} {clause}"))?;
        let rows = stmt.query_map(params, row_to_song)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

struct Known {
    size: i64,
    modified: Option<i64>,
    tags_read: bool,
}

const SELECT_SONG: &str = "SELECT source, key, relative_path, title, artist, album, missing FROM songs";

fn row_to_song(r: &rusqlite::Row<'_>) -> rusqlite::Result<Song> {
    let source: String = r.get(0)?;
    Ok(Song {
        source: SourceKind::parse(&source).unwrap_or(SourceKind::Local),
        key: r.get(1)?,
        relative_path: r.get(2)?,
        title: r.get(3)?,
        artist: r.get(4)?,
        album: r.get(5)?,
        missing: r.get(6)?,
    })
}

fn folder_prefix(folder: &str) -> String {
    let folder = folder.trim_matches('/');
    if folder.is_empty() { String::new() } else { format!("{folder}/") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::local::LocalSource;
    use crate::source::local::tests::put_song;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn no_progress(_: usize, _: usize) {}

    #[test]
    fn refresh_adds_songs_with_tags_or_file_names() {
        let dir = tempfile::tempdir().unwrap();
        put_song(dir.path(), "a.wav", Some(("叢", "虻瀬犬", "カルマーダルマ")));
        put_song(dir.path(), "サブ/タグなし.wav", None);
        let lib = Library::open_in_memory().unwrap();
        let report = lib.refresh(&LocalSource::new(dir.path()), 4, &no_progress).unwrap();
        assert_eq!(report, RefreshReport { added: 2, ..Default::default() });
        let songs = lib.songs(SourceKind::Local).unwrap();
        assert_eq!(songs[0].title, "叢");
        assert_eq!(songs[0].artist.as_deref(), Some("虻瀬犬"));
        assert_eq!(songs[1].title, "タグなし", "タグがなければファイル名");
        assert_eq!(songs[1].relative_path, "サブ/タグなし.wav");
        assert_eq!(songs[1].extension(), "wav");
    }

    #[test]
    fn refresh_marks_missing_and_detects_changes() {
        let dir = tempfile::tempdir().unwrap();
        put_song(dir.path(), "a.wav", None);
        put_song(dir.path(), "b.wav", None);
        let lib = Library::open_in_memory().unwrap();
        let source = LocalSource::new(dir.path());
        lib.refresh(&source, 2, &no_progress).unwrap();

        std::fs::remove_file(dir.path().join("a.wav")).unwrap();
        put_song(dir.path(), "c.wav", None);
        let report = lib.refresh(&source, 2, &no_progress).unwrap();
        assert_eq!(report, RefreshReport { added: 1, unchanged: 1, missing: 1, ..Default::default() });
        let a = lib.song(SourceKind::Local, "a.wav").unwrap().unwrap();
        assert!(a.missing, "消えた曲に印が付く");

        // 戻ってきたら印が消える
        put_song(dir.path(), "a.wav", None);
        lib.refresh(&source, 2, &no_progress).unwrap();
        assert!(!lib.song(SourceKind::Local, "a.wav").unwrap().unwrap().missing);
    }

    #[test]
    fn refresh_failure_keeps_library() {
        let dir = tempfile::tempdir().unwrap();
        put_song(dir.path(), "a.wav", None);
        let lib = Library::open_in_memory().unwrap();
        lib.refresh(&LocalSource::new(dir.path()), 2, &no_progress).unwrap();
        let missing_root = LocalSource::new(dir.path().join("なし"));
        assert!(lib.refresh(&missing_root, 2, &no_progress).is_err());
        assert!(
            !lib.song(SourceKind::Local, "a.wav").unwrap().unwrap().missing,
            "一覧を取れなければ変えない"
        );
    }

    #[test]
    fn browse_and_songs_under() {
        let dir = tempfile::tempdir().unwrap();
        for p in ["1.wav", "x/2.wav", "x/y/3.wav", "x/y/4.wav", "z/5.wav"] {
            put_song(dir.path(), p, None);
        }
        let lib = Library::open_in_memory().unwrap();
        lib.refresh(&LocalSource::new(dir.path()), 2, &no_progress).unwrap();
        let top = lib.browse(SourceKind::Local, "").unwrap();
        assert_eq!(top.folders, vec!["x", "z"]);
        assert_eq!(top.songs.len(), 1);
        let x = lib.browse(SourceKind::Local, "x/").unwrap();
        assert_eq!(x.folders, vec!["y"]);
        assert_eq!(x.songs[0].relative_path, "x/2.wav");
        let under: Vec<String> =
            lib.songs_under(SourceKind::Local, "x").unwrap().into_iter().map(|s| s.key).collect();
        assert_eq!(under, vec!["x/2.wav", "x/y/3.wav", "x/y/4.wav"]);
    }

    #[test]
    fn reports_progress_and_persists_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..20 {
            put_song(&dir.path().join("曲"), &format!("{i:02}.wav"), None);
        }
        let db = dir.path().join("db/library.sqlite");
        let calls = AtomicUsize::new(0);
        {
            let lib = Library::open(&db).unwrap();
            lib.refresh(&LocalSource::new(dir.path().join("曲")), 8, &|done, total| {
                assert!(done <= total && total == 20);
                calls.fetch_add(1, Ordering::Relaxed);
            })
            .unwrap();
        }
        assert_eq!(calls.load(Ordering::Relaxed), 20);
        let reopened = Library::open(&db).unwrap();
        assert_eq!(reopened.songs(SourceKind::Local).unwrap().len(), 20, "開き直しても残る");
    }
}
