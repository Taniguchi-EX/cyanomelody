//! プレイリストの出力：書き出すときに抽選し直した曲（`playlists::draw::draw_items`）を、フォルダとファイルにする

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::chains::chain_effects;
use crate::db::ids_json;
use crate::effects::{apply_all, decode, write_wav, Effect};
use crate::error::{Error, Result};
use crate::library::absolute_path;
use crate::playlists::{
    draw::{draw_items, plan_tracks},
    ExportNode,
};

/// 書き出す1ファイル
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub source: PathBuf,
    /// かけるエフェクト（かける順）。空なら元のファイルをそのままコピーする
    pub effects: Vec<Effect>,
    pub dest: PathBuf,
}

/// Windowsのファイル名・フォルダ名に使えない文字を「_」にし、末尾の空白と「.」を除く。空なら「_」
pub fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_control() || r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
        .collect();
    let s = s.trim().trim_end_matches(['.', ' ']).to_string();
    let s: String = s.chars().take(100).collect();
    if s.is_empty() { "_".into() } else { s }
}

/// フォルダの中での順番の数字（3桁。1000件以上なら桁を増やす）
fn prefix(index: usize, count: usize) -> String {
    let width = count.to_string().len().max(3);
    format!("{:0width$}", index + 1)
}

/// parent の中に name のフォルダを作る。同じ名前があるときは「 (2)」などを付ける
fn unique_dir(parent: &Path, name: &str) -> std::io::Result<PathBuf> {
    let mut path = parent.join(name);
    let mut n = 2;
    while path.exists() {
        path = parent.join(format!("{name} ({n})"));
        n += 1;
    }
    fs::create_dir_all(&path)?;
    Ok(path)
}

