use super::*;
use std::path::Path;
use crate::credits::{set_file_credit, CreditKind};
use crate::db::open_in_memory;
use crate::library::{add_folder, scan_folder};
use crate::tags::{list_tags, move_tag};
use crate::tree::MoveTarget;
use std::fs;

/// a.wav, b.mp3, sub/c_100%.flac を置いたフォルダを登録・スキャンしたDB
fn setup() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    for p in ["a.wav", "b.mp3", "sub/c_100%.flac"] {
        let path = dir.path().join(p);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }
    let mut conn = open_in_memory().unwrap();
    let id = add_folder(&conn, dir.path()).unwrap();
    scan_folder(&mut conn, id).unwrap();
    (dir, conn)
}

fn tag_names(file: &AudioFile) -> Vec<&str> {
    file.tags.iter().map(|t| t.name.as_str()).collect()
}

fn rels(files: &[AudioFile]) -> Vec<&str> {
    files.iter().map(|f| f.rel_path.as_str()).collect()
}

fn id_of(conn: &Connection, rel: &str) -> i64 {
    conn.query_row("SELECT id FROM audio_files WHERE rel_path = ?1", [rel], |r| r.get(0))
        .unwrap()
}

#[test]
fn list_all_sorted_with_absolute_path() {
    let (dir, conn) = setup();
    let files = list_files(&conn, &FileFilter::default()).unwrap();
    assert_eq!(rels(&files), vec!["a.wav", "b.mp3", "sub/c_100%.flac"]);
    assert!(Path::new(&files[2].path).exists());
    assert!(files[2].path.starts_with(&*dunce::canonicalize(dir.path()).unwrap().to_string_lossy()));
}

#[test]
fn filter_by_text_ignores_case_and_escapes_wildcards() {
    let (_dir, conn) = setup();
    let f = |text: &str| FileFilter { text: text.into(), ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &f("A.W")).unwrap()), vec!["a.wav"]);
    assert_eq!(rels(&list_files(&conn, &f("100%")).unwrap()), vec!["sub/c_100%.flac"]);
    assert_eq!(rels(&list_files(&conn, &f("_")).unwrap()), vec!["sub/c_100%.flac"]);
    assert!(list_files(&conn, &f("%")).unwrap().len() == 1);
}

#[test]
fn tags_and_filters() {
    let (_dir, mut conn) = setup();
    let a = id_of(&conn, "a.wav");
    let b = id_of(&conn, "b.mp3");

    let explosion = add_tag(&mut conn, &[a, b], " 爆発 ").unwrap();
    let short = add_tag(&mut conn, &[a], "Short").unwrap();
    // 大文字・小文字の違いは同じタグ
    assert_eq!(add_tag(&mut conn, &[a], "short").unwrap(), short);

    let tags: Vec<(i64, String, i64)> =
        list_tags(&conn).unwrap().into_iter().map(|t| (t.id, t.name, t.file_count)).collect();
    assert_eq!(tags, vec![(explosion, "爆発".into(), 2), (short, "Short".into(), 1)]);

    let and = FileFilter { tag_ids: vec![explosion, short], ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &and).unwrap()), vec!["a.wav"]);
    let one = FileFilter { tag_ids: vec![explosion], ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &one).unwrap()), vec!["a.wav", "b.mp3"]);
    let untagged = FileFilter { untagged_only: true, ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &untagged).unwrap()), vec!["sub/c_100%.flac"]);

    // ファイルに付いたタグは、タグの一覧の順に並ぶ
    let all = list_files(&conn, &FileFilter::default()).unwrap();
    assert_eq!(tag_names(&all[0]), vec!["爆発", "Short"]);
    move_tag(&mut conn, short, MoveTarget::Before(explosion)).unwrap();
    let all = list_files(&conn, &FileFilter::default()).unwrap();
    assert_eq!(tag_names(&all[0]), vec!["Short", "爆発"]);

    // 親のタグで絞り込むと、子孫のタグが付いたファイルも含める
    let parent = crate::tags::create_tag(&conn, "親").unwrap();
    move_tag(&mut conn, explosion, MoveTarget::Child(parent)).unwrap();
    let by_parent = FileFilter { tag_ids: vec![parent], ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &by_parent).unwrap()), vec!["a.wav", "b.mp3"]);
    let both = FileFilter { tag_ids: vec![parent, short], ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &both).unwrap()), vec!["a.wav"]);
    move_tag(&mut conn, explosion, MoveTarget::Root).unwrap();

    remove_tag(&mut conn, &[a, b], explosion).unwrap();
    assert_eq!(list_files(&conn, &one).unwrap().len(), 0);
    // 使われなくなってもタグ自体は残る
    assert_eq!(list_tags(&conn).unwrap().len(), 3);
}

