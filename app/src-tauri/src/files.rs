//! 音声ファイルの一覧・絞り込み、チェックしたファイルの内訳、タグの付け外し

use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

use crate::db::ids_json;
use crate::error::Result;
use crate::library::absolute_path;
use crate::tags::{descendants_and_self, get_or_create_tag, tag_rank, TAG_SEPARATOR};
use crate::tree::NamedRef;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFile {
    pub id: i64,
    pub rel_path: String,
    /// 絶対パス（再生に使う）
    pub path: String,
    pub missing: bool,
    /// 付いているタグ（タグの一覧の順）
    pub tags: Vec<NamedRef>,
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
    /// 選んだタグごとに、そのタグか子孫のタグが付いたファイルに絞り込む（AND）
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
    /// このライブラリフォルダのファイルに絞り込む
    pub folder_id: Option<i64>,
    /// 直近で再生したファイル（recent_plays）に絞り込む。このときは新しく再生した順に並べる
    pub recent_only: bool,
    /// 長さ（秒）がこれ以上・以下のファイルに絞り込む。長さのないファイルは出さない
    pub min_duration: Option<f64>,
    pub max_duration: Option<f64>,
    /// リリース年がこれ以上・以下のファイルに絞り込む。年のないファイルは出さない
    pub min_year: Option<i32>,
    pub max_year: Option<i32>,
    /// 一覧の並び順（絞り込みには使わない）。同じ値どうしはパス順
    pub sort: FileSort,
    pub sort_desc: bool,
}

/// ファイルの一覧の並び順
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileSort {
    /// ライブラリフォルダのパス、相対パスの順
    #[default]
    Path,
    /// フォルダを除いたファイル名（大文字・小文字は区別しない）
    Name,
    /// ライブラリに追加した日時
    Added,
    /// ファイルの更新日時
    Modified,
    /// 長さ。長さのないファイルは、昇順・降順とも最後
    Duration,
}

