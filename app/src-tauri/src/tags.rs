//! タグ自体の管理（作成・名前変更・統合・削除・階層と順番）

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::now;
use crate::names::{ensure_unique_name, find_by_name, normalize_name};
use crate::error::{Error, Result};
use crate::romaji::romaji_key;
use crate::settings;
use crate::tree::MoveTarget;

/// タグ名を区切るための文字（タグ名には入らない制御文字）
pub const TAG_SEPARATOR: char = '\u{1f}';

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    /// 親のタグのid。最上位なら None
    pub parent_id: Option<i64>,
    /// 階層の深さ。最上位は0
    pub depth: i64,
    /// そのタグか子孫のタグが付いたファイルの数
    pub file_count: i64,
    /// 子のタグの並び順と色（詳細画面で設定するもの）
    #[serde(flatten)]
    pub settings: TagSettings,
    /// 表示に使う色。自分の色がなければ、親（その親…）の色を引き継ぐ
    pub shown_bg_color: Option<String>,
    pub shown_fg_color: Option<String>,
    /// 子のタグを実際に並べる順。親の設定を引き継ぐなら、引き継いだもの
    pub shown_child_sort: ChildSort,
    pub shown_child_sort_desc: bool,
    /// シノニム（別の名前）。決めた順
    pub synonyms: Vec<String>,
}

/// 子のタグの並び順。設定では None が「親の設定を引き継ぐ」
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChildSort {
    /// ドラッグで決めた順
    Manual,
    /// 登録順（作った順）
    Created,
    /// ファイル数順（子孫を含む総数）
    Files,
    /// ローマ字順
    Romaji,
}

impl ChildSort {
    fn as_str(self) -> &'static str {
        match self {
            ChildSort::Manual => "manual",
            ChildSort::Created => "created",
            ChildSort::Files => "files",
            ChildSort::Romaji => "romaji",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "manual" => Some(ChildSort::Manual),
            "created" => Some(ChildSort::Created),
            "files" => Some(ChildSort::Files),
            "romaji" => Some(ChildSort::Romaji),
            _ => None,
        }
    }
}

/// タグの詳細画面で設定するもの（名前を除く）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagSettings {
    /// None は親の設定を引き継ぐ（最上位までたどって決まっていなければ、ドラッグで決めた順）
    pub child_sort: Option<ChildSort>,
    pub child_sort_desc: bool,
    /// 背景色・文字色（#rrggbb）。None は親の色を引き継ぐ
    pub bg_color: Option<String>,
    pub fg_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    /// 名前変更後のタグのid。統合したときは統合先のid
    pub tag_id: i64,
    pub merged: bool,
}

/// tags の行（階層を組み立てる前）
struct Row {
    id: i64,
    name: String,
    parent_id: Option<i64>,
    settings: TagSettings,
    /// 子を実際に並べる順（親の設定を引き継いだ結果）と降順か
    shown_sort: (ChildSort, bool),
}

