//! タグ自体の管理（作成・名前変更・統合・削除）

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::db::now;
use crate::error::{Error, Result};

/// タグ名を区切るための文字（タグ名には入らない制御文字）
pub const TAG_SEPARATOR: char = '\u{1f}';

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub file_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    /// 名前変更後のタグのid。統合したときは統合先のid
    pub tag_id: i64,
    pub merged: bool,
}

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, (SELECT count(*) FROM file_tags ft WHERE ft.tag_id = t.id)
         FROM tags t ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Tag {
            id: r.get(0)?,
            name: r.get(1)?,
            file_count: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn normalize_tag_name(name: &str) -> Result<String> {
    normalize_name(name, "タグ")
}

/// タグ・出典・ライセンスの名前の決まり。前後の空白を除き、空や制御文字を含む名前はエラー。
/// what はエラーの文言に入れる、名前の持ち主（「タグ」など）
pub fn normalize_name(name: &str, what: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::invalid(format!("{what}の名前が空です")));
    }
    if name.contains(TAG_SEPARATOR) || name.chars().any(char::is_control) {
        return Err(Error::invalid(format!("{what}の名前に使えない文字が含まれています")));
    }
    Ok(name.to_owned())
}

/// 名前でタグを探す。大文字・小文字は区別しない。
fn find_tag(conn: &Connection, name: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))
        .optional()?)
}

fn insert_tag(conn: &Connection, name: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO tags (name, created_at) VALUES (?1, ?2)",
        params![name, now()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 名前でタグを探し、なければ作る。
pub fn get_or_create_tag(conn: &Connection, name: &str) -> Result<i64> {
    let name = normalize_tag_name(name)?;
    match find_tag(conn, &name)? {
        Some(id) => Ok(id),
        None => insert_tag(conn, &name),
    }
}

/// タグを作る。同じ名前のタグがあればエラー。
pub fn create_tag(conn: &Connection, name: &str) -> Result<i64> {
    let name = normalize_tag_name(name)?;
    if find_tag(conn, &name)?.is_some() {
        return Err(Error::invalid(format!("同じ名前のタグがあります: {name}")));
    }
    insert_tag(conn, &name)
}

fn ensure_exists(conn: &Connection, tag_id: i64) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM tags WHERE id = ?1)",
        [tag_id],
        |r| r.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(Error::invalid("タグが見つかりません"))
    }
}

/// タグの名前を変える。別の既存のタグと同じ名前のときは、merge が true なら統合し、false ならエラー。
pub fn rename_tag(conn: &mut Connection, tag_id: i64, new_name: &str, merge: bool) -> Result<RenameResult> {
    let name = normalize_tag_name(new_name)?;
    ensure_exists(conn, tag_id)?;
    let tx = conn.transaction()?;
    let result = match find_tag(&tx, &name)? {
        Some(other) if other != tag_id => {
            if !merge {
                return Err(Error::invalid(format!("同じ名前のタグがあります: {name}")));
            }
            tx.execute(
                "INSERT OR IGNORE INTO file_tags (file_id, tag_id)
                 SELECT file_id, ?2 FROM file_tags WHERE tag_id = ?1",
                params![tag_id, other],
            )?;
            tx.execute("DELETE FROM tags WHERE id = ?1", [tag_id])?;
            RenameResult { tag_id: other, merged: true }
        }
        // 自分自身（大文字・小文字だけの変更を含む）か、新しい名前
        _ => {
            tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![tag_id, name])?;
            RenameResult { tag_id, merged: false }
        }
    };
    tx.commit()?;
    Ok(result)
}

/// タグを削除する。付いていたファイルからも外れる。
pub fn delete_tag(conn: &Connection, tag_id: i64) -> Result<()> {
    let n = conn.execute("DELETE FROM tags WHERE id = ?1", [tag_id])?;
    if n == 0 {
        return Err(Error::invalid("タグが見つかりません"));
    }
    Ok(())
}

