//! 再生順の展開。プレイリストの項目をたどって、再生するファイルの並び・書き出す内容の木・再生したときのファイル数を決める
//! （詳しくは docs の「再生の順番の決め方」）

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params_from_iter, Connection};

use super::{ensure_exists, not_found, ItemKind, PlayEntry, PlayMode};
use crate::db::ids_json;
use crate::error::{Error, Result};
use crate::files::{filter_conditions, FileFilter, FILE_ORDER};
use crate::library::absolute_path;

/// 項目の行（展開や表示に使う）
#[derive(Clone)]
pub(super) struct ItemRow {
    pub(super) id: i64,
    pub(super) kind: ItemKind,
    pub(super) mode: PlayMode,
    pub(super) owned: bool,
    pub(super) file_id: Option<i64>,
    pub(super) ref_id: Option<i64>,
    pub(super) alias: Option<String>,
    pub(super) effect_chain_id: Option<i64>,
}

/// 再生順の1曲（展開の途中）。別名は、ファイルの項目から来た曲だけが持つ
#[derive(Clone)]
struct Track {
    file_id: i64,
    alias: Option<String>,
    /// かけるエフェクトセット（内側から外側の順）
    chains: Vec<i64>,
    /// この曲を出した項目。外側の項目を展開するたびに書き換わり、最後はいちばん外側の項目になる
    item: Option<i64>,
}

impl Track {
    fn plain(file_id: i64) -> Track {
        Track { file_id, alias: None, chains: Vec::new(), item: None }
    }

    /// この曲を出した項目を、外側の項目に書き換える
    fn from_item(mut self, item_id: i64) -> Track {
        self.item = Some(item_id);
        self
    }

    /// 外側の項目のエフェクトセットを、最後に足す
    fn with_chain(mut self, chain: Option<i64>) -> Track {
        self.chains.extend(chain);
        self
    }
}

/// 展開や表示に使うデータを、まとめて読んだもの。項目ごとに問い合わせると、項目の多いプレイリストで遅くなるため
pub(super) struct Catalog<'a> {
    conn: &'a Connection,
    /// プレイリストごとの項目（順番どおり）
    pub(super) items: HashMap<i64, Vec<ItemRow>>,
    /// タグの組み合わせの項目ごとのタグ
    pub(super) item_tags: HashMap<i64, Vec<i64>>,
    /// ファイルの項目が指すファイルの、相対パスと見つからない印
    pub(super) files: HashMap<i64, (String, bool)>,
    /// プレイリストの名前
    pub(super) names: HashMap<i64, String>,
    /// タグの組み合わせごとの対象のファイル（同じ組み合わせを何度も問い合わせない）
    tag_files: HashMap<Vec<i64>, Vec<i64>>,
}

impl<'a> Catalog<'a> {
    pub(super) fn load(conn: &'a Connection) -> Result<Catalog<'a>> {
        let mut items: HashMap<i64, Vec<ItemRow>> = HashMap::new();
        for row in conn
            .prepare(
                "SELECT playlist_id, id, kind, mode, owned, file_id, ref_id, alias, effect_chain_id FROM playlist_items
                 ORDER BY playlist_id, position, id",
            )?
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    ItemRow {
                        id: r.get(1)?,
                        kind: r.get(2)?,
                        mode: r.get(3)?,
                        owned: r.get(4)?,
                        file_id: r.get(5)?,
                        ref_id: r.get(6)?,
                        alias: r.get(7)?,
                        effect_chain_id: r.get(8)?,
                    },
                ))
            })?
        {
            let (playlist, item) = row?;
            items.entry(playlist).or_default().push(item);
        }
        let mut item_tags: HashMap<i64, Vec<i64>> = HashMap::new();
        for row in conn
            .prepare("SELECT item_id, tag_id FROM playlist_item_tags")?
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        {
            let (item, tag) = row?;
            item_tags.entry(item).or_default().push(tag);
        }
        let files = conn
            .prepare(
                "SELECT a.id, a.rel_path, a.missing FROM audio_files a
                 WHERE a.id IN (SELECT file_id FROM playlist_items WHERE file_id IS NOT NULL)",
            )?
            .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
            .collect::<rusqlite::Result<_>>()?;
        let names = conn
            .prepare("SELECT id, name FROM playlists")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Catalog { conn, items, item_tags, files, names, tag_files: HashMap::new() })
    }

    /// プレイリストの項目（順番どおり）
    pub(super) fn items(&self, playlist_id: i64) -> Vec<ItemRow> {
        self.items.get(&playlist_id).cloned().unwrap_or_default()
    }

    /// 項目と、それが入っているプレイリスト
    fn find_item(&self, item_id: i64) -> Result<(i64, ItemRow)> {
        self.items
            .iter()
            .find_map(|(p, items)| items.iter().find(|i| i.id == item_id).map(|i| (*p, i.clone())))
            .ok_or_else(|| Error::invalid("項目が見つかりません"))
    }

    /// 見つかっているファイルか（ライブラリにないファイルも false）
    fn file_ok(&self, file_id: Option<i64>) -> bool {
        file_id.and_then(|f| self.files.get(&f)).is_some_and(|(_, missing)| !missing)
    }

    /// タグの組み合わせに当てはまる、見つかっているファイル（ファイルの一覧と同じ順）
    fn files_for_tags(&mut self, item_id: i64) -> Result<Vec<i64>> {
        let mut tags = self.item_tags.get(&item_id).cloned().unwrap_or_default();
        if tags.is_empty() {
            return Ok(Vec::new());
        }
        tags.sort_unstable();
        if let Some(files) = self.tag_files.get(&tags) {
            return Ok(files.clone());
        }
        let filter = FileFilter { tag_ids: tags.clone(), ..Default::default() };
        let (conditions, args) = filter_conditions(self.conn, &filter)?;
        let files: Vec<i64> = self
            .conn
            .prepare(&format!(
                "SELECT a.id FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
                 WHERE a.missing = 0{conditions} ORDER BY {FILE_ORDER}"
            ))?
            .query_map(params_from_iter(args), |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        self.tag_files.insert(tags, files.clone());
        Ok(files)
    }
}

