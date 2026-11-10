//! 抽選した並び。プレイリストを選んだときに1回展開して決めた、再生する曲の並び。
//! 一時テーブル `temp.draw_rows` に入れ、ファイルの一覧の絞り込み・件数・並べ替え（`files`・`facets`）はそれとつないで行う。
//! 別名とかけるエフェクトセットは写して持たず、通った項目から今の値を引く（別名・fx を変えてもずれないように）

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection, OptionalExtension};

use super::expand::{draw_tracks, DrawnTrack, ExportNode, Rng};
use super::{ItemKind, PlayMode};
use crate::db::ids_json;
use crate::error::Result;

/// 一時テーブル。seq は抽選した順（1 から）、path は通った項目の id（外側から内側）の JSON
const CREATE: &str = "CREATE TEMP TABLE IF NOT EXISTS draw_rows (
    seq INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    top_item INTEGER,
    alias_item INTEGER,
    drawn INTEGER NOT NULL
)";

/// 抽選の回数。乱数の種を環境変数で決めたとき、抽選し直すたびに違う結果にするのに使う
static DRAWS: AtomicU64 = AtomicU64::new(0);

/// 抽選の乱数。環境変数 CYANOMELODY_DRAW_SEED があれば、その種から（画面テストで結果を決めるため）
fn rng() -> Rng {
    let n = DRAWS.fetch_add(1, Ordering::Relaxed);
    match std::env::var("CYANOMELODY_DRAW_SEED").ok().and_then(|s| s.trim().parse::<u64>().ok()) {
        Some(seed) => Rng((seed.wrapping_add(n).wrapping_mul(0x9E37_79B9_7F4A_7C15)) | 1),
        None => Rng::from_time(),
    }
}

/// プレイリストを抽選し、一時テーブルに入れる。中身の版を返す（抽選し直すかどうかを比べるのに使う）
pub fn draw(conn: &Connection, playlist_id: i64) -> Result<String> {
    draw_with(conn, playlist_id, &mut rng())
}

pub(super) fn draw_with(conn: &Connection, playlist_id: i64, rng: &mut Rng) -> Result<String> {
    let tracks = draw_tracks(conn, playlist_id, rng)?;
    conn.execute(CREATE, [])?;
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM temp.draw_rows", [])?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO temp.draw_rows (seq, file_id, path, top_item, alias_item, drawn) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (i, t) in tracks.iter().enumerate() {
            insert.execute(params![
                i as i64 + 1,
                t.file_id,
                ids_json(&t.path),
                t.path.first(),
                t.alias_item,
                t.drawn
            ])?;
        }
    }
    tx.commit()?;
    version(conn, playlist_id).map(|v| v.unwrap_or_default())
}

/// 抽選した並びを空にする（プレイリストの選択を外したとき）
pub fn clear(conn: &Connection) -> Result<()> {
    ensure_table(conn)?;
    conn.execute("DELETE FROM temp.draw_rows", [])?;
    Ok(())
}

/// 一時テーブルがなければ作る（まだ抽選していないときに、抽選した並びで絞り込んでも空になるように）
pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute(CREATE, [])?;
    Ok(())
}

/// プレイリストの中身の版。そのプレイリストと、その中に入っている（子・参照の）プレイリストの、
/// 項目の並び・種類・再生方法・指すファイルとプレイリスト・タグの組み合わせから作る。
/// 別名・fx・名前は入れない（変えても抽選し直さない）。プレイリストがなければ None
pub fn version(conn: &Connection, playlist_id: i64) -> Result<Option<String>> {
    let found: Option<i64> =
        conn.query_row("SELECT id FROM playlists WHERE id = ?1", [playlist_id], |r| r.get(0)).optional()?;
    if found.is_none() {
        return Ok(None);
    }
    let mut items: HashMap<i64, Vec<(i64, String, String, Option<i64>, Option<i64>)>> = HashMap::new();
    for row in conn
        .prepare("SELECT playlist_id, id, kind, mode, file_id, ref_id FROM playlist_items ORDER BY playlist_id, position, id")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))))?
    {
        let (p, item) = row?;
        items.entry(p).or_default().push(item);
    }
    let mut item_tags: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in conn
        .prepare("SELECT item_id, tag_id FROM playlist_item_tags ORDER BY item_id, tag_id")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
    {
        let (item, tag) = row?;
        item_tags.entry(item).or_default().push(tag);
    }
    let mut hasher = DefaultHasher::new();
    let mut seen = HashSet::new();
    let mut stack = vec![playlist_id];
    while let Some(p) = stack.pop() {
        if !seen.insert(p) {
            continue;
        }
        p.hash(&mut hasher);
        for (id, kind, mode, file, r) in items.get(&p).map(Vec::as_slice).unwrap_or_default() {
            (id, kind, mode, file, r).hash(&mut hasher);
            item_tags.get(id).hash(&mut hasher);
            if let Some(r) = r {
                stack.push(*r);
            }
        }
    }
    Ok(Some(format!("{:016x}", hasher.finish())))
}

/// 項目の、行の表示に使う値
#[derive(Debug, Clone)]
pub(crate) struct ItemInfo {
    pub kind: ItemKind,
    pub mode: PlayMode,
    pub alias: Option<String>,
    pub chain: Option<i64>,
    /// 項目の内容（タグの組み合わせは「雨 ＋ 風」、プレイリストはその名前）
    pub label: String,
}

