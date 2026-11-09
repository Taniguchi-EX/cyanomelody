//! 抽選した並び（draw.rs）の単体テスト

use super::*;
use crate::db::test_db;
use crate::facets::facet_counts;
use crate::files::{add_tag, list_files, FileFilter, FileSort};
use crate::playlists::{
    add_files, add_playlist_ref, add_tags, create_playlist, get_playlist, list_playlists, set_item_alias, set_item_mode,
};

/// a〜d.wav（id 1〜4）と、見つからない e.wav（id 5）
fn setup() -> Connection {
    test_db(&["a.wav", "b.wav", "c.wav", "d.wav", "e.wav"], &["e.wav"])
}

/// 3万件・3万件が対象のタグの組み合わせを含むプレイリスト（と小さなプレイリスト50個）で、
/// 抽選・一覧・件数・全プレイリストの通しの曲数の速さを測る。
/// cargo test --release draw_speed -- --ignored --nocapture
#[test]
#[ignore]
fn draw_speed() {
    use std::time::Instant;
    let mut conn = test_db(&[], &[]);
    {
        let tx = conn.transaction().unwrap();
        let mut stmt = tx
            .prepare("INSERT INTO audio_files (id, folder_id, rel_path, size, modified_at, added_at) VALUES (?1, 1, ?2, 0, 0, 0)")
            .unwrap();
        for i in 1..=30_000i64 {
            stmt.execute(rusqlite::params![i, format!("d{:02}/se_{i:05}.wav", i % 100)]).unwrap();
        }
        drop(stmt);
        tx.commit().unwrap();
    }
    let all: Vec<i64> = (1..=30_000).collect();
    let big = add_tag(&mut conn, &all, "大量").unwrap();
    let half: Vec<i64> = (1..=15_000).collect();
    let rain = add_tag(&mut conn, &half, "雨").unwrap();
    let top = create_playlist(&mut conn, "大量", None).unwrap();
    add_tags(&mut conn, top, &[big]).unwrap();
    let item = add_tags(&mut conn, top, &[rain]).unwrap();
    set_item_mode(&conn, item, PlayMode::Shuffle).unwrap();
    for p in 0..50 {
        let id = create_playlist(&mut conn, &format!("小{p}"), None).unwrap();
        let files: Vec<i64> = (1..=20).map(|k| p * 500 + k).collect();
        add_files(&mut conn, id, &files).unwrap();
        add_playlist_ref(&mut conn, top, id).unwrap();
    }
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    for round in 0..3 {
        let t = Instant::now();
        draw(&conn, top).unwrap();
        let draw_ms = ms(t);
        let t = Instant::now();
        let n = list_files(&conn, &draw_filter()).unwrap().len();
        let list_ms = ms(t);
        let t = Instant::now();
        facet_counts(&conn, &draw_filter()).unwrap();
        let facet_ms = ms(t);
        let t = Instant::now();
        let with_tag = FileFilter { tag_ids: vec![rain], ..draw_filter() };
        let m = list_files(&conn, &with_tag).unwrap().len();
        let filtered_ms = ms(t);
        let t = Instant::now();
        list_playlists(&conn).unwrap();
        let counts_ms = ms(t);
        let t = Instant::now();
        version(&conn, top).unwrap();
        let version_ms = ms(t);
        println!(
            "{round}回目：抽選 {draw_ms:.1}ms、一覧 {list_ms:.1}ms（{n}行）、件数 {facet_ms:.1}ms、\
             タグで絞り込んだ一覧 {filtered_ms:.1}ms（{m}行）、プレイリストの一覧と通しの曲数 {counts_ms:.1}ms、中身の版 {version_ms:.1}ms"
        );
    }
}

fn draw_filter() -> FileFilter {
    FileFilter { draw: true, sort: FileSort::Playlist, ..Default::default() }
}

fn ids(conn: &Connection, filter: &FileFilter) -> Vec<i64> {
    list_files(conn, filter).unwrap().iter().map(|f| f.id).collect()
}

