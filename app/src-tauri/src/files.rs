//! 音声ファイルの一覧・絞り込みとタグの付け外し

use std::path::Path;

use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::tags::{descendants_and_self, get_or_create_tag, list_tags, tag_rank, TAG_SEPARATOR};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFile {
    pub id: i64,
    pub folder_id: i64,
    pub rel_path: String,
    /// 絶対パス（試聴に使う）
    pub path: String,
    pub size: i64,
    pub modified_at: i64,
    pub missing: bool,
    pub tags: Vec<String>,
    /// 音声データ部分のハッシュ値。未計算・計算できなかったときは None
    pub hash: Option<String>,
    /// ハッシュ値を計算できなかった理由
    pub hash_error: Option<String>,
    pub source_id: Option<i64>,
    pub license_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FileFilter {
    /// ファイル名（相対パス）の部分一致
    pub text: String,
    /// すべてのタグが付いたファイルに絞り込む
    pub tag_ids: Vec<i64>,
    pub untagged_only: bool,
    pub missing_only: bool,
    /// 同じハッシュ値のファイルが2件以上あるものだけに絞り込む（重複の判定はライブラリ全体で行う）
    pub duplicates_only: bool,
    /// このハッシュ値のファイルに絞り込む
    pub hash: Option<String>,
    /// どれかの出典が設定されたファイルに絞り込む
    pub source_ids: Vec<i64>,
    pub no_source: bool,
    /// どれかのライセンスが設定されたファイルに絞り込む
    pub license_ids: Vec<i64>,
    pub no_license: bool,
    /// 指定したidのファイルだけに絞り込む（チェックしたファイルだけの表示）
    pub file_ids: Option<Vec<i64>>,
}

/// ファイルのidの一覧を、SQLの1つの引数（JSONの配列）にする。数万件でも引数の数の上限にかからない
fn ids_json(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".into())
}

/// まとめて操作するファイル（チェックしたファイル）の内訳
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    /// 指定したidのうち、ライブラリにあるもの
    pub ids: Vec<i64>,
    /// 見つからない印が付いたファイルの数
    pub missing: i64,
    /// 付いているタグ（タグの一覧の順）と、そのタグが付いたファイルの数
    pub tags: Vec<CountItem>,
    /// 出典ごとのファイルの数（id が None は「なし」）
    pub sources: Vec<CountItem>,
    pub licenses: Vec<CountItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CountItem {
    pub id: Option<i64>,
    pub count: i64,
}

pub fn summarize_files(conn: &Connection, file_ids: &[i64]) -> Result<FileSummary> {
    let json = ids_json(file_ids);
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM audio_files WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id")?
        .query_map([&json], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let missing = conn.query_row(
        "SELECT count(*) FROM audio_files WHERE missing = 1 AND id IN (SELECT value FROM json_each(?1))",
        [&json],
        |r| r.get(0),
    )?;
    let counts = |sql: &str| -> Result<Vec<CountItem>> {
        Ok(conn
            .prepare(sql)?
            .query_map([&json], |r| Ok(CountItem { id: r.get(0)?, count: r.get(1)? }))?
            .collect::<rusqlite::Result<_>>()?)
    };
    let mut tags = counts(
        "SELECT tag_id, count(*) FROM file_tags
         WHERE file_id IN (SELECT value FROM json_each(?1)) GROUP BY tag_id",
    )?;
    let order: std::collections::HashMap<i64, usize> =
        list_tags(conn)?.into_iter().enumerate().map(|(i, t)| (t.id, i)).collect();
    tags.sort_by_key(|c| c.id.and_then(|id| order.get(&id).copied()).unwrap_or(usize::MAX));
    let sources = counts(
        "SELECT source_id, count(*) FROM audio_files
         WHERE id IN (SELECT value FROM json_each(?1)) GROUP BY source_id ORDER BY source_id",
    )?;
    let licenses = counts(
        "SELECT license_id, count(*) FROM audio_files
         WHERE id IN (SELECT value FROM json_each(?1)) GROUP BY license_id ORDER BY license_id",
    )?;
    Ok(FileSummary { ids, missing, tags, sources, licenses })
}

/// 絞り込みの条件を、audio_files（別名 a）に対する WHERE 句の条件にする。
/// 戻り値の文字列は「 AND ...」の並び（条件がなければ空）
pub(crate) fn filter_conditions(conn: &Connection, filter: &FileFilter) -> Result<(String, Vec<Value>)> {
    let mut sql = String::new();
    let mut args: Vec<Value> = Vec::new();
    let text = filter.text.trim();
    if !text.is_empty() {
        sql.push_str(" AND a.rel_path LIKE ? ESCAPE '\\'");
        args.push(Value::Text(format!("%{}%", escape_like(text))));
    }
    // 選んだタグごとに、そのタグか子孫のタグが付いていること
    for tag_id in &filter.tag_ids {
        let ids = descendants_and_self(conn, *tag_id)?;
        let marks = vec!["?"; ids.len()].join(", ");
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = a.id AND ft.tag_id IN ({marks}))"
        ));
        args.extend(ids.into_iter().map(Value::Integer));
    }
    if filter.untagged_only {
        sql.push_str(" AND NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = a.id)");
    }
    if let Some(ids) = &filter.file_ids {
        sql.push_str(" AND a.id IN (SELECT value FROM json_each(?))");
        args.push(Value::Text(ids_json(ids)));
    }
    if filter.missing_only {
        sql.push_str(" AND a.missing = 1");
    }
    if filter.duplicates_only {
        sql.push_str(
            " AND a.hash IN (SELECT hash FROM audio_files WHERE hash IS NOT NULL
                             GROUP BY hash HAVING count(*) > 1)",
        );
    }
    if let Some(hash) = &filter.hash {
        sql.push_str(" AND a.hash = ?");
        args.push(Value::Text(hash.clone()));
    }
    for (column, ids, none) in [
        ("a.source_id", &filter.source_ids, filter.no_source),
        ("a.license_id", &filter.license_ids, filter.no_license),
    ] {
        if none {
            sql.push_str(&format!(" AND {column} IS NULL"));
        } else if !ids.is_empty() {
            let marks = vec!["?"; ids.len()].join(", ");
            sql.push_str(&format!(" AND {column} IN ({marks})"));
            args.extend(ids.iter().map(|id| Value::Integer(*id)));
        }
    }
    Ok((sql, args))
}

