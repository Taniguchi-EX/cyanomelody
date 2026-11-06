//! ファイル内の情報による自動タグ付け。アーティスト・アルバム・ジャンル・作曲者の値を、
//! 項目の名前の親のタグ（「アーティスト」など）の下のタグとして付ける

use rusqlite::{params, Connection, Transaction};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::metadata::FileMeta;
use crate::settings;
use crate::tags::{create_tag_under, find_tag, normalize_tag_name};

/// 無視する値の一覧（設定）
pub const IGNORE_KEY: &str = "meta_ignore_values";
/// 無視する値の一覧の初期値
pub const DEFAULT_IGNORE: [&str; 3] = ["Unknown", "アーティスト情報なし", "Other"];

/// 項目の名前（親のタグの名前）と、ファイルの中の情報での値
fn fields(meta: &FileMeta) -> [(&'static str, Option<&str>); 4] {
    [
        ("アーティスト", meta.artist.as_deref()),
        ("アルバム", meta.album.as_deref()),
        ("ジャンル", meta.genre.as_deref()),
        ("作曲者", meta.composer.as_deref()),
    ]
}

/// 無視する値の一覧。まだ決めていなければ初期値
pub fn ignore_values(conn: &Connection) -> Result<Vec<String>> {
    let saved: Option<Vec<String>> = settings::get(conn, IGNORE_KEY)?;
    Ok(saved.unwrap_or_else(|| DEFAULT_IGNORE.iter().map(|s| s.to_string()).collect()))
}

/// 無視する値の一覧を保存する。前後の空白を除き、空の値・同じ値（大文字・小文字は区別しない）があればエラー
pub fn set_ignore_values(conn: &Connection, values: &[String]) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::new();
    for v in values {
        let v = v.trim();
        if v.is_empty() {
            return Err(Error::invalid("空の値は入れられません"));
        }
        if !seen.insert(v.to_lowercase()) {
            return Err(Error::invalid(format!("「{v}」はもう一覧にあります")));
        }
        list.push(v.to_string());
    }
    settings::set(conn, IGNORE_KEY, &Some(list))
}

/// 付けたタグ（項目の名前とタグの名前）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddedTag {
    pub field: String,
    pub name: String,
}

/// 1つのファイルに付けた結果
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// 新しく付けたタグ（もう付いていたものは入れない）
    pub added: Vec<AddedTag>,
    /// 新しく作ったタグ（親のタグも含む）の数
    pub created: usize,
    /// 使える値があったか（付いていたものしかなかったときも true）
    pub has_info: bool,
}

/// name のタグの id。なければ parent の下（parent が None なら最上位）の最後に作る
fn tag_id(tx: &Transaction, name: &str, parent: Option<i64>, created: &mut usize) -> Result<i64> {
    if let Some(id) = find_tag(tx, name)? {
        return Ok(id);
    }
    let id = create_tag_under(tx, name, parent)?;
    *created += 1;
    Ok(id)
}

/// ファイル（file_id）に、ファイルの中の情報のタグを付ける。ignore にある値（大文字・小文字は区別しない）は使わない。
/// 同じ名前のタグがあれば（どの親の下でも）それを付け、なければ項目の親のタグ（なければ最上位に作る）の下に作る
pub fn apply(tx: &Transaction, file_id: i64, meta: &FileMeta, ignore: &[String]) -> Result<Applied> {
    let mut result = Applied::default();
    let ignored = |v: &str| ignore.iter().any(|i| i.trim().eq_ignore_ascii_case(v) || i.trim() == v);
    for (field, value) in fields(meta) {
        let Some(value) = value.map(str::trim).filter(|v| !v.is_empty() && !ignored(v)) else { continue };
        // タグの名前に使えない値（区切りの文字を含むなど）は使わない
        let Ok(name) = normalize_tag_name(value) else { continue };
        result.has_info = true;
        let parent = tag_id(tx, field, None, &mut result.created)?;
        let tag = tag_id(tx, &name, Some(parent), &mut result.created)?;
        let n = tx.execute("INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?1, ?2)", params![file_id, tag])?;
        if n > 0 {
            result.added.push(AddedTag { field: field.to_string(), name });
        }
    }
    Ok(result)
}

