//! 音声ファイルのタグ情報（ID3、Vorbis コメント、MP4 のメタデータ、WAV の INFO など）を読む。

use std::fs::File;
use std::path::Path;

use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, MetadataRevision, StandardTagKey};
use symphonia::core::probe::Hint;

/// トラック名（タイトル）。読めないファイルや、タイトルがないファイルでは None
pub fn track_title(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    // 形式の外側のタグ（MP3 の先頭の ID3v2 など）を先に見て、なければ形式の中のタグを見る
    if let Some(title) = probed.metadata.get().as_ref().and_then(|m| m.current()).and_then(title_of) {
        return Some(title);
    }
    let metadata = probed.format.metadata();
    metadata.current().and_then(title_of)
}

fn title_of(revision: &MetadataRevision) -> Option<String> {
    revision
        .tags()
        .iter()
        .filter(|t| t.std_key == Some(StandardTagKey::TrackTitle))
        // WAV の INFO などは末尾に NUL が付いている
        .map(|t| t.value.to_string().trim_matches(|c: char| c.is_whitespace() || c == '\0').to_owned())
        .find(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    #[test]
    fn reads_title_of_each_format() {
        // テスト用の素材には、形式ごとのタグ（ID3v2、WAV の INFO、Vorbis コメント、MP4）でタイトル「元」が入っている
        for ext in ["mp3", "wav", "flac", "ogg", "m4a"] {
            assert_eq!(track_title(&fixture(&format!("base.{ext}"))).as_deref(), Some("元"), "{ext}");
        }
    }

    #[test]
    fn none_without_title() {
        let dir = tempfile::tempdir().unwrap();
        // タグのない WAV、ないファイル、音声でないファイル
        let plain = dir.path().join("plain.wav");
        crate::effects::write_wav(&plain, &crate::effects::decode(&fixture("base.wav")).unwrap()).unwrap();
        assert_eq!(track_title(&plain), None);
        assert_eq!(track_title(&dir.path().join("none.wav")), None);
        let text = dir.path().join("text.mp3");
        fs::write(&text, "not audio").unwrap();
        assert_eq!(track_title(&text), None);
    }
}