/// 書き出し先のフォルダを作り、書き出すファイルの一覧を返す（ファイルはまだ書かない）。
/// items は書き出す項目（プレイリストの直下。空ならすべて）。🎲・🔀の項目は、ここで抽選し直す
pub fn prepare(conn: &Connection, playlist_id: i64, items: &[i64], dest: &Path) -> Result<(PathBuf, Vec<Task>)> {
    if !dest.is_dir() {
        return Err(Error::invalid(format!("書き出し先のフォルダがありません: {}", dest.display())));
    }
    let name: String = conn
        .query_row("SELECT name FROM playlists WHERE id = ?1", [playlist_id], |r| r.get(0))
        .map_err(|_| Error::invalid("プレイリストが見つかりません"))?;
    let nodes = plan_tracks(conn, &draw_items(conn, playlist_id, items)?)?;
    // ファイルの場所をまとめて引く
    let mut ids = Vec::new();
    collect_ids(&nodes, &mut ids);
    let files: HashMap<i64, (String, String)> = conn
        .prepare(
            "SELECT a.id, f.path, a.rel_path FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
             WHERE a.id IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([ids_json(&ids)], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    let mut chains: HashMap<i64, Vec<Effect>> = HashMap::new();
    let root = unique_dir(dest, &sanitize(&name))?;
    let mut tasks = Vec::new();
    build(conn, &nodes, &root, &files, &mut chains, &mut tasks)?;
    Ok((root, tasks))
}

fn collect_ids(nodes: &[ExportNode], out: &mut Vec<i64>) {
    for n in nodes {
        match n {
            ExportNode::File { file_id, .. } => out.push(*file_id),
            ExportNode::Folder { children, .. } => collect_ids(children, out),
        }
    }
}

fn build(
    conn: &Connection,
    nodes: &[ExportNode],
    dir: &Path,
    files: &HashMap<i64, (String, String)>,
    chains: &mut HashMap<i64, Vec<Effect>>,
    tasks: &mut Vec<Task>,
) -> Result<()> {
    for (i, node) in nodes.iter().enumerate() {
        let number = prefix(i, nodes.len());
        match node {
            ExportNode::File { file_id, alias, chains: chain_ids } => {
                let Some((folder, rel)) = files.get(file_id) else { continue };
                let source = absolute_path(folder, rel);
                let stem = source.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let mut list = Vec::new();
                for c in chain_ids {
                    if !chains.contains_key(c) {
                        chains.insert(*c, chain_effects(conn, *c)?);
                    }
                    list.extend(chains[c].iter().cloned());
                }
                // エフェクトのかかる曲はWAV、かからない曲は元の形式のまま
                let ext = if list.is_empty() {
                    source.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
                } else {
                    "wav".into()
                };
                let name = sanitize(alias.as_deref().unwrap_or(&stem));
                let dest = dir.join(if ext.is_empty() { format!("{number}_{name}") } else { format!("{number}_{name}.{ext}") });
                tasks.push(Task { source, effects: list, dest });
            }
            ExportNode::Folder { name, children } => {
                let sub = dir.join(format!("{number}_{}", sanitize(name)));
                fs::create_dir_all(&sub)?;
                build(conn, children, &sub, files, chains, tasks)?;
            }
        }
    }
    Ok(())
}

/// 選んだファイル（一括操作の対象）をまとめて書き出す準備。dest の中に folder_name のフォルダ（同じ名前があれば「 (2)」など）を作り、
/// 元のファイルをそのままコピーする一覧を返す（エフェクトはかけない）。名前は元のファイル名のまま、重なるときは「名前 (2).wav」のようにする。
/// 見つからないファイル・ライブラリにないファイルは入れない（書き出せなかった数は、呼んだ側で数える）
pub fn prepare_files(conn: &Connection, file_ids: &[i64], dest: &Path, folder_name: &str) -> Result<(PathBuf, Vec<Task>)> {
    if !dest.is_dir() {
        return Err(Error::invalid(format!("書き出し先のフォルダがありません: {}", dest.display())));
    }
    let files: Vec<(String, String)> = conn
        .prepare(
            "SELECT f.path, a.rel_path FROM audio_files a JOIN library_folders f ON f.id = a.folder_id
             WHERE a.missing = 0 AND a.id IN (SELECT value FROM json_each(?1)) ORDER BY f.path, a.rel_path",
        )?
        .query_map([ids_json(file_ids)], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let root = unique_dir(dest, &sanitize(folder_name))?;
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tasks = Vec::new();
    for (folder, rel) in files {
        let source = absolute_path(&folder, &rel);
        let stem = source.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = source.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let base = sanitize(&stem);
        let mut name = format!("{base}{ext}");
        let mut n = 2;
        // 大文字・小文字の違いだけの名前も重なりとみなす（Windows では同じファイルになるため）
        while !used.insert(name.to_lowercase()) {
            name = format!("{base} ({n}){ext}");
            n += 1;
        }
        tasks.push(Task { dest: root.join(&name), source, effects: Vec::new() });
    }
    Ok((root, tasks))
}

/// 1ファイルを書き出す
pub fn run_task(task: &Task) -> std::result::Result<(), String> {
    if task.effects.is_empty() {
        fs::copy(&task.source, &task.dest).map(|_| ()).map_err(|e| format!("コピーできません: {e}"))
    } else {
        let audio = apply_all(decode(&task.source)?, &task.effects);
        write_wav(&task.dest, &audio).map_err(|e| format!("書き出せません: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::library::{add_folder, scan_folder};
    use crate::playlists::{add_files, create_playlist, get_playlist, set_item_alias};

    #[test]
    fn names() {
        assert_eq!(sanitize(r#"a/b\c:d*e?f"g<h>i|j"#), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize(" 雨. "), "雨");
        assert_eq!(sanitize("..."), "_");
        assert_eq!(prefix(0, 5), "001");
        assert_eq!(prefix(41, 1200), "0042");
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unique_dir(dir.path(), "P").unwrap(), dir.path().join("P"));
        assert_eq!(unique_dir(dir.path(), "P").unwrap(), dir.path().join("P (2)"));
        assert_eq!(unique_dir(dir.path(), "P").unwrap(), dir.path().join("P (3)"));
    }

    #[test]
    fn export_selected_files_copies_with_unique_names() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let lib = tempfile::tempdir().unwrap();
        fs::create_dir_all(lib.path().join("sub")).unwrap();
        fs::copy(fixtures.join("base.mp3"), lib.path().join("rain.mp3")).unwrap();
        fs::copy(fixtures.join("base.mp3"), lib.path().join("sub").join("Rain.mp3")).unwrap();
        fs::copy(fixtures.join("base.flac"), lib.path().join("wind.flac")).unwrap();
        let mut conn = open_in_memory().unwrap();
        let folder = add_folder(&conn, lib.path()).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        // wind.flac は見つからないことにする（書き出さない）
        conn.execute("UPDATE audio_files SET missing = 1 WHERE rel_path = 'wind.flac'", []).unwrap();
        let ids: Vec<i64> = conn
            .prepare("SELECT id FROM audio_files")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let out = tempfile::tempdir().unwrap();
        let (root, tasks) = prepare_files(&conn, &ids, out.path(), "まとめて").unwrap();
        assert_eq!(root, out.path().join("まとめて"));
        let names: Vec<String> = tasks.iter().map(|t| t.dest.file_name().unwrap().to_string_lossy().into_owned()).collect();
        // 大文字・小文字だけ違う名前も重ならないようにする
        assert_eq!(names, vec!["rain.mp3", "Rain (2).mp3"]);
        assert!(tasks.iter().all(|t| t.effects.is_empty()));
        for t in &tasks {
            run_task(t).unwrap();
        }
        assert!(root.join("Rain (2).mp3").exists());
        // もう一度書き出すと別のフォルダ。書き出し先がなければエラー
        assert_eq!(prepare_files(&conn, &ids, out.path(), "まとめて").unwrap().0, out.path().join("まとめて (2)"));
        assert!(prepare_files(&conn, &ids, &out.path().join("none"), "まとめて").is_err());
    }

    #[test]
    fn export_writes_folders_copies_and_wavs() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let lib = tempfile::tempdir().unwrap();
        fs::copy(fixtures.join("base.mp3"), lib.path().join("rain.mp3")).unwrap();
        fs::copy(fixtures.join("base.flac"), lib.path().join("wind.flac")).unwrap();
        let mut conn = open_in_memory().unwrap();
        let folder = add_folder(&conn, lib.path()).unwrap();
        scan_folder(&mut conn, folder).unwrap();
        let rain: i64 = conn.query_row("SELECT id FROM audio_files WHERE rel_path = 'rain.mp3'", [], |r| r.get(0)).unwrap();
        let wind: i64 = conn.query_row("SELECT id FROM audio_files WHERE rel_path = 'wind.flac'", [], |r| r.get(0)).unwrap();

        let chain = crate::chains::create_chain(&conn, "小さく").unwrap();
        crate::chains::set_chain_effects(&mut conn, chain, &[Effect::Gain { db: -6.0 }]).unwrap();
        let top = create_playlist(&mut conn, "戦闘: 1", None).unwrap();
        add_files(&mut conn, top, &[rain]).unwrap();
        let child = create_playlist(&mut conn, "足音", Some(top)).unwrap();
        add_files(&mut conn, child, &[wind]).unwrap();
        let items = get_playlist(&conn, top).unwrap().items;
        set_item_alias(&conn, items[0].id, "激しめの雨").unwrap();
        crate::chains::set_item_chain(&conn, items[1].id, Some(chain)).unwrap();

        crate::playlists::draw::draw(&conn, top).unwrap();
        let out = tempfile::tempdir().unwrap();
        let (root, tasks) = prepare(&conn, top, &[1, 2], out.path()).unwrap();
        assert_eq!(root, out.path().join("戦闘_ 1"));
        let dests: Vec<PathBuf> = tasks.iter().map(|t| t.dest.strip_prefix(&root).unwrap().to_path_buf()).collect();
        assert_eq!(dests, vec![PathBuf::from("001_激しめの雨.mp3"), Path::new("002_足音").join("001_wind.wav")]);
        for t in &tasks {
            run_task(t).unwrap();
        }
        // エフェクトのない曲は元のファイルのまま
        assert_eq!(fs::read(root.join("001_激しめの雨.mp3")).unwrap(), fs::read(lib.path().join("rain.mp3")).unwrap());
        // エフェクトのかかる曲はWAV（読み直せる）
        assert!(decode(&root.join("002_足音").join("001_wind.wav")).is_ok());
        // もう一度書き出すと、別のフォルダになる
        let (again, _) = prepare(&conn, top, &[1, 2], out.path()).unwrap();
        assert_eq!(again, out.path().join("戦闘_ 1 (2)"));
        assert!(prepare(&conn, top, &[1, 2], &out.path().join("none")).is_err());
    }
}
