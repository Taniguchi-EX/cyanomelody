//! 端末 ID。初回起動時に発行し、アプリのデータ領域に保存する。
//! 設定ファイルの端末ごとの値と、ローカルの曲を追加した端末の判定に使う。

use std::io;
use std::path::Path;

const FILE_NAME: &str = "device_id";

/// `data_dir` に保存した端末 ID を読む。なければ発行して保存する。
pub fn load_or_create(data_dir: &Path) -> io::Result<String> {
    let path = data_dir.join(FILE_NAME);
    match std::fs::read_to_string(&path) {
        Ok(id) if is_valid(id.trim()) => return Ok(id.trim().to_string()),
        Ok(_) => log::warn!("端末 ID のファイルが壊れているため、発行し直す"),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::fs::create_dir_all(data_dir)?;
    let id = format!("{:032x}", fastrand::u128(..));
    std::fs::write(&path, &id)?;
    log::info!("端末 ID を発行した: {id}");
    Ok(id)
}

fn is_valid(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_once_and_reuses() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("データ");
        let first = load_or_create(&data).unwrap();
        assert!(is_valid(&first));
        assert_eq!(load_or_create(&data).unwrap(), first, "2 回目は同じ ID");
    }

    #[test]
    fn replaces_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), "壊れた").unwrap();
        let id = load_or_create(dir.path()).unwrap();
        assert!(is_valid(&id));
    }
}
