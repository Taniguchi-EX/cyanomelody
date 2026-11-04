//! リンク切れ（見つからない）ファイルを、ユーザーが選んだファイル・フォルダからひも付け直す

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};
use crate::audio_hash::audio_hash;
use crate::hashing::{compute_parallel, PendingFile};
use crate::library::{self, absolute_path, comparable, is_audio_file};

/// ハッシュ値を計算するときの、1回にまとめて計算する件数（見つかったら、残りは計算しない）
const SEARCH_BATCH: usize = 64;

/// path を含む登録済みのフォルダ（id と、フォルダのパスの部品の数）
fn containing_folder(conn: &Connection, path: &Path) -> Result<Option<(i64, usize)>> {
    let key = comparable(path);
    Ok(library::list_folders(conn)?
        .into_iter()
        .find(|f| key.starts_with(comparable(Path::new(&f.path))))
        .map(|f| (f.id, Path::new(&f.path).components().count())))
}

/// path のファイルのライブラリでの id を返す。
/// - 登録済みのフォルダの中にあれば、そのファイル（まだ一覧になければ、フォルダをスキャンしてから）
/// - 外にあれば、add_root を登録してスキャンしてから。登録したときは、そのフォルダの id も返す
pub fn ensure_in_library(conn: &mut Connection, path: &Path, add_root: &Path) -> Result<(i64, Option<i64>)> {
    if !path.is_file() {
        return Err(Error::invalid(format!("ファイルが見つかりません: {}", path.display())));
    }
    let path = dunce::canonicalize(path)?;
    if !is_audio_file(&path) {
        return Err(Error::invalid(format!("音声ファイルではありません: {}", path.display())));
    }
    let (folder_id, depth, added) = match containing_folder(conn, &path)? {
        Some((id, depth)) => (id, depth, None),
        None => {
            let id = library::add_folder(conn, add_root)?;
            let depth = library::folder_path(conn, id)?.components().count();
            (id, depth, Some(id))
        }
    };
    // フォルダからの相対パス（スキャンと同じく「/」でつなぐ）
    let rel = path
        .components()
        .skip(depth)
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    // 一覧にないか、見つからない印が付いたままなら、スキャンして取り込み直す
    let find = |conn: &Connection| -> Result<Option<i64>> {
        Ok(conn
            .query_row(
                "SELECT id FROM audio_files WHERE folder_id = ?1 AND rel_path = ?2 COLLATE NOCASE AND missing = 0",
                params![folder_id, rel],
                |r| r.get(0),
            )
            .optional()?)
    };
    if let Some(id) = find(conn)? {
        return Ok((id, added));
    }
    library::scan_folder(conn, folder_id)?;
    let id = find(conn)?
        .ok_or_else(|| Error::invalid(format!("ライブラリに取り込めませんでした: {}", path.display())))?;
    Ok((id, added))
}

