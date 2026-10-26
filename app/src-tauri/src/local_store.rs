//! 端末のデータ領域に保存するもの。
//!
//! - `local.json`：端末だけで持つ設定（キャッシュの最大容量、アプリ内の音量）
//! - `settings.json`：最後に読んだ設定（Drive で共有するもの）。オフラインで起動しても指定フォルダの曲を開くため
//! - `playlists.json`：最後に読んだプレイリスト。オフラインでも開いて再生するため

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cyanomelody_core::cache::DEFAULT_MAX_BYTES;
use cyanomelody_core::sync::{Playlist, PlaylistSummary, Settings, sort_summaries};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_json(path: &Path, value: &impl Serialize) {
    let json = serde_json::to_vec(value).expect("JSON にできない値はない");
    if let Err(e) = std::fs::write(path, json) {
        log::warn!("{} に保存できない: {e}", path.display());
    }
}

/// 端末だけで持つ設定（Drive で共有しないもの）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalConfig {
    pub cache_max_bytes: u64,
    pub volume: f32,
}

impl Default for LocalConfig {
    fn default() -> Self {
        Self { cache_max_bytes: DEFAULT_MAX_BYTES, volume: 0.8 }
    }
}

pub struct LocalStore {
    config_path: PathBuf,
    settings_path: PathBuf,
    config: Mutex<LocalConfig>,
    playlists_path: PathBuf,
    playlists: Mutex<HashMap<String, Playlist>>,
}

impl LocalStore {
    pub fn open(data_dir: &Path) -> Self {
        let config_path = data_dir.join("local.json");
        let playlists_path = data_dir.join("playlists.json");
        Self {
            config: Mutex::new(read_json(&config_path).unwrap_or_default()),
            playlists: Mutex::new(read_json(&playlists_path).unwrap_or_default()),
            config_path,
            playlists_path,
            settings_path: data_dir.join("settings.json"),
        }
    }

    pub fn config(&self) -> LocalConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn edit_config(&self, edit: impl FnOnce(&mut LocalConfig)) {
        let mut config = self.config.lock().unwrap();
        edit(&mut config);
        write_json(&self.config_path, &*config);
    }

    /// 最後に読んだ設定。
    pub fn settings(&self) -> Option<Settings> {
        read_json(&self.settings_path)
    }

    pub fn save_settings(&self, settings: &Settings) {
        write_json(&self.settings_path, settings);
    }

    pub fn playlist(&self, id: &str) -> Option<Playlist> {
        self.playlists.lock().unwrap().get(id).cloned()
    }

    pub fn save_playlist(&self, p: &Playlist) {
        let mut items = self.playlists.lock().unwrap();
        items.insert(p.id.clone(), p.clone());
        write_json(&self.playlists_path, &*items);
    }

    pub fn remove_playlist(&self, id: &str) {
        let mut items = self.playlists.lock().unwrap();
        if items.remove(id).is_some() {
            write_json(&self.playlists_path, &*items);
        }
    }

    /// Drive の一覧にないプレイリスト（ほかの端末で削除されたもの）を捨てる。
    pub fn keep_playlists(&self, ids: &[&str]) {
        let mut items = self.playlists.lock().unwrap();
        let before = items.len();
        items.retain(|id, _| ids.contains(&id.as_str()));
        if items.len() != before {
            write_json(&self.playlists_path, &*items);
        }
    }

    /// 保存したプレイリストの一覧（一覧の順に並べたもの）。
    pub fn playlist_summaries(&self) -> Vec<PlaylistSummary> {
        let mut list: Vec<_> = self.playlists.lock().unwrap().values().map(PlaylistSummary::from).collect();
        sort_summaries(&mut list);
        list
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn survives_reopen() {
        let dir = std::env::temp_dir().join(format!("cyanomelody-local-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = LocalStore::open(&dir);
            store.edit_config(|c| c.volume = 0.3);
            let mut a = Playlist::new("あ");
            a.favorite = true;
            store.save_playlist(&a);
            store.save_playlist(&Playlist::new("い"));
            store.save_settings(&Settings::default());
        }
        let store = LocalStore::open(&dir);
        assert_eq!(store.config().volume, 0.3);
        assert!(store.settings().is_some());
        let names: Vec<String> = store.playlist_summaries().into_iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["あ", "い"], "お気に入りが先");
        let keep = store.playlist_summaries()[1].id.clone();
        store.keep_playlists(&[keep.as_str()]);
        assert_eq!(store.playlist_summaries().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
