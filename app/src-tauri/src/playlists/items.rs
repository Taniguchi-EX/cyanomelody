//! プレイリストの項目の操作：加える（ファイル・タグの組み合わせ・プレイリスト）、外す、並べ替え、別名、再生方法

use super::*;

/// プレイリストの最後に、ファイルを加える。加える順は、指定した順ではなくファイルの一覧と同じ順（フォルダ、相対パス）。
/// ライブラリにないidは無視する
pub fn add_files(conn: &mut Connection, playlist_id: i64, file_ids: &[i64]) -> Result<()> {
    let tx = conn.transaction()?;
    ensure_exists(&tx, playlist_id)?;
    let sorted: Vec<i64> = tx
        .prepare(&format!(
            "SELECT a.id FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
             WHERE a.id IN (SELECT value FROM json_each(?1)) ORDER BY {FILE_ORDER}"
        ))?
        .query_map([ids_json(file_ids)], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for f in sorted {
        append_item(&tx, playlist_id, ItemKind::File, Some(f), None, false)?;
    }
    tx.commit()?;
    Ok(())
}

/// プレイリストの最後に、タグの組み合わせを加える
pub fn add_tags(conn: &mut Connection, playlist_id: i64, tag_ids: &[i64]) -> Result<i64> {
    let tx = conn.transaction()?;
    ensure_exists(&tx, playlist_id)?;
    let mut tags: Vec<i64> = Vec::new();
    for &t in tag_ids {
        if exists(&tx, "tags", t)? && !tags.contains(&t) {
            tags.push(t);
        }
    }
    if tags.is_empty() {
        return Err(Error::invalid("タグを1つ以上選んでください"));
    }
    let item = append_item(&tx, playlist_id, ItemKind::Tags, None, None, false)?;
    for t in tags {
        tx.execute("INSERT INTO playlist_item_tags (item_id, tag_id) VALUES (?1, ?2)", [item, t])?;
    }
    tx.commit()?;
    Ok(item)
}

/// プレイリストの最後に、別のプレイリストを参照として加える。ループになるならエラー
pub fn add_playlist_ref(conn: &mut Connection, playlist_id: i64, ref_id: i64) -> Result<i64> {
    let tx = conn.transaction()?;
    ensure_exists(&tx, playlist_id)?;
    ensure_exists(&tx, ref_id)?;
    check_no_loop(&tx, playlist_id, ref_id)?;
    let item = append_item(&tx, playlist_id, ItemKind::Playlist, None, Some(ref_id), false)?;
    tx.commit()?;
    Ok(item)
}

fn item_playlist(conn: &Connection, item_id: i64) -> Result<i64> {
    conn.query_row("SELECT playlist_id FROM playlist_items WHERE id = ?1", [item_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| Error::invalid("項目が見つかりません"))
}

/// 項目を外す。子のプレイリストの項目なら、その子は最上位の最後に移る（消さない）
pub fn remove_item(conn: &mut Connection, item_id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    item_playlist(&tx, item_id)?;
    let child: Option<i64> = tx
        .query_row(
            "SELECT ref_id FROM playlist_items WHERE id = ?1 AND kind = 'playlist' AND owned = 1",
            [item_id],
            |r| r.get(0),
        )
        .optional()?;
    tx.execute("DELETE FROM playlist_items WHERE id = ?1", [item_id])?;
    if let Some(c) = child {
        let mut ids: Vec<i64> = roots(&tx)?.into_iter().filter(|&p| p != c).collect();
        ids.push(c);
        write_root_order(&tx, &ids)?;
    }
    tx.commit()?;
    Ok(())
}

/// プレイリストから、そのファイルの項目をすべて外し、外した数を返す（右の欄のプレイリストのチップの「✕」）
pub fn remove_file_from_playlist(conn: &Connection, playlist_id: i64, file_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM playlist_items WHERE playlist_id = ?1 AND kind = 'file' AND file_id = ?2",
        [playlist_id, file_id],
    )?)
}

/// プレイリストから、ファイル（file_ids）の項目をまとめて外す（ファイルの項目だけ。タグの組み合わせなどはそのまま）。外した項目の数を返す
pub fn remove_files_from_playlist(conn: &Connection, playlist_id: i64, file_ids: &[i64]) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM playlist_items WHERE playlist_id = ?1 AND kind = 'file' AND file_id IN (SELECT value FROM json_each(?2))",
        rusqlite::params![playlist_id, crate::db::ids_json(file_ids)],
    )?)
}

/// 項目を、同じプレイリストの中の index の位置（0から）に移す
pub fn move_item(conn: &mut Connection, item_id: i64, index: usize) -> Result<()> {
    let tx = conn.transaction()?;
    let playlist = item_playlist(&tx, item_id)?;
    let mut ids: Vec<i64> = item_ids(&tx, playlist)?.into_iter().filter(|&i| i != item_id).collect();
    ids.insert(index.min(ids.len()), item_id);
    write_item_order(&tx, playlist, &ids)?;
    tx.commit()?;
    Ok(())
}

/// 項目の別名を変える。空（空白だけを含む）なら外す
pub fn set_item_alias(conn: &Connection, item_id: i64, alias: &str) -> Result<()> {
    let alias = alias.trim();
    let alias = if alias.is_empty() { None } else { Some(normalize_name(alias, "別名")?) };
    if conn.execute("UPDATE playlist_items SET alias = ?2 WHERE id = ?1", params![item_id, alias])? == 0 {
        return Err(Error::invalid("項目が見つかりません"));
    }
    Ok(())
}

pub fn set_item_mode(conn: &Connection, item_id: i64, mode: PlayMode) -> Result<()> {
    let n = conn.execute(
        "UPDATE playlist_items SET mode = ?2 WHERE id = ?1 AND kind <> 'file'",
        params![item_id, mode],
    )?;
    if n == 0 {
        return Err(Error::invalid("再生方法を変えられる項目が見つかりません"));
    }
    Ok(())
}

/// ファイルを項目として直接入れているプレイリスト（名前の順でなく、左の欄と同じ並びは画面側で決める）
pub fn playlists_with_file(conn: &Connection, file_id: i64) -> Result<Vec<i64>> {
    Ok(conn
        .prepare("SELECT DISTINCT playlist_id FROM playlist_items WHERE file_id = ?1 ORDER BY playlist_id")?
        .query_map([file_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// タグが1つもなくなったタグの組み合わせの項目を外す（タグの削除の後に呼ぶ）
pub fn remove_empty_tag_items(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM playlist_items WHERE kind = 'tags'
         AND NOT EXISTS (SELECT 1 FROM playlist_item_tags it WHERE it.item_id = playlist_items.id)",
        [],
    )?)
}
