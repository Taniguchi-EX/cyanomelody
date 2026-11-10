//! OS にインストールされているフォントの一覧（設定画面の「表示」で文字のフォントを選ぶため）。
//! フォントのファイル（.ttf・.otf・.ttc・.otc）の名前の表から、ファミリ名を読む

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

/// フォントのファミリ
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    /// CSS の font-family に書く名前（英語の名前。なければ最初に見つかった名前）
    pub name: String,
    /// 一覧に出す名前（日本語の名前があればそれ）
    pub label: String,
}

/// 名前の表の言語：英語（米国）・日本語
const LANG_EN: u16 = 0x0409;
const LANG_JA: u16 = 0x0411;
/// 名前の表の種類：ファミリ名・優先ファミリ名（太さ違いをまとめた名前）
const NAME_FAMILY: u16 = 1;
const NAME_TYPOGRAPHIC_FAMILY: u16 = 16;

/// フォントのファイルを置く場所（Windows 全体と、ユーザーごとにインストールしたもの）
fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(windir) = std::env::var_os("WINDIR") {
        dirs.push(PathBuf::from(windir).join("Fonts"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Microsoft").join("Windows").join("Fonts"));
    }
    dirs
}

/// 1つの書体の名前の表から、英語と日本語のファミリ名を読む（優先ファミリ名があればそちら）
fn family_names(face: &ttf_parser::Face) -> (Option<String>, Option<String>) {
    let mut en = None;
    let mut ja = None;
    let mut any = None;
    for id in [NAME_TYPOGRAPHIC_FAMILY, NAME_FAMILY] {
        for name in face.names().into_iter().filter(|n| n.name_id == id) {
            let Some(text) = name.to_string().filter(|t| !t.trim().is_empty()) else { continue };
            match name.language_id {
                LANG_EN if en.is_none() => en = Some(text),
                LANG_JA if ja.is_none() => ja = Some(text),
                _ if any.is_none() => any = Some(text),
                _ => {}
            }
        }
        // 優先ファミリ名が見つかったら、ファミリ名は見ない
        if en.is_some() || ja.is_some() || any.is_some() {
            break;
        }
    }
    (en.or(any), ja)
}

/// インストールされているフォントのファミリの一覧（一覧に出す名前の順）。読めないファイルは飛ばす。
/// 記号だけのフォント（Symbol・Wingdings など）や、名前が「@」で始まる縦書き用のものも入る（選んでも読めるとは限らない）が、
/// 縦書き用（@）は外す
pub fn installed_fonts() -> Vec<FontFamily> {
    let mut families: BTreeMap<String, FontFamily> = BTreeMap::new();
    for dir in font_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            if !matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "otc") {
                continue;
            }
            let Ok(data) = std::fs::read(&path) else { continue };
            let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
            for index in 0..count {
                let Ok(face) = ttf_parser::Face::parse(&data, index) else { continue };
                let (en, ja) = family_names(&face);
                let Some(name) = en.clone().or_else(|| ja.clone()) else { continue };
                if name.starts_with('@') {
                    continue;
                }
                let label = ja.unwrap_or_else(|| name.clone());
                families.entry(name.to_lowercase()).or_insert(FontFamily { name, label });
            }
        }
    }
    let mut list: Vec<FontFamily> = families.into_values().collect();
    list.sort_by_key(|f| f.label.to_lowercase());
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_windows_fonts() {
        // 開発する PC（Windows）に入っている標準のフォントが見つかる
        let fonts = installed_fonts();
        assert!(fonts.iter().any(|f| f.name == "Segoe UI"), "Segoe UI がない");
        // 日本語の名前があるフォントは、一覧には日本語の名前で出す
        let meiryo = fonts.iter().find(|f| f.name == "Meiryo").expect("Meiryo がない");
        assert_eq!(meiryo.label, "メイリオ");
    }
}
