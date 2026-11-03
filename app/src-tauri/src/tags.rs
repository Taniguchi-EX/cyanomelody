//! タグ自体の管理（作成・名前変更・統合・削除・階層と順番）

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::db::now;
use crate::names::{ensure_unique_name, find_by_name, normalize_name};
use crate::error::{Error, Result};
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
}

/// すべてのタグを、兄弟の順番どおりに親ごとにまとめる
fn children_map(conn: &Connection) -> Result<(Vec<Row>, HashMap<Option<i64>, Vec<usize>>)> {
    let mut stmt =
        conn.prepare("SELECT id, name, parent_id FROM tags ORDER BY position, name COLLATE NOCASE")?;
    let rows: Vec<Row> = stmt
        .query_map([], |r| Ok(Row { id: r.get(0)?, name: r.get(1)?, parent_id: r.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let ids: HashSet<i64> = rows.iter().map(|r| r.id).collect();
    let mut children: HashMap<Option<i64>, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        // 親が見つからない行は最上位として扱う
        let parent = r.parent_id.filter(|p| ids.contains(p));
        children.entry(parent).or_default().push(i);
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
    let counts: HashMap<i64, i64> = conn
        .prepare(
            "WITH RECURSIVE sub(root, id) AS (
               SELECT id, id FROM tags
               UNION SELECT sub.root, t.id FROM tags t JOIN sub ON t.parent_id = sub.id)
             SELECT sub.root, count(DISTINCT ft.file_id)
             FROM sub JOIN file_tags ft ON ft.tag_id = sub.id GROUP BY sub.root",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(order
        .into_iter()
        .map(|(i, depth)| {
            let r = &rows[i];
            Tag {
                id: r.id,
                name: r.name.clone(),
                parent_id: r.parent_id,
                depth,
                file_count: counts.get(&r.id).copied().unwrap_or(0),
            }
        })
        .collect())
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


/// 名前でタグを探す。大文字・小文字は区別しない。
fn find_tag(conn: &Connection, name: &str) -> Result<Option<i64>> {
    find_by_name(conn, "tags", name)
}

/// 親の子の最後に入れるときの順番
fn next_position(conn: &Connection, parent: Option<i64>) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT coalesce(max(position) + 1, 0) FROM tags WHERE parent_id IS ?1",
        [parent],
        |r| r.get(0),
    )?)
}

/// 新しいタグは最上位の最後に入れる
fn insert_tag(conn: &Connection, name: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO tags (name, created_at, parent_id, position) VALUES (?1, ?2, NULL, ?3)",
        params![name, now(), next_position(conn, None)?],
    )?;
    Ok(conn.last_insert_rowid())
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
pub fn create_tag(conn: &Connection, name: &str) -> Result<i64> {
    let name = normalize_tag_name(name)?;
    ensure_unique_name(conn, "tags", "タグ", &name, None)?;
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

/// タグの名前を変える。別の既存のタグと同じ名前のときは、merge が true なら統合し、false ならエラー。
/// 統合すると、統合元の子は統合先の子の最後に移る。
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
            tx.execute("DELETE FROM tags WHERE id = ?1", [tag_id])?;
            RenameResult { tag_id: other, merged: true }
        }
        // 自分自身（大文字・小文字だけの変更を含む）か、新しい名前
        _ => {
            tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![tag_id, name])?;
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
mod tests {
    use super::*;
    use crate::db::test_db;

    /// ファイル3件（id 1〜3）を入れたDB。フォルダの実体はいらない。
    fn setup() -> Connection {
        test_db(&["a.wav", "b.wav", "c.wav"], &[])
    }

    fn attach(conn: &Connection, file_id: i64, tag_id: i64) {
        conn.execute("INSERT INTO file_tags VALUES (?1, ?2)", [file_id, tag_id]).unwrap();
    }

