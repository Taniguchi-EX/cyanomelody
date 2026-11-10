use super::*;
use crate::db::test_db;

const ALL: Sections = Sections { library: true, tags: true, playlists: true, credits: true };

/// 書き出す元：a.wav（雨・屋外）、b.mp3（風）、sub/c.flac（タグなし）。タグは 環境音 > 雨・風、屋外。
/// プレイリスト「シーン」：a.wav（別名・fx）、タグ「雨」の組み合わせ（1曲）、子のプレイリスト「子」（b.mp3）
fn source_db() -> Connection {
    let conn = test_db(&["a.wav", "b.mp3", "sub/c.flac"], &[]);
    conn.execute_batch(
        "UPDATE audio_files SET size = id * 100, hash = 'h' || id;
         INSERT INTO tags (id, name, created_at, parent_id, position) VALUES (1, '環境音', 0, NULL, 0), (2, '雨', 0, 1, 0), (3, '風', 0, 1, 1), (4, '屋外', 0, NULL, 1);
         UPDATE tags SET bg_color = '#ff0000', child_sort = 'romaji' WHERE id = 1;
         INSERT INTO tag_synonyms (tag_id, name, position) VALUES (3, 'そよ風', 0), (3, 'ウィンド', 1), (4, '外', 0);
         INSERT INTO file_tags VALUES (1, 2), (1, 4), (2, 3);
         INSERT INTO sources (id, name, url, note, created_at, position) VALUES (1, '素材サイト', 'https://example.com', '', 0, 0);
         INSERT INTO licenses (id, name, url, note, license_type, commercial, created_at, position) VALUES (1, 'CC0', '', '', 'cc0', 1, 0, 0);
         UPDATE audio_files SET source_id = 1, license_id = 1 WHERE id = 1;
         INSERT INTO effect_chains (id, name, created_at) VALUES (1, '残響', 0);
         INSERT INTO effect_steps (chain_id, position, effect) VALUES (1, 0, '{\"kind\":\"gain\",\"db\":-6}');
         INSERT INTO playlists (id, name, position, created_at) VALUES (1, 'シーン', 0, 0), (2, '子', 1, 0);
         INSERT INTO playlist_items (playlist_id, position, kind, file_id, ref_id, owned, mode, alias, effect_chain_id) VALUES
           (1, 0, 'file', 1, NULL, 0, 'order', '最初の音', 1),
           (1, 1, 'tags', NULL, NULL, 0, 'random', NULL, NULL),
           (1, 2, 'playlist', NULL, 2, 1, 'shuffle', NULL, NULL),
           (2, 0, 'file', 2, NULL, 0, 'order', NULL, NULL);
         INSERT INTO playlist_item_tags VALUES (2, 2);",
    )
    .unwrap();
    settings::set(&conn, settings::NEW_TAG, &TagSettings { bg_color: Some("#00ff00".into()), ..Default::default() }).unwrap();
    crate::autotag::set_ignore_values(&conn, &["Unknown".into(), "情報なし".into()]).unwrap();
    crate::autotag::set_separators(&conn, &["&".into()]).unwrap();
    conn
}

fn roundtrip(data: &DataFile) -> DataFile {
    parse(&serde_json::to_string(data).unwrap()).unwrap()
}

fn import(conn: &mut Connection, data: &DataFile, sections: Sections, replace: bool) -> ImportResult {
    let mut result = ImportResult::default();
    import_data(conn, data, sections, replace, &mut result).unwrap();
    result
}

fn names(conn: &Connection, sql: &str) -> Vec<String> {
    conn.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
}

fn file_tags_of(conn: &Connection, rel: &str) -> Vec<String> {
    names(
        conn,
        &format!(
            "SELECT t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id JOIN audio_files a ON a.id = ft.file_id
             WHERE a.rel_path = '{rel}' ORDER BY t.name"
        ),
    )
}