/// タグごとの、そのタグか子孫のタグが付いたファイルの数（同じファイルは1回だけ数える）
fn file_counts(conn: &Connection) -> Result<HashMap<i64, i64>> {
    Ok(conn
        .prepare(
            "WITH RECURSIVE sub(root, id) AS (
               SELECT id, id FROM tags
               UNION SELECT sub.root, t.id FROM tags t JOIN sub ON t.parent_id = sub.id)
             SELECT sub.root, count(DISTINCT ft.file_id)
             FROM sub JOIN file_tags ft ON ft.tag_id = sub.id GROUP BY sub.root",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// すべてのタグを、兄弟の順番どおりに親ごとにまとめる。
/// 親が子の並び順を決めていれば、その順にする（同じ値どうしはドラッグで決めた順）
fn children_map(conn: &Connection) -> Result<(Vec<Row>, HashMap<Option<i64>, Vec<usize>>)> {
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, child_sort, child_sort_desc, bg_color, fg_color
         FROM tags ORDER BY position, name COLLATE NOCASE",
    )?;
    let mut rows: Vec<Row> = stmt
        .query_map([], |r| {
            let sort: Option<String> = r.get(3)?;
            Ok(Row {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                settings: TagSettings {
                    child_sort: sort.as_deref().and_then(ChildSort::parse),
                    child_sort_desc: r.get(4)?,
                    bg_color: r.get(5)?,
                    fg_color: r.get(6)?,
                },
                shown_sort: (ChildSort::Manual, false),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let index: HashMap<i64, usize> = rows.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
    // 引き継ぐタグは、決めている先祖までたどる（親子が輪になっていても止まるよう、たどる数を限る）
    let shown: Vec<(ChildSort, bool)> = (0..rows.len())
        .map(|start| {
            let mut i = start;
            for _ in 0..rows.len() {
                if let Some(sort) = rows[i].settings.child_sort {
                    return (sort, rows[i].settings.child_sort_desc);
                }
                match rows[i].parent_id.and_then(|p| index.get(&p)) {
                    Some(&p) => i = p,
                    None => break,
                }
            }
            (ChildSort::Manual, false)
        })
        .collect();
    for (r, s) in rows.iter_mut().zip(shown) {
        r.shown_sort = s;
    }
    let mut children: HashMap<Option<i64>, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        // 親が見つからない行は最上位として扱う
        let parent = r.parent_id.filter(|p| index.contains_key(p));
        children.entry(parent).or_default().push(i);
    }
    let counts = if rows.iter().any(|r| r.shown_sort.0 == ChildSort::Files) {
        file_counts(conn)?
    } else {
        HashMap::new()
    };
    for (parent, list) in children.iter_mut() {
        let Some(&(sort, desc)) = parent.and_then(|p| index.get(&p)).map(|&i| &rows[i].shown_sort) else { continue };
        if sort == ChildSort::Manual {
            continue;
        }
        let key = |i: usize| -> (i64, String) {
            let r = &rows[i];
            match sort {
                ChildSort::Manual => (0, String::new()),
                ChildSort::Created => (r.id, String::new()),
                ChildSort::Files => (counts.get(&r.id).copied().unwrap_or(0), String::new()),
                ChildSort::Romaji => (0, romaji_key(&r.name)),
            }
        };
        // 安定な並べ替えなので、同じ値どうしはドラッグで決めた順のまま
        if desc {
            list.sort_by_cached_key(|&i| std::cmp::Reverse(key(i)));
        } else {
            list.sort_by_cached_key(|&i| key(i));
        }
    }
    Ok((rows, children))
}

/// 階層の順（親の次にその子孫）に並べたタグのidと深さ
fn tree_order(conn: &Connection) -> Result<(Vec<Row>, Vec<(usize, i64)>)> {
    let (rows, children) = children_map(conn)?;
    let mut order = Vec::with_capacity(rows.len());
    let mut visited = HashSet::new();
    fn walk(
        parent: Option<i64>,
        depth: i64,
        rows: &[Row],
        children: &HashMap<Option<i64>, Vec<usize>>,
        visited: &mut HashSet<i64>,
        order: &mut Vec<(usize, i64)>,
    ) {
        for &i in children.get(&parent).map(Vec::as_slice).unwrap_or_default() {
            if visited.insert(rows[i].id) {
                order.push((i, depth));
                walk(Some(rows[i].id), depth + 1, rows, children, visited, order);
            }
        }
    }
    walk(None, 0, &rows, &children, &mut visited, &mut order);
    // 親子が輪になっている行（本来はない）は、最上位として最後に出す
    for (i, r) in rows.iter().enumerate() {
        if visited.insert(r.id) {
            order.push((i, 0));
        }
    }
    Ok((rows, order))
}

/// タグを階層の順に返す
pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>> {
    let (rows, order) = tree_order(conn)?;
    let counts = file_counts(conn)?;
    let mut synonyms = synonym_map(conn)?;
    // 親は子より先に出てくるので、表示の色は前から順に引き継げる
    let mut shown: HashMap<i64, (Option<String>, Option<String>)> = HashMap::new();
    Ok(order
        .into_iter()
        .map(|(i, depth)| {
            let r = &rows[i];
            let inherited = r.parent_id.and_then(|p| shown.get(&p)).cloned().unwrap_or_default();
            let bg = r.settings.bg_color.clone().or(inherited.0);
            let fg = r.settings.fg_color.clone().or(inherited.1);
            shown.insert(r.id, (bg.clone(), fg.clone()));
            Tag {
                id: r.id,
                name: r.name.clone(),
                parent_id: r.parent_id,
                depth,
                file_count: counts.get(&r.id).copied().unwrap_or(0),
                settings: r.settings.clone(),
                shown_bg_color: bg,
                shown_fg_color: fg,
                shown_child_sort: r.shown_sort.0,
                shown_child_sort_desc: r.shown_sort.1,
                synonyms: synonyms.remove(&r.id).unwrap_or_default(),
            }
        })
        .collect())
}

/// 色の形式（#rrggbb）を確かめ、小文字にそろえる
fn normalize_color(color: Option<&str>) -> Result<Option<String>> {
    let Some(c) = color else { return Ok(None) };
    let c = c.trim().to_ascii_lowercase();
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if !ok {
        return Err(Error::invalid(format!("色の形式が正しくありません: {c}")));
    }
    Ok(Some(c))
}

/// タグの詳細画面の設定（並び順と色）を保存する
pub fn set_tag_settings(conn: &Connection, tag_id: i64, settings: &TagSettings) -> Result<()> {
    ensure_exists(conn, tag_id)?;
    conn.execute(
        "UPDATE tags SET child_sort = ?2, child_sort_desc = ?3, bg_color = ?4, fg_color = ?5 WHERE id = ?1",
        params![
            tag_id,
            settings.child_sort.map(ChildSort::as_str),
            settings.child_sort_desc,
            normalize_color(settings.bg_color.as_deref())?,
            normalize_color(settings.fg_color.as_deref())?,
        ],
    )?;
    Ok(())
}

/// タグのidから、階層の順での位置を引く表（ファイルやプレイリストの項目に付いたタグを並べるのに使う）
pub fn tag_rank(conn: &Connection) -> Result<HashMap<i64, usize>> {
    let (rows, order) = tree_order(conn)?;
    Ok(order.into_iter().enumerate().map(|(rank, (i, _))| (rows[i].id, rank)).collect())
}

/// タグ自身と、その子孫のタグのid
pub fn descendants_and_self(conn: &Connection, tag_id: i64) -> Result<Vec<i64>> {
    Ok(conn
        .prepare(
            "WITH RECURSIVE d(id) AS (
               SELECT ?1 UNION SELECT t.id FROM tags t JOIN d ON t.parent_id = d.id)
             SELECT id FROM d",
        )?
        .query_map([tag_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn normalize_tag_name(name: &str) -> Result<String> {
    normalize_name(name, "タグ")
}


/// 名前でタグを探す。大文字・小文字は区別しない。タグの名前になければ、シノニムから探す
pub(crate) fn find_tag(conn: &Connection, name: &str) -> Result<Option<i64>> {
    match find_by_name(conn, "tags", name)? {
        Some(id) => Ok(Some(id)),
        None => synonym_owner(conn, name),
    }
}

/// name をシノニムに持つタグ
fn synonym_owner(conn: &Connection, name: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row("SELECT tag_id FROM tag_synonyms WHERE name = ?1", [name], |r| r.get(0))
        .optional()?)
}

/// タグのidから、シノニムの一覧（決めた順）を引く表
pub(crate) fn synonym_map(conn: &Connection) -> Result<HashMap<i64, Vec<String>>> {
    let mut map: HashMap<i64, Vec<String>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT tag_id, name FROM tag_synonyms ORDER BY tag_id, position, rowid")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (id, name) = row?;
        map.entry(id).or_default().push(name);
    }
    Ok(map)
}

fn tag_name(conn: &Connection, tag_id: i64) -> Result<String> {
    conn.query_row("SELECT name FROM tags WHERE id = ?1", [tag_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| crate::names::not_found("タグ"))
}

/// name を、tag_id のタグ（None なら新しいタグ）の名前かシノニムとして使えるか。ほかのタグの名前・シノニムと重なればエラー
fn ensure_free_name(conn: &Connection, name: &str, tag_id: Option<i64>) -> Result<()> {
    if let Some(other) = find_by_name(conn, "tags", name)?.filter(|o| Some(*o) != tag_id) {
        return Err(Error::invalid(format!("「{name}」は、タグ「{}」の名前です", tag_name(conn, other)?)));
    }
    if let Some(other) = synonym_owner(conn, name)?.filter(|o| Some(*o) != tag_id) {
        return Err(Error::invalid(format!("「{name}」は、タグ「{}」のシノニムです", tag_name(conn, other)?)));
    }
    Ok(())
}

/// タグのシノニムを、names に置き換える（並びもこの順）。own_name（これから付けるタグの名前）と同じもの・重なるものは入れない。
/// ほかのタグの名前・シノニムと同じものがあればエラー（何も変えない）
pub fn set_tag_synonyms(conn: &mut Connection, tag_id: i64, names: &[String], own_name: &str) -> Result<()> {
    ensure_exists(conn, tag_id)?;
    let own = own_name.trim().to_lowercase();
    let mut seen = HashSet::new();
    let mut list = vec![];
    for n in names {
        let name = normalize_tag_name(n)?;
        let key = name.to_lowercase();
        if key == own || !seen.insert(key) {
            continue;
        }
        ensure_free_name(conn, &name, Some(tag_id))?;
        list.push(name);
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM tag_synonyms WHERE tag_id = ?1", [tag_id])?;
    for (i, name) in list.iter().enumerate() {
        tx.execute(
            "INSERT INTO tag_synonyms (tag_id, name, position) VALUES (?1, ?2, ?3)",
            params![tag_id, name, i as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// tag_id のシノニムの最後に name を加える（もう誰かの名前・シノニムなら加えない）
fn push_synonym(conn: &Connection, tag_id: i64, name: &str) -> Result<()> {
    if find_tag(conn, name)?.is_some() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO tag_synonyms (tag_id, name, position)
         VALUES (?1, ?2, (SELECT coalesce(max(position) + 1, 0) FROM tag_synonyms WHERE tag_id = ?1))",
        params![tag_id, name],
    )?;
    Ok(())
}

/// 親の子の最後に入れるときの順番
fn next_position(conn: &Connection, parent: Option<i64>) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT coalesce(max(position) + 1, 0) FROM tags WHERE parent_id IS ?1",
        [parent],
        |r| r.get(0),
    )?)
}

/// 新しいタグは最上位の最後に入れる。並び順と色は、設定画面で決めた既定値にする
fn insert_tag(conn: &Connection, name: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO tags (name, created_at, parent_id, position) VALUES (?1, ?2, NULL, ?3)",
        params![name, now(), next_position(conn, None)?],
    )?;
    let id = conn.last_insert_rowid();
    let defaults: TagSettings = settings::get(conn, settings::NEW_TAG)?;
    if defaults != TagSettings::default() {
        set_tag_settings(conn, id, &defaults)?;
    }
    Ok(id)
}

/// 新しく作るタグの既定値
pub fn new_tag_settings(conn: &Connection) -> Result<TagSettings> {
    settings::get(conn, settings::NEW_TAG)
}

/// 新しく作るタグの既定値を保存する（色の形式を確かめ、小文字にそろえる）
pub fn set_new_tag_settings(conn: &Connection, value: &TagSettings) -> Result<()> {
    let value = TagSettings {
        bg_color: normalize_color(value.bg_color.as_deref())?,
        fg_color: normalize_color(value.fg_color.as_deref())?,
        ..value.clone()
    };
    settings::set(conn, settings::NEW_TAG, &value)
}

/// 名前でタグを探し、なければ作る。
pub fn get_or_create_tag(conn: &Connection, name: &str) -> Result<i64> {
    let name = normalize_tag_name(name)?;
    match find_tag(conn, &name)? {
        Some(id) => Ok(id),
        None => insert_tag(conn, &name),
    }
}

/// タグを作る。同じ名前のタグがあればエラー。
/// タグを parent の子の最後に作る（parent が None なら最上位の最後）。同じ名前のタグがあればエラー
pub fn create_tag_under(conn: &Connection, name: &str, parent: Option<i64>) -> Result<i64> {
    let id = create_tag(conn, name)?;
    if let Some(p) = parent {
        ensure_exists(conn, p)?;
        conn.execute(
            "UPDATE tags SET parent_id = ?2, position = ?3 WHERE id = ?1",
            params![id, p, next_position(conn, Some(p))?],
        )?;
    }
    Ok(id)
}

pub fn create_tag(conn: &Connection, name: &str) -> Result<i64> {
    let name = normalize_tag_name(name)?;
    ensure_unique_name(conn, "tags", "タグ", &name, None)?;
    if let Some(other) = synonym_owner(conn, &name)? {
        return Err(Error::invalid(format!("「{name}」は、タグ「{}」のシノニムです", tag_name(conn, other)?)));
    }
    insert_tag(conn, &name)
}

fn parent_of(conn: &Connection, tag_id: i64) -> Result<Option<i64>> {
    conn.query_row("SELECT parent_id FROM tags WHERE id = ?1", [tag_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| Error::invalid("タグが見つかりません"))
}

/// 兄弟のid（順番どおり）
fn siblings(conn: &Connection, parent: Option<i64>) -> Result<Vec<i64>> {
    Ok(conn
        .prepare("SELECT id FROM tags WHERE parent_id IS ?1 ORDER BY position, name COLLATE NOCASE")?
        .query_map([parent], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// 親と、子の並びをまとめて書き込む
fn write_children(conn: &Connection, parent: Option<i64>, ids: &[i64]) -> Result<()> {
    let mut stmt = conn.prepare("UPDATE tags SET parent_id = ?2, position = ?3 WHERE id = ?1")?;
    for (pos, id) in ids.iter().enumerate() {
        stmt.execute(params![id, parent, pos as i64])?;
    }
    Ok(())
}

/// タグを移す。子孫も一緒に移る。自分自身や自分の子孫の中には移せない。
pub fn move_tag(conn: &mut Connection, tag_id: i64, target: MoveTarget) -> Result<()> {
    let tx = conn.transaction()?;
    parent_of(&tx, tag_id)?;
    let own = descendants_and_self(&tx, tag_id)?;
    let (parent, anchor) = match target {
        MoveTarget::Before(t) | MoveTarget::After(t) => (parent_of(&tx, t)?, Some(t)),
        MoveTarget::Child(t) => {
            parent_of(&tx, t)?;
            (Some(t), None)
        }
        MoveTarget::Root => (None, None),
    };
    if anchor.is_some_and(|a| own.contains(&a)) || parent.is_some_and(|p| own.contains(&p)) {
        return Err(Error::invalid("タグを自分自身やその子孫の中には移せません"));
    }
    let mut ids: Vec<i64> = siblings(&tx, parent)?.into_iter().filter(|&id| id != tag_id).collect();
    let index = match (target, anchor) {
        (MoveTarget::Before(_), Some(a)) => ids.iter().position(|&id| id == a).unwrap_or(0),
        (MoveTarget::After(_), Some(a)) => ids.iter().position(|&id| id == a).map_or(ids.len(), |i| i + 1),
        _ => ids.len(),
    };
    ids.insert(index, tag_id);
    write_children(&tx, parent, &ids)?;
    tx.commit()?;
    Ok(())
}

fn ensure_exists(conn: &Connection, tag_id: i64) -> Result<()> {
    parent_of(conn, tag_id).map(|_| ())
}

/// タグの名前を変える。別の既存のタグと同じ名前（またはそのシノニム）のときは、merge が true なら統合し、false ならエラー。
/// 統合すると、統合元の子は統合先の子の最後に移り、統合元の名前とシノニムは統合先のシノニムに加わる。
/// 自分のシノニムの1つに変えたときは、そのシノニムを外す
pub fn rename_tag(conn: &mut Connection, tag_id: i64, new_name: &str, merge: bool) -> Result<RenameResult> {
    let name = normalize_tag_name(new_name)?;
    ensure_exists(conn, tag_id)?;
    let tx = conn.transaction()?;
    let result = match find_tag(&tx, &name)? {
        Some(other) if other != tag_id => {
            if !merge {
                return Err(Error::invalid(format!("同じ名前のタグがあります: {name}")));
            }
            if descendants_and_self(&tx, tag_id)?.contains(&other) {
                return Err(Error::invalid("タグを自分の子孫のタグに統合することはできません"));
            }
            tx.execute(
                "INSERT OR IGNORE INTO file_tags (file_id, tag_id)
                 SELECT file_id, ?2 FROM file_tags WHERE tag_id = ?1",
                params![tag_id, other],
            )?;
            // プレイリストのタグの組み合わせも、統合先に置き換える
            tx.execute(
                "INSERT OR IGNORE INTO playlist_item_tags (item_id, tag_id)
                 SELECT item_id, ?2 FROM playlist_item_tags WHERE tag_id = ?1",
                params![tag_id, other],
            )?;
            let mut ids = siblings(&tx, Some(other))?;
            ids.extend(siblings(&tx, Some(tag_id))?);
            write_children(&tx, Some(other), &ids)?;
            // 統合元の名前とシノニムは、統合先のシノニムにする（統合元を消してから加える）
            let old_name = tag_name(&tx, tag_id)?;
            let old_synonyms = synonym_map(&tx)?.remove(&tag_id).unwrap_or_default();
            tx.execute("DELETE FROM tags WHERE id = ?1", [tag_id])?;
            for s in std::iter::once(old_name).chain(old_synonyms) {
                push_synonym(&tx, other, &s)?;
            }
            RenameResult { tag_id: other, merged: true }
        }
        // 自分自身（大文字・小文字だけの変更を含む）か、新しい名前
        _ => {
            tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![tag_id, name])?;
            tx.execute("DELETE FROM tag_synonyms WHERE tag_id = ?1 AND name = ?2", params![tag_id, name])?;
            RenameResult { tag_id, merged: false }
        }
    };
    tx.commit()?;
    Ok(result)
}

/// タグを削除する。付いていたファイルや、プレイリストのタグの組み合わせからも外れる。子のタグは、削除したタグがあった位置に繰り上がる。
pub fn delete_tag(conn: &mut Connection, tag_id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let parent = parent_of(&tx, tag_id)?;
    let children = siblings(&tx, Some(tag_id))?;
    let ids: Vec<i64> = siblings(&tx, parent)?
        .into_iter()
        .flat_map(|id| if id == tag_id { children.clone() } else { vec![id] })
        .collect();
    write_children(&tx, parent, &ids)?;
    tx.execute("DELETE FROM tags WHERE id = ?1", [tag_id])?;
    crate::playlists::remove_empty_tag_items(&tx)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
#[path = "tags_tests.rs"]
mod tests;
