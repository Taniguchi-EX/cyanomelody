//! データのエクスポートとインポート（設定画面の「データ」）。
//! ライブラリ・タグ・プレイリストとエフェクト・出典とライセンスと設定を、選んだ項目だけ JSON のファイルに入出力する。
//! ファイルの中では、フォルダ・曲・タグなどにファイルの中だけの番号を振り、つながりはその番号で表す。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::db::now;
use crate::error::{Error, Result};
use crate::library::absolute_path;
use crate::settings;
use crate::tags::TagSettings;

const APP: &str = "cyanomelody";
/// ファイルの形式の版。形式を変えたら上げる（新しすぎるファイルは取り込まない）
const FORMAT_VERSION: u32 = 1;
const CHILD_SORTS: [&str; 4] = ["manual", "created", "files", "romaji"];

/// 入出力する項目
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Sections {
    /// ライブラリ（登録したフォルダ）
    pub library: bool,
    /// タグ（階層・並び順・色）と曲へのタグ付け
    pub tags: bool,
    /// プレイリストとエフェクトセット
    pub playlists: bool,
    /// 出典・ライセンスと曲への設定、新しく作るタグの既定値、画面の設定
    pub credits: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DataFile {
    pub app: String,
    pub format_version: u32,
    pub app_version: String,
    /// 書き出した日時（UNIX 時間の秒）
    pub exported_at: i64,
    pub sections: Sections,
    pub folders: Vec<XFolder>,
    pub files: Vec<XFile>,
    pub tags: Vec<XTag>,
    pub sources: Vec<XCredit>,
    pub licenses: Vec<XCredit>,
    pub effect_chains: Vec<XChain>,
    pub playlists: Vec<XPlaylist>,
    pub new_tag: Option<TagSettings>,
    /// 自動タグ付けで無視する値の一覧
    pub meta_ignore: Option<Vec<String>>,
    /// 自動タグ付けの区切り文字の一覧
    pub meta_separators: Option<Vec<String>>,
    /// 画面の設定（画面側が持つもの。key と値）
    pub screen: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct XFolder {
    pub id: i64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct XFile {
    pub id: i64,
    pub folder: i64,
    pub rel_path: String,
    pub size: i64,
    pub hash: Option<String>,
    /// 付いているタグ（タグを書き出したときだけ）
    pub tags: Vec<i64>,
    /// 出典・ライセンス（出典・ライセンスを書き出したときだけ）
    pub source: Option<i64>,
    pub license: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct XTag {
    pub id: i64,
    pub name: String,
    pub parent: Option<i64>,
    pub position: i64,
    pub child_sort: Option<String>,
    pub child_sort_desc: bool,
    pub bg_color: Option<String>,
    pub fg_color: Option<String>,
}

/// 出典・ライセンス（ライセンスだけが種類と条項を持つ）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct XCredit {
    pub id: i64,
    pub name: String,
    pub url: String,
    pub note: String,
    pub position: i64,
    pub license_type: Option<String>,
    pub commercial: Option<i64>,
    pub credit: Option<i64>,
    pub modify: Option<i64>,
    pub redistribute: Option<i64>,
    pub share_alike: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct XChain {
    pub id: i64,
    pub name: String,
    /// 中のエフェクト（effect_steps の JSON のまま）
    pub steps: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct XPlaylist {
    pub id: i64,
    pub name: String,
    pub position: i64,
    pub items: Vec<XItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct XItem {
    pub kind: String,
    pub file: Option<i64>,
    pub tags: Vec<i64>,
    pub playlist: Option<i64>,
    pub owned: bool,
    pub mode: String,
    pub alias: Option<String>,
    pub chain: Option<i64>,
}

// ---------------------------------------------------------------- エクスポート

/// 選んだ項目を書き出す。screen は画面の設定（出典・ライセンスと設定を選んだときだけ書き出す）
pub fn export(
    conn: &Connection,
    sections: Sections,
    app_version: &str,
    screen: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<DataFile> {
    let mut data = DataFile {
        app: APP.into(),
        format_version: FORMAT_VERSION,
        app_version: app_version.into(),
        exported_at: now(),
        sections,
        ..Default::default()
    };
    // プレイリスト
    let mut item_tags: HashSet<i64> = HashSet::new();
    let mut item_files: HashSet<i64> = HashSet::new();
    if sections.playlists {
        let tag_map = item_tag_map(conn)?;
        let mut items_of: HashMap<i64, Vec<XItem>> = HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT id, playlist_id, kind, file_id, ref_id, owned, mode, alias, effect_chain_id
             FROM playlist_items ORDER BY playlist_id, position, id",
        )?;
        let rows = stmt.query_map([], |r| {
            let id: i64 = r.get(0)?;
            Ok((
                r.get::<_, i64>(1)?,
                XItem {
                    kind: r.get(2)?,
                    file: r.get(3)?,
                    tags: tag_map.get(&id).cloned().unwrap_or_default(),
                    playlist: r.get(4)?,
                    owned: r.get(5)?,
                    mode: r.get(6)?,
                    alias: r.get(7)?,
                    chain: r.get(8)?,
                },
            ))
        })?;
        for row in rows {
            let (playlist, item) = row?;
            item_tags.extend(&item.tags);
            item_files.extend(item.file);
            items_of.entry(playlist).or_default().push(item);
        }
        data.playlists = conn
            .prepare("SELECT id, name, position FROM playlists ORDER BY position, id")?
            .query_map([], |r| {
                Ok(XPlaylist { id: r.get(0)?, name: r.get(1)?, position: r.get(2)?, items: vec![] })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for p in &mut data.playlists {
            p.items = items_of.remove(&p.id).unwrap_or_default();
        }
        data.effect_chains = conn
            .prepare("SELECT id, name FROM effect_chains ORDER BY name COLLATE NOCASE")?
            .query_map([], |r| Ok(XChain { id: r.get(0)?, name: r.get(1)?, steps: vec![] }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for c in &mut data.effect_chains {
            c.steps = conn
                .prepare("SELECT effect FROM effect_steps WHERE chain_id = ?1 ORDER BY position, id")?
                .query_map([c.id], |r| r.get::<_, String>(0))?
                .map(|s| Ok(serde_json::from_str(&s?).unwrap_or(serde_json::Value::Null)))
                .collect::<Result<Vec<_>>>()?;
        }
    }
    // タグ：タグを選んだときはすべて。プレイリストだけのときは、項目のタグの組み合わせに使うもの（とその先祖）
    if sections.tags || !item_tags.is_empty() {
        let all = conn
            .prepare(
                "SELECT id, name, parent_id, position, child_sort, child_sort_desc, bg_color, fg_color FROM tags ORDER BY id",
            )?
            .query_map([], |r| {
                Ok(XTag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent: r.get(2)?,
                    position: r.get(3)?,
                    child_sort: r.get(4)?,
                    child_sort_desc: r.get(5)?,
                    bg_color: r.get(6)?,
                    fg_color: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        data.tags = if sections.tags {
            all
        } else {
            let parents: HashMap<i64, Option<i64>> = all.iter().map(|t| (t.id, t.parent)).collect();
            let mut keep = HashSet::new();
            for &id in &item_tags {
                let mut cur = Some(id);
                while let Some(c) = cur {
                    if !keep.insert(c) {
                        break;
                    }
                    cur = parents.get(&c).copied().flatten();
                }
            }
            all.into_iter().filter(|t| keep.contains(&t.id)).collect()
        };
    }
    // 出典・ライセンスと設定
    if sections.credits {
        data.sources = read_credits(conn, "sources")?;
        data.licenses = read_credits(conn, "licenses")?;
        data.new_tag = Some(settings::get(conn, settings::NEW_TAG)?);
        data.meta_ignore = Some(crate::autotag::ignore_values(conn)?);
        data.meta_separators = Some(crate::autotag::separators(conn)?);
        data.screen = screen;
    }
    // 曲：ライブラリを選んだときはすべて。ほかは、書き出す項目に関係する曲
    let file_tags = if sections.tags { file_tag_map(conn)? } else { HashMap::new() };
    let mut stmt = conn.prepare(
        "SELECT id, folder_id, rel_path, size, hash, source_id, license_id FROM audio_files ORDER BY folder_id, rel_path",
    )?;
    let files = stmt.query_map([], |r| {
        let id: i64 = r.get(0)?;
        Ok(XFile {
            id,
            folder: r.get(1)?,
            rel_path: r.get(2)?,
            size: r.get(3)?,
            hash: r.get(4)?,
            tags: file_tags.get(&id).cloned().unwrap_or_default(),
            source: if sections.credits { r.get(5)? } else { None },
            license: if sections.credits { r.get(6)? } else { None },
        })
    })?;
    for f in files {
        let f = f?;
        let wanted = sections.library
            || !f.tags.is_empty()
            || f.source.is_some()
            || f.license.is_some()
            || item_files.contains(&f.id);
        if wanted {
            data.files.push(f);
        }
    }
    // フォルダ：ライブラリを選んだときはすべて。ほかは、書き出す曲のフォルダ（曲をパスで見分けるため）
    let used: HashSet<i64> = data.files.iter().map(|f| f.folder).collect();
    data.folders = conn
        .prepare("SELECT id, path FROM library_folders ORDER BY id")?
        .query_map([], |r| Ok(XFolder { id: r.get(0)?, path: r.get(1)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|f| sections.library || used.contains(&f.id))
        .collect();
    Ok(data)
}

fn item_tag_map(conn: &Connection) -> Result<HashMap<i64, Vec<i64>>> {
    let mut map: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in conn
        .prepare("SELECT item_id, tag_id FROM playlist_item_tags ORDER BY item_id, tag_id")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
    {
        let (item, tag) = row?;
        map.entry(item).or_default().push(tag);
    }
    Ok(map)
}

fn file_tag_map(conn: &Connection) -> Result<HashMap<i64, Vec<i64>>> {
    let mut map: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in conn
        .prepare("SELECT file_id, tag_id FROM file_tags ORDER BY file_id, tag_id")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
    {
        let (file, tag) = row?;
        map.entry(file).or_default().push(tag);
    }
    Ok(map)
}

fn read_credits(conn: &Connection, table: &str) -> Result<Vec<XCredit>> {
    let license = table == "licenses";
    let cols = if license {
        "id, name, url, note, position, license_type, commercial, credit, modify, redistribute, share_alike"
    } else {
        "id, name, url, note, position"
    };
    Ok(conn
        .prepare(&format!("SELECT {cols} FROM {table} ORDER BY position, id"))?
        .query_map([], |r| {
            let mut c = XCredit {
                id: r.get(0)?,
                name: r.get(1)?,
                url: r.get(2)?,
                note: r.get(3)?,
                position: r.get(4)?,
                ..Default::default()
            };
            if license {
                c.license_type = r.get(5)?;
                c.commercial = r.get(6)?;
                c.credit = r.get(7)?;
                c.modify = r.get(8)?;
                c.redistribute = r.get(9)?;
                c.share_alike = r.get(10)?;
            }
            Ok(c)
        })?
        .collect::<rusqlite::Result<_>>()?)
}

// ---------------------------------------------------------------- ファイルの読み込みと曲の見分け方

/// ファイルの中身を読み、このアプリのものか、形式の版が読めるものかを確かめる
pub fn parse(text: &str) -> Result<DataFile> {
    let data: DataFile = serde_json::from_str(text)
        .map_err(|e| Error::invalid(format!("ファイルを読めませんでした（cyanomelody のデータの形式ではありません）: {e}")))?;
    if data.app != APP {
        return Err(Error::invalid("cyanomelody のデータのファイルではありません"));
    }
    if data.format_version > FORMAT_VERSION {
        return Err(Error::invalid(
            "新しい版の cyanomelody で書き出したファイルです。アプリを新しい版にしてから取り込んでください",
        ));
    }
    Ok(data)
}

/// 曲をどうやって見つけたか
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchBy {
    Path,
    Hash,
    NameSize,
}

struct LocalFile {
    id: i64,
    /// 比べるための絶対パス（小文字、区切りは /）
    key: String,
    name: String,
    size: i64,
    hash: Option<String>,
    missing: bool,
}

fn path_key(folder: &str, rel_path: &str) -> String {
    absolute_path(folder, rel_path).to_string_lossy().replace('\\', "/").to_lowercase()
}

fn base_name(rel_path: &str) -> String {
    rel_path.rsplit('/').next().unwrap_or(rel_path).to_lowercase()
}

/// ファイルの中の曲を、このPCのライブラリの曲に対応させる。パス → ハッシュ値 → 名前と大きさ（1つに決まるときだけ）の順に試す
fn match_files(conn: &Connection, data: &DataFile) -> Result<HashMap<i64, (i64, MatchBy)>> {
    let locals: Vec<LocalFile> = conn
        .prepare(
            "SELECT a.id, f.path, a.rel_path, a.size, a.hash, a.missing FROM audio_files a
             JOIN library_folders f ON f.id = a.folder_id",
        )?
        .query_map([], |r| {
            let folder: String = r.get(1)?;
            let rel: String = r.get(2)?;
            Ok(LocalFile {
                id: r.get(0)?,
                key: path_key(&folder, &rel),
                name: base_name(&rel),
                size: r.get(3)?,
                hash: r.get(4)?,
                missing: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let by_path: HashMap<&str, &LocalFile> = locals.iter().map(|l| (l.key.as_str(), l)).collect();
    let mut by_hash: HashMap<&str, Vec<&LocalFile>> = HashMap::new();
    let mut by_name: HashMap<(&str, i64), Vec<&LocalFile>> = HashMap::new();
    for l in &locals {
        if let Some(h) = &l.hash {
            by_hash.entry(h).or_default().push(l);
        }
        by_name.entry((l.name.as_str(), l.size)).or_default().push(l);
    }
    let folders: HashMap<i64, &str> = data.folders.iter().map(|f| (f.id, f.path.as_str())).collect();
    let mut result = HashMap::new();
    for f in &data.files {
        let name = base_name(&f.rel_path);
        let key = folders.get(&f.folder).map(|folder| path_key(folder, &f.rel_path));
        let found = if let Some(l) = key.as_deref().and_then(|k| by_path.get(k)) {
            Some((l.id, MatchBy::Path))
        } else if let Some(list) = f.hash.as_deref().and_then(|h| by_hash.get(h)) {
            // 同じ音声が複数あれば、見つからない印のないもの、同じファイル名のものを選ぶ
            let best = list.iter().min_by_key(|l| (l.missing, l.name != name, l.id)).unwrap();
            Some((best.id, MatchBy::Hash))
        } else {
            match by_name.get(&(name.as_str(), f.size)).map(Vec::as_slice) {
                Some([only]) => Some((only.id, MatchBy::NameSize)),
                _ => None,
            }
        };
        if let Some(m) = found {
            result.insert(f.id, m);
        }
    }
    Ok(result)
}

/// インポートの見込み（取り込む前に画面に出す）
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub sections: Sections,
    pub app_version: String,
    pub exported_at: i64,
    pub folders: usize,
    /// このPCにあるフォルダの数
    pub folders_found: usize,
    pub files: usize,
    pub tags: usize,
    pub playlists: usize,
    pub effect_chains: usize,
    pub sources: usize,
    pub licenses: usize,
    /// 今のライブラリで見つかる曲（パス・ハッシュ値・名前と大きさ）
    pub matched_by_path: usize,
    pub matched_by_hash: usize,
    pub matched_by_name: usize,
    /// ハッシュ値をまだ計算していない、このPCの曲の数
    pub pending_hashes: i64,
    /// 「置き換える」で消える、今のデータの数
    pub current: CurrentCounts,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentCounts {
    /// ファイルにない、登録済みのフォルダ
    pub folders_not_in_file: usize,
    pub tags: i64,
    pub playlists: i64,
    pub effect_chains: i64,
    pub sources: i64,
    pub licenses: i64,
}

fn count(conn: &Connection, table: &str) -> Result<i64> {
    Ok(conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
}

fn folders_not_in_file(conn: &Connection, data: &DataFile) -> Result<Vec<i64>> {
    let keep: HashSet<String> = data.folders.iter().map(|f| path_key(&f.path, "")).collect();
    Ok(conn
        .prepare("SELECT id, path FROM library_folders")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, p)| !keep.contains(&path_key(p, "")))
        .map(|(id, _)| id)
        .collect())
}

pub fn preview(conn: &Connection, data: &DataFile) -> Result<ImportPreview> {
    let matched = match_files(conn, data)?;
    let by = |m: MatchBy| matched.values().filter(|(_, b)| *b == m).count();
    Ok(ImportPreview {
        sections: data.sections,
        app_version: data.app_version.clone(),
        exported_at: data.exported_at,
        folders: data.folders.len(),
        folders_found: data.folders.iter().filter(|f| Path::new(&f.path).is_dir()).count(),
        files: data.files.len(),
        tags: data.tags.len(),
        playlists: data.playlists.len(),
        effect_chains: data.effect_chains.len(),
        sources: data.sources.len(),
        licenses: data.licenses.len(),
        matched_by_path: by(MatchBy::Path),
        matched_by_hash: by(MatchBy::Hash),
        matched_by_name: by(MatchBy::NameSize),
        pending_hashes: conn.query_row(
            "SELECT count(*) FROM audio_files WHERE hash IS NULL AND hash_error IS NULL AND missing = 0",
            [],
            |r| r.get(0),
        )?,
        current: CurrentCounts {
            folders_not_in_file: folders_not_in_file(conn, data)?.len(),
            tags: count(conn, "tags")?,
            playlists: count(conn, "playlists")?,
            effect_chains: count(conn, "effect_chains")?,
            sources: count(conn, "sources")?,
            licenses: count(conn, "licenses")?,
        },
    })
}

// ---------------------------------------------------------------- インポート

/// インポートの結果
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// 登録したフォルダ（スキャンは呼び出し側で行う）
    pub folders_added: Vec<i64>,
    /// このPCになかったので登録しなかったフォルダの数
    pub folders_skipped: usize,
    pub folders_removed: usize,
    pub files_matched: usize,
    pub files_unmatched: usize,
    pub tags_added: usize,
    pub file_tags_added: usize,
    pub sources_added: usize,
    pub licenses_added: usize,
    pub credits_set: usize,
    pub effect_chains_added: usize,
    pub playlists_added: usize,
    /// 曲が見つからないなどで、取り込まなかったプレイリストの項目
    pub items_skipped: usize,
    /// 取り込んだ画面の設定（画面側で反映する）
    pub screen: Option<serde_json::Map<String, serde_json::Value>>,
}

/// ライブラリのフォルダを取り込む（スキャンが要るので、ほかの項目より前に、トランザクションの外で行う）。
/// 登録したフォルダの id を返す（スキャンは呼び出し側で行う）
pub fn import_folders(conn: &Connection, data: &DataFile, replace: bool, result: &mut ImportResult) -> Result<()> {
    if replace {
        for id in folders_not_in_file(conn, data)? {
            crate::library::remove_folder(conn, id)?;
            result.folders_removed += 1;
        }
    }
    let registered: HashSet<String> = conn
        .prepare("SELECT path FROM library_folders")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .map(|p| path_key(p, ""))
        .collect();
    for f in &data.folders {
        if registered.contains(&path_key(&f.path, "")) {
            continue;
        }
        if !Path::new(&f.path).is_dir() {
            result.folders_skipped += 1;
            continue;
        }
        // 登録済みのフォルダの中・外にあるなどで登録できないものは、飛ばす
        match crate::library::add_folder(conn, Path::new(&f.path)) {
            Ok(id) => result.folders_added.push(id),
            Err(_) => result.folders_skipped += 1,
        }
    }
    Ok(())
}

/// ライブラリ以外の項目を、1つのトランザクションで取り込む。replace なら、選んだ項目の今のデータを消してから取り込む
pub fn import_data(conn: &mut Connection, data: &DataFile, sections: Sections, replace: bool, result: &mut ImportResult) -> Result<()> {
    let matched = match_files(conn, data)?;
    result.files_matched = matched.len();
    result.files_unmatched = data.files.len() - matched.len();
    let file_of = |id: i64| matched.get(&id).map(|(local, _)| *local);
    let tx = conn.transaction()?;
    if replace {
        if sections.tags {
            tx.execute("DELETE FROM tags", [])?;
        }
        if sections.playlists {
            tx.execute("DELETE FROM playlists", [])?;
            tx.execute("DELETE FROM effect_chains", [])?;
        }
        if sections.credits {
            tx.execute("DELETE FROM sources", [])?;
            tx.execute("DELETE FROM licenses", [])?;
        }
    }
    // タグ（プレイリストだけを取り込むときも、項目のタグの組み合わせに使うタグは名前で対応させる）
    let tag_map = if sections.tags || sections.playlists {
        import_tags(&tx, &data.tags, result)?
    } else {
        HashMap::new()
    };
    if sections.tags {
        let mut stmt = tx.prepare("INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?1, ?2)")?;
        for f in &data.files {
            let Some(local) = file_of(f.id) else { continue };
            for t in &f.tags {
                if let Some(&tag) = tag_map.get(t) {
                    result.file_tags_added += stmt.execute(params![local, tag])?;
                }
            }
        }
    }
    if sections.credits {
        let sources = import_credits(&tx, "sources", &data.sources, &mut result.sources_added)?;
        let licenses = import_credits(&tx, "licenses", &data.licenses, &mut result.licenses_added)?;
        // 足すときは、曲にまだ設定がないときだけ設定する
        let only_empty = if replace { "" } else { " AND {col} IS NULL" };
        for (col, map, pick) in [
            ("source_id", &sources, (|f: &XFile| f.source) as fn(&XFile) -> Option<i64>),
            ("license_id", &licenses, |f: &XFile| f.license),
        ] {
            let sql = format!("UPDATE audio_files SET {col} = ?2 WHERE id = ?1{}", only_empty.replace("{col}", col));
            let mut stmt = tx.prepare(&sql)?;
            for f in &data.files {
                let (Some(local), Some(id)) = (file_of(f.id), pick(f).and_then(|c| map.get(&c))) else { continue };
                result.credits_set += stmt.execute(params![local, id])?;
            }
        }
        // 空の値・重なる値は除いて保存する
        let clean = |values: &[String]| -> Vec<String> {
            let mut seen = HashSet::new();
            values.iter().map(|v| v.trim().to_string()).filter(|v| !v.is_empty() && seen.insert(v.to_lowercase())).collect()
        };
        if let Some(values) = &data.meta_ignore {
            crate::autotag::set_ignore_values(&tx, &clean(values))?;
        }
        if let Some(values) = &data.meta_separators {
            crate::autotag::set_separators(&tx, &clean(values))?;
        }
        if let Some(new_tag) = &data.new_tag {
            settings::set(&tx, settings::NEW_TAG, &sanitize_settings(new_tag))?;
        }
        result.screen = data.screen.clone();
    }
    if sections.playlists {
        let chains = import_chains(&tx, &data.effect_chains, &mut result.effect_chains_added)?;
        import_playlists(&tx, data, &file_of, &tag_map, &chains, result)?;
    }
    tx.commit()?;
    Ok(())
}

/// 同じ名前がなければその名前、あれば「名前(2)」「名前(3)」…
fn free_name(tx: &Transaction, table: &str, name: &str) -> Result<String> {
    let taken = |n: &str| -> Result<bool> {
        Ok(tx
            .query_row(&format!("SELECT 1 FROM {table} WHERE name = ?1 COLLATE NOCASE"), [n], |_| Ok(()))
            .optional()?
            .is_some())
    };
    if !taken(name)? {
        return Ok(name.to_string());
    }
    let mut i = 2;
    loop {
        let candidate = format!("{name}({i})");
        if !taken(&candidate)? {
            return Ok(candidate);
        }
        i += 1;
    }
}

fn find_id(tx: &Transaction, table: &str, name: &str) -> Result<Option<i64>> {
    Ok(tx
        .query_row(&format!("SELECT id FROM {table} WHERE name = ?1 COLLATE NOCASE"), [name.trim()], |r| r.get(0))
        .optional()?)
}

fn valid_color(c: &Option<String>) -> Option<String> {
    c.as_ref()
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn sanitize_settings(s: &TagSettings) -> TagSettings {
    TagSettings { bg_color: valid_color(&s.bg_color), fg_color: valid_color(&s.fg_color), ..s.clone() }
}

/// タグを取り込み、ファイルの中の番号 → このPCのタグの id を返す。同じ名前のタグは今のものを使う（変えない）。
/// ない名前のタグは、親の後に作る（親が今あるタグなら、その下に入れる）
fn import_tags(tx: &Transaction, tags: &[XTag], result: &mut ImportResult) -> Result<HashMap<i64, i64>> {
    let mut map: HashMap<i64, i64> = HashMap::new();
    let ids: HashSet<i64> = tags.iter().map(|t| t.id).collect();
    // 兄弟の順に並べ、親を子より先に作る（親が見つからない・輪になっているものは最上位にする）
    let mut ordered: Vec<&XTag> = tags.iter().collect();
    ordered.sort_by_key(|t| (t.position, t.id));
    let mut pending: Vec<&XTag> = ordered;
    while !pending.is_empty() {
        let before = pending.len();
        let mut rest = vec![];
        for t in pending {
            let parent = t.parent.filter(|p| ids.contains(p) && *p != t.id);
            if parent.is_some_and(|p| !map.contains_key(&p)) {
                rest.push(t);
                continue;
            }
            let name = t.name.trim();
            if name.is_empty() {
                continue;
            }
            if let Some(id) = find_id(tx, "tags", name)? {
                map.insert(t.id, id);
                continue;
            }
            let local_parent = parent.and_then(|p| map.get(&p).copied());
            let sort = t.child_sort.clone().filter(|s| CHILD_SORTS.contains(&s.as_str()));
            tx.execute(
                "INSERT INTO tags (name, created_at, parent_id, position, child_sort, child_sort_desc, bg_color, fg_color)
                 VALUES (?1, ?2, ?3, (SELECT coalesce(max(position) + 1, 0) FROM tags WHERE parent_id IS ?3), ?4, ?5, ?6, ?7)",
                params![name, now(), local_parent, sort, t.child_sort_desc, valid_color(&t.bg_color), valid_color(&t.fg_color)],
            )?;
            map.insert(t.id, tx.last_insert_rowid());
            result.tags_added += 1;
        }
        if rest.len() == before {
            // 親が作れない（輪になっている）ものは、親なしで作る
            for t in &rest {
                let mut lone = (*t).clone();
                lone.parent = None;
                let m = import_tags(tx, std::slice::from_ref(&lone), result)?;
                map.extend(m);
            }
            break;
        }
        pending = rest;
    }
    Ok(map)
}

/// 出典・ライセンスを取り込み、ファイルの中の番号 → このPCの id を返す。同じ名前のものは今のものを使う（変えない）
fn import_credits(tx: &Transaction, table: &str, credits: &[XCredit], added: &mut usize) -> Result<HashMap<i64, i64>> {
    let mut map = HashMap::new();
    let mut ordered: Vec<&XCredit> = credits.iter().collect();
    ordered.sort_by_key(|c| (c.position, c.id));
    for c in ordered {
        let name = c.name.trim();
        if name.is_empty() {
            continue;
        }
        if let Some(id) = find_id(tx, table, name)? {
            map.insert(c.id, id);
            continue;
        }
        let position = format!("(SELECT coalesce(max(position) + 1, 0) FROM {table})");
        if table == "licenses" {
            tx.execute(
                &format!(
                    "INSERT INTO licenses (name, url, note, license_type, commercial, credit, modify, redistribute, share_alike, created_at, position)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, {position})"
                ),
                params![name, c.url, c.note, c.license_type, c.commercial, c.credit, c.modify, c.redistribute, c.share_alike, now()],
            )?;
        } else {
            tx.execute(
                &format!("INSERT INTO sources (name, url, note, created_at, position) VALUES (?1, ?2, ?3, ?4, {position})"),
                params![name, c.url, c.note, now()],
            )?;
        }
        map.insert(c.id, tx.last_insert_rowid());
        *added += 1;
    }
    Ok(map)
}

/// エフェクトセットを取り込む。同じ名前で中身も同じなら今のものを使い、違えば「名前(2)」で作る
fn import_chains(tx: &Transaction, chains: &[XChain], added: &mut usize) -> Result<HashMap<i64, i64>> {
    let mut map = HashMap::new();
    for c in chains {
        let name = c.name.trim();
        if name.is_empty() {
            continue;
        }
        let steps: Vec<String> = c.steps.iter().map(|s| s.to_string()).collect();
        if let Some(id) = find_id(tx, "effect_chains", name)? {
            let current: Vec<serde_json::Value> = tx
                .prepare("SELECT effect FROM effect_steps WHERE chain_id = ?1 ORDER BY position, id")?
                .query_map([id], |r| r.get::<_, String>(0))?
                .map(|s| Ok(serde_json::from_str(&s?).unwrap_or(serde_json::Value::Null)))
                .collect::<Result<_>>()?;
            if current == c.steps {
                map.insert(c.id, id);
                continue;
            }
        }
        let name = free_name(tx, "effect_chains", name)?;
        tx.execute("INSERT INTO effect_chains (name, created_at) VALUES (?1, ?2)", params![name, now()])?;
        let id = tx.last_insert_rowid();
        for (i, s) in steps.iter().enumerate() {
            tx.execute("INSERT INTO effect_steps (chain_id, position, effect) VALUES (?1, ?2, ?3)", params![id, i as i64, s])?;
        }
        map.insert(c.id, id);
        *added += 1;
    }
    Ok(map)
}

/// プレイリストを取り込む。同じ名前があれば「名前(2)」で作る（今のプレイリストは変えない）
fn import_playlists(
    tx: &Transaction,
    data: &DataFile,
    file_of: &dyn Fn(i64) -> Option<i64>,
    tags: &HashMap<i64, i64>,
    chains: &HashMap<i64, i64>,
    result: &mut ImportResult,
) -> Result<()> {
    let mut map = HashMap::new();
    let mut ordered: Vec<&XPlaylist> = data.playlists.iter().collect();
    ordered.sort_by_key(|p| (p.position, p.id));
    for p in &ordered {
        let name = p.name.trim();
        if name.is_empty() {
            continue;
        }
        let name = free_name(tx, "playlists", name)?;
        tx.execute(
            "INSERT INTO playlists (name, position, created_at) VALUES (?1, (SELECT coalesce(max(position) + 1, 0) FROM playlists), ?2)",
            params![name, now()],
        )?;
        map.insert(p.id, tx.last_insert_rowid());
        result.playlists_added += 1;
    }
    let mut owned_once = HashSet::new();
    for p in ordered {
        let Some(&playlist) = map.get(&p.id) else { continue };
        let mut position = 0i64;
        for item in &p.items {
            let mode = if ["order", "shuffle", "random"].contains(&item.mode.as_str()) { item.mode.as_str() } else { "order" };
            let (file, ref_id, owned) = match item.kind.as_str() {
                "file" => match item.file.and_then(file_of) {
                    Some(f) => (Some(f), None, false),
                    None => {
                        result.items_skipped += 1;
                        continue;
                    }
                },
                "playlist" => match item.playlist.and_then(|r| map.get(&r).copied()) {
                    // 1つのプレイリストを子にできるのは1か所だけ
                    Some(r) => (None, Some(r), item.owned && owned_once.insert(r)),
                    None => {
                        result.items_skipped += 1;
                        continue;
                    }
                },
                "tags" => (None, None, false),
                _ => {
                    result.items_skipped += 1;
                    continue;
                }
            };
            let tag_ids: Vec<i64> = item.tags.iter().filter_map(|t| tags.get(t).copied()).collect();
            if item.kind == "tags" && tag_ids.is_empty() {
                result.items_skipped += 1;
                continue;
            }
            tx.execute(
                "INSERT INTO playlist_items (playlist_id, position, kind, file_id, ref_id, owned, mode, alias, effect_chain_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    playlist,
                    position,
                    item.kind,
                    file,
                    ref_id,
                    owned,
                    mode,
                    item.alias.as_deref().map(str::trim).filter(|a| !a.is_empty()),
                    item.chain.and_then(|c| chains.get(&c).copied())
                ],
            )?;
            let item_id = tx.last_insert_rowid();
            for t in tag_ids {
                tx.execute("INSERT OR IGNORE INTO playlist_item_tags (item_id, tag_id) VALUES (?1, ?2)", params![item_id, t])?;
            }
            position += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
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
}
