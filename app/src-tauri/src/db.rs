use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::error::Result;

/// マイグレーションの一覧。添字+1がスキーマのバージョン（PRAGMA user_version）になる。
const MIGRATIONS: &[&str] = &[
    // 1: 音声のタグ管理
    r#"
    CREATE TABLE library_folders (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        added_at INTEGER NOT NULL
    );
    CREATE TABLE audio_files (
        id INTEGER PRIMARY KEY,
        folder_id INTEGER NOT NULL REFERENCES library_folders(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        missing INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        UNIQUE (folder_id, rel_path)
    );
    CREATE TABLE tags (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE file_tags (
        file_id INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (file_id, tag_id)
    ) WITHOUT ROWID;
    CREATE INDEX file_tags_tag ON file_tags(tag_id, file_id);
    "#,
    // 2: ハッシュ値を使った機能
    r#"
    ALTER TABLE audio_files ADD COLUMN hash TEXT;
    ALTER TABLE audio_files ADD COLUMN hash_error TEXT;
    CREATE INDEX audio_files_hash ON audio_files(hash);
    "#,
    // 3: 出典とライセンスの管理。条項は 1：可・必要、0：不可・不要、NULL：不明
    r#"
    CREATE TABLE sources (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        url TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
    );
    CREATE TABLE licenses (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        url TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        license_type TEXT,
        commercial INTEGER,
        credit INTEGER,
        modify INTEGER,
        redistribute INTEGER,
        share_alike INTEGER,
        created_at INTEGER NOT NULL
    );
    ALTER TABLE audio_files ADD COLUMN source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL;
    ALTER TABLE audio_files ADD COLUMN license_id INTEGER REFERENCES licenses(id) ON DELETE SET NULL;
    CREATE INDEX audio_files_source ON audio_files(source_id);
    CREATE INDEX audio_files_license ON audio_files(license_id);
    "#,
    // 4: タグの階層構造。今あるタグは最上位に名前の順で並べる
    r#"
    ALTER TABLE tags ADD COLUMN parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL;
    ALTER TABLE tags ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    UPDATE tags SET position = (SELECT count(*) FROM tags t2 WHERE t2.name < tags.name);
    CREATE INDEX tags_parent ON tags(parent_id, position);
    "#,
];

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;",
    )?;
    migrate(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_twice_is_noop() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }

    #[test]
    fn existing_tags_are_ordered_by_name_on_migration_4() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..3] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 3).unwrap();
        conn.execute_batch(
            "INSERT INTO tags (name, created_at) VALUES ('b', 0), ('C', 0), ('a', 0);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM tags WHERE parent_id IS NULL ORDER BY position")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(names, vec!["a", "b", "C"]);
    }
}
