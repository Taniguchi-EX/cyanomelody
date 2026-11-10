//! データのエクスポートとインポート（設定画面の「データ」）。
//! ライブラリ・タグ・プレイリストとエフェクト・出典とライセンスと設定を、選んだ項目だけ JSON のファイルに入出力する。
//! ファイルの中では、フォルダ・曲・タグなどにファイルの中だけの番号を振り、つながりはその番号で表す。
//! このファイルはファイルの形式と読み込み。書き出しは exporting.rs、曲の見分け方と取り込みは importing.rs

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
    /// 選んだファイルの書き出し（`export_metadata`）だけ：見るための情報。取り込みでは使わない
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_year: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
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
    /// シノニム（決めた順）
    pub synonyms: Vec<String>,
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

mod copying;
pub mod package;
mod exporting;
mod importing;

pub use copying::{copy_into_library, copy_preview, CopyPreview, CopySource, PackageDir, PACKAGE_JSON};
pub use exporting::{export, export_metadata};
pub use importing::*;

// ---------------------------------------------------------------- ファイルの読み込み

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

#[cfg(test)]
mod tests;
