//! データのインポート：ファイルの中の曲をこのPCのライブラリの曲に対応させ、選んだ項目を取り込む

use super::*;

// ---------------------------------------------------------------- 曲の見分け方
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
            // 同じ名前（今あるタグのシノニムを含む）のタグがあれば、それを使う（変えない）
            if let Some(id) = crate::tags::find_tag(tx, name)? {
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
            let id = tx.last_insert_rowid();
            // シノニムは、ほかのタグの名前・シノニムと重ならないものだけ付ける
            for (i, s) in t.synonyms.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).enumerate() {
                if crate::tags::find_tag(tx, s)?.is_none() {
                    tx.execute(
                        "INSERT INTO tag_synonyms (tag_id, name, position) VALUES (?1, ?2, ?3)",
                        params![id, s, i as i64],
                    )?;
                }
            }
            map.insert(t.id, id);
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
