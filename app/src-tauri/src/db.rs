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
    // 5: プレイリスト。子のプレイリストは、親の項目（kind = 'playlist'、owned = 1）として持つ
    r#"
    CREATE TABLE playlists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE playlist_items (
        id INTEGER PRIMARY KEY,
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'tags', 'playlist')),
        file_id INTEGER REFERENCES audio_files(id) ON DELETE CASCADE,
        ref_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
        owned INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'order' CHECK (mode IN ('order', 'shuffle', 'random'))
    );
    CREATE INDEX playlist_items_list ON playlist_items(playlist_id, position);
    CREATE INDEX playlist_items_file ON playlist_items(file_id);
    CREATE INDEX playlist_items_ref ON playlist_items(ref_id);
    -- 1つのプレイリストを子にできるのは1か所だけ
    CREATE UNIQUE INDEX playlist_items_owner ON playlist_items(ref_id) WHERE owned = 1;
    CREATE TABLE playlist_item_tags (
        item_id INTEGER NOT NULL REFERENCES playlist_items(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (item_id, tag_id)
    ) WITHOUT ROWID;
    CREATE INDEX playlist_item_tags_tag ON playlist_item_tags(tag_id);
    "#,
    // 6: プレイリストの項目の別名
    r#"
    ALTER TABLE playlist_items ADD COLUMN alias TEXT;
    "#,
    // 7: エフェクト。エフェクトセットの中のエフェクトは、種類と設定をJSONで持つ
    r#"
    CREATE TABLE effect_chains (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE effect_steps (
        id INTEGER PRIMARY KEY,
        chain_id INTEGER NOT NULL REFERENCES effect_chains(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        effect TEXT NOT NULL
    );
    CREATE INDEX effect_steps_chain ON effect_steps(chain_id, position);
    ALTER TABLE playlist_items ADD COLUMN effect_chain_id INTEGER REFERENCES effect_chains(id) ON DELETE SET NULL;
    CREATE INDEX playlist_items_chain ON playlist_items(effect_chain_id);
    "#,
    // 8: 直近で再生したファイル。seq は再生した順の通し番号（大きいほど新しい）
    r#"
    CREATE TABLE recent_plays (
        file_id INTEGER PRIMARY KEY REFERENCES audio_files(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL
    );
    CREATE INDEX recent_plays_seq ON recent_plays(seq);
    "#,
    // 9: 出典・ライセンスの並び順。今あるものは名前の順で始める
    r#"
    ALTER TABLE sources ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE licenses ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    UPDATE sources SET position = (SELECT count(*) FROM sources s2 WHERE s2.name < sources.name COLLATE NOCASE);
    UPDATE licenses SET position = (SELECT count(*) FROM licenses l2 WHERE l2.name < licenses.name COLLATE NOCASE);
    "#,
    // 10: タグの詳細設定。子のタグの並び順（NULL はドラッグで決めた順）と、表示の色（#rrggbb）
    r#"
    ALTER TABLE tags ADD COLUMN child_sort TEXT;
    ALTER TABLE tags ADD COLUMN child_sort_desc INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tags ADD COLUMN bg_color TEXT;
    ALTER TABLE tags ADD COLUMN fg_color TEXT;
    "#,
    // 11: ファイルの長さ（秒）。ハッシュ値の計算と一緒に調べる。duration_done は調べたら1（読めなかったときも）
    r#"
    ALTER TABLE audio_files ADD COLUMN duration REAL;
    ALTER TABLE audio_files ADD COLUMN duration_done INTEGER NOT NULL DEFAULT 0;
    "#,
    // 12: アプリの設定（新しく作るタグの既定値など）。値は key ごとに JSON
    r#"
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // 13: リリース年。長さと一緒に調べる。release_year_done は調べたら1（読めなかったときも）
    r#"
    ALTER TABLE audio_files ADD COLUMN release_year INTEGER;
    ALTER TABLE audio_files ADD COLUMN release_year_done INTEGER NOT NULL DEFAULT 0;
    "#,
    // 14: タグのシノニム（別の名前）。表全体で重ならない（大文字・小文字は区別しない）。タグを消すと消える
    r#"
    CREATE TABLE tag_synonyms (
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX tag_synonyms_tag ON tag_synonyms(tag_id);
    "#,
    // 15: Android の SAF のフォルダ。kind は場所の種類（path：パス、saf：SAF のフォルダで、path に FsUri の JSON）。
    // uri は SAF のフォルダのファイルの FsUri の JSON（スキャンのときに入れる。パスのフォルダのファイルは NULL）
    r#"
    ALTER TABLE library_folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'path';
    ALTER TABLE audio_files ADD COLUMN uri TEXT;
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

/// テスト用のDB。フォルダ（id 1、実体はいらない）に、相対パスのファイルを id 1 から順に入れる。
/// missing に入れた相対パスのファイルには、見つからない印を付ける
#[cfg(test)]
pub fn test_db(files: &[&str], missing: &[&str]) -> Connection {
    let conn = open_in_memory().unwrap();
    conn.execute("INSERT INTO library_folders (id, path, added_at) VALUES (1, 'C:\\lib', 0)", []).unwrap();
    for (i, rel) in files.iter().enumerate() {
        conn.execute(
            "INSERT INTO audio_files (id, folder_id, rel_path, size, modified_at, added_at, missing)
             VALUES (?1, 1, ?2, 0, 0, 0, ?3)",
            rusqlite::params![i as i64 + 1, rel, missing.contains(rel)],
        )
        .unwrap();
    }
    conn
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

/// idの一覧を、SQLの1つの引数（JSONの配列）にする。SQLでは `IN (SELECT value FROM json_each(?))` で使う。
/// 数万件でも、SQLの引数の数の上限にかからない
pub fn ids_json(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".into())
}

/// table に id の行があるか（table はコードの中で決めた名前だけを渡す）
pub fn exists(conn: &Connection, table: &str, id: i64) -> Result<bool> {
    Ok(conn.query_row(&format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE id = ?1)"), [id], |r| r.get(0))?)
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
