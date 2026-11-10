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

fn sort(conn: &Connection, id: i64, child_sort: Option<ChildSort>, desc: bool) {
    let settings = TagSettings { child_sort, child_sort_desc: desc, ..Default::default() };
    set_tag_settings(conn, id, &settings).unwrap();
}

#[test]
fn child_sort_orders_only_direct_children() {
    let mut conn = setup();
    let root = create_tag(&conn, "親").unwrap();
    let ids: Vec<i64> = ["かぜ", "Ame", "ゆき", "雷"].iter().map(|n| create_tag(&conn, n).unwrap()).collect();
    for &id in &ids {
        move_tag(&mut conn, id, MoveTarget::Child(root)).unwrap();
    }
    // 子が自分の並び順を決めていれば、孫は親の設定の影響を受けない
    let grand_b = create_tag(&conn, "b").unwrap();
    let grand_a = create_tag(&conn, "a").unwrap();
    move_tag(&mut conn, grand_b, MoveTarget::Child(ids[0])).unwrap();
    move_tag(&mut conn, grand_a, MoveTarget::Child(ids[0])).unwrap();
    sort(&conn, ids[0], Some(ChildSort::Manual), false);
    // ドラッグで「雷」を先頭にしておく
    move_tag(&mut conn, ids[3], MoveTarget::Before(ids[0])).unwrap();
    let children = |conn: &Connection| -> Vec<String> {
        list_tags(conn).unwrap().into_iter().filter(|t| t.depth == 1).map(|t| t.name).collect()
    };
    assert_eq!(children(&conn), vec!["雷", "かぜ", "Ame", "ゆき"]);

    sort(&conn, root, Some(ChildSort::Romaji), false);
    assert_eq!(children(&conn), vec!["Ame", "かぜ", "ゆき", "雷"]);
    assert_eq!(&tree(&conn)[3..5], &[t("b", 2), t("a", 2)]);
    sort(&conn, root, Some(ChildSort::Romaji), true);
    assert_eq!(children(&conn), vec!["雷", "ゆき", "かぜ", "Ame"]);

    sort(&conn, root, Some(ChildSort::Created), false);
    assert_eq!(children(&conn), vec!["かぜ", "Ame", "ゆき", "雷"]);
    sort(&conn, root, Some(ChildSort::Created), true);
    assert_eq!(children(&conn), vec!["雷", "ゆき", "Ame", "かぜ"]);

    // ファイル数は子孫を含む。同じ数どうしはドラッグで決めた順
    attach(&conn, 1, ids[2]);
    attach(&conn, 2, ids[2]);
    attach(&conn, 3, grand_a);
    sort(&conn, root, Some(ChildSort::Files), true);
    assert_eq!(children(&conn), vec!["ゆき", "かぜ", "雷", "Ame"]);
    sort(&conn, root, Some(ChildSort::Files), false);
    assert_eq!(children(&conn), vec!["雷", "Ame", "かぜ", "ゆき"]);

    // ドラッグで決めた順に戻す
    sort(&conn, root, Some(ChildSort::Manual), false);
    assert_eq!(children(&conn), vec!["雷", "かぜ", "Ame", "ゆき"]);
}

#[test]
fn new_tags_use_default_settings() {
    let mut conn = setup();
    // 既定値を決めていなければ、今までどおり（引き継ぐ・色なし）
    assert_eq!(new_tag_settings(&conn).unwrap(), TagSettings::default());
    let before = create_tag(&conn, "前").unwrap();
    let defaults = TagSettings {
        child_sort: Some(ChildSort::Romaji),
        child_sort_desc: true,
        bg_color: Some("#FFEEDD".into()),
        fg_color: None,
    };
    set_new_tag_settings(&conn, &defaults).unwrap();
    // 色は小文字にそろえて保存する
    let saved = new_tag_settings(&conn).unwrap();
    assert_eq!(saved.bg_color.as_deref(), Some("#ffeedd"));
    // どこで作っても既定値になる（左の欄の「＋」、ファイルに付けるときに作る）
    let a = create_tag(&conn, "後").unwrap();
    let b = crate::files::add_tag(&mut conn, &[1], "付けて作る").unwrap();
    let settings_of = |id: i64| list_tags(&conn).unwrap().into_iter().find(|t| t.id == id).unwrap().settings;
    assert_eq!(settings_of(a), saved);
    assert_eq!(settings_of(b), saved);
    // 今あるタグは変わらない
    assert_eq!(settings_of(before), TagSettings::default());
    // 形式の違う色は保存しない
    let bad = TagSettings { fg_color: Some("red".into()), ..TagSettings::default() };
    assert!(set_new_tag_settings(&conn, &bad).is_err());
    assert_eq!(new_tag_settings(&conn).unwrap(), saved);
}

#[test]
fn child_sort_inherits_from_ancestors() {
    let mut conn = setup();
    let root = create_tag(&conn, "親").unwrap();
    let mid = create_tag(&conn, "子").unwrap();
    move_tag(&mut conn, mid, MoveTarget::Child(root)).unwrap();
    for n in ["c", "a", "b"] {
        let id = create_tag(&conn, n).unwrap();
        move_tag(&mut conn, id, MoveTarget::Child(mid)).unwrap();
    }
    let grand = |conn: &Connection| -> Vec<String> {
        list_tags(conn).unwrap().into_iter().filter(|t| t.depth == 2).map(|t| t.name).collect()
    };
    let shown = |conn: &Connection, id: i64| {
        let t = list_tags(conn).unwrap().into_iter().find(|t| t.id == id).unwrap();
        (t.settings.child_sort, t.shown_child_sort, t.shown_child_sort_desc)
    };
    // 作ったタグは引き継ぐ。最上位までたどって決まっていなければ、ドラッグで決めた順
    assert_eq!(shown(&conn, mid), (None, ChildSort::Manual, false));
    assert_eq!(grand(&conn), vec!["c", "a", "b"]);
    // 祖父の設定（降順も）を、子が引き継いで孫を並べる
    sort(&conn, root, Some(ChildSort::Romaji), true);
    assert_eq!(shown(&conn, mid), (None, ChildSort::Romaji, true));
    assert_eq!(grand(&conn), vec!["c", "b", "a"]);
    // 子が自分で決めれば、そちらにする
    sort(&conn, mid, Some(ChildSort::Manual), false);
    assert_eq!(grand(&conn), vec!["c", "a", "b"]);
    sort(&conn, mid, Some(ChildSort::Romaji), false);
    assert_eq!(grand(&conn), vec!["a", "b", "c"]);
}