#[test]
fn filter_by_source_and_license() {
    let (_dir, mut conn) = setup();
    let a = id_of(&conn, "a.wav");
    let b = id_of(&conn, "b.mp3");
    let s1 = set_file_credit(&mut conn, CreditKind::Source, &[a], Some("s1")).unwrap().unwrap();
    let s2 = set_file_credit(&mut conn, CreditKind::Source, &[b], Some("s2")).unwrap().unwrap();
    let l1 = set_file_credit(&mut conn, CreditKind::License, &[a], Some("l1")).unwrap().unwrap();

    let f = |source_ids: Vec<i64>, no_source: bool, license_ids: Vec<i64>, no_license: bool| {
        let filter = FileFilter { source_ids, no_source, license_ids, no_license, ..Default::default() };
        rels(&list_files(&conn, &filter).unwrap()).iter().map(|s| s.to_string()).collect::<Vec<_>>()
    };
    // 出典どうしはOR
    assert_eq!(f(vec![s1], false, vec![], false), vec!["a.wav"]);
    assert_eq!(f(vec![s1, s2], false, vec![], false), vec!["a.wav", "b.mp3"]);
    assert_eq!(f(vec![], true, vec![], false), vec!["sub/c_100%.flac"]);
    // 出典とライセンスはAND
    assert_eq!(f(vec![s1, s2], false, vec![l1], false), vec!["a.wav"]);
    assert_eq!(f(vec![s1, s2], false, vec![], true), vec!["b.mp3"]);

    let all = list_files(&conn, &FileFilter::default()).unwrap();
    assert_eq!((all[0].source_id, all[0].license_id), (Some(s1), Some(l1)));
    assert_eq!((all[2].source_id, all[2].license_id), (None, None));
}

#[test]
fn filter_by_folder() {
    let (_dir, conn) = setup();
    let folder: i64 = conn.query_row("SELECT id FROM library_folders", [], |r| r.get(0)).unwrap();
    let f = FileFilter { folder_id: Some(folder), ..Default::default() };
    assert_eq!(list_files(&conn, &f).unwrap().len(), 3);
    let other = FileFilter { folder_id: Some(folder + 1), ..Default::default() };
    assert!(list_files(&conn, &other).unwrap().is_empty());
    let and = FileFilter { folder_id: Some(folder), text: "mp3".into(), ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &and).unwrap()), vec!["b.mp3"]);
}

#[test]
fn filter_by_duration() {
    let (_dir, conn) = setup();
    // a.wav は 30秒、b.mp3 は 90秒、c は長さなし（調べていない・読めない）
    conn.execute("UPDATE audio_files SET duration = 30 WHERE rel_path = 'a.wav'", []).unwrap();
    conn.execute("UPDATE audio_files SET duration = 90 WHERE rel_path = 'b.mp3'", []).unwrap();
    let list = |min: Option<f64>, max: Option<f64>| -> Vec<String> {
        let f = FileFilter { min_duration: min, max_duration: max, ..Default::default() };
        list_files(&conn, &f).unwrap().into_iter().map(|f| f.rel_path).collect()
    };
    assert_eq!(list(None, None).len(), 3);
    assert_eq!(list(Some(30.0), None), vec!["a.wav", "b.mp3"]);
    assert_eq!(list(Some(31.0), None), vec!["b.mp3"]);
    assert_eq!(list(None, Some(90.0)), vec!["a.wav", "b.mp3"]);
    assert_eq!(list(None, Some(89.0)), vec!["a.wav"]);
    assert_eq!(list(Some(31.0), Some(89.0)), Vec::<String>::new());
    assert_eq!(list(Some(10.0), Some(60.0)), vec!["a.wav"]);
}

