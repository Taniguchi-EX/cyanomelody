//! Windows：スマホへの直接コピーで、スマホの cyanomelody 用のフォルダ（`Music/cyanomelody`）に置くもの。
//! データの JSON（`cyanomelody.json`）と、ライブラリの曲の音声ファイルを、ライブラリのフォルダごとのフォルダに相対パスのまま置く。
//! ここは置く場所と差分の決め方（端末に依存しない）。端末とのやりとりは phone.rs

use std::path::PathBuf;

use super::*;
use crate::export::sanitize;

/// cyanomelody 用のフォルダに置く音声ファイル
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageFile {
    pub source: PathBuf,
    /// cyanomelody 用のフォルダの中の相対パス（区切りは `/`）
    pub dest: String,
    pub size: i64,
    pub hash: Option<String>,
}

/// ライブラリのフォルダごとの、cyanomelody 用のフォルダの中のフォルダ名（フォルダの名前。重なるときは「名前 (2)」）
fn folder_names(data: &DataFile) -> HashMap<i64, String> {
    let mut used = HashSet::new();
    let mut names = HashMap::new();
    for f in &data.folders {
        let last = f.path.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(&f.path);
        let base = sanitize(last);
        let mut name = base.clone();
        let mut n = 2;
        while !used.insert(name.to_lowercase()) {
            name = format!("{base} ({n})");
            n += 1;
        }
        names.insert(f.id, name);
    }
    names
}

/// data（エクスポートしたデータ）の曲のうち、置く音声ファイル（見つからない印のあるものは除く）と、除いた数
pub fn package_files(conn: &Connection, data: &DataFile) -> Result<(Vec<PackageFile>, usize)> {
    let missing: HashSet<i64> =
        conn.prepare("SELECT id FROM audio_files WHERE missing = 1")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let names = folder_names(data);
    let paths: HashMap<i64, &str> = data.folders.iter().map(|f| (f.id, f.path.as_str())).collect();
    let mut files = Vec::new();
    let mut skipped = 0;
    for f in &data.files {
        let (Some(folder), Some(name)) = (paths.get(&f.folder), names.get(&f.folder)) else { continue };
        if missing.contains(&f.id) {
            skipped += 1;
            continue;
        }
        files.push(PackageFile {
            source: absolute_path(folder, &f.rel_path),
            dest: format!("{name}/{}", f.rel_path),
            size: f.size,
            hash: f.hash.clone(),
        });
    }
    Ok((files, skipped))
}

/// スマホの cyanomelody 用のフォルダの中にあるファイル
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFile {
    /// フォルダの中の相対パス（区切りは `/`）
    pub rel: String,
    pub size: i64,
}

/// cyanomelody 用のフォルダの中の、cyanomelody が置く管理用のファイル（消さない）
pub const KEEP_FILES: [&str; 2] = [PACKAGE_JSON_NAME, ".nomedia"];
const PACKAGE_JSON_NAME: &str = "cyanomelody.json";

/// 差分：写すファイル（current の番号）と、消すファイル（スマホの相対パス）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PhoneDiff {
    pub copy: Vec<usize>,
    pub delete: Vec<String>,
    /// そのままのファイルの数
    pub unchanged: usize,
}

/// 今の曲（current）と、前に書いたデータ（old。なければ None）と、スマホのフォルダの中（device）から、差分を決める。
/// - スマホにない・大きさが違う・前のデータとハッシュ値が違う曲は写す
/// - スマホにあって今の曲にないファイルは消す（管理用のファイルは除く）
///
/// 相対パスは大文字・小文字を区別せずに比べる
pub fn diff(current: &[PackageFile], old: Option<&DataFile>, device: &[DeviceFile]) -> PhoneDiff {
    let key = |s: &str| s.to_lowercase();
    let on_device: HashMap<String, i64> = device.iter().map(|f| (key(&f.rel), f.size)).collect();
    let mut old_hash: HashMap<String, String> = HashMap::new();
    if let Some(old) = old {
        let names = folder_names(old);
        for f in &old.files {
            if let (Some(name), Some(hash)) = (names.get(&f.folder), &f.hash) {
                old_hash.insert(key(&format!("{name}/{}", f.rel_path)), hash.clone());
            }
        }
    }
    let mut result = PhoneDiff::default();
    let mut wanted = HashSet::new();
    for (i, f) in current.iter().enumerate() {
        let k = key(&f.dest);
        let same_size = on_device.get(&k) == Some(&f.size);
        let changed = matches!((old_hash.get(&k), &f.hash), (Some(a), Some(b)) if a != b);
        if same_size && !changed {
            result.unchanged += 1;
        } else {
            result.copy.push(i);
        }
        wanted.insert(k);
    }
    result.delete = device
        .iter()
        .filter(|f| !wanted.contains(&key(&f.rel)) && !KEEP_FILES.iter().any(|k| f.rel.eq_ignore_ascii_case(k)))
        .map(|f| f.rel.clone())
        .collect();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(dest: &str, size: i64, hash: &str) -> PackageFile {
        PackageFile { source: PathBuf::new(), dest: dest.into(), size, hash: Some(hash.into()) }
    }

    fn on_device(rel: &str, size: i64) -> DeviceFile {
        DeviceFile { rel: rel.into(), size }
    }

    #[test]
    fn diff_copies_new_and_changed_and_deletes_removed() {
        // 前のデータ：lib フォルダの a（h1）と b（h2）
        let old = DataFile {
            folders: vec![XFolder { id: 1, path: r"C:\music\lib".into() }],
            files: vec![
                XFile { id: 1, folder: 1, rel_path: "a.wav".into(), size: 10, hash: Some("h1".into()), ..Default::default() },
                XFile { id: 2, folder: 1, rel_path: "b.wav".into(), size: 20, hash: Some("h2".into()), ..Default::default() },
            ],
            ..Default::default()
        };
        let current = vec![
            file("lib/a.wav", 10, "h1"),      // そのまま
            file("lib/b.wav", 20, "h2-new"),  // 大きさは同じだが中身が変わった
            file("lib/sub/c.wav", 30, "h3"),  // 新しい
            file("lib/D.wav", 40, "h4"),      // スマホから消されていた（大文字・小文字は区別しない）
        ];
        let device = vec![
            on_device("cyanomelody.json", 1),
            on_device(".nomedia", 0),
            on_device("lib/a.wav", 10),
            on_device("lib/b.wav", 20),
            on_device("lib/d.wav", 1),
            on_device("lib/old.wav", 5), // 今のライブラリにない
        ];
        let d = diff(&current, Some(&old), &device);
        assert_eq!(d.copy, vec![1, 2, 3]);
        assert_eq!(d.unchanged, 1);
        assert_eq!(d.delete, vec!["lib/old.wav".to_string()]);
        // 前のデータがないとき（初めて）は、スマホのファイルの大きさで比べる
        let d = diff(&current, None, &device);
        assert_eq!(d.copy, vec![2, 3]);
    }

    #[test]
    fn folder_names_use_last_component_and_avoid_duplicates() {
        let data = DataFile {
            folders: vec![
                XFolder { id: 1, path: r"C:\music\効果音".into() },
                XFolder { id: 2, path: r"D:\backup\効果音\".into() },
                XFolder { id: 3, path: r"E:\BGM".into() },
            ],
            ..Default::default()
        };
        let names = folder_names(&data);
        assert_eq!(names[&1], "効果音");
        assert_eq!(names[&2], "効果音 (2)");
        assert_eq!(names[&3], "BGM");
    }
}
