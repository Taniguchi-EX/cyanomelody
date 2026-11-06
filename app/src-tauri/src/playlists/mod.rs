//! プレイリスト（項目の管理、階層、ループの防止）。再生順の展開は expand.rs
//!
//! 子のプレイリストは、親の項目（種類がプレイリストで owned = 1）として持つ。
//! どこの子でもないプレイリストが最上位で、最上位の中の順番は playlists.position に持つ。

mod expand;

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
    pub item_count: i64,
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
    /// この曲を出した、再生したプレイリストの（いちばん外側の）項目。詳細画面で再生中の項目を示すのに使う
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
    let counts: HashMap<i64, i64> = conn
        .prepare("SELECT playlist_id, count(*) FROM playlist_items GROUP BY playlist_id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
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
            item_count: counts.get(&id).copied().unwrap_or(0),
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

/// ファイルを項目として直接入れているプレイリスト（名前の順でなく、左の欄と同じ並びは画面側で決める）
pub fn playlists_with_file(conn: &Connection, file_id: i64) -> Result<Vec<i64>> {
    Ok(conn
        .prepare("SELECT DISTINCT playlist_id FROM playlist_items WHERE file_id = ?1 ORDER BY playlist_id")?
        .query_map([file_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

pub use expand::{expand_playlist, expand_playlist_item, item_files, plan_export, ExportNode};
use expand::{count_item, Catalog};

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

/// タグが1つもなくなったタグの組み合わせの項目を外す（タグの削除の後に呼ぶ）
pub fn remove_empty_tag_items(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM playlist_items WHERE kind = 'tags'
         AND NOT EXISTS (SELECT 1 FROM playlist_item_tags it WHERE it.item_id = playlist_items.id)",
        [],
    )?)
}

#[cfg(test)]
mod tests {
    use super::expand::{expand_item_with, expand_with, plan_export_with, Rng};
    use super::*;
    use crate::db::test_db;
    use crate::files::add_tag;

    /// ファイル5件（id 1〜5）を入れたDB。5は見つからないファイル
    fn setup() -> Connection {
        test_db(&["a.wav", "b.wav", "c.wav", "d.wav", "e.wav"], &["e.wav"])
    }

    /// 左の欄の並びを「名前:深さ」で
    fn tree(conn: &Connection) -> String {
        list_playlists(conn)
            .unwrap()
            .into_iter()
            .map(|n| format!("{}:{}", n.name, n.depth))
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn files_of(conn: &Connection, id: i64, mode: PlayMode, seed: u64) -> Vec<i64> {
        expand_with(conn, id, mode, &mut Rng(seed)).unwrap().into_iter().map(|e| e.file_id).collect()
    }

    #[test]
    fn create_rename_and_names() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, " 戦闘 ", None).unwrap();
        let b = create_playlist(&mut conn, "足音", Some(a)).unwrap();
        create_playlist(&mut conn, "環境", None).unwrap();
        assert!(create_playlist(&mut conn, "足音", None).is_err());
        assert!(create_playlist(&mut conn, "", None).is_err());
        assert!(create_playlist(&mut conn, "x", Some(99)).is_err());
        assert_eq!(tree(&conn), "戦闘:0 足音:1 環境:0");
        assert!(rename_playlist(&conn, b, "環境").is_err());
        rename_playlist(&conn, b, "足音2").unwrap();
        let nodes = list_playlists(&conn).unwrap();
        assert_eq!(nodes[1].name, "足音2");
        assert_eq!(nodes[1].parent_id, Some(a));
        assert_eq!(nodes[0].refs, vec![b]);
        assert_eq!(nodes[0].item_count, 1);
    }

    #[test]
    fn loops_are_rejected() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        let b = create_playlist(&mut conn, "B", Some(a)).unwrap();
        let c = create_playlist(&mut conn, "C", None).unwrap();
        add_playlist_ref(&mut conn, b, c).unwrap();
        // 自分自身
        assert!(add_playlist_ref(&mut conn, a, a).is_err());
        // A → B → C なので、C に A・B は入れられない
        assert!(add_playlist_ref(&mut conn, c, a).is_err());
        assert!(add_playlist_ref(&mut conn, c, b).is_err());
        assert!(move_playlist(&mut conn, a, MoveTarget::Child(c)).is_err());
        assert!(move_playlist(&mut conn, a, MoveTarget::Child(b)).is_err());
        assert!(move_playlist(&mut conn, a, MoveTarget::Child(a)).is_err());
        assert!(move_playlist(&mut conn, a, MoveTarget::Before(a)).is_err());
        // 同じものを2回参照するのはループではない
        add_playlist_ref(&mut conn, a, c).unwrap();
        assert_eq!(tree(&conn), "A:0 B:1 C:0");
    }

    #[test]
    fn move_playlists_in_the_tree() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        let b = create_playlist(&mut conn, "B", None).unwrap();
        let c = create_playlist(&mut conn, "C", None).unwrap();
        add_files(&mut conn, a, &[1]).unwrap();
        move_playlist(&mut conn, b, MoveTarget::Child(a)).unwrap();
        assert_eq!(tree(&conn), "A:0 B:1 C:0");
        // 子の項目は、親の項目の並びの最後に入る
        let items = get_playlist(&conn, a).unwrap().items;
        assert_eq!(items.iter().map(|i| i.kind).collect::<Vec<_>>(), vec![ItemKind::File, ItemKind::Playlist]);
        // 子の前に移すと、親の項目の並びの中で前に入る
        move_playlist(&mut conn, c, MoveTarget::Before(b)).unwrap();
        assert_eq!(tree(&conn), "A:0 C:1 B:1");
        let items = get_playlist(&conn, a).unwrap().items;
        assert_eq!(items[1].playlist.as_ref().unwrap().name, "C");
        // 子の再生方法は、親の中で動かしても引き継ぐ
        set_item_mode(&conn, items[1].id, PlayMode::Shuffle).unwrap();
        move_playlist(&mut conn, c, MoveTarget::After(b)).unwrap();
        let items = get_playlist(&conn, a).unwrap().items;
        assert_eq!((items[2].playlist.as_ref().unwrap().name.as_str(), items[2].mode), ("C", PlayMode::Shuffle));
        // 最上位へ
        move_playlist(&mut conn, b, MoveTarget::Root).unwrap();
        assert_eq!(tree(&conn), "A:0 C:1 B:0");
        move_playlist(&mut conn, b, MoveTarget::Before(a)).unwrap();
        assert_eq!(tree(&conn), "B:0 A:0 C:1");
        move_playlist(&mut conn, c, MoveTarget::After(b)).unwrap();
        assert_eq!(tree(&conn), "B:0 C:0 A:0");
        assert_eq!(get_playlist(&conn, a).unwrap().items.len(), 1);
    }

    #[test]
    fn items_add_move_remove() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        create_playlist(&mut conn, "B", Some(a)).unwrap();
        let c = create_playlist(&mut conn, "C", None).unwrap();
        add_files(&mut conn, a, &[1, 2, 99]).unwrap();
        let rain = add_tag(&mut conn, &[1, 3], "雨").unwrap();
        let wind = add_tag(&mut conn, &[3], "風").unwrap();
        assert!(add_tags(&mut conn, a, &[]).is_err());
        add_tags(&mut conn, a, &[wind, rain, rain]).unwrap();
        add_playlist_ref(&mut conn, a, c).unwrap();
        let items = get_playlist(&conn, a).unwrap().items;
        // 子（B）、ファイル2つ（99はない）、タグの組み合わせ、参照（C）
        assert_eq!(items.len(), 5);
        assert!(items[0].owned);
        assert_eq!(items[1].file.as_ref().unwrap().rel_path, "a.wav");
        assert_eq!(items[3].tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["雨", "風"]);
        assert_eq!(items[3].file_count, 1);
        assert!(!items[4].owned);
        // ファイルの項目は再生方法を持たない
        assert!(set_item_mode(&conn, items[1].id, PlayMode::Random).is_err());
        move_item(&mut conn, items[4].id, 0).unwrap();
        let names: Vec<_> = get_playlist(&conn, a).unwrap().items.iter().map(|i| i.kind).collect();
        assert_eq!(names[0], ItemKind::Playlist);
        // 子の項目を外すと、子は最上位に移る
        remove_item(&mut conn, items[0].id).unwrap();
        assert_eq!(tree(&conn), "A:0 C:0 B:0");
        assert!(remove_item(&mut conn, 999).is_err());
    }

    #[test]
    fn remove_file_removes_only_that_file_in_that_playlist() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        let b = create_playlist(&mut conn, "B", None).unwrap();
        // 同じファイルを2回入れる（1回の追加では重ならないので、分けて入れる）
        add_files(&mut conn, a, &[1, 2]).unwrap();
        add_files(&mut conn, a, &[1]).unwrap();
        add_files(&mut conn, b, &[1]).unwrap();
        assert_eq!(remove_file_from_playlist(&conn, a, 1).unwrap(), 2);
        let files = |p: i64| -> Vec<i64> {
            get_playlist(&conn, p).unwrap().items.iter().map(|i| i.file.as_ref().unwrap().id).collect()
        };
        assert_eq!(files(a), vec![2]);
        assert_eq!(files(b), vec![1]);
        assert_eq!(playlists_with_file(&conn, 1).unwrap(), vec![b]);
    }

    #[test]
    fn delete_promotes_children_and_removes_refs() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        let b = create_playlist(&mut conn, "B", Some(a)).unwrap();
        create_playlist(&mut conn, "B1", Some(b)).unwrap();
        create_playlist(&mut conn, "B2", Some(b)).unwrap();
        let c = create_playlist(&mut conn, "C", None).unwrap();
        add_playlist_ref(&mut conn, c, b).unwrap();
        add_files(&mut conn, a, &[1]).unwrap();
        delete_playlist(&mut conn, b).unwrap();
        assert_eq!(tree(&conn), "A:0 B1:1 B2:1 C:0");
        assert!(get_playlist(&conn, c).unwrap().items.is_empty());
        let items = get_playlist(&conn, a).unwrap().items;
        assert_eq!(items.len(), 3);
        // 最上位のプレイリストを消すと、子は最上位のその位置に入る
        delete_playlist(&mut conn, a).unwrap();
        assert_eq!(tree(&conn), "B1:0 B2:0 C:0");
        assert!(delete_playlist(&mut conn, a).is_err());
    }

    #[test]
    fn expand_one_item_and_playlists_with_file() {
        let mut conn = setup();
        let rain = add_tag(&mut conn, &[1, 2, 3], "雨").unwrap();
        let steps = create_playlist(&mut conn, "足音", None).unwrap();
        add_files(&mut conn, steps, &[2, 3]).unwrap();
        let battle = create_playlist(&mut conn, "戦闘", None).unwrap();
        add_files(&mut conn, battle, &[4]).unwrap();
        let tag_item = add_tags(&mut conn, battle, &[rain]).unwrap();
        let ref_item = add_playlist_ref(&mut conn, battle, steps).unwrap();
        let file_item = get_playlist(&conn, battle).unwrap().items[0].id;
        set_item_alias(&conn, file_item, "扉").unwrap();
        let one = |id, seed| expand_item_with(&conn, id, &mut Rng(seed)).unwrap();
        let ids = |v: Vec<PlayEntry>| v.into_iter().map(|e| e.file_id).collect::<Vec<_>>();
        let f = one(file_item, 1);
        assert_eq!((f.len(), f[0].file_id, f[0].alias.as_deref()), (1, 4, Some("扉")));
        assert_eq!(ids(one(tag_item, 1)), vec![1, 2, 3]);
        assert_eq!(ids(one(ref_item, 1)), vec![2, 3]);
        set_item_mode(&conn, tag_item, PlayMode::Random).unwrap();
        assert_eq!(one(tag_item, 7).len(), 1);
        assert!(expand_item_with(&conn, 9999, &mut Rng(1)).is_err());

        assert_eq!(playlists_with_file(&conn, 2).unwrap(), vec![steps]);
        assert_eq!(playlists_with_file(&conn, 4).unwrap(), vec![battle]);
        // タグの組み合わせで入るだけのファイルは含めない
        assert!(playlists_with_file(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn entries_know_their_outer_item_and_item_files_lists_all() {
        let mut conn = setup();
        let rain = add_tag(&mut conn, &[1, 2, 3], "雨").unwrap();
        let steps = create_playlist(&mut conn, "足音", None).unwrap();
        add_files(&mut conn, steps, &[2, 3]).unwrap();
        let battle = create_playlist(&mut conn, "戦闘", None).unwrap();
        add_files(&mut conn, battle, &[4]).unwrap();
        let tag_item = add_tags(&mut conn, battle, &[rain]).unwrap();
        let ref_item = add_playlist_ref(&mut conn, battle, steps).unwrap();
        let file_item = get_playlist(&conn, battle).unwrap().items[0].id;
        // 再生の順の各曲が、戦闘のどの項目から出たか（足音の中の項目ではなく、戦闘の項目）
        let entries = expand_with(&conn, battle, PlayMode::Order, &mut Rng(1)).unwrap();
        let items: Vec<Option<i64>> = entries.iter().map(|e| e.item_id).collect();
        let (f, t, r) = (Some(file_item), Some(tag_item), Some(ref_item));
        assert_eq!(items, vec![f, t, t, t, r, r]);
        // 項目1つだけの再生でも、その項目
        let one = expand_item_with(&conn, ref_item, &mut Rng(1)).unwrap();
        assert!(one.iter().all(|e| e.item_id == Some(ref_item)));
        // 曲のリストは、再生方法にかかわらずすべて並べる
        set_item_mode(&conn, tag_item, PlayMode::Random).unwrap();
        set_item_mode(&conn, ref_item, PlayMode::Shuffle).unwrap();
        let ids = |item: i64| item_files(&conn, item).unwrap().iter().map(|e| e.file_id).collect::<Vec<_>>();
        assert_eq!(ids(tag_item), vec![1, 2, 3]);
        assert_eq!(ids(ref_item), vec![2, 3]);
        assert_eq!(ids(file_item), vec![4]);
        assert!(item_files(&conn, 9999).is_err());
    }

    #[test]
    fn expand_with_modes() {
        let mut conn = setup();
        let rain = add_tag(&mut conn, &[1, 2, 3, 5], "雨").unwrap();
        let steps = create_playlist(&mut conn, "足音", None).unwrap();
        add_files(&mut conn, steps, &[2, 3, 4]).unwrap();
        let battle = create_playlist(&mut conn, "戦闘", None).unwrap();
        add_files(&mut conn, battle, &[4, 5]).unwrap();
        let tag_item = add_tags(&mut conn, battle, &[rain]).unwrap();
        let ref_item = add_playlist_ref(&mut conn, battle, steps).unwrap();

        // 順に：ファイル4（5は見つからないので除く）、雨の1・2・3（5は除く）、足音の2・3・4
        assert_eq!(files_of(&conn, battle, PlayMode::Order, 1), vec![4, 1, 2, 3, 2, 3, 4]);
        // 項目は ファイル4・ファイル5・雨・足音 の順
        assert_eq!(get_playlist(&conn, battle).unwrap().items[2].file_count, 3);

        set_item_mode(&conn, tag_item, PlayMode::Random).unwrap();
        set_item_mode(&conn, ref_item, PlayMode::Shuffle).unwrap();
        for seed in 1..20 {
            let f = files_of(&conn, battle, PlayMode::Order, seed);
            assert_eq!(f.len(), 5);
            assert_eq!(f[0], 4);
            assert!([1, 2, 3].contains(&f[1]));
            let mut rest = f[2..].to_vec();
            rest.sort();
            assert_eq!(rest, vec![2, 3, 4]);
        }
        let items = get_playlist(&conn, battle).unwrap().items;
        assert_eq!((items[1].file_count, items[2].file_count, items[3].file_count), (0, 1, 3));
        // プレイリスト自体の再生方法
        assert_eq!(files_of(&conn, battle, PlayMode::Random, 3).len(), 1);
        let mut all = files_of(&conn, battle, PlayMode::Shuffle, 5);
        all.sort();
        assert_eq!(all.len(), 5);
        // 並べ替えが起きる種がある
        assert!((1..20).any(|s| files_of(&conn, steps, PlayMode::Shuffle, s) != vec![2, 3, 4]));
        let entries = expand_with(&conn, steps, PlayMode::Order, &mut Rng(1)).unwrap();
        assert_eq!(entries[0].rel_path, "b.wav");
        assert!(entries[0].path.ends_with("b.wav"));
        assert!(expand_playlist(&conn, 99, PlayMode::Order).is_err());
    }

    #[test]
    fn nested_children_play_in_place() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        add_files(&mut conn, a, &[1]).unwrap();
        let b = create_playlist(&mut conn, "B", Some(a)).unwrap();
        add_files(&mut conn, b, &[2, 3]).unwrap();
        add_files(&mut conn, a, &[4]).unwrap();
        let empty = create_playlist(&mut conn, "空", Some(a)).unwrap();
        assert_eq!(files_of(&conn, a, PlayMode::Order, 1), vec![1, 2, 3, 4]);
        assert_eq!(files_of(&conn, empty, PlayMode::Random, 1), Vec::<i64>::new());
    }

    #[test]
    fn tag_changes_update_tag_items() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        let rain = add_tag(&mut conn, &[1], "雨").unwrap();
        let wind = add_tag(&mut conn, &[2], "風").unwrap();
        let storm = crate::tags::create_tag(&conn, "嵐").unwrap();
        let only_rain = add_tags(&mut conn, a, &[rain]).unwrap();
        add_tags(&mut conn, a, &[rain, wind]).unwrap();
        add_tags(&mut conn, a, &[storm]).unwrap();
        // 統合すると、組み合わせのタグも統合先になる
        crate::tags::rename_tag(&mut conn, rain, "風", true).unwrap();
        let items = get_playlist(&conn, a).unwrap().items;
        let names = |i: usize| items[i].tags.iter().map(|t| t.name.clone()).collect::<Vec<_>>();
        assert_eq!((names(0), names(1)), (vec!["風".to_string()], vec!["風".to_string()]));
        assert_eq!(items[0].id, only_rain);
        // 削除すると、タグがなくなった組み合わせの項目は外れる
        crate::tags::delete_tag(&mut conn, wind).unwrap();
        let items = get_playlist(&conn, a).unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].tags[0].name, "嵐");
    }

    #[test]
    fn removed_files_leave_playlists() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        add_files(&mut conn, a, &[1, 5]).unwrap();
        // 見つからないファイルの項目は残り、印が分かる
        let items = get_playlist(&conn, a).unwrap().items;
        assert!(items[1].file.as_ref().unwrap().missing);
        assert_eq!(items[1].file_count, 0);
        crate::files::remove_missing_files(&mut conn, &[5]).unwrap();
        assert_eq!(get_playlist(&conn, a).unwrap().items.len(), 1);
        crate::library::remove_folder(&conn, 1).unwrap();
        assert!(get_playlist(&conn, a).unwrap().items.is_empty());
    }

    #[test]
    fn files_are_added_in_list_order() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        add_files(&mut conn, a, &[3, 1, 2]).unwrap();
        let names: Vec<String> =
            get_playlist(&conn, a).unwrap().items.into_iter().map(|i| i.file.unwrap().rel_path).collect();
        assert_eq!(names, vec!["a.wav", "b.wav", "c.wav"]);
    }

    /// 項目の多いプレイリストの表示と展開の速さを測る。cargo test --release playlist_speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn playlist_speed() {
        use std::time::Instant;
        let mut conn = setup();
        {
            let tx = conn.transaction().unwrap();
            let mut stmt = tx
                .prepare("INSERT INTO audio_files (id, folder_id, rel_path, size, modified_at, added_at) VALUES (?1, 1, ?2, 0, 0, 0)")
                .unwrap();
            for i in 100..30_100i64 {
                stmt.execute(rusqlite::params![i, format!("se_{i:05}.wav")]).unwrap();
            }
            drop(stmt);
            tx.commit().unwrap();
        }
        let tags: Vec<i64> = (0..20)
            .map(|k| {
                let ids: Vec<i64> = (100..30_100).filter(|i| i % 20 == k).collect();
                add_tag(&mut conn, &ids, &format!("t{k}")).unwrap()
            })
            .collect();
        // 子を10個持ち、それぞれにファイル100件・タグの組み合わせ5つ。親にもファイル1000件
        let top = create_playlist(&mut conn, "top", None).unwrap();
        add_files(&mut conn, top, &(100..1_100).collect::<Vec<_>>()).unwrap();
        for c in 0..10 {
            let child = create_playlist(&mut conn, &format!("c{c}"), Some(top)).unwrap();
            add_files(&mut conn, child, &(1_100 + c * 100..1_200 + c * 100).collect::<Vec<_>>()).unwrap();
            for k in 0..5 {
                add_tags(&mut conn, child, &[tags[(c as usize + k) % 20]]).unwrap();
            }
        }
        let t0 = Instant::now();
        let detail = get_playlist(&conn, top).unwrap();
        let get_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        let n = expand_playlist(&conn, top, PlayMode::Shuffle).unwrap().len();
        let expand_ms = t1.elapsed().as_secs_f64() * 1000.0;
        println!("編集画面の表示 {get_ms:.1}ms（項目{}件）、展開 {expand_ms:.1}ms（{n}曲）", detail.items.len());
    }

    #[test]
    fn unknown_text_in_database_is_an_error() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        let b = create_playlist(&mut conn, "B", None).unwrap();
        let item = add_playlist_ref(&mut conn, a, b).unwrap();
        // CHECK 制約を外して、決まっていない文字列を入れる
        conn.execute_batch("PRAGMA ignore_check_constraints = ON").unwrap();
        conn.execute("UPDATE playlist_items SET mode = 'loop' WHERE id = ?1", [item]).unwrap();
        let err = get_playlist(&conn, a).unwrap_err().to_string();
        assert!(err.contains("不明な再生方法です: loop"), "{err}");
    }

    /// 3万件が対象のタグの組み合わせ1つのプレイリストを展開する速さ。cargo test --release tag_combo_speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn tag_combo_speed() {
        use std::time::Instant;
        let mut conn = setup();
        {
            let tx = conn.transaction().unwrap();
            let mut stmt = tx
                .prepare("INSERT INTO audio_files (id, folder_id, rel_path, size, modified_at, added_at) VALUES (?1, 1, ?2, 0, 0, 0)")
                .unwrap();
            for i in 100..30_100i64 {
                stmt.execute(rusqlite::params![i, format!("d{:02}/se_{i:05}.wav", i % 100)]).unwrap();
            }
            drop(stmt);
            tx.commit().unwrap();
        }
        let all: Vec<i64> = (1..30_100).collect();
        let tag = add_tag(&mut conn, &all, "大量").unwrap();
        let p = create_playlist(&mut conn, "大量", None).unwrap();
        add_tags(&mut conn, p, &[tag]).unwrap();
        for round in 0..3 {
            let t0 = Instant::now();
            let n = expand_playlist(&conn, p, PlayMode::Order).unwrap().len();
            println!("{round}回目：展開 {:.1}ms（{n}曲）", t0.elapsed().as_secs_f64() * 1000.0);
        }
    }

    #[test]
    fn aliases_are_kept_on_items_and_tracks() {
        let mut conn = setup();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        let b = create_playlist(&mut conn, "B", Some(a)).unwrap();
        add_files(&mut conn, b, &[1, 2]).unwrap();
        let rain = add_tag(&mut conn, &[3], "雨").unwrap();
        add_tags(&mut conn, b, &[rain]).unwrap();
        let items = get_playlist(&conn, b).unwrap().items;
        set_item_alias(&conn, items[0].id, " 激しめの雨 ").unwrap();
        set_item_alias(&conn, items[2].id, "雨の音").unwrap();
        assert!(set_item_alias(&conn, items[1].id, "a\u{7}b").is_err());
        assert!(set_item_alias(&conn, 999, "x").is_err());
        let items = get_playlist(&conn, b).unwrap().items;
        assert_eq!(items[0].alias.as_deref(), Some("激しめの雨"));
        assert_eq!(items[1].alias, None);
        // 親から再生しても、項目の別名は使う。タグの組み合わせから選ばれた曲には付かない
        let entries = expand_with(&conn, a, PlayMode::Order, &mut Rng(1)).unwrap();
        let aliases: Vec<Option<&str>> = entries.iter().map(|e| e.alias.as_deref()).collect();
        assert_eq!(aliases, vec![Some("激しめの雨"), None, None]);
        // 同じファイルを別のプレイリストに入れても、別名は付かない
        let other = create_playlist(&mut conn, "C", None).unwrap();
        add_files(&mut conn, other, &[1]).unwrap();
        assert_eq!(expand_with(&conn, other, PlayMode::Order, &mut Rng(1)).unwrap()[0].alias, None);
        // 空にすると外れる
        set_item_alias(&conn, items[0].id, "  ").unwrap();
        assert_eq!(get_playlist(&conn, b).unwrap().items[0].alias, None);
    }

    #[test]
    fn effects_go_from_inner_to_outer_items() {
        let mut conn = setup();
        let inner = crate::chains::create_chain(&conn, "内").unwrap();
        let outer = crate::chains::create_chain(&conn, "外").unwrap();
        let tagc = crate::chains::create_chain(&conn, "タグ").unwrap();
        let a = create_playlist(&mut conn, "A", None).unwrap();
        let b = create_playlist(&mut conn, "B", Some(a)).unwrap();
        add_files(&mut conn, b, &[1, 2]).unwrap();
        let rain = add_tag(&mut conn, &[3], "雨").unwrap();
        let tag_item = add_tags(&mut conn, a, &[rain]).unwrap();
        let b_items = get_playlist(&conn, b).unwrap().items;
        crate::chains::set_item_chain(&conn, b_items[0].id, Some(inner)).unwrap();
        // A の中の B の項目（子）にエフェクトセットを結び付ける
        let child_item = get_playlist(&conn, a).unwrap().items[0].id;
        crate::chains::set_item_chain(&conn, child_item, Some(outer)).unwrap();
        crate::chains::set_item_chain(&conn, tag_item, Some(tagc)).unwrap();
        let entries = expand_with(&conn, a, PlayMode::Order, &mut Rng(1)).unwrap();
        let chains: Vec<Vec<i64>> = entries.iter().map(|e| e.chains.clone()).collect();
        assert_eq!(chains, vec![vec![inner, outer], vec![outer], vec![tagc]]);
        // B を直接再生すると、A の中の項目のエフェクトセットはかからない
        let entries = expand_with(&conn, b, PlayMode::Order, &mut Rng(1)).unwrap();
        assert_eq!(entries[0].chains, vec![inner]);
        assert!(entries[1].chains.is_empty());
    }

    #[test]
    fn export_plan_keeps_folders_for_ordered_playlists() {
        let mut conn = setup();
        let chain = crate::chains::create_chain(&conn, "c").unwrap();
        let top = create_playlist(&mut conn, "戦闘", None).unwrap();
        add_files(&mut conn, top, &[1, 5]).unwrap();
        let child = create_playlist(&mut conn, "足音", Some(top)).unwrap();
        let grand = create_playlist(&mut conn, "孫", Some(child)).unwrap();
        add_files(&mut conn, grand, &[2]).unwrap();
        add_files(&mut conn, child, &[3]).unwrap();
        let shuffled = create_playlist(&mut conn, "混ぜる", Some(top)).unwrap();
        let inner = create_playlist(&mut conn, "中", Some(shuffled)).unwrap();
        add_files(&mut conn, inner, &[4]).unwrap();
        let items = get_playlist(&conn, top).unwrap().items;
        set_item_alias(&conn, items[0].id, "剣").unwrap();
        crate::chains::set_item_chain(&conn, items[2].id, Some(chain)).unwrap();
        set_item_mode(&conn, items[3].id, PlayMode::Shuffle).unwrap();

        let (name, nodes) = plan_export_with(&conn, top, &mut Rng(1)).unwrap();
        assert_eq!(name, "戦闘");
        let file = |id: i64, alias: Option<&str>, chains: Vec<i64>| ExportNode::File {
            file_id: id,
            alias: alias.map(str::to_owned),
            chains,
        };
        assert_eq!(
            nodes,
            vec![
                file(1, Some("剣"), vec![]),
                // 見つからないファイル（5）も入れる（書き出すときに失敗として数える）
                file(5, None, vec![]),
                ExportNode::Folder {
                    name: "足音".into(),
                    children: vec![
                        ExportNode::Folder { name: "孫".into(), children: vec![file(2, None, vec![chain])] },
                        file(3, None, vec![chain]),
                    ],
                },
                // シャッフルの項目は、中の階層を開いて並べる
                ExportNode::Folder { name: "混ぜる".into(), children: vec![file(4, None, vec![])] },
            ]
        );
    }
}