#[test]
fn sort_orders() {
    let (_dir, conn) = setup();
    let set = |rel: &str, added: i64, modified: i64, duration: Option<f64>| {
        conn.execute(
            "UPDATE audio_files SET added_at = ?2, modified_at = ?3, duration = ?4 WHERE rel_path = ?1",
            params![rel, added, modified, duration],
        )
        .unwrap();
    };
    set("a.wav", 2, 30, Some(90.0));
    set("b.mp3", 3, 10, None);
    set("sub/c_100%.flac", 1, 20, Some(30.0));
    let list = |sort: FileSort, desc: bool| -> Vec<String> {
        let f = FileFilter { sort, sort_desc: desc, ..Default::default() };
        list_files(&conn, &f).unwrap().into_iter().map(|f| f.rel_path).collect()
    };
    assert_eq!(list(FileSort::Path, false), vec!["a.wav", "b.mp3", "sub/c_100%.flac"]);
    assert_eq!(list(FileSort::Path, true), vec!["sub/c_100%.flac", "b.mp3", "a.wav"]);
    assert_eq!(list(FileSort::Added, false), vec!["sub/c_100%.flac", "a.wav", "b.mp3"]);
    assert_eq!(list(FileSort::Added, true), vec!["b.mp3", "a.wav", "sub/c_100%.flac"]);
    assert_eq!(list(FileSort::Modified, true), vec!["a.wav", "sub/c_100%.flac", "b.mp3"]);
    // 長さのないファイルは、どちらでも最後
    assert_eq!(list(FileSort::Duration, false), vec!["sub/c_100%.flac", "a.wav", "b.mp3"]);
    assert_eq!(list(FileSort::Duration, true), vec!["a.wav", "sub/c_100%.flac", "b.mp3"]);
    // ファイル名はフォルダを除いて比べる（大文字・小文字は区別しない）
    conn.execute("UPDATE audio_files SET rel_path = 'z/A.wav' WHERE rel_path = 'a.wav'", []).unwrap();
    assert_eq!(list(FileSort::Name, false), vec!["z/A.wav", "b.mp3", "sub/c_100%.flac"]);
    assert_eq!(list(FileSort::Name, true), vec!["sub/c_100%.flac", "b.mp3", "z/A.wav"]);
    // 直近で再生したものの絞り込みでは、選んだ並び順は使わない
    let recent = FileFilter { recent_only: true, sort: FileSort::Name, ..Default::default() };
    assert!(list_files(&conn, &recent).unwrap().is_empty());
}

#[test]
fn bulk_summary_counts_tags_playlists_credits_and_missing() {
    let (_dir, mut conn) = setup();
    let a = id_of(&conn, "a.wav");
    let b = id_of(&conn, "b.mp3");
    let c = id_of(&conn, "sub/c_100%.flac");
    add_tag(&mut conn, &[a, b], "雨").unwrap();
    conn.execute_batch(&format!(
        "INSERT INTO playlists (id, name, position, created_at) VALUES (1, 'P1', 0, 0), (2, 'P2', 1, 0);
         INSERT INTO playlist_items (playlist_id, position, kind, file_id, owned, mode) VALUES
           (2, 0, 'file', {a}, 0, 'order'), (2, 1, 'file', {a}, 0, 'order'), (2, 2, 'file', {b}, 0, 'order'), (1, 0, 'file', {c}, 0, 'order');
         INSERT INTO sources (id, name, url, note, created_at, position) VALUES (7, 's', '', '', 0, 0);
         UPDATE audio_files SET source_id = 7 WHERE id IN ({a}, {b});
         UPDATE audio_files SET missing = 1 WHERE id = {b};"
    ))
    .unwrap();
    let s = bulk_summary(&conn, &[a, b]).unwrap();
    assert_eq!(s.tags.iter().map(|t| (t.name.as_str(), t.count)).collect::<Vec<_>>(), vec![("雨", 2)]);
    // 同じファイルが2回入っていても1件と数える。チェックしていないファイルだけのプレイリストは出さない
    assert_eq!(s.playlists.iter().map(|p| (p.name.as_str(), p.count)).collect::<Vec<_>>(), vec![("P2", 2)]);
    assert_eq!(s.sources, vec![CreditCount { id: Some(7), count: 2 }]);
    assert_eq!(s.licenses, vec![CreditCount { id: None, count: 2 }]);
    assert_eq!(s.missing_ids, vec![b]);
    // 設定がばらばらなら、出典ごとに数える
    let s = bulk_summary(&conn, &[a, c]).unwrap();
    assert_eq!(s.sources.len(), 2);
    // プレイリストからまとめて外す（ファイルの項目だけ）
    assert_eq!(crate::playlists::remove_files_from_playlist(&conn, 2, &[a, b]).unwrap(), 3);
    assert!(bulk_summary(&conn, &[a, b]).unwrap().playlists.is_empty());
}

