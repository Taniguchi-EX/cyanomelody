//! 音声ファイルの一覧・絞り込み、チェックしたファイルの内訳、タグの付け外し

use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

use crate::db::ids_json;
use crate::error::Result;
use crate::location::Location;
use crate::playlists::{ItemKind, PlayMode};
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
    /// 一覧の中で行を見分ける値。ライブラリの一覧ではファイルの id、抽選した並びでは行の番号（同じファイルが2行出ることがある）
    pub key: i64,
    /// 抽選した並びの行だけ：ファイルの項目の別名（プレイリスト上での名前）
    pub alias: Option<String>,
    /// 抽選した並びの行だけ：選んだプレイリストの、この曲を出した項目（直下の項目）。ファイルの項目から来た曲は None
    pub origin: Option<RowOrigin>,
    /// 抽選した並びの行だけ：選んだプレイリストの直下の項目の id（ファイルの項目も含む）
    pub item_id: Option<i64>,
    /// 抽選した並びの行だけ：かけるエフェクトセット（内側から外側の順）
    pub chains: Vec<i64>,
    /// 抽選した並びの行だけ：🎲・🔀の項目を通った曲か（抽選し直すと変わりうる）
    pub drawn: bool,
}

/// 抽選した並びの行が、どの項目から来たか（行のアイコンと説明に使う）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowOrigin {
    pub item_id: i64,
    pub kind: ItemKind,
    pub mode: PlayMode,
    /// 項目の内容（タグの組み合わせは「雨 ＋ 風」、プレイリストは別名かその名前）
    pub label: String,
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
    /// 抽選した並び（プレイリストを選んでいるとき）の中で絞り込む。行ごとに返し、同じファイルが2行出ることがある
    pub draw: bool,
    /// 一覧の並び順（絞り込みには使わない）。同じ値どうしはパス順
    pub sort: FileSort,
    pub sort_desc: bool,
}

/// フォルダを除いたファイル名（audio_files を a として）
const FILE_NAME: &str = "substr(a.rel_path, length(rtrim(a.rel_path, replace(a.rel_path, '/', ''))) + 1)";

/// 絞り込みの対象の表（FROM 句）。抽選した並びでは、行（d）ごとにファイル（a）と、別名を引く項目（pi）をつなぐ
pub(crate) fn source_tables(filter: &FileFilter) -> &'static str {
    if filter.draw {
        "temp.draw_rows d JOIN audio_files a ON a.id = d.file_id LEFT JOIN playlist_items pi ON pi.id = d.alias_item"
    } else {
        "audio_files a"
    }
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
    /// 抽選した順（プレイリストを選んでいるときだけ。ライブラリの一覧ではパス順）
    Playlist,
}

impl FileSort {
    /// ORDER BY に書く式（パス順の前に置く）。パス順なら None
    fn key(self, desc: bool, draw: bool) -> Option<String> {
        let dir = if desc { "DESC" } else { "ASC" };
        Some(match self {
            FileSort::Path => return None,
            FileSort::Playlist if draw => format!("d.seq {dir}"),
            FileSort::Playlist => return None,
            // 最後の「/」の後ろ（rtrim で「/」以外を消した長さが、最後の「/」の位置になる）。
            // 抽選した並びでは、出している名前（別名があれば別名）で並べる
            FileSort::Name if draw => format!("coalesce(pi.alias, {FILE_NAME}) COLLATE NOCASE {dir}"),
            FileSort::Name => format!("{FILE_NAME} COLLATE NOCASE {dir}"),
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
        let pattern = Value::Text(format!("%{}%", escape_like(text)));
        if filter.draw {
            // 抽選した並びでは、別名にも当てる
            sql.push_str(" AND (a.rel_path LIKE ? ESCAPE '\\' OR pi.alias LIKE ? ESCAPE '\\')");
            args.push(pattern.clone());
        } else {
            sql.push_str(" AND a.rel_path LIKE ? ESCAPE '\\'");
        }
        args.push(pattern);
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
    if filter.draw {
        crate::playlists::draw::ensure_table(conn)?;
    }
    // 抽選した並びでは、行の番号・通った項目・別名・抽選の印も引く
    let draw_columns = if filter.draw { "d.seq, d.path, d.top_item, pi.alias, d.drawn" } else { "a.id, NULL, NULL, NULL, 0" };
    let tables = source_tables(filter);
    let mut sql = format!(
        "SELECT a.id, a.rel_path, f.path, a.missing, a.uri,
                (SELECT group_concat(t.id || char(30) || t.name, char(31)) FROM file_tags ft
                   JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = a.id),
                a.hash, a.hash_error, a.source_id, a.license_id, {draw_columns}
         FROM {tables} JOIN library_folders f ON f.id = a.folder_id
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
        order.extend(filter.sort.key(filter.sort_desc, filter.draw));
    }
    order.push(if filter.sort == FileSort::Path && filter.sort_desc && !filter.recent_only {
        "f.path DESC, a.rel_path DESC".into()
    } else {
        FILE_ORDER.into()
    });
    // 同じファイルが2行出るときは、抽選した順
    if filter.draw {
        order.push("d.seq".into());
    }
    sql.push_str(&format!(" ORDER BY {}", order.join(", ")));

    // 抽選した並びの行の、来た項目とかけるエフェクトセットは、今の項目から引く
    let infos = if filter.draw { crate::playlists::draw::item_infos(conn)? } else { Default::default() };

    // ファイルに付いたタグは、タグの一覧と同じ順に並べる
    let rank = tag_rank(conn)?;
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        let rel_path: String = r.get(1)?;
        let folder_path: String = r.get(2)?;
        // 「id、区切り（char(30)）、名前」をタグの区切り（char(31)）でつないだもの
        let tags: Option<String> = r.get(5)?;
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
        let path: Vec<i64> = r.get::<_, Option<String>>(11)?.and_then(|p| serde_json::from_str(&p).ok()).unwrap_or_default();
        let top_item: Option<i64> = r.get(12)?;
        // 来た項目：直下の項目がタグの組み合わせかプレイリストのとき（ファイルの項目なら出さない）
        let origin = top_item.and_then(|id| {
            let info = infos.get(&id)?;
            (info.kind != ItemKind::File).then(|| RowOrigin {
                item_id: id,
                kind: info.kind,
                mode: info.mode,
                label: info.alias.clone().filter(|_| info.kind == ItemKind::Playlist).unwrap_or_else(|| info.label.clone()),
            })
        });
        Ok(AudioFile {
            id: r.get(0)?,
            path: Location::of_file(&folder_path, &rel_path, r.get(4)?).to_display(),
            rel_path,
            missing: r.get(3)?,
            tags,
            hash: r.get(6)?,
            hash_error: r.get(7)?,
            source_id: r.get(8)?,
            license_id: r.get(9)?,
            key: r.get(10)?,
            alias: r.get(13)?,
            origin,
            item_id: top_item,
            chains: crate::playlists::draw::chains_of(&path, &infos),
            drawn: r.get(14)?,
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
#[path = "files_tests.rs"]
mod tests;