/// どのファイルにも付いていないタグを削除し、削除した数を返す。
pub fn delete_unused_tags(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.tag_id = tags.id)",
        [],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    /// ファイル3件（id 1〜3）を入れたDB。フォルダの実体はいらない。
    fn setup() -> Connection {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO library_folders (id, path, added_at) VALUES (1, 'C:\\lib', 0);
             INSERT INTO audio_files (id, folder_id, rel_path, size, modified_at, added_at)
               VALUES (1, 1, 'a.wav', 0, 0, 0), (2, 1, 'b.wav', 0, 0, 0), (3, 1, 'c.wav', 0, 0, 0);",
        )
        .unwrap();
        conn
    }

    fn attach(conn: &Connection, file_id: i64, tag_id: i64) {
        conn.execute("INSERT INTO file_tags VALUES (?1, ?2)", [file_id, tag_id]).unwrap();
    }

    fn tagged_files(conn: &Connection, tag_id: i64) -> Vec<i64> {
        conn.prepare("SELECT file_id FROM file_tags WHERE tag_id = ?1 ORDER BY file_id")
            .unwrap()
            .query_map([tag_id], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn names(conn: &Connection) -> Vec<String> {
        list_tags(conn).unwrap().into_iter().map(|t| t.name).collect()
    }

    #[test]
    fn create_rejects_duplicate_ignoring_case() {
        let conn = setup();
        create_tag(&conn, " 爆発 ").unwrap();
        create_tag(&conn, "Short").unwrap();
        assert!(create_tag(&conn, "short").is_err());
        assert!(create_tag(&conn, "爆発").is_err());
        assert!(create_tag(&conn, "").is_err());
        assert_eq!(names(&conn), vec!["Short", "爆発"]);
    }

    #[test]
    fn rename_to_new_name_and_change_case() {
        let mut conn = setup();
        let id = create_tag(&conn, "short").unwrap();
        attach(&conn, 1, id);
        let r = rename_tag(&mut conn, id, "Short", false).unwrap();
        assert_eq!(r, RenameResult { tag_id: id, merged: false });
        let r = rename_tag(&mut conn, id, "短い", false).unwrap();
        assert_eq!(r, RenameResult { tag_id: id, merged: false });
        assert_eq!(names(&conn), vec!["短い"]);
        assert_eq!(tagged_files(&conn, id), vec![1]);
    }

    #[test]
    fn rename_to_existing_name_merges_only_when_asked() {
        let mut conn = setup();
        let from = create_tag(&conn, "explosion").unwrap();
        let to = create_tag(&conn, "爆発").unwrap();
        attach(&conn, 1, from);
        attach(&conn, 2, from);
        attach(&conn, 2, to);
        attach(&conn, 3, to);

        assert!(rename_tag(&mut conn, from, "爆発", false).is_err());
        assert_eq!(names(&conn).len(), 2);

        let r = rename_tag(&mut conn, from, " 爆発 ", true).unwrap();
        assert_eq!(r, RenameResult { tag_id: to, merged: true });
        assert_eq!(names(&conn), vec!["爆発"]);
        assert_eq!(tagged_files(&conn, to), vec![1, 2, 3]);
        assert_eq!(tagged_files(&conn, from), Vec::<i64>::new());
    }

    #[test]
    fn rename_missing_tag_fails() {
        let mut conn = setup();
        assert!(rename_tag(&mut conn, 99, "x", true).is_err());
    }

    #[test]
    fn delete_removes_from_files() {
        let conn = setup();
        let id = create_tag(&conn, "a").unwrap();
        attach(&conn, 1, id);
        delete_tag(&conn, id).unwrap();
        assert!(names(&conn).is_empty());
        let n: i64 = conn.query_row("SELECT count(*) FROM file_tags", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        let files: i64 = conn.query_row("SELECT count(*) FROM audio_files", [], |r| r.get(0)).unwrap();
        assert_eq!(files, 3);
        assert!(delete_tag(&conn, id).is_err());
    }

    #[test]
    fn delete_unused_keeps_tags_on_missing_files() {
        let conn = setup();
        let used = create_tag(&conn, "used").unwrap();
        let on_missing = create_tag(&conn, "on_missing").unwrap();
        create_tag(&conn, "unused1").unwrap();
        create_tag(&conn, "unused2").unwrap();
        attach(&conn, 1, used);
        attach(&conn, 3, on_missing);
        conn.execute("UPDATE audio_files SET missing = 1 WHERE id = 3", []).unwrap();
        assert_eq!(delete_unused_tags(&conn).unwrap(), 2);
        assert_eq!(names(&conn), vec!["on_missing", "used"]);
    }
}