    fn tagged_files(conn: &Connection, tag_id: i64) -> Vec<i64> {
        conn.prepare("SELECT file_id FROM file_tags WHERE tag_id = ?1 ORDER BY file_id")
            .unwrap()
            .query_map([tag_id], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn names(conn: &Connection) -> Vec<String> {
        list_tags(conn).unwrap().into_iter().map(|t| t.name).collect()
    }

    #[test]
    fn create_rejects_duplicate_ignoring_case() {
        let conn = setup();
        create_tag(&conn, " 爆発 ").unwrap();
        create_tag(&conn, "Short").unwrap();
        assert!(create_tag(&conn, "short").is_err());
        assert!(create_tag(&conn, "爆発").is_err());
        assert!(create_tag(&conn, "").is_err());
        // 新しいタグは最上位の最後に入る
        assert_eq!(names(&conn), vec!["爆発", "Short"]);
    }

    #[test]
    fn rename_to_new_name_and_change_case() {
        let mut conn = setup();
        let id = create_tag(&conn, "short").unwrap();
        attach(&conn, 1, id);
        let r = rename_tag(&mut conn, id, "Short", false).unwrap();
        assert_eq!(r, RenameResult { tag_id: id, merged: false });
        let r = rename_tag(&mut conn, id, "短い", false).unwrap();
        assert_eq!(r, RenameResult { tag_id: id, merged: false });
        assert_eq!(names(&conn), vec!["短い"]);
        assert_eq!(tagged_files(&conn, id), vec![1]);
    }

    #[test]
    fn rename_to_existing_name_merges_only_when_asked() {
        let mut conn = setup();
        let from = create_tag(&conn, "explosion").unwrap();
        let to = create_tag(&conn, "爆発").unwrap();
        attach(&conn, 1, from);
        attach(&conn, 2, from);
        attach(&conn, 2, to);
        attach(&conn, 3, to);

        assert!(rename_tag(&mut conn, from, "爆発", false).is_err());
        assert_eq!(names(&conn).len(), 2);

        let r = rename_tag(&mut conn, from, " 爆発 ", true).unwrap();
        assert_eq!(r, RenameResult { tag_id: to, merged: true });
        assert_eq!(names(&conn), vec!["爆発"]);
        assert_eq!(tagged_files(&conn, to), vec![1, 2, 3]);
        assert_eq!(tagged_files(&conn, from), Vec::<i64>::new());
    }

    #[test]
    fn rename_missing_tag_fails() {
        let mut conn = setup();
        assert!(rename_tag(&mut conn, 99, "x", true).is_err());
    }

    #[test]
    fn delete_removes_from_files() {
        let mut conn = setup();
        let id = create_tag(&conn, "a").unwrap();
        attach(&conn, 1, id);
        delete_tag(&mut conn, id).unwrap();
        assert!(names(&conn).is_empty());
        let n: i64 = conn.query_row("SELECT count(*) FROM file_tags", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        let files: i64 = conn.query_row("SELECT count(*) FROM audio_files", [], |r| r.get(0)).unwrap();
        assert_eq!(files, 3);
        assert!(delete_tag(&mut conn, id).is_err());
    }

    /// 名前と深さを階層の順に
    fn tree(conn: &Connection) -> Vec<(String, i64)> {
        list_tags(conn).unwrap().into_iter().map(|t| (t.name, t.depth)).collect()
    }

    fn t(name: &str, depth: i64) -> (String, i64) {
        (name.to_owned(), depth)
    }

    /// 環境音 > (雨, 風 > 強風), 爆発
    fn setup_tree() -> (Connection, [i64; 5]) {
        let mut conn = setup();
        let env = create_tag(&conn, "環境音").unwrap();
        let rain = create_tag(&conn, "雨").unwrap();
        let wind = create_tag(&conn, "風").unwrap();
        let gale = create_tag(&conn, "強風").unwrap();
        let boom = create_tag(&conn, "爆発").unwrap();
        move_tag(&mut conn, rain, MoveTarget::Child(env)).unwrap();
        move_tag(&mut conn, wind, MoveTarget::Child(env)).unwrap();
        move_tag(&mut conn, gale, MoveTarget::Child(wind)).unwrap();
        (conn, [env, rain, wind, gale, boom])
    }

    #[test]
    fn tree_order_and_counts_include_descendants() {
        let (conn, [env, rain, wind, gale, boom]) = setup_tree();
        assert_eq!(tree(&conn), vec![t("環境音", 0), t("雨", 1), t("風", 1), t("強風", 2), t("爆発", 0)]);
        attach(&conn, 1, rain);
        attach(&conn, 2, gale);
        attach(&conn, 2, wind);
        attach(&conn, 3, boom);
        let tags = list_tags(&conn).unwrap();
        let count = |id| tags.iter().find(|t| t.id == id).unwrap().file_count;
        // 同じファイルは1回だけ数える
        assert_eq!((count(env), count(rain), count(wind), count(gale), count(boom)), (2, 1, 1, 1, 1));
        assert_eq!(tags[1].parent_id, Some(env));
        let mut d = descendants_and_self(&conn, env).unwrap();
        d.sort();
        assert_eq!(d, vec![env, rain, wind, gale]);
    }

    #[test]
    fn move_before_after_child_root() {
        let (mut conn, [env, rain, wind, gale, boom]) = setup_tree();
        move_tag(&mut conn, boom, MoveTarget::Before(rain)).unwrap();
        assert_eq!(tree(&conn), vec![t("環境音", 0), t("爆発", 1), t("雨", 1), t("風", 1), t("強風", 2)]);
        move_tag(&mut conn, rain, MoveTarget::After(wind)).unwrap();
        assert_eq!(tree(&conn), vec![t("環境音", 0), t("爆発", 1), t("風", 1), t("強風", 2), t("雨", 1)]);
        // 子孫も一緒に移る
        move_tag(&mut conn, wind, MoveTarget::Root).unwrap();
        assert_eq!(tree(&conn), vec![t("環境音", 0), t("爆発", 1), t("雨", 1), t("風", 0), t("強風", 1)]);
        move_tag(&mut conn, env, MoveTarget::After(wind)).unwrap();
        assert_eq!(tree(&conn), vec![t("風", 0), t("強風", 1), t("環境音", 0), t("爆発", 1), t("雨", 1)]);
        let _ = gale;
    }

    #[test]
    fn move_into_self_or_descendant_fails() {
        let (mut conn, [env, rain, wind, gale, _]) = setup_tree();
        let before = tree(&conn);
        assert!(move_tag(&mut conn, env, MoveTarget::Child(env)).is_err());
        assert!(move_tag(&mut conn, env, MoveTarget::Child(gale)).is_err());
        assert!(move_tag(&mut conn, env, MoveTarget::Before(rain)).is_err());
        assert!(move_tag(&mut conn, wind, MoveTarget::After(gale)).is_err());
        assert!(move_tag(&mut conn, wind, MoveTarget::Before(wind)).is_err());
        assert!(move_tag(&mut conn, 99, MoveTarget::Root).is_err());
        assert!(move_tag(&mut conn, wind, MoveTarget::Child(99)).is_err());
        assert_eq!(tree(&conn), before);
    }

    #[test]
    fn new_tags_go_to_the_end_of_root() {
        let (conn, _) = setup_tree();
        get_or_create_tag(&conn, "新しい").unwrap();
        assert_eq!(tree(&conn).last().unwrap(), &t("新しい", 0));
    }

    #[test]
    fn delete_promotes_children_in_place() {
        let (mut conn, [env, _, wind, _, _]) = setup_tree();
        delete_tag(&mut conn, wind).unwrap();
        assert_eq!(tree(&conn), vec![t("環境音", 0), t("雨", 1), t("強風", 1), t("爆発", 0)]);
        delete_tag(&mut conn, env).unwrap();
        assert_eq!(tree(&conn), vec![t("雨", 0), t("強風", 0), t("爆発", 0)]);
    }

    #[test]
    fn merge_moves_children_and_rejects_descendant_target() {
        let (mut conn, [env, _, wind, gale, boom]) = setup_tree();
        assert!(rename_tag(&mut conn, env, "強風", true).is_err());
        let r = rename_tag(&mut conn, wind, "爆発", true).unwrap();
        assert_eq!(r, RenameResult { tag_id: boom, merged: true });
        assert_eq!(tree(&conn), vec![t("環境音", 0), t("雨", 1), t("爆発", 0), t("強風", 1)]);
        let _ = gale;
    }
}