/// ファイル（見つかっているもの）の絶対パス。見つからないファイル・ないファイルは None
pub fn file_path(conn: &Connection, file_id: i64) -> Result<Option<std::path::PathBuf>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT f.path, a.rel_path FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
             WHERE a.id = ?1 AND a.missing = 0",
            [file_id],
            |r| Ok(crate::library::absolute_path(&r.get::<_, String>(0)?, &r.get::<_, String>(1)?)),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_db;
    use crate::tags::list_tags;

    fn meta(artist: &str, album: &str, genre: &str, composer: &str) -> FileMeta {
        let some = |s: &str| (!s.is_empty()).then(|| s.to_string());
        FileMeta { artist: some(artist), album: some(album), genre: some(genre), composer: some(composer) }
    }

    fn run(conn: &mut Connection, file: i64, m: &FileMeta, ignore: &[String]) -> Applied {
        let tx = conn.transaction().unwrap();
        let r = apply(&tx, file, m, ignore).unwrap();
        tx.commit().unwrap();
        r
    }

    fn tree(conn: &Connection) -> Vec<String> {
        list_tags(conn).unwrap().into_iter().map(|t| format!("{}{}", "  ".repeat(t.depth as usize), t.name)).collect()
    }

    #[test]
    fn adds_tags_under_field_parents() {
        let mut conn = test_db(&["a.mp3", "b.mp3"], &[]);
        // 「アルバム」は今あるタグを使う。「米津玄師」は別の親（作者・グループ）の下に今あるので、それを付ける
        let group = create_tag_under(&conn, "作者・グループ", None).unwrap();
        create_tag_under(&conn, "米津玄師", Some(group)).unwrap();
        create_tag_under(&conn, "アルバム", None).unwrap();
        let r = run(&mut conn, 1, &meta("米津玄師", "STRAY SHEEP", "J-POP", "米津玄師"), &[]);
        assert_eq!(
            r.added.iter().map(|a| format!("{}:{}", a.field, a.name)).collect::<Vec<_>>(),
            vec!["アーティスト:米津玄師", "アルバム:STRAY SHEEP", "ジャンル:J-POP"]
        );
        // 作ったのは、アーティスト・ジャンル・作曲者の親と、STRAY SHEEP・J-POP（作曲者は米津玄師がもう付いている）
        assert_eq!(r.created, 5);
        assert_eq!(
            tree(&conn),
            vec!["作者・グループ", "  米津玄師", "アルバム", "  STRAY SHEEP", "アーティスト", "ジャンル", "  J-POP", "作曲者"]
        );
        // 何度行っても同じ（増えない）
        let again = run(&mut conn, 1, &meta("米津玄師", "STRAY SHEEP", "J-POP", "米津玄師"), &[]);
        assert!(again.added.is_empty() && again.created == 0 && again.has_info);
        // 大文字・小文字の違う名前は、今のタグを付ける
        let r = run(&mut conn, 2, &meta("", "stray sheep", "", ""), &[]);
        assert_eq!(r.added[0].name, "stray sheep");
        assert_eq!(r.created, 0);
    }

    #[test]
    fn ignores_values_and_empty_info() {
        let mut conn = test_db(&["a.mp3"], &[]);
        let ignore = ignore_values(&conn).unwrap();
        assert_eq!(ignore, vec!["Unknown", "アーティスト情報なし", "Other"]);
        // 大文字・小文字は区別しない。無視した項目の親のタグは作らない
        let r = run(&mut conn, 1, &meta("UNKNOWN", "", "other", " 作曲家A "), &ignore);
        assert_eq!(r.added.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["作曲家A"]);
        assert_eq!(tree(&conn), vec!["作曲者", "  作曲家A"]);
        // 無視しなければ使う
        let r = run(&mut conn, 1, &meta("Unknown", "", "", ""), &[]);
        assert_eq!(r.added.len(), 1);
        // 情報がなければ何もしない
        let r = run(&mut conn, 1, &FileMeta::default(), &ignore);
        assert!(!r.has_info && r.added.is_empty());
    }

    #[test]
    fn saves_ignore_values() {
        let conn = test_db(&[], &[]);
        set_ignore_values(&conn, &[" Unknown ".into(), "なし".into()]).unwrap();
        assert_eq!(ignore_values(&conn).unwrap(), vec!["Unknown", "なし"]);
        assert!(set_ignore_values(&conn, &["a".into(), "A".into()]).is_err());
        assert!(set_ignore_values(&conn, &["".into()]).is_err());
        // 空の一覧も保存できる（初期値には戻らない）
        set_ignore_values(&conn, &[]).unwrap();
        assert!(ignore_values(&conn).unwrap().is_empty());
    }
}
