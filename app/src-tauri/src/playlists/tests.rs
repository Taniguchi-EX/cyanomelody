use super::expand::{expand_item_with, expand_with, Rng};
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
    // 通しの曲数：A の項目は子の B だけで、B は空
    assert_eq!(nodes[0].track_count, 0);
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

    super::draw::draw_with(&conn, top, &mut Rng(1)).unwrap();
    let seqs: Vec<i64> = conn.prepare("SELECT seq FROM temp.draw_rows ORDER BY seq").unwrap()
        .query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    let nodes = super::draw::plan_rows(&conn, &seqs).unwrap();
    let file = |id: i64, alias: Option<&str>, chains: Vec<i64>| ExportNode::File {
        file_id: id,
        alias: alias.map(str::to_owned),
        chains,
    };
    assert_eq!(
        nodes,
        vec![
            // 見つからないファイル（5）は抽選した並びに入らない
            file(1, Some("剣"), vec![]),
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