#[test]
fn filter_by_release_year() {
    let (_dir, conn) = setup();
    // a.wav は 2006年、b.mp3 は 2019年、c は年なし
    conn.execute("UPDATE audio_files SET release_year = 2006 WHERE rel_path = 'a.wav'", []).unwrap();
    conn.execute("UPDATE audio_files SET release_year = 2019 WHERE rel_path = 'b.mp3'", []).unwrap();
    let list = |min: Option<i32>, max: Option<i32>| -> Vec<String> {
        let f = FileFilter { min_year: min, max_year: max, ..Default::default() };
        list_files(&conn, &f).unwrap().into_iter().map(|f| f.rel_path).collect()
    };
    assert_eq!(list(None, None).len(), 3);
    // その年を含む
    assert_eq!(list(Some(2006), None), vec!["a.wav", "b.mp3"]);
    assert_eq!(list(Some(2007), None), vec!["b.mp3"]);
    assert_eq!(list(None, Some(2019)), vec!["a.wav", "b.mp3"]);
    assert_eq!(list(None, Some(2018)), vec!["a.wav"]);
    assert_eq!(list(Some(2010), Some(2020)), vec!["b.mp3"]);
}

#[test]
fn filter_by_file_ids() {
    let (_dir, mut conn) = setup();
    let a = id_of(&conn, "a.wav");
    let c = id_of(&conn, "sub/c_100%.flac");
    let f = FileFilter { file_ids: Some(vec![c, a, 9999]), ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &f).unwrap()), vec!["a.wav", "sub/c_100%.flac"]);
    let none = FileFilter { file_ids: Some(vec![]), ..Default::default() };
    assert!(list_files(&conn, &none).unwrap().is_empty());
    // ほかの条件とはAND
    let and = FileFilter { file_ids: Some(vec![a, c]), text: "flac".into(), ..Default::default() };
    assert_eq!(rels(&list_files(&conn, &and).unwrap()), vec!["sub/c_100%.flac"]);
    // 引数の数の上限（32766）を超える数のidでも使える
    let many: Vec<i64> = (1..=40_000).collect();
    let f = FileFilter { file_ids: Some(many.clone()), ..Default::default() };
    assert_eq!(list_files(&conn, &f).unwrap().len(), 3);
    assert_eq!(existing_file_ids(&conn, &many).unwrap().len(), 3);
    // タグの内訳：付いているタグと、付いているファイルの数（タグの一覧の順）
    let x = add_tag(&mut conn, &[a, c], "x").unwrap();
    let y = add_tag(&mut conn, &[c], "y").unwrap();
    move_tag(&mut conn, y, MoveTarget::Before(x)).unwrap();
    let counts: Vec<(String, i64)> = tag_counts(&conn, &[a, c, 9999]).unwrap().into_iter().map(|t| (t.name, t.count)).collect();
    assert_eq!(counts, vec![("y".to_string(), 1), ("x".to_string(), 2)]);
    assert!(tag_counts(&conn, &[]).unwrap().is_empty());
    // ないidは除く
    assert_eq!(existing_file_ids(&conn, &[a, 9999]).unwrap(), vec![a]);
}

#[test]
fn empty_tag_name_is_rejected() {
    let (_dir, mut conn) = setup();
    let a = id_of(&conn, "a.wav");
    assert!(add_tag(&mut conn, &[a], "  ").is_err());
    assert!(add_tag(&mut conn, &[a], "a\u{1f}b").is_err());
}

#[test]
fn missing_files_can_be_removed() {
    let (dir, mut conn) = setup();
    let a = id_of(&conn, "a.wav");
    let b = id_of(&conn, "b.mp3");
    add_tag(&mut conn, &[a], "tag").unwrap();
    fs::remove_file(dir.path().join("a.wav")).unwrap();
    let folder: i64 = conn.query_row("SELECT id FROM library_folders", [], |r| r.get(0)).unwrap();
    scan_folder(&mut conn, folder).unwrap();

    let missing = FileFilter { missing_only: true, ..Default::default() };
    let files = list_files(&conn, &missing).unwrap();
    assert_eq!(rels(&files), vec!["a.wav"]);
    assert!(files[0].missing);
    // 付けたタグは残っている
    assert_eq!(tag_names(&files[0]), vec!["tag"]);

    // 印のないファイルは外れない
    assert_eq!(remove_missing_files(&mut conn, &[a, b]).unwrap(), 1);
    assert_eq!(rels(&list_files(&conn, &FileFilter::default()).unwrap()), vec!["b.mp3", "sub/c_100%.flac"]);
    assert_eq!(list_tags(&conn).unwrap()[0].file_count, 0);
}
