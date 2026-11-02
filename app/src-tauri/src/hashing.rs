//! ハッシュ値の計算待ちの取得・保存と、ひも付け直し

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::audio_hash::{audio_hash, HashError};
use crate::error::Result;
use crate::library::absolute_path;

/// ハッシュ値の計算を待っているファイル
#[derive(Debug, Clone)]
pub struct PendingFile {
    pub id: i64,
    pub path: PathBuf,
}

pub type HashOutcome = std::result::Result<String, HashError>;

/// ハッシュ値がまだなく、計算できなかった記録もない、見つかっているファイル
pub fn pending_files(conn: &Connection) -> Result<Vec<PendingFile>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, f.path, a.rel_path FROM audio_files a
         JOIN library_folders f ON f.id = a.folder_id
         WHERE a.hash IS NULL AND a.hash_error IS NULL AND a.missing = 0
         ORDER BY a.id",
    )?;
    let rows = stmt.query_map([], |r| {
        let folder: String = r.get(1)?;
        let rel: String = r.get(2)?;
        Ok(PendingFile {
            id: r.get(0)?,
            path: absolute_path(&folder, &rel),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn save_hashes(conn: &mut Connection, results: &[(i64, HashOutcome)]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE audio_files SET hash = ?2, hash_error = ?3 WHERE id = ?1")?;
        for (id, outcome) in results {
            match outcome {
                Ok(hash) => stmt.execute(params![id, hash, None::<String>])?,
                Err(e) => stmt.execute(params![id, None::<String>, e.to_string()])?,
            };
        }
    }
    tx.commit()?;
    Ok(())
}

/// ファイルのハッシュ値を、複数のスレッドで並列に計算する。
/// cancel が立ったら、まだ始めていないファイルは計算せずに None を返す。
pub fn compute_parallel(files: &[PendingFile], cancel: &AtomicBool) -> Vec<(i64, Option<HashOutcome>)> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(files.len().max(1));
    let chunk = files.len().div_ceil(threads).max(1);
    std::thread::scope(|s| {
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|part| {
                s.spawn(move || {
                    part.iter()
                        .map(|f| {
                            if cancel.load(Ordering::Relaxed) {
                                (f.id, None)
                            } else {
                                (f.id, Some(audio_hash(&f.path)))
                            }
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelinkResult {
    /// ひも付け直した件数
    pub relinked: usize,
    /// 同じハッシュ値のファイルがなかった件数
    pub not_found: usize,
    /// 同じハッシュ値のファイルが2件以上あった件数
    pub ambiguous: usize,
    /// ハッシュ値がなく、探せなかった件数
    pub no_hash: usize,
}

/// 見つからないファイルを、同じハッシュ値の見つかっているファイルにひも付け直す。
/// タグを移して、見つからないファイルの情報を消す。見つからない印がないファイルは無視する。
pub fn relink(conn: &mut Connection, file_ids: &[i64]) -> Result<RelinkResult> {
    let tx = conn.transaction()?;
    let mut result = RelinkResult::default();
    for &id in file_ids {
        let hash: Option<Option<String>> = tx
            .query_row(
                "SELECT hash FROM audio_files WHERE id = ?1 AND missing = 1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(hash) = hash else { continue };
        let Some(hash) = hash else {
            result.no_hash += 1;
            continue;
        };
        let candidates: Vec<i64> = tx
            .prepare("SELECT id FROM audio_files WHERE hash = ?1 AND missing = 0 AND id <> ?2")?
            .query_map(params![hash, id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        match candidates.as_slice() {
            [] => result.not_found += 1,
            [target] => {
                tx.execute(
                    "INSERT OR IGNORE INTO file_tags (file_id, tag_id)
                     SELECT ?2, tag_id FROM file_tags WHERE file_id = ?1",
                    params![id, target],
                )?;
                // 出典・ライセンスは、ひも付け直し先に設定がなければ移す
                tx.execute(
                    "UPDATE audio_files SET
                       source_id = coalesce(source_id, (SELECT source_id FROM audio_files WHERE id = ?1)),
                       license_id = coalesce(license_id, (SELECT license_id FROM audio_files WHERE id = ?1))
                     WHERE id = ?2",
                    params![id, target],
                )?;
                // プレイリストのファイルの項目も付け替える
                tx.execute("UPDATE playlist_items SET file_id = ?2 WHERE file_id = ?1", params![id, target])?;
                tx.execute("DELETE FROM audio_files WHERE id = ?1", [id])?;
                result.relinked += 1;
            }
            _ => result.ambiguous += 1,
        }
    }
    tx.commit()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use crate::credits::{set_file_credit, CreditKind};
    use crate::db::open_in_memory;
    use crate::files::{add_tag, list_files, FileFilter};
    use crate::library::{add_folder, scan_folder};
    use std::fs;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    fn id_of(conn: &Connection, rel: &str) -> i64 {
        conn.query_row("SELECT id FROM audio_files WHERE rel_path = ?1", [rel], |r| r.get(0))
            .unwrap()
    }

    fn hash_all(conn: &mut Connection) -> usize {
        let pending = pending_files(conn).unwrap();
        let results: Vec<(i64, HashOutcome)> = compute_parallel(&pending, &AtomicBool::new(false))
            .into_iter()
            .map(|(id, r)| (id, r.unwrap()))
            .collect();
        save_hashes(conn, &results).unwrap();
        results.len()
    }

    /// base.mp3（2つ）、retag.mp3、other.mp3、壊れたファイルを置いたライブラリ
    fn setup() -> (tempfile::TempDir, Connection, i64) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        fs::copy(fixture("base.mp3"), dir.path().join("a.mp3")).unwrap();
        fs::copy(fixture("base.mp3"), dir.path().join("sub/a_copy.mp3")).unwrap();
        fs::copy(fixture("retag.mp3"), dir.path().join("a_retag.mp3")).unwrap();
        fs::copy(fixture("other.mp3"), dir.path().join("b.mp3")).unwrap();
        fs::write(dir.path().join("broken.wav"), b"not audio").unwrap();
        let mut conn = open_in_memory().unwrap();
        let folder = add_folder(&conn, dir.path()).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        (dir, conn, folder)
    }

    #[test]
    fn hashes_are_computed_and_errors_recorded() {
        let (_dir, mut conn, _) = setup();
        assert_eq!(hash_all(&mut conn), 5);
        // 計算済み・計算できなかったファイルは、もう計算待ちにならない
        assert!(pending_files(&conn).unwrap().is_empty());
        let error: Option<String> = conn
            .query_row("SELECT hash_error FROM audio_files WHERE rel_path = 'broken.wav'", [], |r| r.get(0))
            .unwrap();
        assert!(error.is_some());
    }

    #[test]
    fn cancel_skips_remaining_files() {
        let (_dir, conn, _) = setup();
        let pending = pending_files(&conn).unwrap();
        let results = compute_parallel(&pending, &AtomicBool::new(true));
        assert!(results.iter().all(|(_, r)| r.is_none()));
    }

    #[test]
    fn duplicates_and_hash_filter() {
        let (_dir, mut conn, _) = setup();
        hash_all(&mut conn);
        let dup = FileFilter { duplicates_only: true, ..Default::default() };
        let files = list_files(&conn, &dup).unwrap();
        let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, vec!["a.mp3", "a_retag.mp3", "sub/a_copy.mp3"]);

        let hash = files[0].hash.clone().unwrap();
        let by_hash = FileFilter { hash: Some(hash.clone()), text: "copy".into(), ..Default::default() };
        let rels: Vec<String> = list_files(&conn, &by_hash).unwrap().into_iter().map(|f| f.rel_path).collect();
        assert_eq!(rels, vec!["sub/a_copy.mp3"]);
        assert_eq!(audio_hash(&fixture("retag.mp3")).unwrap(), hash);
    }

    #[test]
    fn relink_moves_tags_to_the_only_candidate() {
        let (dir, mut conn, folder) = setup();
        hash_all(&mut conn);
        let b = id_of(&conn, "b.mp3");
        add_tag(&mut conn, &[b], "移動前").unwrap();
        // b.mp3 を移動してスキャンすると、元の記録は見つからない印が付き、移動先は新しい記録になる
        fs::rename(dir.path().join("b.mp3"), dir.path().join("sub/b_moved.mp3")).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        hash_all(&mut conn);
        let moved = id_of(&conn, "sub/b_moved.mp3");
        add_tag(&mut conn, &[moved], "移動後").unwrap();

        let r = relink(&mut conn, &[b]).unwrap();
        assert_eq!(r, RelinkResult { relinked: 1, ..Default::default() });
        let files = list_files(&conn, &FileFilter::default()).unwrap();
        assert!(files.iter().all(|f| f.rel_path != "b.mp3"));
        let target = files.iter().find(|f| f.id == moved).unwrap();
        assert_eq!(target.tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["移動前", "移動後"]);
    }

    #[test]
    fn relink_moves_credits_unless_target_has_them() {
        let (dir, mut conn, folder) = setup();
        hash_all(&mut conn);
        let b = id_of(&conn, "b.mp3");
        set_file_credit(&mut conn, CreditKind::Source, &[b], Some("移動前の出典")).unwrap();
        let license = set_file_credit(&mut conn, CreditKind::License, &[b], Some("移動前のライセンス")).unwrap();
        fs::rename(dir.path().join("b.mp3"), dir.path().join("sub/b_moved.mp3")).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        hash_all(&mut conn);
        let moved = id_of(&conn, "sub/b_moved.mp3");
        let source = set_file_credit(&mut conn, CreditKind::Source, &[moved], Some("移動後の出典")).unwrap();

        relink(&mut conn, &[b]).unwrap();
        let files = list_files(&conn, &FileFilter::default()).unwrap();
        let target = files.iter().find(|f| f.id == moved).unwrap();
        // 移動先に設定があれば残し、なければ移す
        assert_eq!(target.source_id, source);
        assert_eq!(target.license_id, license);
    }

    #[test]
    fn relink_moves_playlist_items() {
        let (dir, mut conn, folder) = setup();
        hash_all(&mut conn);
        let b = id_of(&conn, "b.mp3");
        let list = crate::playlists::create_playlist(&mut conn, "P", None).unwrap();
        crate::playlists::add_files(&mut conn, list, &[b]).unwrap();
        fs::rename(dir.path().join("b.mp3"), dir.path().join("sub/b_moved.mp3")).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        hash_all(&mut conn);
        let moved = id_of(&conn, "sub/b_moved.mp3");
        relink(&mut conn, &[b]).unwrap();
        let items = crate::playlists::get_playlist(&conn, list).unwrap().items;
        assert_eq!(items[0].file.as_ref().unwrap().id, moved);
    }

    #[test]
    fn relink_skips_ambiguous_missing_and_unhashed() {
        let (dir, mut conn, folder) = setup();
        let unhashed_before = id_of(&conn, "broken.wav");
        hash_all(&mut conn);
        let a = id_of(&conn, "a.mp3");
        let b = id_of(&conn, "b.mp3");
        let present = id_of(&conn, "a_retag.mp3");
        fs::remove_file(dir.path().join("a.mp3")).unwrap();
        fs::remove_file(dir.path().join("b.mp3")).unwrap();
        fs::remove_file(dir.path().join("broken.wav")).unwrap();
        scan_folder(&mut conn, folder).unwrap();

        // a は候補が2件（a_retag と sub/a_copy）、b は候補なし、broken はハッシュ値なし、present は印がないので無視
        let r = relink(&mut conn, &[a, b, unhashed_before, present]).unwrap();
        assert_eq!(r, RelinkResult { relinked: 0, not_found: 1, ambiguous: 1, no_hash: 1 });
        let missing = FileFilter { missing_only: true, ..Default::default() };
        assert_eq!(list_files(&conn, &missing).unwrap().len(), 3);
    }
}
