//! Android：Windows からのコピー。Windows で書き出したデータ（JSON）と、一緒に書き出した音声ファイルのフォルダ（書き出したフォルダ）を取り込む。
//! 書き出したフォルダの中のフォルダは、置いた場所のままライブラリに登録する（端末の中で写し直さない）。
//! 曲は「フォルダの中の相対パス」でも見分け、選んだ項目を Windows のとおりに置き換える。
//! SAF を使う所（フォルダ・ファイルを選ぶ、中を読む）は commands/copy.rs、ここはデータベースと見分け方

use super::importing::{import_data, load_locals, preview_with, LocalFile, MatchOptions};
use super::*;
use crate::library::{self, KIND_SAF};
use crate::saf::{self, TreeFile};

/// 書き出したフォルダの中の、データのファイルの名前
pub const PACKAGE_JSON: &str = "cyanomelody.json";

/// どこから写すか：書き出したフォルダ（dir）か、データのファイルだけ（file）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopySource {
    /// "dir" か "file"
    pub kind: String,
    /// 選んだフォルダ・ファイルの FsUri の JSON
    pub uri: String,
}

impl CopySource {
    pub fn is_dir(&self) -> bool {
        self.kind == "dir"
    }

    /// 書き出したフォルダ（選んだフォルダ）の場所の名前。ファイルだけを選んだときは None
    fn tree(&self) -> Option<String> {
        if self.is_dir() { saf::tree_id(&self.uri) } else { None }
    }
}

/// 書き出したフォルダの中のフォルダ（ライブラリに登録するもの）と、その中の音声ファイル
#[derive(Debug, Clone)]
pub struct PackageDir {
    pub name: String,
    pub uri: String,
    pub files: Vec<TreeFile>,
}

/// 見込みに出す、書き出したフォルダの中のフォルダ
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyFolder {
    pub name: String,
    /// 登録済み（前に同じ場所から写した）か。登録済みなら、スキャンし直す
    pub registered: bool,
    pub files: usize,
}

/// 前に別の場所から写したフォルダ（登録を外すか聞く）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OldFolder {
    pub id: i64,
    pub label: String,
}

/// コピーの見込み
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyPreview {
    pub source: CopySource,
    /// 中身の件数・見つかる曲・置き換えで消える件数（インポートと同じ）
    pub import: ImportPreview,
    /// 書き出したフォルダの中のフォルダ（ファイルだけを選んだときは空）
    pub folders: Vec<CopyFolder>,
    pub old_folders: Vec<OldFolder>,
}

/// 登録済みの SAF のフォルダ
fn saf_folders(conn: &Connection) -> Result<Vec<library::LibraryFolder>> {
    Ok(library::list_folders(conn)?.into_iter().filter(|f| f.kind == KIND_SAF).collect())
}

/// 同じフォルダか（フォルダの場所の名前で比べる。大文字・小文字は区別しない）
fn same_folder(a: &str, b: &str) -> bool {
    match (saf::document_id(a), saf::document_id(b)) {
        (Some(a), Some(b)) => a.to_lowercase() == b.to_lowercase(),
        _ => false,
    }
}

fn registered_id(folders: &[library::LibraryFolder], uri: &str) -> Option<i64> {
    folders.iter().find(|f| same_folder(&f.path, uri)).map(|f| f.id)
}

/// 前に別の場所から写したフォルダ：選んだフォルダの中のフォルダとして登録したもので、今回の書き出したフォルダ（package_tree）の外にあるもの。
/// データのファイルだけを選んだとき（package_tree が None）は、ない
fn old_folders(folders: &[library::LibraryFolder], package_tree: Option<&str>) -> Vec<OldFolder> {
    let Some(tree) = package_tree else { return vec![] };
    folders
        .iter()
        .filter(|f| saf::is_subfolder(&f.path))
        .filter(|f| saf::tree_id(&f.path).is_none_or(|t| !t.eq_ignore_ascii_case(tree)))
        .map(|f| OldFolder { id: f.id, label: f.label.clone() })
        .collect()
}

const BY_FOLDER: MatchOptions = MatchOptions { by_folder: true };

