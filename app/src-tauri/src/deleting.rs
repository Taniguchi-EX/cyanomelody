//! ファイルの削除。実際のファイルをごみ箱に移し（移せなければ、確認してから完全に消す）、ライブラリからも外す

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::db::ids_json;
use crate::error::Result;
use crate::library::absolute_path;

/// 削除できなかったファイルと、その理由
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub id: i64,
    pub rel_path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    /// 削除して、ライブラリから外したファイルの数
    pub deleted: usize,
    /// 削除できなかったファイル（ライブラリに残す）
    pub failed: Vec<DeleteFailure>,
}

/// ids のうち、見つかっているファイル（id・相対パス・絶対パス）。見つからないファイルは消す実体がないので除く
fn targets(conn: &Connection, ids: &[i64]) -> Result<Vec<(i64, String, PathBuf)>> {
    Ok(conn
        .prepare(
            "SELECT a.id, a.rel_path, f.path FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
             WHERE a.missing = 0 AND a.id IN (SELECT value FROM json_each(?1)) ORDER BY a.id",
        )?
        .query_map([ids_json(ids)], |r| {
            let rel: String = r.get(1)?;
            let folder: String = r.get(2)?;
            let path = absolute_path(&folder, &rel);
            Ok((r.get(0)?, rel, path))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// ごみ箱に移す。trash_dir があるとき（画面テスト）は、ごみ箱の代わりにそのフォルダへ移し、
/// 名前が「_notrash」で終わるファイルは移せないことにする（ごみ箱に移せないときの確認を試すため）
fn move_to_trash(path: &Path, trash_dir: Option<&Path>) -> std::result::Result<(), String> {
    let Some(dir) = trash_dir else {
        return trash::delete(path).map_err(|e| e.to_string());
    };
    if path.file_stem().and_then(|s| s.to_str()).is_some_and(|s| s.ends_with("_notrash")) {
        return Err("画面テスト用：ごみ箱に移せないファイルです".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().ok_or("ファイル名がありません")?;
    let mut dest = dir.join(name);
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("{n}_{}", name.to_string_lossy()));
        n += 1;
    }
    std::fs::rename(path, &dest)
        .or_else(|_| std::fs::copy(path, &dest).and_then(|_| std::fs::remove_file(path)))
        .map_err(|e| e.to_string())
}

/// ids のファイル（見つかっているもの）を削除する。permanent でなければごみ箱に移し、permanent なら完全に消す。
/// 削除できたファイル（もう無かったファイルを含む）はライブラリから外す（タグ・出典・ライセンスの設定、プレイリストの項目も消える）。
/// 削除できなかったファイルは、理由と一緒に返し、ライブラリに残す
pub fn delete_files(conn: &mut Connection, ids: &[i64], permanent: bool, trash_dir: Option<&Path>) -> Result<DeleteResult> {
    let mut result = DeleteResult::default();
    let mut done = Vec::new();
    for (id, rel_path, path) in targets(conn, ids)? {
        let outcome = if !path.exists() {
            Ok(())
        } else if permanent {
            std::fs::remove_file(&path).map_err(|e| e.to_string())
        } else {
            move_to_trash(&path, trash_dir)
        };
        match outcome {
            Ok(()) => done.push(id),
            Err(reason) => result.failed.push(DeleteFailure { id, rel_path, reason }),
        }
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM audio_files WHERE id IN (SELECT value FROM json_each(?1))", [ids_json(&done)])?;
    tx.commit()?;
    result.deleted = done.len();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::library::{add_folder, scan_folder};
    use std::fs;

    fn setup(dir: &Path) -> (Connection, PathBuf) {
        let lib = dir.join("lib");
        fs::create_dir_all(&lib).unwrap();
        let wav = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/base.wav");
        for name in ["a.wav", "b.wav", "c_notrash.wav", "gone.wav"] {
            fs::copy(&wav, lib.join(name)).unwrap();
        }
        let mut conn = open_in_memory().unwrap();
        let folder = add_folder(&conn, &lib).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        (conn, lib)
    }

    fn id_of(conn: &Connection, rel: &str) -> i64 {
        conn.query_row("SELECT id FROM audio_files WHERE rel_path = ?1", [rel], |r| r.get(0)).unwrap()
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM audio_files", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn moves_to_trash_and_removes_from_library() {
        let dir = tempfile::tempdir().unwrap();
        let (mut conn, lib) = setup(dir.path());
        let trash = dir.path().join("trash");
        let (a, b, c, gone) = (id_of(&conn, "a.wav"), id_of(&conn, "b.wav"), id_of(&conn, "c_notrash.wav"), id_of(&conn, "gone.wav"));
        conn.execute("INSERT INTO tags (id, name, created_at) VALUES (1, 'x', 0)", []).unwrap();
        conn.execute("INSERT INTO file_tags VALUES (?1, 1)", [a]).unwrap();
        // 削除の前に消えていたファイルも、ライブラリから外す
        fs::remove_file(lib.join("gone.wav")).unwrap();
        let r = delete_files(&mut conn, &[a, b, c, gone], false, Some(&trash)).unwrap();
        assert_eq!(r.deleted, 3);
        assert_eq!(r.failed.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(), vec!["c_notrash.wav"]);
        assert!(!lib.join("a.wav").exists() && trash.join("a.wav").exists() && trash.join("b.wav").exists());
        // 移せなかったファイルは残る（ライブラリにも）
        assert!(lib.join("c_notrash.wav").exists());
        assert_eq!(count(&conn), 1);
        let tagged: i64 = conn.query_row("SELECT count(*) FROM file_tags", [], |r| r.get(0)).unwrap();
        assert_eq!(tagged, 0);
        // 完全に消す
        let r = delete_files(&mut conn, &[c], true, Some(&trash)).unwrap();
        assert_eq!((r.deleted, r.failed.len()), (1, 0));
        assert!(!lib.join("c_notrash.wav").exists() && !trash.join("c_notrash.wav").exists());
        assert_eq!(count(&conn), 0);
    }

    #[test]
    fn skips_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let (mut conn, _) = setup(dir.path());
        let a = id_of(&conn, "a.wav");
        conn.execute("UPDATE audio_files SET missing = 1 WHERE id = ?1", [a]).unwrap();
        let r = delete_files(&mut conn, &[a, 9999], false, Some(&dir.path().join("trash"))).unwrap();
        assert_eq!((r.deleted, r.failed.len()), (0, 0));
        assert_eq!(count(&conn), 4);
    }
}