pub fn list_files(conn: &Connection, filter: &FileFilter) -> Result<Vec<AudioFile>> {
    let (conditions, args) = filter_conditions(conn, filter)?;
    let mut sql = format!(
        "SELECT a.id, a.folder_id, a.rel_path, f.path, a.size, a.modified_at, a.missing,
                (SELECT group_concat(t.name, char(31)) FROM file_tags ft
                   JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = a.id),
                a.hash, a.hash_error, a.source_id, a.license_id
         FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
         WHERE 1 = 1{conditions}"
    );
    // 重複の一覧では、同じハッシュ値のファイルが並ぶようにする
    sql.push_str(if filter.duplicates_only {
        " ORDER BY a.hash, f.path, a.rel_path"
    } else {
        " ORDER BY f.path, a.rel_path"
    });

    // ファイルに付いたタグは、タグの一覧と同じ順に並べる
    let rank = tag_rank(conn)?;
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        let folder_path: String = r.get(3)?;
        let rel_path: String = r.get(2)?;
        let tags: Option<String> = r.get(7)?;
        let mut tags: Vec<String> = tags
            .map(|s| s.split(TAG_SEPARATOR).map(str::to_owned).collect())
            .unwrap_or_default();
        tags.sort_by_key(|t| rank.get(t).copied().unwrap_or(usize::MAX));
        Ok(AudioFile {
            id: r.get(0)?,
            folder_id: r.get(1)?,
            path: Path::new(&folder_path)
                .join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR))
                .to_string_lossy()
                .into_owned(),
            rel_path,
            size: r.get(4)?,
            modified_at: r.get(5)?,
            missing: r.get(6)?,
            tags,
            hash: r.get(8)?,
            hash_error: r.get(9)?,
            source_id: r.get(10)?,
            license_id: r.get(11)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn add_tag(conn: &mut Connection, file_ids: &[i64], tag_name: &str) -> Result<i64> {
    let tx = conn.transaction()?;
    let tag_id = get_or_create_tag(&tx, tag_name)?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO file_tags (file_id, tag_id)
             SELECT id, ?2 FROM audio_files WHERE id = ?1",
        )?;
        for id in file_ids {
            stmt.execute(params![id, tag_id])?;
        }
    }
    tx.commit()?;
    Ok(tag_id)
}

