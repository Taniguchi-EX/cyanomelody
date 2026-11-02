//! 音声ファイルの一覧・絞り込みとタグの付け外し

use std::path::Path;

use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::tags::{get_or_create_tag, TAG_SEPARATOR};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFile {
    pub id: i64,
    pub folder_id: i64,
    pub rel_path: String,
    /// 絶対パス（試聴に使う）
    pub path: String,
    pub size: i64,
    pub modified_at: i64,
    pub missing: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FileFilter {
    /// ファイル名（相対パス）の部分一致
    pub text: String,
    /// すべてのタグが付いたファイルに絞り込む
    pub tag_ids: Vec<i64>,
    pub untagged_only: bool,
    pub missing_only: bool,
}

pub fn list_files(conn: &Connection, filter: &FileFilter) -> Result<Vec<AudioFile>> {
    let mut sql = String::from(
        "SELECT a.id, a.folder_id, a.rel_path, f.path, a.size, a.modified_at, a.missing,
                (SELECT group_concat(t.name, char(31)) FROM file_tags ft
                   JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = a.id)
         FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
         WHERE 1 = 1",
    );
    let mut args: Vec<Value> = Vec::new();
    let text = filter.text.trim();
    if !text.is_empty() {
        sql.push_str(" AND a.rel_path LIKE ? ESCAPE '\\'");
        args.push(Value::Text(format!("%{}%", escape_like(text))));
    }
    for tag_id in &filter.tag_ids {
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = a.id AND ft.tag_id = ?)",
        );
        args.push(Value::Integer(*tag_id));
    }
    if filter.untagged_only {
        sql.push_str(" AND NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = a.id)");
    }
    if filter.missing_only {
        sql.push_str(" AND a.missing = 1");
    }
    sql.push_str(" ORDER BY f.path, a.rel_path");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        let folder_path: String = r.get(3)?;
        let rel_path: String = r.get(2)?;
        let tags: Option<String> = r.get(7)?;
        let mut tags: Vec<String> = tags
            .map(|s| s.split(TAG_SEPARATOR).map(str::to_owned).collect())
            .unwrap_or_default();
        tags.sort_by_key(|t| t.to_lowercase());
        Ok(AudioFile {
            id: r.get(0)?,
            folder_id: r.get(1)?,
            path: Path::new(&folder_path)
                .join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR))
                .to_string_lossy()
                .into_owned(),
            rel_path,
            size: r.get(4)?,
            modified_at: r.get(5)?,
            missing: r.get(6)?,
            tags,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn add_tag(conn: &mut Connection, file_ids: &[i64], tag_name: &str) -> Result<i64> {
    let tx = conn.transaction()?;
    let tag_id = get_or_create_tag(&tx, tag_name)?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO file_tags (file_id, tag_id)
             SELECT id, ?2 FROM audio_files WHERE id = ?1",
        )?;
        for id in file_ids {
            stmt.execute(params![id, tag_id])?;
        }
    }
    tx.commit()?;
    Ok(tag_id)
}

