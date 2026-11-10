//! Windows：Android へ写すための書き出し（書き出したフォルダ）。
//! 書き出したフォルダの中に、データの JSON（`cyanomelody.json`）と、書き出す曲の音声ファイルを、ライブラリのフォルダごとのフォルダに相対パスのまま置く。
//! 音声ファイルのコピーは、ほかの書き出しと同じ仕組み（export_job）で裏で行う

use std::path::PathBuf;

use super::*;
use crate::export::sanitize;

/// 書き出したフォルダに置く音声ファイル
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageFile {
    pub source: PathBuf,
    /// 書き出したフォルダの中の相対パス（区切りは `/`）
    pub dest: String,
    pub size: i64,
}

/// 書き出す前に出す、音声ファイルの数と合計の大きさ
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackageEstimate {
    pub files: usize,
    pub bytes: i64,
    /// 見つからない印があるので入れない曲
    pub missing: usize,
}

/// ライブラリのフォルダごとの、書き出したフォルダの中のフォルダ名（フォルダの名前。重なるときは「名前 (2)」）
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
        files.push(PackageFile { source: absolute_path(folder, &f.rel_path), dest: format!("{name}/{}", f.rel_path), size: f.size });
    }
    Ok((files, skipped))
}

pub fn estimate(files: &[PackageFile], missing: usize) -> PackageEstimate {
    PackageEstimate { files: files.len(), bytes: files.iter().map(|f| f.size).sum(), missing }
}

#[cfg(test)]
mod tests {
    use super::*;

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
