//! cyanomelody の中核。OS に依存しない処理（再生順の制御、音楽ソース、保存など）を置く。
//! Tauri や画面には依存しない。

pub mod cache;
pub mod device;
pub mod drive;
pub mod library;
pub mod parallel;
pub mod playback;
pub mod source;
pub mod sync;

/// 中核のバージョン。
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_workspace_version() {
        assert_eq!(version(), "0.1.0");
    }
}
