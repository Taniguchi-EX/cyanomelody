//! ライブラリフォルダの登録とスキャン

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use walkdir::WalkDir;

use crate::db::now;
use crate::error::{Error, Result};
use crate::location::Location;
use crate::saf;

pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "ogg", "m4a"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub id: i64,
    /// パス（SAF のフォルダは FsUri の JSON）
    pub path: String,
    /// 場所の種類（"path"・"saf"）
    pub kind: String,
    /// 画面に出す名前（パスのフォルダはパス、SAF のフォルダは「Music/効果音」など）
    pub label: String,
    pub file_count: i64,
    pub missing_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub folder_id: i64,
    /// スキャンで見つかったファイルの数
    pub found: usize,
    pub added: usize,
    /// 新しくひも付けが切れたファイルの数
    pub missing: usize,
    /// ひも付けが切れていたが、同じ場所に戻ってきたファイルの数
    pub restored: usize,
    #[serde(skip)]
    pub elapsed_ms: u128,
}

pub fn list_folders(conn: &Connection) -> Result<Vec<LibraryFolder>> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.path, f.kind,
                (SELECT count(*) FROM audio_files a WHERE a.folder_id = f.id),
                (SELECT count(*) FROM audio_files a WHERE a.folder_id = f.id AND a.missing = 1)
         FROM library_folders f ORDER BY f.path",
    )?;
    let rows = stmt.query_map([], |r| {
        let path: String = r.get(1)?;
        let kind: String = r.get(2)?;
        let label = if kind == KIND_SAF { saf::display_name(&path) } else { path.clone() };
        Ok(LibraryFolder {
            id: r.get(0)?,
            path,
            kind,
            label,
            file_count: r.get(3)?,
            missing_count: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// ライブラリフォルダのパスと、その中の相対パス（区切りは `/`）から、ファイルの絶対パスを作る
pub fn absolute_path(folder: &str, rel_path: &str) -> PathBuf {
    Path::new(folder).join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// フォルダの場所の種類：パス・SAF のフォルダ
pub const KIND_PATH: &str = "path";
pub const KIND_SAF: &str = "saf";

/// フォルダのパス（SAF のフォルダは FsUri の JSON）と、場所の種類
pub fn folder_record(conn: &Connection, folder_id: i64) -> Result<(String, String)> {
    conn.query_row("SELECT path, kind FROM library_folders WHERE id = ?1", [folder_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| Error::invalid("登録されていないフォルダです"))
}

pub fn folder_path(conn: &Connection, folder_id: i64) -> Result<PathBuf> {
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM library_folders WHERE id = ?1",
            [folder_id],
            |r| r.get(0),
        )
        .optional()?;
    path.map(PathBuf::from)
        .ok_or_else(|| Error::invalid("登録されていないフォルダです"))
}

/// フォルダを登録する。スキャンは呼び出し側で行う。
pub fn add_folder(conn: &Connection, path: &Path) -> Result<i64> {
    if !path.is_dir() {
        return Err(Error::invalid(format!(
            "フォルダが見つかりません: {}",
            path.display()
        )));
    }
    let path = dunce::canonicalize(path)?;
    let key = comparable(&path);
    for folder in list_folders(conn)? {
        let other = comparable(Path::new(&folder.path));
        if key == other {
            return Err(Error::invalid("このフォルダは既に登録されています"));
        }
        if key.starts_with(&other) {
            return Err(Error::invalid(format!(
                "登録済みのフォルダの中にあるため登録できません: {}",
                folder.path
            )));
        }
        if other.starts_with(&key) {
            return Err(Error::invalid(format!(
                "登録済みのフォルダを含むため登録できません: {}",
                folder.path
            )));
        }
    }
    conn.execute(
        "INSERT INTO library_folders (path, added_at) VALUES (?1, ?2)",
        params![path.to_string_lossy(), now()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// SAF のフォルダ（選んで権限を残したもの。uri は FsUri の JSON）を登録する。スキャンは呼び出し側で行う
pub fn add_saf_folder(conn: &Connection, uri: &str) -> Result<i64> {
    // 同じフォルダ・登録済みのフォルダの中・登録済みのフォルダを含むフォルダは登録できない（パスのフォルダと同じ決まり）。
    // フォルダの場所の名前（「primary:Music/効果音」など。大文字・小文字は区別しない）で比べる
    let key = saf::document_id(uri).unwrap_or_else(|| uri.to_string()).to_lowercase();
    for folder in list_folders(conn)?.into_iter().filter(|f| f.kind == KIND_SAF) {
        let other = saf::document_id(&folder.path).unwrap_or(folder.path.clone()).to_lowercase();
        let inside = |a: &str, b: &str| a.strip_prefix(b).is_some_and(|rest| rest.starts_with('/') || b.ends_with(':'));
        if key == other {
            return Err(Error::invalid("このフォルダは既に登録されています"));
        }
        if inside(&key, &other) {
            return Err(Error::invalid(format!("登録済みのフォルダの中にあるため登録できません: {}", folder.label)));
        }
        if inside(&other, &key) {
            return Err(Error::invalid(format!("登録済みのフォルダを含むため登録できません: {}", folder.label)));
        }
    }
    conn.execute(
        "INSERT INTO library_folders (path, kind, added_at) VALUES (?1, ?2, ?3)",
        params![uri, KIND_SAF, now()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// フォルダの登録を解除する。ファイルの情報と、付けたタグ・出典・ライセンスの設定、プレイリストの項目も消える。実際のファイルは消さない。
pub fn remove_folder(conn: &Connection, folder_id: i64) -> Result<()> {
    let n = conn.execute("DELETE FROM library_folders WHERE id = ?1", [folder_id])?;
    if n == 0 {
        return Err(Error::invalid("登録されていないフォルダです"));
    }
    Ok(())
}

/// Windowsのパスは大文字・小文字を区別しないので、比べるときは小文字にそろえる
pub(crate) fn comparable(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().to_lowercase())
}

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.iter().any(|a| a.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// root の中（サブフォルダを含む）の音声ファイルのパス。シンボリックリンクはたどらず、読めないフォルダは飛ばす
pub fn audio_files_under(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_audio_file(e.path()))
        .map(|e| e.into_path())
        .collect()
}

struct FoundFile {
    rel_path: String,
    size: i64,
    modified_at: i64,
    /// SAF のフォルダのファイルの FsUri の JSON（パスのフォルダでは None）
    uri: Option<String>,
}

fn walk(root: &Path) -> Vec<FoundFile> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        // 読めないフォルダなどは飛ばす
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_audio_file(e.path()))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let rel = e.path().strip_prefix(root).ok()?;
            let rel_path = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let modified_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(FoundFile {
                rel_path,
                size: meta.len() as i64,
                modified_at,
                uri: None,
            })
        })
        .collect()
}

pub fn scan_folder(conn: &mut Connection, folder_id: i64) -> Result<ScanResult> {
    let started = Instant::now();
    let (root, kind) = folder_record(conn, folder_id)?;
    let found = if kind == KIND_SAF {
        // SAF のフォルダ：権限がなくなった（端末の設定で取り消した・フォルダを消した）ときは、フォルダがないのと同じ
        if !saf::readable(&root) {
            return Err(Error::invalid(format!(
                "フォルダが見つからないか、読む許可がないため、スキャンできませんでした: {}",
                saf::display_name(&root)
            )));
        }
        saf::list_files(&root, AUDIO_EXTENSIONS)?
            .into_iter()
            .map(|f| FoundFile { rel_path: f.rel_path, size: f.size, modified_at: f.modified_at, uri: Some(f.uri) })
            .collect()
    } else {
        let root = PathBuf::from(&root);
        if !root.is_dir() {
            return Err(Error::invalid(format!(
                "フォルダが見つからないため、スキャンできませんでした: {}",
                root.display()
            )));
        }
        walk(&root)
    };

    let tx = conn.transaction()?;
    let mut result = ScanResult {
        folder_id,
        found: found.len(),
        added: 0,
        missing: 0,
        restored: 0,
        elapsed_ms: 0,
    };
    {
        // 相対パス → (id, ひも付けが切れているか)
        let mut existing: HashMap<String, (i64, bool)> = HashMap::new();
        let mut stmt =
            tx.prepare("SELECT id, rel_path, missing FROM audio_files WHERE folder_id = ?1")?;
        let rows = stmt.query_map([folder_id], |r| {
            Ok((r.get::<_, String>(1)?, (r.get::<_, i64>(0)?, r.get::<_, bool>(2)?)))
        })?;
        for row in rows {
            let (rel, v) = row?;
            existing.insert(rel, v);
        }

        let mut insert = tx.prepare(
            "INSERT INTO audio_files (folder_id, rel_path, size, modified_at, missing, added_at, uri)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
        )?;
        let mut update = tx.prepare(
            // サイズか更新日時が変わったら、ハッシュ値と長さ・リリース年を消して計算し直させる
            "UPDATE audio_files SET
                hash = CASE WHEN size = ?2 AND modified_at = ?3 THEN hash END,
                hash_error = CASE WHEN size = ?2 AND modified_at = ?3 THEN hash_error END,
                duration = CASE WHEN size = ?2 AND modified_at = ?3 THEN duration END,
                duration_done = CASE WHEN size = ?2 AND modified_at = ?3 THEN duration_done ELSE 0 END,
                release_year = CASE WHEN size = ?2 AND modified_at = ?3 THEN release_year END,
                release_year_done = CASE WHEN size = ?2 AND modified_at = ?3 THEN release_year_done ELSE 0 END,
                size = ?2, modified_at = ?3, missing = 0, uri = ?4
             WHERE id = ?1",
        )?;
        let mut mark_missing = tx.prepare("UPDATE audio_files SET missing = 1 WHERE id = ?1")?;

        let added_at = now();
        let mut seen: HashSet<&str> = HashSet::with_capacity(found.len());
        for f in &found {
            seen.insert(&f.rel_path);
            match existing.get(&f.rel_path) {
                Some(&(id, was_missing)) => {
                    update.execute(params![id, f.size, f.modified_at, f.uri])?;
                    if was_missing {
                        result.restored += 1;
                    }
                }
                None => {
                    insert.execute(params![folder_id, f.rel_path, f.size, f.modified_at, added_at, f.uri])?;
                    result.added += 1;
                }
            }
        }
        for (rel, &(id, was_missing)) in &existing {
            if !was_missing && !seen.contains(rel.as_str()) {
                mark_missing.execute([id])?;
                result.missing += 1;
            }
        }
    }
    tx.commit()?;
    result.elapsed_ms = started.elapsed().as_millis();
    Ok(result)
}

/// ファイルの場所（パスのフォルダはフォルダのパスと相対パスから、SAF のフォルダはファイルの URI）
pub fn file_location(conn: &Connection, file_id: i64) -> Result<Location> {
    conn.query_row(
        "SELECT f.path, a.rel_path, a.uri FROM audio_files a JOIN library_folders f ON f.id = a.folder_id WHERE a.id = ?1",
        [file_id],
        |r| Ok(Location::of_file(&r.get::<_, String>(0)?, &r.get::<_, String>(1)?, r.get(2)?)),
    )
    .map_err(|_| Error::invalid("ファイルが見つかりません"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use std::fs;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"dummy").unwrap();
    }

    #[test]
    fn audio_extensions_ignore_case() {
        assert!(is_audio_file(Path::new("a.MP3")));
        assert!(is_audio_file(Path::new("a.m4a")));
        assert!(!is_audio_file(Path::new("a.txt")));
        assert!(!is_audio_file(Path::new("mp3")));
    }

    #[test]
    fn add_folder_rejects_nested_and_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("parent");
        let child = parent.join("child");
        fs::create_dir_all(&child).unwrap();
        let conn = open_in_memory().unwrap();

        add_folder(&conn, &parent).unwrap();
        assert!(add_folder(&conn, &parent).is_err());
        assert!(add_folder(&conn, &child).is_err());

        let conn = open_in_memory().unwrap();
        add_folder(&conn, &child).unwrap();
        assert!(add_folder(&conn, &parent).is_err());
    }

    #[test]
    fn add_folder_allows_sibling_with_common_prefix() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("se")).unwrap();
        fs::create_dir_all(dir.path().join("se2")).unwrap();
        let conn = open_in_memory().unwrap();
        add_folder(&conn, &dir.path().join("se")).unwrap();
        add_folder(&conn, &dir.path().join("se2")).unwrap();
    }

    #[test]
    fn add_folder_rejects_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_in_memory().unwrap();
        assert!(add_folder(&conn, &dir.path().join("none")).is_err());
    }

    #[test]
    fn scan_adds_marks_and_restores() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("a.wav"));
        touch(&root.join("sub/b.MP3"));
        touch(&root.join("sub/readme.txt"));
        let mut conn = open_in_memory().unwrap();
        let id = add_folder(&conn, root).unwrap();

        let r = scan_folder(&mut conn, id).unwrap();
        assert_eq!((r.found, r.added, r.missing, r.restored), (2, 2, 0, 0));
        let rels: Vec<String> = conn
            .prepare("SELECT rel_path FROM audio_files ORDER BY rel_path")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(rels, vec!["a.wav", "sub/b.MP3"]);

        // 2回目は何も変わらない
        let r = scan_folder(&mut conn, id).unwrap();
        assert_eq!((r.found, r.added, r.missing, r.restored), (2, 0, 0, 0));

        // 消すと印が付く
        fs::remove_file(root.join("a.wav")).unwrap();
        let r = scan_folder(&mut conn, id).unwrap();
        assert_eq!((r.found, r.added, r.missing, r.restored), (1, 0, 1, 0));
        let missing: bool = conn
            .query_row("SELECT missing FROM audio_files WHERE rel_path = 'a.wav'", [], |r| r.get(0))
            .unwrap();
        assert!(missing);

        // もう一度スキャンしても数え直さない
        let r = scan_folder(&mut conn, id).unwrap();
        assert_eq!(r.missing, 0);

        // 戻すと印が外れる
        touch(&root.join("a.wav"));
        let r = scan_folder(&mut conn, id).unwrap();
        assert_eq!((r.found, r.added, r.missing, r.restored), (2, 0, 0, 1));
    }

    #[test]
    fn scan_clears_hash_only_when_file_changed() {
        let dir = tempfile::tempdir().unwrap();
        touch(&dir.path().join("a.wav"));
        touch(&dir.path().join("b.wav"));
        let mut conn = open_in_memory().unwrap();
        let id = add_folder(&conn, dir.path()).unwrap();
        scan_folder(&mut conn, id).unwrap();
        conn.execute("UPDATE audio_files SET hash = 'h', hash_error = NULL, duration = 1.5, duration_done = 1", [])
            .unwrap();

        fs::write(dir.path().join("b.wav"), b"changed content").unwrap();
        scan_folder(&mut conn, id).unwrap();
        fn hash(conn: &Connection, rel: &str) -> Option<String> {
            conn.query_row("SELECT hash FROM audio_files WHERE rel_path = ?1", [rel], |r| r.get(0))
                .unwrap()
        }
        assert_eq!(hash(&conn, "a.wav").as_deref(), Some("h"));
        assert_eq!(hash(&conn, "b.wav"), None);
        // 長さも同じく、変わったファイルだけ調べ直させる
        let duration = |rel: &str| -> (Option<f64>, i64) {
            conn.query_row("SELECT duration, duration_done FROM audio_files WHERE rel_path = ?1", [rel], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(duration("a.wav"), (Some(1.5), 1));
        assert_eq!(duration("b.wav"), (None, 0));

        // 見つからなくなってもハッシュ値は残す
        fs::remove_file(dir.path().join("a.wav")).unwrap();
        scan_folder(&mut conn, id).unwrap();
        assert_eq!(hash(&conn, "a.wav").as_deref(), Some("h"));
    }

    #[test]
    fn scan_fails_without_marking_when_folder_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("lib");
        touch(&root.join("a.wav"));
        let mut conn = open_in_memory().unwrap();
        let id = add_folder(&conn, &root).unwrap();
        scan_folder(&mut conn, id).unwrap();

        fs::remove_dir_all(&root).unwrap();
        assert!(scan_folder(&mut conn, id).is_err());
        let missing: i64 = conn
            .query_row("SELECT count(*) FROM audio_files WHERE missing = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(missing, 0);
    }

    #[test]
    fn remove_folder_deletes_files() {
        let dir = tempfile::tempdir().unwrap();
        touch(&dir.path().join("a.wav"));
        let mut conn = open_in_memory().unwrap();
        let id = add_folder(&conn, dir.path()).unwrap();
        scan_folder(&mut conn, id).unwrap();
        remove_folder(&conn, id).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM audio_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        assert!(dir.path().join("a.wav").exists());
    }

    /// 3万ファイルのスキャン時間を測る。時間がかかるので通常は実行しない。
    /// cargo test --release scan_30000_files -- --ignored --nocapture
    #[test]
    #[ignore]
    fn scan_30000_files() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..30_000 {
            let path = dir.path().join(format!("d{:03}/s{:05}.wav", i / 300, i));
            if i % 300 == 0 {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
            }
            fs::write(&path, b"x").unwrap();
        }
        let mut conn = crate::db::open(&dir.path().join("test.db")).unwrap();
        let id = add_folder(&conn, dir.path()).unwrap();
        let first = scan_folder(&mut conn, id).unwrap();
        let second = scan_folder(&mut conn, id).unwrap();
        println!(
            "初回: {} 件 {} ms / 2回目: {} 件 {} ms",
            first.added, first.elapsed_ms, second.found, second.elapsed_ms
        );
        assert_eq!(first.added, 30_000);
    }

    /// SAF のフォルダの URI の JSON（テスト用）
    fn saf_uri(doc: &str) -> String {
        let enc = doc.replace(':', "%3A").replace('/', "%2F");
        format!(r#"{{"uri":"content://com.android.externalstorage.documents/tree/{enc}/document/{enc}","documentTopTreeUri":null}}"#)
    }

    #[test]
    fn saf_folders_must_not_overlap() {
        let conn = open_in_memory().unwrap();
        let id = add_saf_folder(&conn, &saf_uri("primary:Music/効果音")).unwrap();
        let folders = list_folders(&conn).unwrap();
        assert_eq!((folders[0].id, folders[0].kind.as_str(), folders[0].label.as_str()), (id, KIND_SAF, "Music/効果音"));
        // 同じフォルダ（大文字・小文字の違いだけも）・中のフォルダ・外側のフォルダは登録できない
        assert!(add_saf_folder(&conn, &saf_uri("primary:Music/効果音")).is_err());
        assert!(add_saf_folder(&conn, &saf_uri("primary:music/効果音")).is_err());
        assert!(add_saf_folder(&conn, &saf_uri("primary:Music/効果音/雨")).is_err());
        assert!(add_saf_folder(&conn, &saf_uri("primary:Music")).is_err());
        assert!(add_saf_folder(&conn, &saf_uri("primary:")).is_err());
        // 名前の頭が同じだけのフォルダ・別のボリュームは登録できる
        add_saf_folder(&conn, &saf_uri("primary:Music/効果音2")).unwrap();
        add_saf_folder(&conn, &saf_uri("1234-ABCD:Music/効果音")).unwrap();
    }
}
