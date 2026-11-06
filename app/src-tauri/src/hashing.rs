//! ハッシュ値と長さの計算待ちの取得・保存と、ひも付け直し

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::audio_hash::{audio_hash, HashError};
use crate::error::{Error, Result};
use crate::library::absolute_path;
use crate::metadata;

/// ハッシュ値か長さの計算を待っているファイル
#[derive(Debug, Clone)]
pub struct PendingFile {
    pub id: i64,
    pub path: PathBuf,
}

pub type HashOutcome = std::result::Result<String, HashError>;

/// ファイルを調べた結果（ハッシュ値と長さ）
pub struct Analysis {
    pub hash: HashOutcome,
    /// 長さ（秒）。読めなかったときは None
    pub duration: Option<f64>,
    /// リリース年。読めなかったときは None
    pub year: Option<i32>,
}

/// ファイルのハッシュ値と、長さ・リリース年を調べる
pub fn analyze(path: &Path) -> Analysis {
    let info = metadata::audio_info(path);
    Analysis { hash: audio_hash(path), duration: info.duration, year: info.year }
}

/// 見つかっているファイルのうち、ハッシュ値がまだなく計算できなかった記録もないもの、または長さ・リリース年をまだ調べていないもの
pub fn pending_files(conn: &Connection) -> Result<Vec<PendingFile>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, f.path, a.rel_path FROM audio_files a
         JOIN library_folders f ON f.id = a.folder_id
         WHERE ((a.hash IS NULL AND a.hash_error IS NULL) OR a.duration_done = 0 OR a.release_year_done = 0) AND a.missing = 0
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

pub fn save_analyses(conn: &mut Connection, results: &[(i64, Analysis)]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE audio_files SET hash = ?2, hash_error = ?3, duration = ?4, duration_done = 1,
                release_year = ?5, release_year_done = 1 WHERE id = ?1",
        )?;
        for (id, a) in results {
            match &a.hash {
                Ok(hash) => stmt.execute(params![id, hash, None::<String>, a.duration, a.year])?,
                Err(e) => stmt.execute(params![id, None::<String>, e.to_string(), a.duration, a.year])?,
            };
        }
    }
    tx.commit()?;
    Ok(())
}

/// ファイルごとの計算（ハッシュ値など）を、複数のスレッドで並列に行う。
/// cancel が立ったら、まだ始めていないファイルは計算せずに None を返す。
pub fn compute_parallel<T: Send>(
    files: &[PendingFile],
    cancel: &AtomicBool,
    work: fn(&Path) -> T,
) -> Vec<(i64, Option<T>)> {
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
                                (f.id, Some(work(&f.path)))
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
/// タグ・出典・ライセンス・プレイリストの項目を移して、見つからないファイルの情報を消す。見つからない印がないファイルは無視する。
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
                merge_into(&tx, id, *target)?;
                result.relinked += 1;
            }
            _ => result.ambiguous += 1,
        }
    }
    tx.commit()?;
    Ok(result)
}

/// 見つからないファイル missing の、タグ・出典・ライセンス・プレイリストの項目・再生の履歴を target に移し、
/// missing の情報を消す（ひも付け直しの共通の処理）
fn merge_into(conn: &Connection, missing: i64, target: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO file_tags (file_id, tag_id)
         SELECT ?2, tag_id FROM file_tags WHERE file_id = ?1",
        params![missing, target],
    )?;
    // 出典・ライセンスは、ひも付け直し先に設定がなければ移す
    conn.execute(
        "UPDATE audio_files SET
           source_id = coalesce(source_id, (SELECT source_id FROM audio_files WHERE id = ?1)),
           license_id = coalesce(license_id, (SELECT license_id FROM audio_files WHERE id = ?1))
         WHERE id = ?2",
        params![missing, target],
    )?;
    // プレイリストのファイルの項目も付け替える
    conn.execute("UPDATE playlist_items SET file_id = ?2 WHERE file_id = ?1", params![missing, target])?;
    // 再生の履歴は、新しい方を残す
    conn.execute(
        "INSERT INTO recent_plays (file_id, seq) SELECT ?2, seq FROM recent_plays WHERE file_id = ?1
         ON CONFLICT(file_id) DO UPDATE SET seq = max(seq, excluded.seq)",
        params![missing, target],
    )?;
    conn.execute("DELETE FROM audio_files WHERE id = ?1", [missing])?;
    Ok(())
}

/// 見つからないファイル missing を、ユーザーが選んだファイル target にひも付け直す（ハッシュ値は比べない）
pub fn relink_to(conn: &mut Connection, missing: i64, target: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let is_missing: Option<bool> = tx
        .query_row("SELECT missing FROM audio_files WHERE id = ?1", [missing], |r| r.get(0))
        .optional()?;
    if is_missing != Some(true) {
        return Err(Error::invalid("見つからないファイルではありません"));
    }
    let target_ok: Option<bool> = tx
        .query_row("SELECT missing = 0 FROM audio_files WHERE id = ?1", [target], |r| r.get(0))
        .optional()?;
    if target_ok != Some(true) || target == missing {
        return Err(Error::invalid("ひも付け先のファイルが見つかりません"));
    }
    merge_into(&tx, missing, target)?;
    tx.commit()?;
    Ok(())
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
        let results: Vec<(i64, Analysis)> = compute_parallel(&pending, &AtomicBool::new(false), analyze)
            .into_iter()
            .map(|(id, r)| (id, r.unwrap()))
            .collect();
        save_analyses(conn, &results).unwrap();
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
        // 長さも一緒に調べる。読めないファイルは長さなし
        let duration = |rel: &str| -> Option<f64> {
            conn.query_row("SELECT duration FROM audio_files WHERE rel_path = ?1", [rel], |r| r.get(0)).unwrap()
        };
        assert!(duration("a.mp3").is_some_and(|d| (d - 0.3).abs() < 0.1), "{:?}", duration("a.mp3"));
        assert_eq!(duration("broken.wav"), None);
        // ハッシュ値があっても、長さを調べていなければ計算待ちになる
        conn.execute("UPDATE audio_files SET duration_done = 0 WHERE rel_path = 'b.mp3'", []).unwrap();
        // リリース年も一緒に調べる（テスト用の素材には年がない）。調べた印は付く
        let year: (Option<i64>, i64) = conn
            .query_row("SELECT release_year, release_year_done FROM audio_files WHERE rel_path = 'a.mp3'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(year, (None, 1));
        assert_eq!(pending_files(&conn).unwrap().len(), 1);
    }

    #[test]
    fn cancel_skips_remaining_files() {
        let (_dir, conn, _) = setup();
        let pending = pending_files(&conn).unwrap();
        let results = compute_parallel(&pending, &AtomicBool::new(true), analyze);
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
