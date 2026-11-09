//! 絞り込みの各項目を「選んだときの件数」。選ぶと0件になる項目をグレーアウトするのに使う

use std::collections::HashMap;

use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

use crate::error::Result;
use crate::files::{filter_conditions, source_tables, CountItem, FileFilter};

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    /// タグごとの件数（子孫のタグを含む）。0件のタグは入らない
    pub tags: Vec<CountItem>,
    /// 「（タグなし）」を選んだときの件数
    pub untagged: i64,
    /// 出典ごとの件数。id が None は「（出典なし）」。0件の出典は入らない
    pub sources: Vec<CountItem>,
    pub licenses: Vec<CountItem>,
    /// 「その他」の各項目を選んだときの件数（項目どうしとほかの条件はAND）
    pub duplicates: i64,
    pub recent: i64,
    pub missing: i64,
}

/// 条件に合うファイルの id・出典・ライセンス
struct Row {
    id: i64,
    source_id: Option<i64>,
    license_id: Option<i64>,
}

fn matching_rows(conn: &Connection, filter: &FileFilter) -> Result<Vec<Row>> {
    let (conditions, args) = filter_conditions(conn, filter)?;
    if filter.draw {
        crate::playlists::draw::ensure_table(conn)?;
    }
    // 抽選した並びでは行ごとに返す（同じファイルが2行あれば2回数える）
    let tables = source_tables(filter);
    Ok(conn
        .prepare(&format!("SELECT a.id, a.source_id, a.license_id FROM {tables} WHERE 1 = 1{conditions}"))?
        .query_map(params_from_iter(args), |r| {
            Ok(Row { id: r.get(0)?, source_id: r.get(1)?, license_id: r.get(2)? })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// 同じ条件を何度も問い合わせないよう、条件ごとに結果を覚えておく。
/// タグの条件はメモリの上で調べるので、SQLにはタグの条件を外して問い合わせる
struct Cache<'a> {
    conn: &'a Connection,
    results: Vec<(String, std::rc::Rc<Vec<Row>>)>,
}

impl Cache<'_> {
    fn rows(&mut self, filter: &FileFilter) -> Result<std::rc::Rc<Vec<Row>>> {
        let filter = FileFilter { tag_ids: vec![], untagged_only: false, ..filter.clone() };
        let filter = &filter;
        let key = format!("{filter:?}");
        if let Some((_, rows)) = self.results.iter().find(|(k, _)| *k == key) {
            return Ok(rows.clone());
        }
        let rows = std::rc::Rc::new(matching_rows(self.conn, filter)?);
        self.results.push((key, rows.clone()));
        Ok(rows)
    }
}

fn group(rows: &[Row], key: impl Fn(&Row) -> Option<i64>) -> Vec<CountItem> {
    let mut map: HashMap<Option<i64>, i64> = HashMap::new();
    for r in rows {
        *map.entry(key(r)).or_default() += 1;
    }
    let mut items: Vec<CountItem> = map.into_iter().map(|(id, count)| CountItem { id, count }).collect();
    items.sort_by_key(|c| c.id);
    items
}

/// いまの絞り込みの条件に、各項目を選ぶ条件を加えたときの件数を求める。
/// - タグ：タグどうしはANDなので、いまの条件（「タグなし」を除く）に合うファイルのうち、そのタグか子孫が付いたもの
/// - 「タグなし」：タグの条件を除いた条件に合うファイルのうち、タグがないもの
/// - 出典・ライセンス：同じ欄どうしはORなので、同じ欄の条件を除いた条件に合うファイルを、設定ごとに数える
///
/// SQLではタグ以外の条件に合うファイルを取り出すだけにし、タグの条件と数えるのはメモリの上で行う
/// （SQLでタグの条件を調べると、子孫のタグが多いときに遅くなるため）。
pub fn facet_counts(conn: &Connection, filter: &FileFilter) -> Result<Facets> {
    let mut cache = Cache { conn, results: Vec::new() };

    // タグごとの祖先（自分を含む）
    let parents: HashMap<i64, Option<i64>> = conn
        .prepare("SELECT id, parent_id FROM tags")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let ancestors = |tag: i64| {
        let mut list = vec![tag];
        let mut cur = parents.get(&tag).copied().flatten();
        while let Some(p) = cur {
            if list.contains(&p) {
                break; // 親子が輪になっているデータ（本来はない）で止まらないように
            }
            list.push(p);
            cur = parents.get(&p).copied().flatten();
        }
        list
    };
    // ファイルごとに付いているタグ
    let mut file_tags: HashMap<i64, Vec<i64>> = HashMap::new();
    for pair in conn
        .prepare("SELECT file_id, tag_id FROM file_tags")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
    {
        let (file, tag) = pair?;
        file_tags.entry(file).or_default().push(tag);
    }
    let ancestor_cache: HashMap<i64, Vec<i64>> = parents.keys().map(|&t| (t, ancestors(t))).collect();
    // タグの条件：untagged ならタグがないこと、そうでなければ選んだタグごとに、そのタグか子孫が付いていること
    let tags_ok = |file: i64, tag_ids: &[i64], untagged: bool| match file_tags.get(&file) {
        None => untagged || tag_ids.is_empty(),
        Some(_) if untagged => false,
        Some(tags) => tag_ids
            .iter()
            .all(|sel| tags.iter().any(|t| ancestor_cache.get(t).is_some_and(|a| a.contains(sel)))),
    };

    let rows = cache.rows(filter)?;
    let mut tag_counts: HashMap<i64, i64> = HashMap::new();
    let mut seen: Vec<i64> = Vec::new();
    for r in rows.iter().filter(|r| tags_ok(r.id, &filter.tag_ids, false)) {
        let Some(tags) = file_tags.get(&r.id) else { continue };
        // 同じファイルを、同じ祖先について2回数えないように
        seen.clear();
        for t in tags {
            for &a in ancestor_cache.get(t).map(Vec::as_slice).unwrap_or_default() {
                if !seen.contains(&a) {
                    seen.push(a);
                    *tag_counts.entry(a).or_default() += 1;
                }
            }
        }
    }
    let mut tags: Vec<CountItem> =
        tag_counts.into_iter().map(|(id, count)| CountItem { id: Some(id), count }).collect();
    tags.sort_by_key(|c| c.id);

    let untagged = rows.iter().filter(|r| tags_ok(r.id, &[], true)).count() as i64;

    let keep = |rows: &[Row]| -> Vec<Row> {
        rows.iter()
            .filter(|r| tags_ok(r.id, &filter.tag_ids, filter.untagged_only))
            .map(|r| Row { id: r.id, source_id: r.source_id, license_id: r.license_id })
            .collect()
    };
    let rows = cache.rows(&FileFilter { source_ids: vec![], no_source: false, ..filter.clone() })?;
    let sources = group(&keep(&rows), |r| r.source_id);
    let rows = cache.rows(&FileFilter { license_ids: vec![], no_license: false, ..filter.clone() })?;
    let licenses = group(&keep(&rows), |r| r.license_id);
    // 「その他」：いまの条件に、その項目を加えたときの件数
    let mut other = |f: FileFilter| -> Result<i64> { Ok(keep(&cache.rows(&f)?).len() as i64) };
    let duplicates = other(FileFilter { duplicates_only: true, ..filter.clone() })?;
    let recent = other(FileFilter { recent_only: true, ..filter.clone() })?;
    let missing = other(FileFilter { missing_only: true, ..filter.clone() })?;
    Ok(Facets { tags, untagged, sources, licenses, duplicates, recent, missing })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credits::{set_file_credit, CreditKind};
    use crate::db::test_db;
    use crate::files::{add_tag, list_files};
    use crate::tags::{create_tag, move_tag};
    use crate::tree::MoveTarget;

    /// ファイル5件（id 1〜5）を入れたDB
    fn setup() -> Connection {
        test_db(&["a.wav", "b.wav", "c.wav", "d.wav", "e.mp3"], &[])
    }

    fn map(items: &[CountItem]) -> HashMap<Option<i64>, i64> {
        items.iter().map(|c| (c.id, c.count)).collect()
    }

    /// 項目を選んだときの件数が、実際にその条件で絞り込んだ件数と一致するか
    fn check_against_list(conn: &Connection, filter: &FileFilter) {
        let f = facet_counts(conn, filter).unwrap();
        let tags = map(&f.tags);
        for t in crate::tags::list_tags(conn).unwrap() {
            if filter.tag_ids.contains(&t.id) {
                continue;
            }
            let mut with = FileFilter { untagged_only: false, ..filter.clone() };
            with.tag_ids.push(t.id);
            let n = list_files(conn, &with).unwrap().len() as i64;
            assert_eq!(tags.get(&Some(t.id)).copied().unwrap_or(0), n, "tag {} {:?}", t.name, filter);
        }
        let untagged = FileFilter { tag_ids: vec![], untagged_only: true, ..filter.clone() };
        assert_eq!(f.untagged, list_files(conn, &untagged).unwrap().len() as i64);
        let sources = map(&f.sources);
        for c in crate::credits::list_credits(conn, CreditKind::Source).unwrap() {
            let with = FileFilter { source_ids: vec![c.id], no_source: false, ..filter.clone() };
            let n = list_files(conn, &with).unwrap().len() as i64;
            assert_eq!(sources.get(&Some(c.id)).copied().unwrap_or(0), n, "source {}", c.name);
        }
        let none = FileFilter { source_ids: vec![], no_source: true, ..filter.clone() };
        assert_eq!(sources.get(&None).copied().unwrap_or(0), list_files(conn, &none).unwrap().len() as i64);
        let count = |f: FileFilter| list_files(conn, &f).unwrap().len() as i64;
        assert_eq!(f.duplicates, count(FileFilter { duplicates_only: true, ..filter.clone() }), "重複");
        assert_eq!(f.recent, count(FileFilter { recent_only: true, ..filter.clone() }), "直近で再生");
        assert_eq!(f.missing, count(FileFilter { missing_only: true, ..filter.clone() }), "リンク切れ");
    }

    #[test]
    fn other_items_count_with_other_conditions() {
        let mut conn = setup();
        // a・b は同じ音声（重複）、c は見つからない、a・c を直近で再生
        conn.execute("UPDATE audio_files SET hash = 'h1' WHERE id IN (1, 2)", []).unwrap();
        conn.execute("UPDATE audio_files SET hash = 'h3', missing = 1 WHERE id = 3", []).unwrap();
        crate::recent::record_play(&conn, 1).unwrap();
        crate::recent::record_play(&conn, 3).unwrap();
        let rain = add_tag(&mut conn, &[1, 3], "雨").unwrap();
        let f = facet_counts(&conn, &FileFilter::default()).unwrap();
        assert_eq!((f.duplicates, f.recent, f.missing), (2, 2, 1));
        let f = facet_counts(&conn, &FileFilter { tag_ids: vec![rain], ..Default::default() }).unwrap();
        assert_eq!((f.duplicates, f.recent, f.missing), (1, 2, 1));
        for filter in [
            FileFilter::default(),
            FileFilter { tag_ids: vec![rain], ..Default::default() },
            FileFilter { recent_only: true, ..Default::default() },
            FileFilter { duplicates_only: true, missing_only: true, ..Default::default() },
        ] {
            check_against_list(&conn, &filter);
        }
    }

    #[test]
    fn counts_match_actual_filter_results() {
        let mut conn = setup();
        // 環境音 > 雨、爆発
        let env = create_tag(&conn, "環境音").unwrap();
        let rain = add_tag(&mut conn, &[1, 2], "雨").unwrap();
        move_tag(&mut conn, rain, MoveTarget::Child(env)).unwrap();
        let boom = add_tag(&mut conn, &[2, 3], "爆発").unwrap();
        add_tag(&mut conn, &[4], "環境音").unwrap();
        let s1 = set_file_credit(&mut conn, CreditKind::Source, &[1, 3], Some("s1")).unwrap().unwrap();
        set_file_credit(&mut conn, CreditKind::Source, &[2], Some("s2")).unwrap();
        set_file_credit(&mut conn, CreditKind::License, &[1], Some("l1")).unwrap();

        let none = FileFilter::default();
        let f = facet_counts(&conn, &none).unwrap();
        let tags = map(&f.tags);
        // 親は子孫を含む（1, 2 は雨、4 は環境音）
        assert_eq!(tags[&Some(env)], 3);
        assert_eq!(tags[&Some(rain)], 2);
        assert_eq!(f.untagged, 1);

        // 爆発で絞り込むと、雨は1件（2）、環境音も1件、タグなしは条件を外して数えるので1件
        let by_boom = FileFilter { tag_ids: vec![boom], ..Default::default() };
        let f = facet_counts(&conn, &by_boom).unwrap();
        let tags = map(&f.tags);
        assert_eq!(tags.get(&Some(rain)), Some(&1));
        assert_eq!(tags.get(&Some(env)), Some(&1));
        assert_eq!(f.untagged, 1);
        // 出典は同じ欄の条件を除くので、s1 を選んでいても s2 は数える
        let by_s1 = FileFilter { source_ids: vec![s1], ..Default::default() };
        let f = facet_counts(&conn, &by_s1).unwrap();
        let sources = map(&f.sources);
        assert_eq!((sources[&Some(s1)], sources.get(&None).copied()), (2, Some(2)));
        let tags = map(&f.tags);
        assert_eq!(tags.get(&Some(env)), Some(&1));

        for filter in [
            none,
            by_boom,
            by_s1,
            FileFilter { tag_ids: vec![env], ..Default::default() },
            FileFilter { untagged_only: true, ..Default::default() },
            FileFilter { no_source: true, text: "wav".into(), ..Default::default() },
            FileFilter { file_ids: Some(vec![1, 2]), ..Default::default() },
            FileFilter { tag_ids: vec![boom], source_ids: vec![s1], ..Default::default() },
            FileFilter { untagged_only: true, no_license: true, ..Default::default() },
            FileFilter { tag_ids: vec![env, rain], license_ids: vec![99], ..Default::default() },
        ] {
            check_against_list(&conn, &filter);
        }
    }

    /// 3万ファイル・300タグ（3階層）での速さを測る。cargo test --release -- --ignored --nocapture facet_speed
    #[test]
    #[ignore]
    fn facet_speed() {
        use std::time::Instant;
        let mut conn = setup();
        conn.execute("DELETE FROM audio_files", []).unwrap();
        let tx = conn.transaction().unwrap();
        {
            let mut stmt = tx
                .prepare("INSERT INTO audio_files (id, folder_id, rel_path, size, modified_at, added_at) VALUES (?1, 1, ?2, 0, 0, 0)")
                .unwrap();
            for i in 1..=30_000i64 {
                stmt.execute(rusqlite::params![i, format!("d{:02}/se_{i:05}.wav", i % 100)]).unwrap();
            }
            // 10の最上位 × 各5の子 × 各5の孫 = 10 + 50 + 250 = 310タグ
            let mut ids = vec![];
            for r in 0..10 {
                tx.execute("INSERT INTO tags (name, created_at, position) VALUES (?1, 0, ?2)", rusqlite::params![format!("r{r}"), r]).unwrap();
                let root = tx.last_insert_rowid();
                ids.push(root);
                for c in 0..5 {
                    tx.execute("INSERT INTO tags (name, created_at, parent_id, position) VALUES (?1, 0, ?2, ?3)", rusqlite::params![format!("r{r}c{c}"), root, c]).unwrap();
                    let child = tx.last_insert_rowid();
                    ids.push(child);
                    for g in 0..5 {
                        tx.execute("INSERT INTO tags (name, created_at, parent_id, position) VALUES (?1, 0, ?2, ?3)", rusqlite::params![format!("r{r}c{c}g{g}"), child, g]).unwrap();
                        ids.push(tx.last_insert_rowid());
                    }
                }
            }
            // 各ファイルに3つのタグ（決まった並びで散らす）
            let mut stmt = tx.prepare("INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?1, ?2)").unwrap();
            for i in 1..=30_000i64 {
                for k in 0..3i64 {
                    let t = ids[((i * 7 + k * 131) % ids.len() as i64) as usize];
                    stmt.execute([i, t]).unwrap();
                }
            }
            for s in 0..20 {
                tx.execute("INSERT INTO sources (name, created_at) VALUES (?1, 0)", [format!("s{s}")]).unwrap();
            }
            tx.execute("UPDATE audio_files SET source_id = (id % 21) WHERE id % 21 > 0", []).unwrap();
        }
        tx.commit().unwrap();
        let root: i64 = conn.query_row("SELECT id FROM tags WHERE name = 'r3'", [], |r| r.get(0)).unwrap();
        let leaf: i64 = conn.query_row("SELECT id FROM tags WHERE name = 'r5c2g1'", [], |r| r.get(0)).unwrap();
        for (name, filter) in [
            ("条件なし", FileFilter::default()),
            ("最上位のタグ1つ", FileFilter { tag_ids: vec![root], ..Default::default() }),
            ("タグ2つ", FileFilter { tag_ids: vec![root, leaf], ..Default::default() }),
            ("ファイル名", FileFilter { text: "d1".into(), ..Default::default() }),
            ("出典1つ", FileFilter { source_ids: vec![3], ..Default::default() }),
        ] {
            let t0 = Instant::now();
            let f = facet_counts(&conn, &filter).unwrap();
            let facet_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let t1 = Instant::now();
            let n = list_files(&conn, &filter).unwrap().len();
            let list_ms = t1.elapsed().as_secs_f64() * 1000.0;
            println!(
                "{name}: 件数の計算 {facet_ms:.1}ms（タグ{}項目）、一覧 {list_ms:.1}ms（{n}件）",
                f.tags.len()
            );
        }
    }
}