impl FileSort {
    /// ORDER BY に書く式（パス順の前に置く）。パス順なら None
    fn key(self, desc: bool) -> Option<String> {
        let dir = if desc { "DESC" } else { "ASC" };
        Some(match self {
            FileSort::Path => return None,
            // 最後の「/」の後ろ（rtrim で「/」以外を消した長さが、最後の「/」の位置になる）
            FileSort::Name => format!(
                "substr(a.rel_path, length(rtrim(a.rel_path, replace(a.rel_path, '/', ''))) + 1) COLLATE NOCASE {dir}"
            ),
            FileSort::Added => format!("a.added_at {dir}, a.id {dir}"),
            FileSort::Modified => format!("a.modified_at {dir}"),
            FileSort::Duration => format!("a.duration IS NULL, a.duration {dir}"),
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CountItem {
    pub id: Option<i64>,
    pub count: i64,
}

/// 指定したidのうち、ライブラリにあるもの（チェックから、ライブラリから消えたファイルを外すのに使う）
pub fn existing_file_ids(conn: &Connection, file_ids: &[i64]) -> Result<Vec<i64>> {
    Ok(conn
        .prepare("SELECT id FROM audio_files WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id")?
        .query_map([ids_json(file_ids)], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// 指定したファイルに付いているタグと、そのタグが付いたファイルの数（タグの一覧の順）。
/// チェックしたファイルの、タグの内訳に使う
pub fn tag_counts(conn: &Connection, file_ids: &[i64]) -> Result<Vec<NamedCount>> {
    let mut items: Vec<NamedCount> = conn
        .prepare(
            "SELECT t.id, t.name, count(*) FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
             WHERE ft.file_id IN (SELECT value FROM json_each(?1)) GROUP BY t.id",
        )?
        .query_map([ids_json(file_ids)], |r| Ok(NamedCount { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let rank = tag_rank(conn)?;
    items.sort_by_key(|c| rank.get(&c.id).copied().unwrap_or(usize::MAX));
    Ok(items)
}

/// 一括操作の欄に出す、チェックしたファイルの内訳
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BulkSummary {
    /// 付いているタグと件数（タグの一覧の順）
    pub tags: Vec<NamedCount>,
    /// 入っているプレイリスト（ファイルの項目として）と件数（左の欄の順）
    pub playlists: Vec<NamedCount>,
    /// 出典・ライセンスごとの件数（None は設定なし）
    pub sources: Vec<CreditCount>,
    pub licenses: Vec<CreditCount>,
    /// リンク切れのファイル
    pub missing_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreditCount {
    pub id: Option<i64>,
    pub count: i64,
}

/// チェックしたファイルの内訳（タグ・プレイリスト・出典・ライセンス・リンク切れ）
pub fn bulk_summary(conn: &Connection, file_ids: &[i64]) -> Result<BulkSummary> {
    let ids = ids_json(file_ids);
    let mut playlists: Vec<NamedCount> = conn
        .prepare(
            "SELECT p.id, p.name, count(DISTINCT i.file_id) FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
             WHERE i.kind = 'file' AND i.file_id IN (SELECT value FROM json_each(?1)) GROUP BY p.id",
        )?
        .query_map([&ids], |r| Ok(NamedCount { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let rank: std::collections::HashMap<i64, usize> = crate::playlists::list_playlists(conn)?
        .into_iter()
        .enumerate()
        .map(|(i, p)| (p.id, i))
        .collect();
    playlists.sort_by_key(|p| rank.get(&p.id).copied().unwrap_or(usize::MAX));
    let credits = |col: &str| -> Result<Vec<CreditCount>> {
        Ok(conn
            .prepare(&format!(
                "SELECT {col}, count(*) FROM audio_files WHERE id IN (SELECT value FROM json_each(?1))
                 GROUP BY {col} ORDER BY count(*) DESC"
            ))?
            .query_map([&ids], |r| Ok(CreditCount { id: r.get(0)?, count: r.get(1)? }))?
            .collect::<rusqlite::Result<_>>()?)
    };
    Ok(BulkSummary {
        tags: tag_counts(conn, file_ids)?,
        playlists,
        sources: credits("source_id")?,
        licenses: credits("license_id")?,
        missing_ids: conn
            .prepare("SELECT id FROM audio_files WHERE missing = 1 AND id IN (SELECT value FROM json_each(?1)) ORDER BY id")?
            .query_map([&ids], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?,
    })
}

/// 名前の付いた項目と、その数
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NamedCount {
    pub id: i64,
    pub name: String,
    pub count: i64,
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
    if let Some(folder) = filter.folder_id {
        sql.push_str(" AND a.folder_id = ?");
        args.push(Value::Integer(folder));
    }
    if filter.missing_only {
        sql.push_str(" AND a.missing = 1");
    }
    if filter.recent_only {
        sql.push_str(" AND a.id IN (SELECT file_id FROM recent_plays)");
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
    if let Some(min) = filter.min_duration {
        sql.push_str(" AND a.duration >= ?");
        args.push(Value::Real(min));
    }
    if let Some(min) = filter.min_year {
        sql.push_str(" AND a.release_year >= ?");
        args.push(Value::Integer(min as i64));
    }
    if let Some(max) = filter.max_year {
        sql.push_str(" AND a.release_year <= ?");
        args.push(Value::Integer(max as i64));
    }
    if let Some(max) = filter.max_duration {
        sql.push_str(" AND a.duration <= ?");
        args.push(Value::Real(max));
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

/// ファイルの一覧の並び順（フォルダ、相対パス）。audio_files を a、library_folders を f として使う
pub const FILE_ORDER: &str = "f.path, a.rel_path";

pub fn list_files(conn: &Connection, filter: &FileFilter) -> Result<Vec<AudioFile>> {
    let (conditions, args) = filter_conditions(conn, filter)?;
    let mut sql = format!(
        "SELECT a.id, a.rel_path, f.path, a.missing,
                (SELECT group_concat(t.id || char(30) || t.name, char(31)) FROM file_tags ft
                   JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = a.id),
                a.hash, a.hash_error, a.source_id, a.license_id
         FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
         WHERE 1 = 1{conditions}"
    );
    // 直近で再生したものは、新しく再生した順にする（選んだ並び順は使わない）
    // 重複の一覧では、同じハッシュ値のファイルが並ぶようにし、その中を選んだ順にする
    let mut order: Vec<String> = Vec::new();
    if filter.recent_only {
        order.push("(SELECT seq FROM recent_plays r WHERE r.file_id = a.id) DESC".into());
    } else {
        if filter.duplicates_only {
            order.push("a.hash".into());
        }
        order.extend(filter.sort.key(filter.sort_desc));
    }
    order.push(if filter.sort == FileSort::Path && filter.sort_desc && !filter.recent_only {
        "f.path DESC, a.rel_path DESC".into()
    } else {
        FILE_ORDER.into()
    });
    sql.push_str(&format!(" ORDER BY {}", order.join(", ")));

    // ファイルに付いたタグは、タグの一覧と同じ順に並べる
    let rank = tag_rank(conn)?;
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        let rel_path: String = r.get(1)?;
        let folder_path: String = r.get(2)?;
        // 「id、区切り（char(30)）、名前」をタグの区切り（char(31)）でつないだもの
        let tags: Option<String> = r.get(4)?;
        let mut tags: Vec<NamedRef> = tags
            .map(|s| {
                s.split(TAG_SEPARATOR)
                    .filter_map(|pair| {
                        let (id, name) = pair.split_once('\u{1e}')?;
                        Some(NamedRef { id: id.parse().ok()?, name: name.to_owned() })
                    })
                    .collect()
            })
            .unwrap_or_default();
        tags.sort_by_key(|t| rank.get(&t.id).copied().unwrap_or(usize::MAX));
        Ok(AudioFile {
            id: r.get(0)?,
            path: absolute_path(&folder_path, &rel_path).to_string_lossy().into_owned(),
            rel_path,
            missing: r.get(3)?,
            tags,
            hash: r.get(5)?,
            hash_error: r.get(6)?,
            source_id: r.get(7)?,
            license_id: r.get(8)?,
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
    tx.execute(
        "INSERT OR IGNORE INTO file_tags (file_id, tag_id)
         SELECT id, ?2 FROM audio_files WHERE id IN (SELECT value FROM json_each(?1))",
        params![ids_json(file_ids), tag_id],
    )?;
    tx.commit()?;
    Ok(tag_id)
}

pub fn remove_tag(conn: &Connection, file_ids: &[i64], tag_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM file_tags WHERE tag_id = ?2 AND file_id IN (SELECT value FROM json_each(?1))",
        params![ids_json(file_ids), tag_id],
    )?;
    Ok(())
}

/// ひも付けが切れたファイルをライブラリから外す。印が付いていないファイルは外さない。
/// 外したファイルの数を返す。
pub fn remove_missing_files(conn: &Connection, file_ids: &[i64]) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM audio_files WHERE missing = 1 AND id IN (SELECT value FROM json_each(?1))",
        [ids_json(file_ids)],
    )?)
}

#[cfg(test)]
mod tests {
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
}