/// すべての項目の、行の表示に使う値
pub(crate) fn item_infos(conn: &Connection) -> Result<HashMap<i64, ItemInfo>> {
    let names: HashMap<i64, String> = conn
        .prepare("SELECT id, name FROM playlists")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut tag_names: HashMap<i64, Vec<String>> = HashMap::new();
    for row in conn
        .prepare(
            "SELECT it.item_id, t.name FROM playlist_item_tags it JOIN tags t ON t.id = it.tag_id
             ORDER BY it.item_id, t.name COLLATE NOCASE",
        )?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
    {
        let (item, name) = row?;
        tag_names.entry(item).or_default().push(name);
    }
    let infos = conn
        .prepare("SELECT id, kind, mode, alias, effect_chain_id, ref_id FROM playlist_items")?
        .query_map([], |r| {
            let id: i64 = r.get(0)?;
            let kind: ItemKind = r.get(1)?;
            let ref_id: Option<i64> = r.get(5)?;
            let label = match kind {
                ItemKind::Tags => tag_names.get(&id).map(|n| n.join(" ＋ ")).unwrap_or_default(),
                ItemKind::Playlist => ref_id.and_then(|p| names.get(&p).cloned()).unwrap_or_default(),
                ItemKind::File => String::new(),
            };
            Ok((id, ItemInfo { kind, mode: r.get(2)?, alias: r.get(3)?, chain: r.get(4)?, label }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(infos)
}

/// 通った項目から、かけるエフェクトセット（内側から外側の順）を引く
pub(crate) fn chains_of(path: &[i64], infos: &HashMap<i64, ItemInfo>) -> Vec<i64> {
    path.iter().rev().filter_map(|i| infos.get(i).and_then(|info| info.chain)).collect()
}

/// 書き出し用に、プレイリストを抽選し直す（中央の一覧の抽選した並びは変えない）。
/// items があれば、その項目（プレイリストの直下）から来た曲だけ。空ならすべて
pub fn draw_items(conn: &Connection, playlist_id: i64, items: &[i64]) -> Result<Vec<DrawnTrack>> {
    let tracks = draw_tracks(conn, playlist_id, &mut rng())?;
    Ok(tracks.into_iter().filter(|t| items.is_empty() || t.path.first().is_some_and(|i| items.contains(i))).collect())
}

/// 抽選した並びの行（seq）のうち、渡した順のものを、書き出す内容にする（`plan_tracks` と同じ。テストで使う）
#[cfg(test)]
pub fn plan_rows(conn: &Connection, seqs: &[i64]) -> Result<Vec<ExportNode>> {
    conn.execute(CREATE, [])?;
    let mut rows: HashMap<i64, DrawnTrack> = conn
        .prepare(
            "SELECT seq, file_id, path, alias_item, drawn FROM temp.draw_rows
             WHERE seq IN (SELECT value FROM json_each(?1)) AND file_id IN (SELECT id FROM audio_files)",
        )?
        .query_map([ids_json(seqs)], |r| {
            let path: String = r.get(2)?;
            Ok((
                r.get(0)?,
                DrawnTrack {
                    file_id: r.get(1)?,
                    path: serde_json::from_str(&path).unwrap_or_default(),
                    alias_item: r.get(3)?,
                    drawn: r.get(4)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let tracks: Vec<DrawnTrack> = seqs.iter().filter_map(|s| rows.remove(s)).collect();
    plan_tracks(conn, &tracks)
}

/// 抽選した曲（渡した順）を、書き出す内容にする。
/// 通った項目のうち、プレイリストの項目はフォルダにする。「順に再生」でない（🔀・🎲の）プレイリストの項目は、
/// その中をフォルダに分けず、そのフォルダに並べる（再生の順番の決め方と同じ）。フォルダの名前は項目の別名かプレイリストの名前
pub fn plan_tracks(conn: &Connection, tracks: &[DrawnTrack]) -> Result<Vec<ExportNode>> {
    let infos = item_infos(conn)?;
    let mut root: Vec<ExportNode> = Vec::new();
    // フォルダの場所（親のフォルダの中での位置の並び）を、通った項目の並びから引く
    let mut folders: HashMap<Vec<i64>, Vec<usize>> = HashMap::new();
    for DrawnTrack { file_id, path, alias_item, .. } in tracks {
        let mut at: Vec<usize> = Vec::new();
        for (depth, item) in path.iter().enumerate() {
            let Some(info) = infos.get(item) else { break };
            if info.kind != ItemKind::Playlist {
                break;
            }
            let key = path[..=depth].to_vec();
            let index = match folders.get(&key) {
                Some(i) => i.clone(),
                None => {
                    let children = children_at(&mut root, &at);
                    let name = info.alias.clone().unwrap_or_else(|| info.label.clone());
                    children.push(ExportNode::Folder { name, children: Vec::new() });
                    let mut index = at.clone();
                    index.push(children.len() - 1);
                    folders.insert(key, index.clone());
                    index
                }
            };
            at = index;
            if info.mode != PlayMode::Order {
                break;
            }
        }
        let alias = alias_item.and_then(|i| infos.get(&i)).and_then(|info| info.alias.clone());
        children_at(&mut root, &at).push(ExportNode::File { file_id: *file_id, alias, chains: chains_of(path, &infos) });
    }
    Ok(root)
}

/// 位置の並び（フォルダの中での位置）でたどった先のフォルダの中身
fn children_at<'a>(root: &'a mut Vec<ExportNode>, at: &[usize]) -> &'a mut Vec<ExportNode> {
    let mut list = root;
    for &i in at {
        list = match &mut list[i] {
            ExportNode::Folder { children, .. } => children,
            ExportNode::File { .. } => unreachable!("フォルダの位置にファイルがある"),
        };
    }
    list
}

#[cfg(test)]
#[path = "draw_tests.rs"]
mod tests;