/// 見つからないファイル missing と同じハッシュ値の音声ファイルを、folder の中（サブフォルダを含む）から探す。
/// ライブラリにあって計算済みのファイルを先に調べ、なければフォルダの中のファイルのハッシュ値を計算して探す
pub fn find_in_folder(conn: &Connection, missing: i64, folder: &Path) -> Result<Option<PathBuf>> {
    let hash: Option<Option<String>> = conn
        .query_row("SELECT hash FROM audio_files WHERE id = ?1 AND missing = 1", [missing], |r| r.get(0))
        .optional()?;
    let Some(hash) = hash else {
        return Err(Error::invalid("見つからないファイルではありません"));
    };
    let Some(hash) = hash else {
        return Err(Error::invalid("このファイルはハッシュ値がないため、同じ音声のファイルを探せません"));
    };
    if !folder.is_dir() {
        return Err(Error::invalid(format!("フォルダが見つかりません: {}", folder.display())));
    }
    let folder = dunce::canonicalize(folder)?;
    let key = comparable(&folder);

    let known: Vec<PathBuf> = conn
        .prepare(
            "SELECT f.path, a.rel_path FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
             WHERE a.hash = ?1 AND a.missing = 0",
        )?
        .query_map([&hash], |r| Ok(absolute_path(&r.get::<_, String>(0)?, &r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if let Some(p) = known.into_iter().find(|p| comparable(p).starts_with(&key) && p.is_file()) {
        return Ok(Some(p));
    }

    let files: Vec<PendingFile> = library::audio_files_under(&folder)
        .into_iter()
        .enumerate()
        .map(|(i, path)| PendingFile { id: i as i64, path })
        .collect();
    let cancel = AtomicBool::new(false);
    for batch in files.chunks(SEARCH_BATCH) {
        for (i, outcome) in compute_parallel(batch, &cancel, audio_hash) {
            if matches!(outcome, Some(Ok(ref h)) if *h == hash) {
                return Ok(Some(files[i as usize].path.clone()));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::hashing::relink_to;
    use crate::library::{add_folder, scan_folder};
    use std::fs;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    fn id_of(conn: &Connection, rel: &str) -> i64 {
        conn.query_row("SELECT id FROM audio_files WHERE rel_path = ?1", [rel], |r| r.get(0)).unwrap()
    }

    /// ライブラリ（lib）に a.wav を取り込み、ハッシュ値を付けてから、見つからない状態にする
    fn setup(dir: &Path) -> (Connection, i64) {
        let lib = dir.join("lib");
        fs::create_dir_all(&lib).unwrap();
        fs::copy(fixture("base.wav"), lib.join("a.wav")).unwrap();
        let mut conn = open_in_memory().unwrap();
        let folder = add_folder(&conn, &lib).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        let id = id_of(&conn, "a.wav");
        let hash = crate::audio_hash::audio_hash(&lib.join("a.wav")).unwrap();
        conn.execute("UPDATE audio_files SET hash = ?1 WHERE id = ?2", params![hash, id]).unwrap();
        fs::remove_file(lib.join("a.wav")).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        (conn, id)
    }

    #[test]
    fn file_inside_library_is_scanned_and_linked() {
        let dir = tempfile::tempdir().unwrap();
        let (mut conn, missing) = setup(dir.path());
        let moved = dir.path().join("lib").join("sub").join("moved.wav");
        fs::create_dir_all(moved.parent().unwrap()).unwrap();
        fs::copy(fixture("base.wav"), &moved).unwrap();
        let (target, added) = ensure_in_library(&mut conn, &moved, moved.parent().unwrap()).unwrap();
        assert_eq!(added, None);
        assert_eq!(target, id_of(&conn, "sub/moved.wav"));
        relink_to(&mut conn, missing, target).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM audio_files WHERE id = ?1", [missing], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn file_outside_library_adds_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (mut conn, _) = setup(dir.path());
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::copy(fixture("base.mp3"), outside.join("b.mp3")).unwrap();
        let (target, added) = ensure_in_library(&mut conn, &outside.join("b.mp3"), &outside).unwrap();
        assert!(added.is_some());
        assert_eq!(target, id_of(&conn, "b.mp3"));
        assert_eq!(library::list_folders(&conn).unwrap().len(), 2);
        // 音声でないファイルは選べない
        fs::write(outside.join("note.txt"), "x").unwrap();
        assert!(ensure_in_library(&mut conn, &outside.join("note.txt"), &outside).is_err());
    }

    #[test]
    fn find_in_folder_by_hash() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, missing) = setup(dir.path());
        let search = dir.path().join("search");
        fs::create_dir_all(search.join("deep")).unwrap();
        fs::copy(fixture("base.mp3"), search.join("other.mp3")).unwrap();
        // 見つからない
        assert_eq!(find_in_folder(&conn, missing, &search).unwrap(), None);
        // サブフォルダの、名前の違う同じ音声のファイルが見つかる
        fs::copy(fixture("base.wav"), search.join("deep").join("renamed.wav")).unwrap();
        let found = find_in_folder(&conn, missing, &search).unwrap().unwrap();
        assert!(found.ends_with("renamed.wav"), "{}", found.display());
        // ハッシュ値がなければ探せない
        conn.execute("UPDATE audio_files SET hash = NULL WHERE id = ?1", [missing]).unwrap();
        assert!(find_in_folder(&conn, missing, &search).is_err());
    }
}
