//! プレイリスト（項目の管理、階層、ループの防止）。再生順の展開は expand.rs
//!
//! 子のプレイリストは、親の項目（種類がプレイリストで owned = 1）として持つ。
//! どこの子でもないプレイリストが最上位で、最上位の中の順番は playlists.position に持つ。

pub mod draw;
mod expand;
mod items;

use std::collections::{HashMap, HashSet};

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};

use crate::db::{exists, ids_json, now};
use crate::error::{Error, Result};
use crate::files::FILE_ORDER;
use crate::names::{ensure_unique_name, normalize_name};
use crate::tags::tag_rank;
use crate::tree::{MoveTarget, NamedRef};

/// 抽象的な項目（タグの組み合わせ、プレイリスト）の再生方法
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayMode {
    /// 順に再生
    #[default]
    Order,
    /// 並べ替えて全部再生
    Shuffle,
    /// 1つだけ選んで再生
    Random,
}

/// 項目の種類
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    File,
    Tags,
    Playlist,
}

/// データベースの文字列（playlist_items の mode・kind 列）と列挙型の対応。
/// 決まった文字列以外はエラーにする（黙って別の値として扱わない）
macro_rules! sql_text_enum {
    ($ty:ident, $what:literal, { $($variant:ident => $text:literal),+ $(,)? }) => {
        impl $ty {
            fn as_str(self) -> &'static str {
                match self {
                    $($ty::$variant => $text),+
                }
            }
        }

        impl ToSql for $ty {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }

        impl FromSql for $ty {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                match value.as_str()? {
                    $($text => Ok($ty::$variant),)+
                    other => Err(FromSqlError::Other(format!("不明な{}です: {other}", $what).into())),
                }
            }
        }
    };
}

sql_text_enum!(PlayMode, "再生方法", { Order => "order", Shuffle => "shuffle", Random => "random" });
sql_text_enum!(ItemKind, "項目の種類", { File => "file", Tags => "tags", Playlist => "playlist" });