#[test]
fn exports_only_selected_files_with_tags_and_credits() {
    let conn = source_db();
    // a.wav（タグ2つ・出典・ライセンス）と sub/c.flac（何もない）を選ぶ
    let data = roundtrip(&export_metadata(&conn, &[1, 3], "1.2.0").unwrap());
    assert_eq!(data.sections, Sections { tags: true, credits: true, ..Default::default() });
    let rels: Vec<&str> = data.files.iter().map(|f| f.rel_path.as_str()).collect();
    assert_eq!(rels, vec!["a.wav", "sub/c.flac"]);
    assert_eq!(data.files[0].tags, vec![2, 4]);
    assert_eq!((data.files[0].source, data.files[0].license), (Some(1), Some(1)));
    assert!(data.files[1].tags.is_empty());
    assert_eq!(data.files[0].missing, Some(false));
    // タグ・出典・ライセンスの定義はすべて。プレイリストと設定は入れない
    assert_eq!(data.tags.len(), 4);
    assert_eq!((data.sources.len(), data.licenses.len()), (1, 1));
    assert!(data.playlists.is_empty() && data.effect_chains.is_empty());
    assert!(data.new_tag.is_none() && data.meta_ignore.is_none() && data.screen.is_none());
    assert_eq!(data.folders.len(), 1);
    // 別のDBに取り込める（選んだファイルのタグ付けだけが入る）
    let mut dest = test_db(&["a.wav", "b.mp3", "sub/c.flac"], &[]);
    let mut result = ImportResult::default();
    import_data(&mut dest, &data, data.sections, false, &mut result).unwrap();
    let tagged: i64 = dest.query_row("SELECT count(DISTINCT file_id) FROM file_tags", [], |r| r.get(0)).unwrap();
    assert_eq!(tagged, 1);
}

#[test]
fn exports_and_imports_everything_into_same_paths() {
    let screen = serde_json::Map::from_iter([("volume".to_string(), serde_json::Value::from(0.5))]);
    let data = roundtrip(&export(&source_db(), ALL, "1.2.0", Some(screen)).unwrap());
    assert_eq!((data.folders.len(), data.files.len(), data.tags.len(), data.playlists.len()), (1, 3, 4, 2));
    // 取り込み先：同じパスの曲（id は違う）があり、データは空
    let mut dest = test_db(&["sub/c.flac", "b.mp3", "a.wav"], &[]);
    let p = preview(&dest, &data).unwrap();
    assert_eq!((p.matched_by_path, p.files), (3, 3));
    let r = import(&mut dest, &data, ALL, false);
    assert_eq!((r.files_matched, r.files_unmatched, r.tags_added, r.playlists_added, r.effect_chains_added), (3, 0, 4, 2, 1));
    assert_eq!(file_tags_of(&dest, "a.wav"), vec!["屋外", "雨"]);
    assert_eq!(file_tags_of(&dest, "b.mp3"), vec!["風"]);
    // タグの階層・並び順・色
    let tags = crate::tags::list_tags(&dest).unwrap();
    let shown: Vec<String> = tags.iter().map(|t| format!("{}:{}", t.name, t.depth)).collect();
    assert_eq!(shown, vec!["環境音:0", "雨:1", "風:1", "屋外:0"]);
    assert_eq!(tags[0].settings.bg_color.as_deref(), Some("#ff0000"));
    // 出典・ライセンスと曲への設定、新しく作るタグの既定値、画面の設定
    let credit: (Option<String>, Option<String>) = dest
        .query_row(
            "SELECT s.name, l.name FROM audio_files a LEFT JOIN sources s ON s.id = a.source_id
             LEFT JOIN licenses l ON l.id = a.license_id WHERE a.rel_path = 'a.wav'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(credit, (Some("素材サイト".into()), Some("CC0".into())));
    assert_eq!(crate::tags::new_tag_settings(&dest).unwrap().bg_color.as_deref(), Some("#00ff00"));
    // 自動タグ付けで無視する値の一覧
    assert_eq!(crate::autotag::ignore_values(&dest).unwrap(), vec!["Unknown", "情報なし"]);
    assert_eq!(crate::autotag::separators(&dest).unwrap(), vec!["&"]);
    assert_eq!(r.screen.unwrap()["volume"], 0.5);
    // プレイリスト：項目・別名・再生方法・fx・タグの組み合わせ・子のプレイリスト
    let items = names(
        &dest,
        "SELECT p.name || ':' || i.kind || ':' || coalesce(a.rel_path, r.name, (SELECT group_concat(t.name) FROM playlist_item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id))
             || ':' || i.mode || ':' || coalesce(i.alias, '') || ':' || coalesce(c.name, '') || ':' || i.owned
         FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id LEFT JOIN audio_files a ON a.id = i.file_id
         LEFT JOIN playlists r ON r.id = i.ref_id LEFT JOIN effect_chains c ON c.id = i.effect_chain_id
         ORDER BY p.position, i.position",
    );
    assert_eq!(
        items,
        vec![
            "シーン:file:a.wav:order:最初の音:残響:0",
            "シーン:tags:雨:random:::0",
            "シーン:playlist:子:shuffle:::1",
            "子:file:b.mp3:order:::0",
        ]
    );
    let steps = names(&dest, "SELECT effect FROM effect_steps");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&steps[0]).unwrap()["db"], -6);
}