/// コピーの見込み。書き出したフォルダの中のフォルダは、まだ登録していなくても、中の曲を探す先に入れて数える
pub fn copy_preview(conn: &Connection, data: &DataFile, source: &CopySource, package: &[PackageDir]) -> Result<CopyPreview> {
    let registered = saf_folders(conn)?;
    let mut locals = load_locals(conn)?;
    let mut folders = Vec::new();
    // まだ登録していない曲には、ありえない番号（負の数）を振る
    let mut next_file = -1;
    for (i, dir) in package.iter().enumerate() {
        let reg = registered_id(&registered, &dir.uri);
        let folder_id = reg.unwrap_or(-(i as i64) - 1);
        // 登録済みのフォルダは、今の中身（これからスキャンし直す）で数える
        locals.retain(|l| l.folder_id != folder_id);
        for f in &dir.files {
            locals.push(LocalFile::new(next_file, folder_id, "", &f.rel_path, f.size, None, false));
            next_file -= 1;
        }
        folders.push(CopyFolder { name: dir.name.clone(), registered: reg.is_some(), files: dir.files.len() });
    }
    Ok(CopyPreview {
        source: source.clone(),
        import: preview_with(conn, data, &locals, BY_FOLDER)?,
        folders,
        old_folders: old_folders(&registered, source.tree().as_deref()),
    })
}

/// 書き出したフォルダの中のフォルダを登録してスキャンし（登録済みならスキャンし直す）、選んだ項目を置き換えで取り込む。
/// remove_old なら、前に別の場所から写したフォルダの登録を外す。ライブラリ（フォルダの登録）の項目は使わない
pub fn copy_into_library(
    conn: &mut Connection,
    data: &DataFile,
    source: &CopySource,
    package: &[saf::ChildDir],
    sections: Sections,
    remove_old: bool,
) -> Result<ImportResult> {
    let mut result = ImportResult::default();
    let registered = saf_folders(conn)?;
    if remove_old {
        for old in old_folders(&registered, source.tree().as_deref()) {
            library::remove_folder(conn, old.id)?;
            result.folders_removed += 1;
        }
    }
    for dir in package {
        let id = match registered_id(&registered, &dir.uri) {
            Some(id) => id,
            None => match library::add_saf_folder(conn, &dir.uri) {
                Ok(id) => {
                    result.folders_added.push(id);
                    id
                }
                // 登録済みのフォルダの中にあるなどで登録できないものは、飛ばす（中の曲は、ほかの見分け方で探す）
                Err(e) => {
                    result.folders_skipped += 1;
                    result.messages.push(format!("{}：{e}", dir.name));
                    continue;
                }
            },
        };
        library::scan_folder(conn, id)?;
        result.folders_scanned += 1;
    }
    let sections = Sections { library: false, ..sections };
    import_data(conn, data, sections, true, BY_FOLDER, &mut result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saf_uri(tree: &str, doc: &str) -> String {
        let enc = |s: &str| s.replace(':', "%3A").replace('/', "%2F");
        format!(
            r#"{{"uri":"content://com.android.externalstorage.documents/tree/{}/document/{}","documentTopTreeUri":null}}"#,
            enc(tree),
            enc(doc)
        )
    }

    fn folder(id: i64, uri: &str) -> library::LibraryFolder {
        library::LibraryFolder {
            id,
            path: uri.into(),
            kind: KIND_SAF.into(),
            label: saf::display_name(uri),
            file_count: 0,
            missing_count: 0,
        }
    }

    #[test]
    fn old_folders_are_subfolders_of_other_trees() {
        let folders = vec![
            // 普通に登録したフォルダ（選んだフォルダそのもの）は対象にしない
            folder(1, &saf_uri("primary:Music", "primary:Music")),
            // 前に別の場所から写したもの
            folder(2, &saf_uri("primary:Download/cm-old", "primary:Download/cm-old/sound")),
            // 今回と同じ場所から写したもの
            folder(3, &saf_uri("primary:Download/cm", "primary:Download/cm/BGM")),
        ];
        let old = old_folders(&folders, Some("primary:Download/cm"));
        assert_eq!(old, vec![OldFolder { id: 2, label: "Download/cm-old/sound".into() }]);
        assert!(old_folders(&folders, None).is_empty());
    }
}
