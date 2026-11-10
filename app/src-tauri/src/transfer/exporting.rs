//! データのエクスポート：選んだ項目を、ファイルの形式（DataFile）にする

use super::*;
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
                    synonyms: vec![],
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut synonyms = crate::tags::synonym_map(conn)?;
        let all: Vec<XTag> = all
            .into_iter()
            .map(|t| XTag { synonyms: synonyms.remove(&t.id).unwrap_or_default(), ..t })
            .collect();
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
            ..Default::default()
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

/// 選んだファイル（一括操作の対象）のメタデータを、データのエクスポートと同じ形で書き出す。
/// 項目は「タグ」と「出典・ライセンス」（曲へのタグ付け・設定は、選んだファイルの分だけ）。タグ・出典・ライセンスの定義はすべて入れる
/// （取り込む側で名前を合わせるため）。新しく作るタグの既定値・自動タグ付けの設定・画面の設定は入れない。
/// 曲には、見るための情報（曲名・長さ・リリース年・見つからない印）も入れる（取り込みでは使わない）
pub fn export_metadata(conn: &Connection, file_ids: &[i64], app_version: &str) -> Result<DataFile> {
    let sections = Sections { tags: true, credits: true, ..Default::default() };
    let mut data = export(conn, sections, app_version, None)?;
    data.new_tag = None;
    data.meta_ignore = None;
    data.meta_separators = None;
    let file_tags = file_tag_map(conn)?;
    let mut stmt = conn.prepare(
        "SELECT a.id, a.folder_id, a.rel_path, a.size, a.hash, a.source_id, a.license_id, a.duration, a.release_year,
                a.missing, f.path
         FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
         WHERE a.id IN (SELECT value FROM json_each(?1)) ORDER BY f.path, a.rel_path",
    )?;
    let rows = stmt.query_map([crate::db::ids_json(file_ids)], |r| {
        let id: i64 = r.get(0)?;
        let rel_path: String = r.get(2)?;
        let folder_path: String = r.get(10)?;
        let missing: bool = r.get(9)?;
        Ok((
            XFile {
                id,
                folder: r.get(1)?,
                rel_path: rel_path.clone(),
                size: r.get(3)?,
                hash: r.get(4)?,
                tags: file_tags.get(&id).cloned().unwrap_or_default(),
                source: r.get(5)?,
                license: r.get(6)?,
                title: None,
                duration: r.get(7)?,
                release_year: r.get(8)?,
                missing: Some(missing),
            },
            crate::library::absolute_path(&folder_path, &rel_path),
        ))
    })?;
    data.files = Vec::new();
    for row in rows {
        let (mut f, path) = row?;
        // 曲名（タグ情報のタイトル）はファイルから読む（見つからないファイルは読まない）
        if f.missing != Some(true) {
            f.title = crate::metadata::track_title(&path);
        }
        data.files.push(f);
    }
    let used: HashSet<i64> = data.files.iter().map(|f| f.folder).collect();
    data.folders = conn
        .prepare("SELECT id, path FROM library_folders ORDER BY id")?
        .query_map([], |r| Ok(XFolder { id: r.get(0)?, path: r.get(1)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|f| used.contains(&f.id))
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