pub fn remove_tag(conn: &mut Connection, file_ids: &[i64], tag_id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM file_tags WHERE file_id = ?1 AND tag_id = ?2")?;
        for id in file_ids {
            stmt.execute(params![id, tag_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// ひも付けが切れたファイルをライブラリから外す。印が付いていないファイルは外さない。
/// 外したファイルの数を返す。
pub fn remove_missing_files(conn: &mut Connection, file_ids: &[i64]) -> Result<usize> {
    let tx = conn.transaction()?;
    let mut removed = 0;
    {
        let mut stmt = tx.prepare("DELETE FROM audio_files WHERE id = ?1 AND missing = 1")?;
        for id in file_ids {
            removed += stmt.execute([id])?;
        }
    }
    tx.commit()?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credits::{set_file_credit, CreditKind};
    use crate::db::open_in_memory;
    use crate::library::{add_folder, scan_folder};
    use crate::tags::{move_tag, MoveTarget};
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
        assert_eq!(all[0].tags, vec!["爆発", "Short"]);
        move_tag(&mut conn, short, MoveTarget::Before(explosion)).unwrap();
        let all = list_files(&conn, &FileFilter::default()).unwrap();
        assert_eq!(all[0].tags, vec!["Short", "爆発"]);

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
    fn filter_by_file_ids() {
        let (_dir, conn) = setup();
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
        assert_eq!(summarize_files(&conn, &many).unwrap().ids.len(), 3);
    }

    #[test]
    fn summarize_checked_files() {
        let (dir, mut conn) = setup();
        let a = id_of(&conn, "a.wav");
        let b = id_of(&conn, "b.mp3");
        let c = id_of(&conn, "sub/c_100%.flac");
        let x = add_tag(&mut conn, &[a, b], "x").unwrap();
        let y = add_tag(&mut conn, &[b, c], "y").unwrap();
        // タグの一覧の順に並ぶ
        move_tag(&mut conn, y, MoveTarget::Before(x)).unwrap();
        let s1 = set_file_credit(&mut conn, CreditKind::Source, &[a, b], Some("s1")).unwrap();
        fs::remove_file(dir.path().join("b.mp3")).unwrap();
        let folder: i64 = conn.query_row("SELECT id FROM library_folders", [], |r| r.get(0)).unwrap();
        scan_folder(&mut conn, folder).unwrap();

        let s = summarize_files(&conn, &[a, b, 9999]).unwrap();
        assert_eq!(s.ids, vec![a, b]);
        assert_eq!(s.missing, 1);
        assert_eq!(
            s.tags,
            vec![CountItem { id: Some(y), count: 1 }, CountItem { id: Some(x), count: 2 }]
        );
        assert_eq!(s.sources, vec![CountItem { id: s1, count: 2 }]);
        assert_eq!(s.licenses, vec![CountItem { id: None, count: 2 }]);
        let empty = summarize_files(&conn, &[]).unwrap();
        assert_eq!(empty, FileSummary::default());
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
        assert_eq!(files[0].tags, vec!["tag"]);

        // 印のないファイルは外れない
        assert_eq!(remove_missing_files(&mut conn, &[a, b]).unwrap(), 1);
        assert_eq!(rels(&list_files(&conn, &FileFilter::default()).unwrap()), vec!["b.mp3", "sub/c_100%.flac"]);
        assert_eq!(list_tags(&conn).unwrap()[0].file_count, 0);
    }
}
