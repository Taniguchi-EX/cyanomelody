//! 直近で再生したファイル（試聴とプレイリストの再生）。左の欄の「その他」の「直近で再生したもの」に使う

use rusqlite::{params, Connection};

use crate::error::Result;

/// 覚えておく件数
pub const RECENT_LIMIT: i64 = 100;

/// ファイルを再生したことを記録する。同じファイルは1件にまとめ、いちばん新しい順番にする。
/// 古いものから消して、RECENT_LIMIT 件までにする。
/// 順番は時刻ではなく通し番号で持つ（同じ秒に何件再生しても、再生した順に並ぶように）
pub fn record_play(conn: &Connection, file_id: i64) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO recent_plays (file_id, seq)
         SELECT ?1, coalesce((SELECT max(seq) FROM recent_plays), 0) + 1
         WHERE EXISTS (SELECT 1 FROM audio_files WHERE id = ?1)",
        [file_id],
    )?;
    conn.execute(
        "DELETE FROM recent_plays WHERE seq <= (SELECT max(seq) FROM recent_plays) - ?1",
        params![RECENT_LIMIT],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_db;
    use crate::files::{list_files, FileFilter};

    fn recent(conn: &Connection) -> Vec<String> {
        let f = FileFilter { recent_only: true, ..Default::default() };
        list_files(conn, &f).unwrap().into_iter().map(|f| f.rel_path).collect()
    }

    #[test]
    fn newest_first_and_same_file_once() {
        let conn = test_db(&["a.wav", "b.wav", "c.wav"], &[]);
        record_play(&conn, 1).unwrap();
        record_play(&conn, 2).unwrap();
        record_play(&conn, 1).unwrap();
        assert_eq!(recent(&conn), vec!["a.wav", "b.wav"]);
        // ライブラリにないファイルは記録しない
        record_play(&conn, 999).unwrap();
        assert_eq!(recent(&conn).len(), 2);
    }

    #[test]
    fn keeps_only_the_limit() {
        let names: Vec<String> = (0..RECENT_LIMIT + 5).map(|i| format!("{i:03}.wav")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let conn = test_db(&refs, &[]);
        for id in 1..=RECENT_LIMIT + 5 {
            record_play(&conn, id).unwrap();
        }
        let list = recent(&conn);
        assert_eq!(list.len() as i64, RECENT_LIMIT);
        assert_eq!(list.first().unwrap(), &format!("{:03}.wav", RECENT_LIMIT + 4));
        assert_eq!(list.last().unwrap(), "005.wav");
    }

    #[test]
    fn removed_files_leave_the_list() {
        let conn = test_db(&["a.wav", "b.wav"], &[]);
        record_play(&conn, 1).unwrap();
        record_play(&conn, 2).unwrap();
        conn.execute("DELETE FROM audio_files WHERE id = 1", []).unwrap();
        assert_eq!(recent(&conn), vec!["b.wav"]);
    }
}