/// 左の欄に出すプレイリスト（階層の順）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistNode {
    pub id: i64,
    pub name: String,
    /// 親（このプレイリストを子として持つプレイリスト）。最上位なら None
    pub parent_id: Option<i64>,
    pub depth: i64,
    /// 通しで流したときに鳴る曲の数（🎲の項目は1曲。見つからないファイルは数えない）。左の欄の行の件数
    pub track_count: i64,
    /// 項目として直接入れているプレイリスト（子と参照）。画面でループになる候補を外すのに使う
    pub refs: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemFile {
    pub id: i64,
    pub rel_path: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistItem {
    pub id: i64,
    pub kind: ItemKind,
    pub mode: PlayMode,
    /// 子のプレイリストの項目か（参照なら false）
    pub owned: bool,
    pub file: Option<ItemFile>,
    /// タグの組み合わせ（タグの一覧の順）
    pub tags: Vec<NamedRef>,
    pub playlist: Option<NamedRef>,
    /// 再生したときのファイル数（ランダムセレクトは1。見つからないファイルは数えない）
    pub file_count: i64,
    /// 別名（このプレイリストの中でだけ使う名前）。なければ None
    pub alias: Option<String>,
    /// 結び付けたエフェクトセット。なければ None
    pub effect_chain: Option<NamedRef>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
    pub id: i64,
    pub name: String,
    pub items: Vec<PlaylistItem>,
}

/// 再生順の1曲
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlayEntry {
    pub file_id: i64,
    pub rel_path: String,
    /// 絶対パス
    pub path: String,
    /// ファイルの項目の別名。タグの組み合わせから選ばれた曲や、別名のない項目は None
    pub alias: Option<String>,
    /// かけるエフェクトセット（内側の項目のものから外側へ、かける順）。空ならエフェクトなし
    pub chains: Vec<i64>,
    /// この曲を出した、再生したプレイリストの（いちばん外側の）項目。編集画面で再生中の項目を示すのに使う
    pub item_id: Option<i64>,
}

/// エラーの文言に入れる名前
const WHAT: &str = "プレイリスト";

fn not_found() -> Error {
    crate::names::not_found(WHAT)
}

fn ensure_exists(conn: &Connection, id: i64) -> Result<()> {
    if exists(conn, "playlists", id)? { Ok(()) } else { Err(not_found()) }
}

/// プレイリストを子として持つプレイリスト（最上位なら None）と、その項目のid
fn owner_of(conn: &Connection, id: i64) -> Result<Option<(i64, i64)>> {
    Ok(conn
        .query_row(
            "SELECT playlist_id, id FROM playlist_items WHERE kind = 'playlist' AND owned = 1 AND ref_id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// 最上位のプレイリスト（順番どおり）
fn roots(conn: &Connection) -> Result<Vec<i64>> {
    Ok(conn
        .prepare(
            "SELECT p.id FROM playlists p
             WHERE NOT EXISTS (SELECT 1 FROM playlist_items i
                               WHERE i.kind = 'playlist' AND i.owned = 1 AND i.ref_id = p.id)
             ORDER BY p.position, p.name COLLATE NOCASE",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// プレイリストの項目のid（順番どおり）
fn item_ids(conn: &Connection, playlist_id: i64) -> Result<Vec<i64>> {
    Ok(conn
        .prepare("SELECT id FROM playlist_items WHERE playlist_id = ?1 ORDER BY position, id")?
        .query_map([playlist_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

fn write_item_order(conn: &Connection, playlist_id: i64, ids: &[i64]) -> Result<()> {
    let mut stmt = conn.prepare("UPDATE playlist_items SET playlist_id = ?2, position = ?3 WHERE id = ?1")?;
    for (pos, id) in ids.iter().enumerate() {
        stmt.execute(params![id, playlist_id, pos as i64])?;
    }
    Ok(())
}

fn write_root_order(conn: &Connection, ids: &[i64]) -> Result<()> {
    let mut stmt = conn.prepare("UPDATE playlists SET position = ?2 WHERE id = ?1")?;
    for (pos, id) in ids.iter().enumerate() {
        stmt.execute(params![id, pos as i64])?;
    }
    Ok(())
}

/// from から項目をたどって行けるプレイリスト（from 自身を含む）
fn reachable(conn: &Connection, from: i64) -> Result<HashSet<i64>> {
    Ok(conn
        .prepare(
            "WITH RECURSIVE r(id) AS (
               SELECT ?1
               UNION SELECT i.ref_id FROM playlist_items i JOIN r ON i.playlist_id = r.id
                     WHERE i.kind = 'playlist')
             SELECT id FROM r",
        )?
        .query_map([from], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// container の中に playlist を入れるとループになるなら、エラーにする
fn check_no_loop(conn: &Connection, container: i64, playlist: i64) -> Result<()> {
    if reachable(conn, playlist)?.contains(&container) {
        return Err(Error::invalid(
            "ループになるため入れられません（プレイリストが自分自身を含むことになります）",
        ));
    }
    Ok(())
}

pub fn list_playlists(conn: &Connection) -> Result<Vec<PlaylistNode>> {
    let names: HashMap<i64, String> = conn
        .prepare("SELECT id, name FROM playlists")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let tracks = track_counts(conn)?;
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut refs: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in conn
        .prepare(
            "SELECT playlist_id, ref_id, owned FROM playlist_items
             WHERE kind = 'playlist' ORDER BY playlist_id, position, id",
        )?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, bool>(2)?)))?
    {
        let (parent, child, owned) = row?;
        if owned {
            children.entry(parent).or_default().push(child);
        }
        let list = refs.entry(parent).or_default();
        if !list.contains(&child) {
            list.push(child);
        }
    }

    let mut out = Vec::with_capacity(names.len());
    let mut visited = HashSet::new();
    let mut stack: Vec<(i64, Option<i64>, i64)> = roots(conn)?.into_iter().rev().map(|id| (id, None, 0)).collect();
    while let Some((id, parent_id, depth)) = stack.pop() {
        if !visited.insert(id) {
            continue;
        }
        out.push(PlaylistNode {
            id,
            name: names.get(&id).cloned().unwrap_or_default(),
            parent_id,
            depth,
            track_count: tracks.get(&id).copied().unwrap_or(0),
            refs: refs.get(&id).cloned().unwrap_or_default(),
        });
        for &c in children.get(&id).map(Vec::as_slice).unwrap_or_default().iter().rev() {
            stack.push((c, Some(id), depth + 1));
        }
    }
    Ok(out)
}

/// 項目をプレイリストの最後に加え、項目のidを返す
fn append_item(
    conn: &Connection,
    playlist_id: i64,
    kind: ItemKind,
    file_id: Option<i64>,
    ref_id: Option<i64>,
    owned: bool,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO playlist_items (playlist_id, position, kind, file_id, ref_id, owned, mode)
         VALUES (?1, (SELECT coalesce(max(position) + 1, 0) FROM playlist_items WHERE playlist_id = ?1),
                 ?2, ?3, ?4, ?5, 'order')",
        params![playlist_id, kind, file_id, ref_id, owned],
    )?;
    Ok(conn.last_insert_rowid())
}

/// プレイリストを作る。parent を指定すると、その子（親の項目の最後）にする。指定しなければ最上位の最後
pub fn create_playlist(conn: &mut Connection, name: &str, parent: Option<i64>) -> Result<i64> {
    let name = normalize_name(name, WHAT)?;
    let tx = conn.transaction()?;
    ensure_unique_name(&tx, "playlists", WHAT, &name, None)?;
    if let Some(p) = parent {
        ensure_exists(&tx, p)?;
    }
    tx.execute(
        "INSERT INTO playlists (name, position, created_at)
         VALUES (?1, (SELECT coalesce(max(position) + 1, 0) FROM playlists), ?2)",
        params![name, now()],
    )?;
    let id = tx.last_insert_rowid();
    if let Some(p) = parent {
        append_item(&tx, p, ItemKind::Playlist, None, Some(id), true)?;
    }
    tx.commit()?;
    Ok(id)
}

pub fn rename_playlist(conn: &Connection, id: i64, name: &str) -> Result<()> {
    let name = normalize_name(name, WHAT)?;
    ensure_unique_name(conn, "playlists", WHAT, &name, Some(id))?;
    if conn.execute("UPDATE playlists SET name = ?2 WHERE id = ?1", params![id, name])? == 0 {
        return Err(not_found());
    }
    Ok(())
}

/// プレイリストを削除する。子は削除したプレイリストがあった位置に繰り上がり、ほかのプレイリストからの参照は外れる。
pub fn delete_playlist(conn: &mut Connection, id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    ensure_exists(&tx, id)?;
    // 子の項目（順番どおり）
    let child_items: Vec<(i64, i64)> = tx
        .prepare(
            "SELECT id, ref_id FROM playlist_items
             WHERE playlist_id = ?1 AND kind = 'playlist' AND owned = 1 ORDER BY position, id",
        )?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    match owner_of(&tx, id)? {
        Some((parent, own_item)) => {
            // 親の項目の並びで、削除するプレイリストの項目を、子の項目に置き換える
            let ids: Vec<i64> = item_ids(&tx, parent)?
                .into_iter()
                .flat_map(|i| if i == own_item { child_items.iter().map(|c| c.0).collect() } else { vec![i] })
                .collect();
            write_item_order(&tx, parent, &ids)?;
        }
        None => {
            let ids: Vec<i64> = roots(&tx)?
                .into_iter()
                .flat_map(|p| if p == id { child_items.iter().map(|c| c.1).collect() } else { vec![p] })
                .collect();
            // 子の項目を消すと、子は最上位になる
            for (item, _) in &child_items {
                tx.execute("DELETE FROM playlist_items WHERE id = ?1", [item])?;
            }
            write_root_order(&tx, &ids)?;
        }
    }
    // 自分の項目と、ほかのプレイリストからの参照の項目は、外部キーで消える
    tx.execute("DELETE FROM playlists WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

/// 左の欄での並べ替え。子孫や参照も一緒に移る。ループになる位置にはエラー
pub fn move_playlist(conn: &mut Connection, id: i64, target: MoveTarget) -> Result<()> {
    let tx = conn.transaction()?;
    ensure_exists(&tx, id)?;
    let anchor = match target {
        MoveTarget::Before(t) | MoveTarget::After(t) => {
            if t == id {
                return Err(Error::invalid("プレイリストを自分自身の前後には移せません"));
            }
            ensure_exists(&tx, t)?;
            Some(t)
        }
        MoveTarget::Child(t) => {
            ensure_exists(&tx, t)?;
            None
        }
        MoveTarget::Root => None,
    };
    // 移す先（子にする親。最上位なら None）
    let container = match target {
        MoveTarget::Before(t) | MoveTarget::After(t) => owner_of(&tx, t)?.map(|(p, _)| p),
        MoveTarget::Child(t) => Some(t),
        MoveTarget::Root => None,
    };
    if let Some(c) = container {
        check_no_loop(&tx, c, id)?;
    }
    let current = owner_of(&tx, id)?;

    match container {
        Some(c) => {
            // 今の親での項目をそのまま使う（再生方法を引き継ぐ）。最上位からなら新しく作る
            let item = match current {
                Some((_, item)) => item,
                None => append_item(&tx, c, ItemKind::Playlist, None, Some(id), true)?,
            };
            let mut ids: Vec<i64> = item_ids(&tx, c)?.into_iter().filter(|&i| i != item).collect();
            let index = match (target, anchor) {
                (MoveTarget::Before(_) | MoveTarget::After(_), Some(a)) => {
                    let (_, anchor_item) = owner_of(&tx, a)?.ok_or_else(not_found)?;
                    let pos = ids.iter().position(|&i| i == anchor_item).unwrap_or(ids.len());
                    if matches!(target, MoveTarget::After(_)) { pos + 1 } else { pos }
                }
                _ => ids.len(),
            };
            ids.insert(index.min(ids.len()), item);
            write_item_order(&tx, c, &ids)?;
        }
        None => {
            if let Some((_, item)) = current {
                tx.execute("DELETE FROM playlist_items WHERE id = ?1", [item])?;
            }
            let mut ids: Vec<i64> = roots(&tx)?.into_iter().filter(|&p| p != id).collect();
            let index = match (target, anchor) {
                (MoveTarget::Before(_), Some(a)) => ids.iter().position(|&p| p == a).unwrap_or(0),
                (MoveTarget::After(_), Some(a)) => ids.iter().position(|&p| p == a).map_or(ids.len(), |i| i + 1),
                _ => ids.len(),
            };
            ids.insert(index.min(ids.len()), id);
            write_root_order(&tx, &ids)?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub use expand::expand_playlist;
pub use expand::{expand_playlist_item, item_files, ExportNode};
pub use items::*;
use expand::{count_item, track_counts, Catalog};

pub fn get_playlist(conn: &Connection, id: i64) -> Result<PlaylistDetail> {
    let mut cat = Catalog::load(conn)?;
    let name = cat.names.get(&id).cloned().ok_or_else(not_found)?;
    let order = tag_rank(conn)?;
    let tag_names: HashMap<i64, String> = conn
        .prepare("SELECT id, name FROM tags")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let chain_names: HashMap<i64, String> = conn
        .prepare("SELECT id, name FROM effect_chains")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut memo = HashMap::new();
    let mut items = Vec::new();
    for row in cat.items(id) {
        let file = row.file_id.and_then(|f| {
            cat.files.get(&f).map(|(rel_path, missing)| ItemFile { id: f, rel_path: rel_path.clone(), missing: *missing })
        });
        let playlist = row.ref_id.and_then(|r| cat.names.get(&r).map(|name| NamedRef { id: r, name: name.clone() }));
        let mut tags: Vec<NamedRef> = cat
            .item_tags
            .get(&row.id)
            .map(|ids| {
                ids.iter()
                    .filter_map(|t| tag_names.get(t).map(|name| NamedRef { id: *t, name: name.clone() }))
                    .collect()
            })
            .unwrap_or_default();
        tags.sort_by_key(|t| order.get(&t.id).copied().unwrap_or(usize::MAX));
        let file_count = count_item(&mut cat, &row, &mut memo, &mut vec![id])?;
        items.push(PlaylistItem {
            id: row.id,
            kind: row.kind,
            mode: row.mode,
            owned: row.owned,
            file,
            tags,
            playlist,
            file_count,
            alias: row.alias.clone(),
            effect_chain: row
                .effect_chain_id
                .and_then(|c| chain_names.get(&c).map(|name| NamedRef { id: c, name: name.clone() })),
        });
    }
    Ok(PlaylistDetail { id, name, items })
}

#[cfg(test)]
mod tests;