#[test]
fn draw_keeps_duplicates_paths_alias_and_origin() {
    let mut conn = setup();
    let rain = add_tag(&mut conn, &[2, 3], "雨").unwrap();
    let top = create_playlist(&mut conn, "戦闘", None).unwrap();
    add_files(&mut conn, top, &[1, 2, 5]).unwrap();
    let tag_item = add_tags(&mut conn, top, &[rain]).unwrap();
    let child = create_playlist(&mut conn, "足音", Some(top)).unwrap();
    add_files(&mut conn, child, &[4]).unwrap();
    let items = get_playlist(&conn, top).unwrap().items;
    set_item_alias(&conn, items[0].id, "剣").unwrap();
    let chain = crate::chains::create_chain(&conn, "響き").unwrap();
    crate::chains::set_item_chain(&conn, items[4].id, Some(chain)).unwrap();
    let inner_chain = crate::chains::create_chain(&conn, "小さく").unwrap();
    let child_item = get_playlist(&conn, child).unwrap().items[0].id;
    crate::chains::set_item_chain(&conn, child_item, Some(inner_chain)).unwrap();

    draw_with(&conn, top, &mut Rng(1)).unwrap();
    let rows = list_files(&conn, &draw_filter()).unwrap();
    // a・b、（e は見つからないので入らない）、雨の b・c、足音の d。b は2行
    assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 2, 2, 3, 4]);
    assert_eq!(rows.iter().map(|r| r.key).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
    assert_eq!(rows[0].alias.as_deref(), Some("剣"));
    assert!(rows[0].origin.is_none());
    assert_eq!(rows[0].item_id, Some(items[0].id));
    let origin = rows[2].origin.as_ref().unwrap();
    assert_eq!((origin.item_id, origin.kind, origin.label.as_str()), (tag_item, ItemKind::Tags, "雨"));
    assert!(rows[2].alias.is_none());
    let origin = rows[4].origin.as_ref().unwrap();
    assert_eq!((origin.kind, origin.label.as_str()), (ItemKind::Playlist, "足音"));
    // エフェクトは内側から外側の順
    assert_eq!(rows[4].chains, vec![inner_chain, chain]);
    assert!(rows.iter().all(|r| !r.drawn));

    // 別名・fx を変えると、抽選し直さなくても今の値が出る
    set_item_alias(&conn, items[0].id, "大剣").unwrap();
    crate::chains::set_item_chain(&conn, items[4].id, None).unwrap();
    let rows = list_files(&conn, &draw_filter()).unwrap();
    assert_eq!(rows[0].alias.as_deref(), Some("大剣"));
    assert_eq!(rows[4].chains, vec![inner_chain]);
}

#[test]
fn random_and_shuffle_items_are_drawn_once() {
    let mut conn = setup();
    let rain = add_tag(&mut conn, &[1, 2, 3, 4], "雨").unwrap();
    let top = create_playlist(&mut conn, "雨", None).unwrap();
    let item = add_tags(&mut conn, top, &[rain]).unwrap();
    set_item_mode(&conn, item, PlayMode::Random).unwrap();
    draw_with(&conn, top, &mut Rng(7)).unwrap();
    let rows = list_files(&conn, &draw_filter()).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].drawn);
    // 一覧を読み直しても、選ばれた曲は変わらない
    assert_eq!(ids(&conn, &draw_filter()), vec![rows[0].id]);
    // 通しの曲数は1
    let node = list_playlists(&conn).unwrap().into_iter().find(|p| p.id == top).unwrap();
    assert_eq!(node.track_count, 1);
    set_item_mode(&conn, item, PlayMode::Shuffle).unwrap();
    draw_with(&conn, top, &mut Rng(7)).unwrap();
    let mut got = ids(&conn, &draw_filter());
    got.sort_unstable();
    assert_eq!(got, vec![1, 2, 3, 4]);
}

