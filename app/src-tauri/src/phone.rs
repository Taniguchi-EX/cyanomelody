//! Windows：USB でつないだスマホ（MTP。スマホで「ファイル転送」を選んだ状態）への直接コピー。
//! スマホの内部ストレージの `Music/cyanomelody` に、ライブラリの全曲（ライブラリのフォルダごと・相対パスのまま）と、データの `cyanomelody.json` を写す。
//! 2回目からは差分だけ写す（差分の決め方は transfer/package.rs）。ほかの音楽アプリに並ばないよう、`.nomedia` を置く。
//! Windows Portable Devices の API を winmtp で使う。ファイルを書くときは、winmtp の push_file が書くたびにフォルダの中を読み直して遅いので、
//! 先に読んだ一覧をもとに、確認なしで書く（push_fast）

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::Path;

use serde::Serialize;
use widestring::{U16CStr, U16CString};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Devices::PortableDevices::{
    IPortableDeviceValues, PortableDeviceValues, WPD_OBJECT_NAME, WPD_OBJECT_ORIGINAL_FILE_NAME, WPD_OBJECT_PARENT_ID,
    WPD_OBJECT_SIZE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use winmtp::device::device_values::AppIdentifiers;
use winmtp::device::Content;
use winmtp::object::{Object, ObjectType};
use winmtp::Provider;

use crate::error::{Error, Result};
use crate::transfer::package::{self, DeviceFile, PackageFile};
use crate::transfer::{DataFile, PACKAGE_JSON};

/// スマホの中の cyanomelody 用のフォルダ（内部ストレージの中の場所）
pub const PHONE_DIR: &str = "Music/cyanomelody";
const MUSIC: &str = "Music";
const APP_DIR: &str = "cyanomelody";
const NOMEDIA: &str = ".nomedia";

fn mtp_error(e: impl std::fmt::Display) -> Error {
    Error::invalid(format!("スマホとのやりとりに失敗しました: {e}"))
}

/// つないでいる端末
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneDevice {
    pub id: String,
    pub name: String,
}

/// つないでいる端末の一覧（スマホで「ファイル転送」を選んでいるものだけが見える）
pub fn list_devices() -> Result<Vec<PhoneDevice>> {
    let provider = Provider::new().map_err(mtp_error)?;
    Ok(provider
        .enumerate_devices()
        .map_err(mtp_error)?
        .iter()
        .map(|d| PhoneDevice { id: d.device_id(), name: d.friendly_name().to_string() })
        .collect())
}

/// 端末を開き、中身（Content）と、最初のストレージ（内部ストレージ）を返す
fn open(device_id: &str) -> Result<(Content, Object)> {
    let provider = Provider::new().map_err(mtp_error)?;
    let basic = provider
        .enumerate_devices()
        .map_err(mtp_error)?
        .into_iter()
        .find(|d| d.device_id() == device_id)
        .ok_or_else(|| Error::invalid("スマホが見つかりません。USB でつなぎ、スマホで「ファイル転送」を選んでください"))?;
    let app = AppIdentifiers { app_name: "cyanomelody".into(), app_major: 1, app_minor: 0, app_patch: 0 };
    let device = basic.open(&app, false).map_err(mtp_error)?;
    let content = device.content().map_err(mtp_error)?;
    let storage = content
        .root()
        .map_err(mtp_error)?
        .children()
        .map_err(mtp_error)?
        .next()
        .ok_or_else(|| Error::invalid("スマホのストレージが見えません。スマホのロックを解除して、「ファイル転送」を選んでください"))?;
    Ok((content, storage))
}

/// cyanomelody 用のフォルダの中（サブフォルダも）
#[derive(Debug, Default)]
struct Listing {
    /// フォルダ（相対パスの小文字 → id）
    folders: HashMap<String, U16CString>,
    /// ファイル（相対パスと大きさ）と id
    files: Vec<(DeviceFile, U16CString)>,
}

fn walk(dir: &Object, prefix: &str, listing: &mut Listing) -> Result<()> {
    for child in dir.children().map_err(mtp_error)? {
        let name = child.name().to_string_lossy();
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if child.object_type() == ObjectType::Folder {
            listing.folders.insert(rel.to_lowercase(), U16CString::from_ustr_truncate(child.id()));
            walk(&child, &rel, listing)?;
        } else {
            let size = child
                .properties(&[WPD_OBJECT_SIZE])
                .and_then(|v| v.get_u64(&WPD_OBJECT_SIZE))
                .map(|s| s as i64)
                .unwrap_or(-1);
            listing.files.push((DeviceFile { rel, size }, U16CString::from_ustr_truncate(child.id())));
        }
    }
    Ok(())
}

/// 写す前に出す、写すものの数
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneSummary {
    pub device: String,
    /// 写す曲の数と合計の大きさ
    pub copy_files: usize,
    pub copy_bytes: i64,
    /// スマホから消す曲の数（Windows のライブラリにないもの）
    pub delete_files: usize,
    /// そのままの曲の数
    pub unchanged: usize,
    /// 見つからない印があるので写さない曲の数
    pub missing: usize,
}

/// 写す計画（調べた結果。写すときに使う）
#[derive(Debug)]
pub struct PhonePlan {
    device_id: String,
    pub summary: PhoneSummary,
    copy: Vec<PackageFile>,
    delete: Vec<U16CString>,
    /// スマホに今ある、写すファイルと同じ場所のファイル（相対パスの小文字 → id。消してから書く）
    existing: HashMap<String, U16CString>,
    folders: HashMap<String, U16CString>,
    /// cyanomelody 用のフォルダの id（まだなければ None）と、管理用のファイルの id
    app_dir: Option<U16CString>,
    json: Option<U16CString>,
    has_nomedia: bool,
}

/// スマホの中を調べ、data（エクスポートしたデータ。全項目）の曲と比べて、写す計画を作る
pub fn plan(conn: &rusqlite::Connection, device_id: &str, data: &DataFile) -> Result<PhonePlan> {
    let (_content, storage) = open(device_id)?;
    let device = list_devices()?.into_iter().find(|d| d.id == device_id).map(|d| d.name).unwrap_or_default();
    let music = storage.object_by_path(Path::new(MUSIC)).ok();
    let app_dir = music.as_ref().and_then(|m| m.object_by_path(Path::new(APP_DIR)).ok());
    let mut listing = Listing::default();
    if let Some(dir) = &app_dir {
        walk(dir, "", &mut listing)?;
    }
    let find = |name: &str| listing.files.iter().find(|(f, _)| f.rel.eq_ignore_ascii_case(name)).map(|(_, id)| id.clone());
    let json = find(PACKAGE_JSON);
    // 前に書いたデータ（読めなければ、スマホのファイルの大きさだけで比べる）
    let old = match (&app_dir, &json) {
        (Some(dir), Some(_)) => read_text(dir, PACKAGE_JSON).ok().and_then(|t| crate::transfer::parse(&t).ok()),
        _ => None,
    };
    let (files, missing) = package::package_files(conn, data)?;
    let device_files: Vec<DeviceFile> = listing.files.iter().map(|(f, _)| f.clone()).collect();
    let diff = package::diff(&files, old.as_ref(), &device_files);
    let ids: HashMap<String, U16CString> = listing.files.iter().map(|(f, id)| (f.rel.to_lowercase(), id.clone())).collect();
    let copy: Vec<PackageFile> = diff.copy.iter().map(|&i| files[i].clone()).collect();
    let existing = copy.iter().filter_map(|f| ids.get(&f.dest.to_lowercase()).map(|id| (f.dest.to_lowercase(), id.clone()))).collect();
    let delete = diff.delete.iter().filter_map(|rel| ids.get(&rel.to_lowercase()).cloned()).collect();
    Ok(PhonePlan {
        device_id: device_id.to_string(),
        summary: PhoneSummary {
            device,
            copy_files: copy.len(),
            copy_bytes: copy.iter().map(|f| f.size).sum(),
            delete_files: diff.delete.len(),
            unchanged: diff.unchanged,
            missing,
        },
        copy,
        delete,
        existing,
        folders: listing.folders,
        app_dir: app_dir.map(|d| U16CString::from_ustr_truncate(d.id())),
        json,
        has_nomedia: find(NOMEDIA).is_some(),
    })
}

fn read_text(dir: &Object, name: &str) -> Result<String> {
    let mut text = String::new();
    dir.object_by_path(Path::new(name))
        .map_err(mtp_error)?
        .open_read_stream()
        .map_err(mtp_error)?
        .read_to_string(&mut text)?;
    Ok(text)
}

/// 親（parent の id）の中に、名前が name で中身が reader のファイルを書く（同じ名前があるかは確かめない）
fn push_fast(content: &Content, parent: &U16CStr, name: &str, size: u64, reader: &mut dyn Read) -> Result<()> {
    let name = U16CString::from_str_truncate(name);
    // SAFETY: Windows Portable Devices の COM の呼び出し。渡す文字列（parent・name）は呼び出しの間生きている
    let stream = unsafe {
        let values: IPortableDeviceValues = CoCreateInstance(&PortableDeviceValues, None, CLSCTX_ALL).map_err(mtp_error)?;
        values.SetStringValue(&WPD_OBJECT_PARENT_ID, PCWSTR::from_raw(parent.as_ptr())).map_err(mtp_error)?;
        values.SetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE, size).map_err(mtp_error)?;
        values.SetStringValue(&WPD_OBJECT_ORIGINAL_FILE_NAME, PCWSTR::from_raw(name.as_ptr())).map_err(mtp_error)?;
        values.SetStringValue(&WPD_OBJECT_NAME, PCWSTR::from_raw(name.as_ptr())).map_err(mtp_error)?;
        let mut stream = None;
        let mut buffer = 0u32;
        content
            .com_object()
            .CreateObjectWithPropertiesAndData(&values, &mut stream, &mut buffer, &mut PWSTR::null())
            .map_err(mtp_error)?;
        let stream = stream.ok_or_else(|| mtp_error("書き込み先を作れませんでした"))?;
        (stream, buffer.max(4096) as usize)
    };
    let writer = winmtp::io::WriteStream::new(stream.0, stream.1);
    let mut writer = std::io::BufWriter::with_capacity(stream.1, writer);
    std::io::copy(reader, &mut writer)?;
    // flush で Commit する（Commit しないと、ファイルができない）
    writer.flush()?;
    Ok(())
}