#[test]
fn colors_are_inherited_separately_and_child_wins() {
    let (conn, [env, rain, wind, gale, boom]) = setup_tree();
    let set = |id, bg: Option<&str>, fg: Option<&str>| {
        let settings = TagSettings {
            bg_color: bg.map(str::to_owned),
            fg_color: fg.map(str::to_owned),
            ..Default::default()
        };
        set_tag_settings(&conn, id, &settings).unwrap();
    };
    set(env, Some("#112233"), Some("#FFFFFF"));
    set(wind, Some("#445566"), None);
    let tags = list_tags(&conn).unwrap();
    let shown = |id| {
        let t = tags.iter().find(|t| t.id == id).unwrap();
        (t.shown_bg_color.as_deref(), t.shown_fg_color.as_deref())
    };
    assert_eq!(shown(rain), (Some("#112233"), Some("#ffffff")));
    assert_eq!(shown(wind), (Some("#445566"), Some("#ffffff")));
    assert_eq!(shown(gale), (Some("#445566"), Some("#ffffff")));
    assert_eq!(shown(boom), (None, None));
    let w = tags.iter().find(|t| t.id == wind).unwrap();
    assert_eq!(w.settings.fg_color, None);

    let bad = TagSettings { bg_color: Some("red".into()), ..Default::default() };
    assert!(set_tag_settings(&conn, env, &bad).is_err());
    assert!(set_tag_settings(&conn, 99, &TagSettings::default()).is_err());
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

fn synonyms_of(conn: &Connection, id: i64) -> Vec<String> {
    synonym_map(conn).unwrap().remove(&id).unwrap_or_default()
}

#[test]
fn synonyms_are_unique_and_found_by_name() {
    let mut conn = setup();
    let a = create_tag(&conn, "歌手A").unwrap();
    let b = create_tag(&conn, "歌手B").unwrap();
    // 自分の名前と同じもの・重なるものは入れない。並びは決めた順
    let names = ["Aの別名義", "歌手A", "aの別名義", "Second"].map(String::from);
    set_tag_synonyms(&mut conn, a, &names, "歌手A").unwrap();
    assert_eq!(synonyms_of(&conn, a), vec!["Aの別名義", "Second"]);
    assert_eq!(list_tags(&conn).unwrap().iter().find(|t| t.id == a).unwrap().synonyms, vec!["Aの別名義", "Second"]);
    // ほかのタグの名前・シノニムと同じものはエラーで、何も変えない
    assert!(set_tag_synonyms(&mut conn, b, &["歌手A".into()], "歌手B").is_err());
    let err = set_tag_synonyms(&mut conn, b, &["ok".into(), "SECOND".into()], "歌手B").unwrap_err();
    assert!(err.to_string().contains("歌手A"), "{err}");
    assert!(synonyms_of(&conn, b).is_empty());
    // シノニムでも探せる。シノニムと同じ名前のタグは作れない（名前から探すと、そのタグを使う）
    assert_eq!(find_tag(&conn, "second").unwrap(), Some(a));
    assert!(create_tag(&conn, "Aの別名義").is_err());
    assert_eq!(get_or_create_tag(&conn, "Aの別名義").unwrap(), a);
    // 自分のシノニムに名前を変えると、そのシノニムは外れる
    rename_tag(&mut conn, a, "Second", false).unwrap();
    assert_eq!(synonyms_of(&conn, a), vec!["Aの別名義"]);
    // タグを消すと、シノニムも消える
    delete_tag(&mut conn, a).unwrap();
    assert_eq!(find_tag(&conn, "Aの別名義").unwrap(), None);
}

#[test]
fn merge_moves_name_and_synonyms() {
    let mut conn = setup();
    let a = create_tag(&conn, "歌手A").unwrap();
    let b = create_tag(&conn, "歌手B").unwrap();
    let c = create_tag(&conn, "歌手C").unwrap();
    set_tag_synonyms(&mut conn, a, &["A別名".into()], "歌手A").unwrap();
    set_tag_synonyms(&mut conn, b, &["B別名".into()], "歌手B").unwrap();
    set_tag_synonyms(&mut conn, c, &["C別名".into()], "歌手C").unwrap();
    // ほかのタグの名前に変えて統合：統合元の名前とシノニムが、統合先のシノニムの後ろに入る
    let r = rename_tag(&mut conn, b, "歌手a", true).unwrap();
    assert_eq!(r, RenameResult { tag_id: a, merged: true });
    assert_eq!(synonyms_of(&conn, a), vec!["A別名", "歌手B", "B別名"]);
    // ほかのタグのシノニムに変えても、そのタグへの統合になる
    assert!(rename_tag(&mut conn, c, "A別名", false).is_err());
    let r = rename_tag(&mut conn, c, "A別名", true).unwrap();
    assert_eq!(r.tag_id, a);
    assert_eq!(synonyms_of(&conn, a), vec!["A別名", "歌手B", "B別名", "歌手C", "C別名"]);
}