pub fn remove_tag(conn: &mut Connection, file_ids: &[i64], tag_id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM file_tags WHERE file_id = ?1 AND tag_id = ?2")?;
        for id in file_ids {
            stmt.execute(params![id, tag_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// ひも付けが切れたファイルをライブラリから外す。印が付いていないファイルは外さない。
/// 外したファイルの数を返す。
pub fn remove_missing_files(conn: &mut Connection, file_ids: &[i64]) -> Result<usize> {
    let tx = conn.transaction()?;
    let mut removed = 0;
    {
        let mut stmt = tx.prepare("DELETE FROM audio_files WHERE id = ?1 AND missing = 1")?;
        for id in file_ids {
            removed += stmt.execute([id])?;
        }
    }
    tx.commit()?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::library::{add_folder, scan_folder};
    use crate::tags::{list_tags, Tag};
    use std::fs;

    /// a.wav, b.mp3, sub/c_100%.flac を置いたフォルダを登録・スキャンしたDB
    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        for p in ["a.wav", "b.mp3", "sub/c_100%.flac"] {
            let path = dir.path().join(p);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
        }
        let mut conn = open_in_memory().unwrap();
        let id = add_folder(&conn, dir.path()).unwrap();
        scan_folder(&mut conn, id).unwrap();
        (dir, conn)
    }

    fn rels(files: &[AudioFile]) -> Vec<&str> {
        files.iter().map(|f| f.rel_path.as_str()).collect()
    }

    fn id_of(conn: &Connection, rel: &str) -> i64 {
        conn.query_row("SELECT id FROM audio_files WHERE rel_path = ?1", [rel], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn list_all_sorted_with_absolute_path() {
        let (dir, conn) = setup();
        let files = list_files(&conn, &FileFilter::default()).unwrap();
        assert_eq!(rels(&files), vec!["a.wav", "b.mp3", "sub/c_100%.flac"]);
        assert!(Path::new(&files[2].path).exists());
        assert!(files[2].path.starts_with(&*dunce::canonicalize(dir.path()).unwrap().to_string_lossy()));
    }

    #[test]
    fn filter_by_text_ignores_case_and_escapes_wildcards() {
        let (_dir, conn) = setup();
        let f = |text: &str| FileFilter { text: text.into(), ..Default::default() };
        assert_eq!(rels(&list_files(&conn, &f("A.W")).unwrap()), vec!["a.wav"]);
        assert_eq!(rels(&list_files(&conn, &f("100%")).unwrap()), vec!["sub/c_100%.flac"]);
        assert_eq!(rels(&list_files(&conn, &f("_")).unwrap()), vec!["sub/c_100%.flac"]);
        assert!(list_files(&conn, &f("%")).unwrap().len() == 1);
    }

    #[test]
    fn tags_and_filters() {
        let (_dir, mut conn) = setup();
        let a = id_of(&conn, "a.wav");
        let b = id_of(&conn, "b.mp3");

        let explosion = add_tag(&mut conn, &[a, b], " 爆発 ").unwrap();
        let short = add_tag(&mut conn, &[a], "Short").unwrap();
        // 大文字・小文字の違いは同じタグ
        assert_eq!(add_tag(&mut conn, &[a], "short").unwrap(), short);

        let tags = list_tags(&conn).unwrap();
        assert_eq!(
            tags,
            vec![
                Tag { id: short, name: "Short".into(), file_count: 1 },
                Tag { id: explosion, name: "爆発".into(), file_count: 2 },
            ]
        );

        let and = FileFilter { tag_ids: vec![explosion, short], ..Default::default() };
        assert_eq!(rels(&list_files(&conn, &and).unwrap()), vec!["a.wav"]);
        let one = FileFilter { tag_ids: vec![explosion], ..Default::default() };
        assert_eq!(rels(&list_files(&conn, &one).unwrap()), vec!["a.wav", "b.mp3"]);
        let untagged = FileFilter { untagged_only: true, ..Default::default() };
        assert_eq!(rels(&list_files(&conn, &untagged).unwrap()), vec!["sub/c_100%.flac"]);

        let all = list_files(&conn, &FileFilter::default()).unwrap();
        assert_eq!(all[0].tags, vec!["Short", "爆発"]);

        remove_tag(&mut conn, &[a, b], explosion).unwrap();
        assert_eq!(list_files(&conn, &one).unwrap().len(), 0);
        // 使われなくなってもタグ自体は残る
        assert_eq!(list_tags(&conn).unwrap().len(), 2);
    }

    #[test]
    fn empty_tag_name_is_rejected() {
        let (_dir, mut conn) = setup();
        let a = id_of(&conn, "a.wav");
        assert!(add_tag(&mut conn, &[a], "  ").is_err());
        assert!(add_tag(&mut conn, &[a], "a\u{1f}b").is_err());
    }

    #[test]
    fn missing_files_can_be_removed() {
        let (dir, mut conn) = setup();
        let a = id_of(&conn, "a.wav");
        let b = id_of(&conn, "b.mp3");
        add_tag(&mut conn, &[a], "tag").unwrap();
        fs::remove_file(dir.path().join("a.wav")).unwrap();
        let folder: i64 = conn.query_row("SELECT id FROM library_folders", [], |r| r.get(0)).unwrap();
        scan_folder(&mut conn, folder).unwrap();

        let missing = FileFilter { missing_only: true, ..Default::default() };
        let files = list_files(&conn, &missing).unwrap();
        assert_eq!(rels(&files), vec!["a.wav"]);
        assert!(files[0].missing);
        // 付けたタグは残っている
        assert_eq!(files[0].tags, vec!["tag"]);

        // 印のないファイルは外れない
        assert_eq!(remove_missing_files(&mut conn, &[a, b]).unwrap(), 1);
        assert_eq!(rels(&list_files(&conn, &FileFilter::default()).unwrap()), vec!["b.mp3", "sub/c_100%.flac"]);
        assert_eq!(list_tags(&conn).unwrap()[0].file_count, 0);
    }
}
