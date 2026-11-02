//! エフェクトをかけた音を作って、データ領域に置く（同じファイル・同じ設定なら作り直さずに使い回す）

use std::fs;
use std::path::{Path, PathBuf};

use crate::effects::{apply_all, decode, write_wav, Effect};

/// 置いておく音の合計の上限。超えたら古いものから消す
const CACHE_LIMIT: u64 = 1024 * 1024 * 1024;

/// 元のファイル（パス・大きさ・更新日時）とエフェクトの設定から、置き場所のファイル名を決める。
/// 元のファイルが変わるか、設定が変わると、別の名前になる
fn cache_key(source: &Path, effects: &[Effect]) -> String {
    let meta = fs::metadata(source).ok();
    let size = meta.as_ref().map_or(0, |m| m.len());
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let effects = serde_json::to_string(&effects.iter().map(Effect::clamped).collect::<Vec<_>>()).unwrap_or_default();
    let mut h = blake3::Hasher::new();
    h.update(source.to_string_lossy().as_bytes());
    h.update(&size.to_le_bytes());
    h.update(&modified.to_le_bytes());
    h.update(effects.as_bytes());
    h.finalize().to_hex()[..32].to_string()
}

/// source にエフェクトを順にかけた音を、cache_dir の中のWAVとして用意し、そのパスを返す
pub fn render(cache_dir: &Path, source: &Path, effects: &[Effect]) -> Result<PathBuf, String> {
    fs::create_dir_all(cache_dir).map_err(|e| format!("置き場所を作れません: {e}"))?;
    let out = cache_dir.join(format!("{}.wav", cache_key(source, effects)));
    if out.exists() {
        // 使ったことを残す（古いものから消すときの目安）
        let _ = fs::File::options().append(true).open(&out).and_then(|f| f.set_modified(std::time::SystemTime::now()));
        return Ok(out);
    }
    let audio = apply_all(decode(source)?, effects);
    // 書きかけのファイルを使わないよう、別の名前で書いてから名前を変える
    let tmp = out.with_extension("tmp");
    write_wav(&tmp, &audio).map_err(|e| format!("書き出せません: {e}"))?;
    fs::rename(&tmp, &out).map_err(|e| format!("書き出せません: {e}"))?;
    trim(cache_dir, CACHE_LIMIT);
    Ok(out)
}

/// 合計が limit を超えていたら、更新日時の古いものから消す
fn trim(cache_dir: &Path, limit: u64) {
    let Ok(entries) = fs::read_dir(cache_dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .filter(|(_, _, p)| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, size, path) in files {
        if total <= limit {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total -= size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/base.wav")
    }

    #[test]
    fn render_reuses_same_settings() {
        let dir = tempfile::tempdir().unwrap();
        let fx = [Effect::Gain { db: -6.0 }];
        let a = render(dir.path(), &fixture(), &fx).unwrap();
        let b = render(dir.path(), &fixture(), &fx).unwrap();
        assert_eq!(a, b);
        assert!(a.exists());
        let c = render(dir.path(), &fixture(), &[Effect::Gain { db: -3.0 }]).unwrap();
        assert_ne!(a, c);
        assert!(render(dir.path(), &dir.path().join("none.wav"), &fx).is_err());
    }

    #[test]
    fn trim_removes_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        for (i, name) in ["old.wav", "mid.wav", "new.wav"].iter().enumerate() {
            let p = dir.path().join(name);
            fs::write(&p, vec![0u8; 100]).unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + i as u64);
            fs::File::options().append(true).open(&p).unwrap().set_modified(t).unwrap();
        }
        trim(dir.path(), 150);
        assert!(!dir.path().join("old.wav").exists());
        assert!(!dir.path().join("mid.wav").exists());
        assert!(dir.path().join("new.wav").exists());
    }
}