#[test]
fn finds_files_by_hash_then_name_and_size() {
    let data = roundtrip(&export(&source_db(), ALL, "1.0.0", None).unwrap());
    // 別の PC：フォルダの場所も名前も違う。a はハッシュ値で、b は名前と大きさで見つかる。c は見つからない
    let mut dest = test_db(&["x/renamed.wav", "b.mp3", "c.flac"], &[]);
    dest.execute_batch(
        "UPDATE library_folders SET path = 'D:\\other';
         UPDATE audio_files SET hash = 'h1', size = 100 WHERE id = 1;
         UPDATE audio_files SET size = 200 WHERE id = 2;
         UPDATE audio_files SET size = 999 WHERE id = 3;",
    )
    .unwrap();
    let p = preview(&dest, &data).unwrap();
    assert_eq!((p.matched_by_path, p.matched_by_hash, p.matched_by_name, p.pending_hashes), (0, 1, 1, 2));
    let r = import(&mut dest, &data, ALL, false);
    assert_eq!((r.files_matched, r.files_unmatched), (2, 1));
    assert_eq!(file_tags_of(&dest, "x/renamed.wav"), vec!["屋外", "雨"]);
    assert_eq!(file_tags_of(&dest, "b.mp3"), vec!["風"]);
    assert!(file_tags_of(&dest, "c.flac").is_empty());
}