/// id のものを消す
fn delete(content: &Content, id: &U16CString) -> Result<()> {
    content.object_by_id(id.clone()).map_err(mtp_error)?.delete(false).map_err(mtp_error)
}

/// 写す（裏の仕事の中で呼ぶ）。step は1件ごとに呼び、false が返ったら（中止されたら）やめる。
/// 中止せずに終えたら、最後にデータ（json）を書く。途中でやめたときは書かない（半端な曲のデータを取り込まないため）
pub fn run(plan: PhonePlan, json: String, step: &mut dyn FnMut(bool) -> bool) -> Result<()> {
    let (content, storage) = open(&plan.device_id)?;
    // cyanomelody 用のフォルダ（なければ作る）と .nomedia
    let app_dir = match plan.app_dir {
        Some(id) => id,
        None => {
            let music = match storage.object_by_path(Path::new(MUSIC)) {
                Ok(m) => m,
                Err(_) => {
                    let id = storage.create_subfolder(OsStr::new(MUSIC)).map_err(mtp_error)?;
                    content.object_by_id(id).map_err(mtp_error)?
                }
            };
            music.create_subfolder(OsStr::new(APP_DIR)).map_err(mtp_error)?
        }
    };
    if !plan.has_nomedia {
        push_fast(&content, &app_dir, NOMEDIA, 0, &mut std::io::empty())?;
    }
    let mut folders = plan.folders;
    // 親のフォルダの id（なければ1段ずつ作る）
    let mut folder_of = |rel_dir: &str| -> Result<U16CString> {
        let mut parent = app_dir.clone();
        let mut path = String::new();
        for part in rel_dir.split('/').filter(|p| !p.is_empty()) {
            path = if path.is_empty() { part.to_string() } else { format!("{path}/{part}") };
            let key = path.to_lowercase();
            parent = match folders.get(&key) {
                Some(id) => id.clone(),
                None => {
                    let obj = content.object_by_id(parent.clone()).map_err(mtp_error)?;
                    let id = obj.create_subfolder(OsStr::new(part)).map_err(mtp_error)?;
                    folders.insert(key, id.clone());
                    id
                }
            };
        }
        Ok(parent)
    };
    for id in &plan.delete {
        let ok = delete(&content, id).inspect_err(|e| log::warn!("phone delete: {e}")).is_ok();
        if !step(ok) {
            return Ok(());
        }
    }
    for f in &plan.copy {
        let result = (|| -> Result<()> {
            if let Some(id) = plan.existing.get(&f.dest.to_lowercase()) {
                delete(&content, id)?;
            }
            let (dir, name) = f.dest.rsplit_once('/').unwrap_or(("", f.dest.as_str()));
            let parent = folder_of(dir)?;
            let mut file = std::fs::File::open(&f.source)?;
            let size = file.metadata()?.len();
            push_fast(&content, &parent, name, size, &mut file)
        })();
        if let Err(e) = &result {
            log::warn!("phone copy: {}: {e}", f.source.display());
        }
        if !step(result.is_ok()) {
            return Ok(());
        }
    }
    if let Some(id) = &plan.json {
        delete(&content, id)?;
    }
    let bytes = json.into_bytes();
    push_fast(&content, &app_dir, PACKAGE_JSON, bytes.len() as u64, &mut bytes.as_slice())
}

/// 写す件数（消す件数＋写す件数）
pub fn total_steps(plan: &PhonePlan) -> usize {
    plan.delete.len() + plan.copy.len()
}