#[test]
fn filters_counts_and_sorts_apply_to_draw_rows() {
    let mut conn = setup();
    let rain = add_tag(&mut conn, &[1, 2], "雨").unwrap();
    let top = create_playlist(&mut conn, "P", None).unwrap();
    // 1回で加えるとパス順になり重なりも除くので、1つずつ加える
    for f in [3, 1, 1, 2] {
        add_files(&mut conn, top, &[f]).unwrap();
    }
    let items = get_playlist(&conn, top).unwrap().items;
    set_item_alias(&conn, items[0].id, "zzz").unwrap();
    set_item_alias(&conn, items[3].id, "0first").unwrap();
    draw_with(&conn, top, &mut Rng(1)).unwrap();
    // タグで絞り込むと、抽選した並びの中の行（a が2行）
    let with_rain = FileFilter { tag_ids: vec![rain], ..draw_filter() };
    assert_eq!(ids(&conn, &with_rain), vec![1, 1, 2]);
    // 件数は行の数
    let f = facet_counts(&conn, &draw_filter()).unwrap();
    assert_eq!(f.tags.iter().find(|c| c.id == Some(rain)).unwrap().count, 3);
    assert_eq!(f.untagged, 1);
    // ファイル名の検索は別名にも当たる
    assert_eq!(ids(&conn, &FileFilter { text: "first".into(), ..draw_filter() }), vec![2]);
    assert_eq!(ids(&conn, &FileFilter { text: "c.wav".into(), ..draw_filter() }), vec![3]);
    // ファイル名順は出している名前（別名があれば別名）で
    let by_name = FileFilter { sort: FileSort::Name, ..draw_filter() };
    assert_eq!(ids(&conn, &by_name), vec![2, 1, 1, 3]);
    // ライブラリの一覧は今までどおり（行はファイルごと、key はファイルの id）
    let lib = list_files(&conn, &FileFilter::default()).unwrap();
    assert_eq!(lib.iter().map(|f| f.key).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
    // 選択を外すと空
    clear(&conn).unwrap();
    assert!(ids(&conn, &draw_filter()).is_empty());
}

#[test]
fn version_changes_only_with_contents() {
    let mut conn = setup();
    let top = create_playlist(&mut conn, "P", None).unwrap();
    add_files(&mut conn, top, &[1]).unwrap();
    let child = create_playlist(&mut conn, "C", None).unwrap();
    add_playlist_ref(&mut conn, top, child).unwrap();
    let v0 = version(&conn, top).unwrap().unwrap();
    let item = get_playlist(&conn, top).unwrap().items[0].id;
    // 別名・fx・名前では変わらない
    set_item_alias(&conn, item, "別名").unwrap();
    let chain = crate::chains::create_chain(&conn, "c").unwrap();
    crate::chains::set_item_chain(&conn, item, Some(chain)).unwrap();
    crate::playlists::rename_playlist(&conn, top, "Q").unwrap();
    assert_eq!(version(&conn, top).unwrap().unwrap(), v0);
    // 参照先の中身が変わると変わる
    add_files(&mut conn, child, &[2]).unwrap();
    let v1 = version(&conn, top).unwrap().unwrap();
    assert_ne!(v1, v0);
    // 再生方法を変えると変わる
    let ref_item = get_playlist(&conn, top).unwrap().items[1].id;
    set_item_mode(&conn, ref_item, PlayMode::Shuffle).unwrap();
    assert_ne!(version(&conn, top).unwrap().unwrap(), v1);
    // 消えたら None
    crate::playlists::delete_playlist(&mut conn, top).unwrap();
    assert_eq!(version(&conn, top).unwrap(), None);
}

#[test]
fn plan_rows_follows_visible_rows_and_folders() {
    let mut conn = setup();
    let top = create_playlist(&mut conn, "戦闘", None).unwrap();
    add_files(&mut conn, top, &[1]).unwrap();
    let child = create_playlist(&mut conn, "足音", Some(top)).unwrap();
    add_files(&mut conn, child, &[2, 3]).unwrap();
    let mixed = create_playlist(&mut conn, "混ぜる", Some(top)).unwrap();
    let inner = create_playlist(&mut conn, "中", Some(mixed)).unwrap();
    add_files(&mut conn, inner, &[4]).unwrap();
    let items = get_playlist(&conn, top).unwrap().items;
    set_item_mode(&conn, items[2].id, PlayMode::Shuffle).unwrap();
    draw_with(&conn, top, &mut Rng(1)).unwrap();
    let rows = list_files(&conn, &draw_filter()).unwrap();
    assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
    let file = |id: i64| ExportNode::File { file_id: id, alias: None, chains: vec![] };
    // 見えている順（3 を 2 より先に、1 は絞り込みで隠れた）で渡す
    let seq = |id: i64| rows.iter().find(|r| r.id == id).unwrap().key;
    let nodes = plan_rows(&conn, &[seq(3), seq(4), seq(2)]).unwrap();
    assert_eq!(
        nodes,
        vec![
            ExportNode::Folder { name: "足音".into(), children: vec![file(3), file(2)] },
            // 🔀の項目は、中の「中」をフォルダにせず並べる
            ExportNode::Folder { name: "混ぜる".into(), children: vec![file(4)] },
        ]
    );
}