#[test]
fn merge_keeps_current_data_and_replace_clears_it() {
    let data = roundtrip(&export(&source_db(), ALL, "1.0.0", None).unwrap());
    let setup = "INSERT INTO tags (id, name, created_at, parent_id, position, bg_color) VALUES (10, '雨', 0, NULL, 0, '#0000ff'), (11, '古いタグ', 0, NULL, 1, NULL);
         INSERT INTO file_tags VALUES (3, 11);
         INSERT INTO playlists (id, name, position, created_at) VALUES (10, 'シーン', 0, 0);
         INSERT INTO sources (id, name, url, note, created_at, position) VALUES (5, '別の出典', '', '', 0, 0);
         UPDATE audio_files SET source_id = 5 WHERE id = 1;";
    let mut dest = test_db(&["a.wav", "b.mp3", "sub/c.flac"], &[]);
    dest.execute_batch(setup).unwrap();
    let p = preview(&dest, &data).unwrap();
    assert_eq!((p.current.tags, p.current.playlists, p.current.sources), (2, 1, 1));
    // 足す：同じ名前のタグは今のもの（色も位置も変えない）、同じ名前のプレイリストは「(2)」、曲の出典は今のまま
    let r = import(&mut dest, &data, ALL, false);
    assert_eq!(r.tags_added, 3);
    // 新しく作ったタグにだけシノニムを付ける（今ある「雨」は変えない）
    let synonyms = crate::tags::synonym_map(&dest).unwrap();
    let wind: i64 = dest.query_row("SELECT id FROM tags WHERE name = '風'", [], |r| r.get(0)).unwrap();
    assert_eq!(synonyms.get(&wind).cloned().unwrap_or_default(), vec!["そよ風", "ウィンド"]);
    let rain: (Option<i64>, Option<String>) =
        dest.query_row("SELECT parent_id, bg_color FROM tags WHERE id = 10", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(rain, (None, Some("#0000ff".into())));
    assert_eq!(file_tags_of(&dest, "a.wav"), vec!["屋外", "雨"]);
    assert_eq!(file_tags_of(&dest, "sub/c.flac"), vec!["古いタグ"]);
    assert_eq!(names(&dest, "SELECT name FROM playlists ORDER BY position"), vec!["シーン", "シーン(2)", "子"]);
    assert_eq!(names(&dest, "SELECT s.name FROM audio_files a JOIN sources s ON s.id = a.source_id"), vec!["別の出典"]);
    // 同じ名前で中身も同じエフェクトセットは、もう一度足しても増えない
    let again = import(&mut dest, &data, Sections { playlists: true, ..Default::default() }, false);
    assert_eq!(again.effect_chains_added, 0);
    // 置き換える：選んだ項目の今のデータを消してから取り込む
    let mut dest2 = test_db(&["a.wav", "b.mp3", "sub/c.flac"], &[]);
    dest2.execute_batch(setup).unwrap();
    import(&mut dest2, &data, ALL, true);
    assert_eq!(names(&dest2, "SELECT name FROM tags ORDER BY id"), vec!["環境音", "雨", "風", "屋外"]);
    assert!(file_tags_of(&dest2, "sub/c.flac").is_empty());
    assert_eq!(names(&dest2, "SELECT name FROM playlists ORDER BY position"), vec!["シーン", "子"]);
    assert_eq!(names(&dest2, "SELECT s.name FROM audio_files a JOIN sources s ON s.id = a.source_id"), vec!["素材サイト"]);
    // 選ばなかった項目は変えない
    let mut dest3 = test_db(&["a.wav"], &[]);
    dest3.execute_batch("INSERT INTO playlists (id, name, position, created_at) VALUES (10, '残す', 0, 0);").unwrap();
    import(&mut dest3, &data, Sections { tags: true, ..Default::default() }, true);
    assert_eq!(names(&dest3, "SELECT name FROM playlists"), vec!["残す"]);
}

#[test]
fn exports_only_what_is_needed_for_chosen_sections() {
    let conn = source_db();
    // プレイリストだけ：項目の曲（a・b）と、タグの組み合わせのタグ「雨」とその親「環境音」だけ。出典などは入れない
    let data = export(&conn, Sections { playlists: true, ..Default::default() }, "1.0.0", None).unwrap();
    let rels: Vec<&str> = data.files.iter().map(|f| f.rel_path.as_str()).collect();
    assert_eq!(rels, vec!["a.wav", "b.mp3"]);
    let tags: Vec<&str> = data.tags.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(tags, vec!["環境音", "雨"]);
    assert!(data.files.iter().all(|f| f.tags.is_empty() && f.source.is_none()));
    assert!(data.sources.is_empty() && data.new_tag.is_none());
    // プレイリストだけを取り込んでも、項目のタグは名前で対応させる（なければ作る）。曲へのタグ付けはしない
    let mut dest = test_db(&["a.wav", "b.mp3"], &[]);
    import(&mut dest, &roundtrip(&data), Sections { playlists: true, ..Default::default() }, false);
    assert_eq!(names(&dest, "SELECT t.name FROM playlist_item_tags it JOIN tags t ON t.id = it.tag_id"), vec!["雨"]);
    assert!(file_tags_of(&dest, "a.wav").is_empty());
    // 出典・ライセンスだけ：設定のある曲（a）だけ
    let data = export(&conn, Sections { credits: true, ..Default::default() }, "1.0.0", None).unwrap();
    assert_eq!(data.files.len(), 1);
    assert!(data.playlists.is_empty() && data.tags.is_empty());
}

#[test]
fn rejects_other_files() {
    assert!(parse("not json").is_err());
    assert!(parse(r#"{"app":"other","formatVersion":1}"#).is_err());
    let newer = parse(r#"{"app":"cyanomelody","formatVersion":99}"#).unwrap_err().to_string();
    assert!(newer.contains("新しい版"), "{newer}");
    assert!(parse(r#"{"app":"cyanomelody","formatVersion":1}"#).is_ok());
}