/// 再生順を決めるときの乱数（xorshift）。テストでは種を決めて同じ結果にする
pub(super) struct Rng(pub(super) u64);

impl Rng {
    fn from_time() -> Rng {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Rng(nanos | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn apply_mode<T>(mut files: Vec<T>, mode: PlayMode, rng: &mut Rng) -> Vec<T> {
    match mode {
        PlayMode::Order => files,
        PlayMode::Shuffle => {
            for i in (1..files.len()).rev() {
                files.swap(i, rng.below(i + 1));
            }
            files
        }
        PlayMode::Random if files.is_empty() => files,
        PlayMode::Random => {
            let i = rng.below(files.len());
            vec![files.swap_remove(i)]
        }
    }
}

/// プレイリストの項目を展開して、再生するファイルの並びにする（プレイリスト自体の再生方法は当てはめない）
fn expand_items(cat: &mut Catalog, playlist_id: i64, rng: &mut Rng, path: &mut Vec<i64>) -> Result<Vec<Track>> {
    // ループは保存できないが、念のため同じプレイリストを二重にたどらない
    if path.contains(&playlist_id) {
        return Ok(Vec::new());
    }
    path.push(playlist_id);
    let mut out = Vec::new();
    for item in cat.items(playlist_id) {
        out.extend(expand_item(cat, &item, rng, path)?.into_iter().map(|t| t.from_item(item.id)));
    }
    path.pop();
    Ok(out)
}

/// 項目に入る曲を、再生方法にかかわらずすべて、順に再生したときの並びで返す（右の欄の曲のリスト）
fn expand_item_all(cat: &mut Catalog, item: &ItemRow, path: &mut Vec<i64>) -> Result<Vec<Track>> {
    Ok(match item.kind {
        ItemKind::File => match (cat.file_ok(item.file_id), item.file_id) {
            (true, Some(file_id)) => vec![Track::plain(file_id)],
            _ => Vec::new(),
        },
        ItemKind::Tags => cat.files_for_tags(item.id)?.into_iter().map(Track::plain).collect(),
        ItemKind::Playlist => match item.ref_id {
            // ループは保存できないが、念のため同じプレイリストを二重にたどらない
            Some(r) if !path.contains(&r) => {
                path.push(r);
                let mut out = Vec::new();
                for inner in cat.items(r) {
                    out.extend(expand_item_all(cat, &inner, path)?);
                }
                path.pop();
                out
            }
            _ => Vec::new(),
        },
    })
}

/// 項目に入る曲をすべて（再生方法にかかわらず、順に再生したときの並び）。タグの組み合わせ・プレイリストの項目を押したときの右の欄に出す
pub fn item_files(conn: &Connection, item_id: i64) -> Result<Vec<PlayEntry>> {
    let mut cat = Catalog::load(conn)?;
    let (playlist_id, item) = cat.find_item(item_id)?;
    let tracks = expand_item_all(&mut cat, &item, &mut vec![playlist_id])?;
    to_entries(conn, tracks)
}

/// 項目1つを展開する（項目の再生方法とエフェクトを当てはめる）
fn expand_item(cat: &mut Catalog, item: &ItemRow, rng: &mut Rng, path: &mut Vec<i64>) -> Result<Vec<Track>> {
    Ok(match item.kind {
        ItemKind::File => match (cat.file_ok(item.file_id), item.file_id) {
            (true, Some(file_id)) => {
                vec![Track { file_id, alias: item.alias.clone(), chains: Vec::from_iter(item.effect_chain_id), item: None }]
            }
            _ => Vec::new(),
        },
        ItemKind::Tags => {
            let tracks =
                cat.files_for_tags(item.id)?.into_iter().map(|f| Track::plain(f).with_chain(item.effect_chain_id)).collect();
            apply_mode(tracks, item.mode, rng)
        }
        ItemKind::Playlist => match item.ref_id {
            Some(r) => {
                let tracks: Vec<Track> =
                    expand_items(cat, r, rng, path)?.into_iter().map(|t| t.with_chain(item.effect_chain_id)).collect();
                apply_mode(tracks, item.mode, rng)
            }
            None => Vec::new(),
        },
    })
}

/// 書き出す内容の木（「プレイリストの出力」で使う）
#[derive(Debug, Clone, PartialEq)]
pub enum ExportNode {
    /// 書き出すファイル。名前は、別名があれば別名、なければファイル名から決める
    File { file_id: i64, alias: Option<String>, chains: Vec<i64> },
    /// プレイリストの項目のフォルダ。名前は、別名があれば別名、なければプレイリスト名
    Folder { name: String, children: Vec<ExportNode> },
}

impl ExportNode {
    fn from_track(t: Track) -> ExportNode {
        ExportNode::File { file_id: t.file_id, alias: t.alias, chains: t.chains }
    }

    /// 中のファイルすべてに、外側の項目のエフェクトセットを足す
    fn with_chain(self, chain: Option<i64>) -> ExportNode {
        match self {
            ExportNode::File { file_id, alias, mut chains } => {
                chains.extend(chain);
                ExportNode::File { file_id, alias, chains }
            }
            ExportNode::Folder { name, children } => {
                ExportNode::Folder { name, children: children.into_iter().map(|c| c.with_chain(chain)).collect() }
            }
        }
    }
}

/// 書き出す内容を決める。項目の展開・再生方法・別名・エフェクトは再生と同じ決まりで、プレイリストの項目はフォルダにする。
/// 「順に再生」のプレイリストの項目は、中の階層をそのままフォルダにする。シャッフル・ランダムセレクトの項目は、
/// 並べ替えや選び方が中の階層をまたぐので、展開した曲をそのフォルダに並べる
fn plan_items(cat: &mut Catalog, playlist_id: i64, rng: &mut Rng, path: &mut Vec<i64>) -> Result<Vec<ExportNode>> {
    if path.contains(&playlist_id) {
        return Ok(Vec::new());
    }
    path.push(playlist_id);
    let mut out = Vec::new();
    for item in cat.items(playlist_id) {
        match item.kind {
            ItemKind::File => {
                // 見つからないファイルも入れておき、書き出すときに「書き出せなかった」に数える
                if let Some(file_id) = item.file_id.filter(|f| cat.files.contains_key(f)) {
                    out.push(ExportNode::File {
                        file_id,
                        alias: item.alias.clone(),
                        chains: Vec::from_iter(item.effect_chain_id),
                    });
                }
            }
            ItemKind::Tags => {
                let tracks: Vec<Track> =
                    cat.files_for_tags(item.id)?.into_iter().map(|f| Track::plain(f).with_chain(item.effect_chain_id)).collect();
                out.extend(apply_mode(tracks, item.mode, rng).into_iter().map(ExportNode::from_track));
            }
            ItemKind::Playlist => {
                let Some(r) = item.ref_id else { continue };
                let name = item.alias.clone().or_else(|| cat.names.get(&r).cloned()).unwrap_or_default();
                let children = if item.mode == PlayMode::Order {
                    plan_items(cat, r, rng, path)?.into_iter().map(|n| n.with_chain(item.effect_chain_id)).collect()
                } else {
                    let tracks: Vec<Track> =
                        expand_items(cat, r, rng, path)?.into_iter().map(|t| t.with_chain(item.effect_chain_id)).collect();
                    apply_mode(tracks, item.mode, rng).into_iter().map(ExportNode::from_track).collect()
                };
                out.push(ExportNode::Folder { name, children });
            }
        }
    }
    path.pop();
    Ok(out)
}

/// プレイリストの名前と、書き出す内容
pub fn plan_export(conn: &Connection, id: i64) -> Result<(String, Vec<ExportNode>)> {
    plan_export_with(conn, id, &mut Rng::from_time())
}

pub(super) fn plan_export_with(conn: &Connection, id: i64, rng: &mut Rng) -> Result<(String, Vec<ExportNode>)> {
    let mut cat = Catalog::load(conn)?;
    let name = cat.names.get(&id).cloned().ok_or_else(not_found)?;
    let nodes = plan_items(&mut cat, id, rng, &mut Vec::new())?;
    Ok((name, nodes))
}

pub(super) fn expand_with(conn: &Connection, id: i64, mode: PlayMode, rng: &mut Rng) -> Result<Vec<PlayEntry>> {
    ensure_exists(conn, id)?;
    let mut cat = Catalog::load(conn)?;
    let tracks = apply_mode(expand_items(&mut cat, id, rng, &mut Vec::new())?, mode, rng);
    to_entries(conn, tracks)
}

/// 項目1つだけの再生順（項目の再生方法・別名・エフェクトは、プレイリストの中で再生したときと同じ。外側の項目のものは付かない）
pub fn expand_playlist_item(conn: &Connection, item_id: i64) -> Result<Vec<PlayEntry>> {
    expand_item_with(conn, item_id, &mut Rng::from_time())
}

pub(super) fn expand_item_with(conn: &Connection, item_id: i64, rng: &mut Rng) -> Result<Vec<PlayEntry>> {
    let mut cat = Catalog::load(conn)?;
    let (playlist_id, item) = cat.find_item(item_id)?;
    let tracks = expand_item(&mut cat, &item, rng, &mut vec![playlist_id])?.into_iter().map(|t| t.from_item(item_id)).collect();
    to_entries(conn, tracks)
}

/// 展開した曲に、パスを付けて再生順の1曲にする
fn to_entries(conn: &Connection, tracks: Vec<Track>) -> Result<Vec<PlayEntry>> {
    let files: Vec<i64> = tracks.iter().map(|t| t.file_id).collect();
    // パスはまとめて1回で引く（数万件でも速く）
    let paths: HashMap<i64, (String, String)> = conn
        .prepare(
            "SELECT a.id, a.rel_path, f.path FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
             WHERE a.id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([ids_json(&files)], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(tracks
        .into_iter()
        .filter_map(|t| {
            let (rel_path, folder) = paths.get(&t.file_id)?;
            let path = absolute_path(folder, rel_path).to_string_lossy().into_owned();
            Some(PlayEntry {
                file_id: t.file_id,
                rel_path: rel_path.clone(),
                path,
                alias: t.alias,
                chains: t.chains,
                item_id: t.item,
            })
        })
        .collect())
}

/// 再生順を決める（詳しくは docs の「再生の順番の決め方」）
pub fn expand_playlist(conn: &Connection, id: i64, mode: PlayMode) -> Result<Vec<PlayEntry>> {
    expand_with(conn, id, mode, &mut Rng::from_time())
}

/// 再生したときのファイル数（乱数を使わずに数える。ランダムセレクトは1）
fn count_items(cat: &mut Catalog, playlist_id: i64, memo: &mut HashMap<i64, i64>, path: &mut Vec<i64>) -> Result<i64> {
    if let Some(&n) = memo.get(&playlist_id) {
        return Ok(n);
    }
    if path.contains(&playlist_id) {
        return Ok(0);
    }
    path.push(playlist_id);
    let mut total = 0;
    for item in cat.items(playlist_id) {
        total += count_item(cat, &item, memo, path)?;
    }
    path.pop();
    memo.insert(playlist_id, total);
    Ok(total)
}

pub(super) fn count_item(cat: &mut Catalog, item: &ItemRow, memo: &mut HashMap<i64, i64>, path: &mut Vec<i64>) -> Result<i64> {
    let n = match item.kind {
        ItemKind::File => i64::from(cat.file_ok(item.file_id)),
        ItemKind::Tags => cat.files_for_tags(item.id)?.len() as i64,
        ItemKind::Playlist => match item.ref_id {
            Some(r) => count_items(cat, r, memo, path)?,
            None => 0,
        },
    };
    Ok(if item.mode == PlayMode::Random { n.min(1) } else { n })
}
