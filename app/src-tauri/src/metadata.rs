//! 音声ファイルのタグ情報（ID3、Vorbis コメント、MP4 のメタデータ、WAV の INFO など）と、長さを読む。

use std::fs::File;
use std::path::Path;

use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::units::TimeBase;
use symphonia::core::meta::{MetadataOptions, MetadataRevision, StandardTagKey};
use symphonia::core::probe::{Hint, ProbeResult};

/// ファイルを開いて、形式を調べる。読めないファイルでは None
fn probe(path: &Path) -> Option<ProbeResult> {
    let file = File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()
}

/// トラック名（タイトル）。読めないファイルや、タイトルがないファイルでは None
pub fn track_title(path: &Path) -> Option<String> {
    let mut probed = probe(path)?;
    // 形式の外側のタグ（MP3 の先頭の ID3v2 など）を先に見て、なければ形式の中のタグを見る
    if let Some(title) = probed.metadata.get().as_ref().and_then(|m| m.current()).and_then(title_of) {
        return Some(title);
    }
    let metadata = probed.format.metadata();
    metadata.current().and_then(title_of)
}

/// 長さ（秒）。音声ファイルの情報（全体のフレーム数）から求め、情報にないとき（一部の MP3 など）は
/// 音声データのパケットを最後までたどって（デコードはせずに）足し合わせる。読めないファイルでは None
pub fn duration(path: &Path) -> Option<f64> {
    let mut format = probe(path)?.format;
    let track = format.default_track()?;
    let track_id = track.id;
    let params = &track.codec_params;
    let time_base = params.time_base.or_else(|| params.sample_rate.map(|r| TimeBase::new(1, r)))?;
    let frames = match params.n_frames {
        Some(n) => n,
        None => {
            let mut total = 0;
            while let Ok(packet) = format.next_packet() {
                if packet.track_id() == track_id {
                    total += packet.dur;
                }
            }
            total
        }
    };
    let time = time_base.calc_time(frames);
    let seconds = time.seconds as f64 + time.frac;
    (seconds > 0.0).then_some(seconds)
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
    fn reads_duration_of_each_format() {
        // テスト用の素材は、どの形式も同じ音（0.3秒）
        let wav = duration(&fixture("base.wav")).unwrap();
        assert!((wav - 0.3).abs() < 0.01, "wav {wav}");
        for ext in ["mp3", "flac", "ogg", "m4a"] {
            let d = duration(&fixture(&format!("base.{ext}"))).unwrap();
            assert!((d - wav).abs() < 0.1, "{ext}: {d} / wav {wav}");
        }
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("text.mp3");
        fs::write(&text, "not audio").unwrap();
        assert_eq!(duration(&text), None);
        assert_eq!(duration(&dir.path().join("none.wav")), None);
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
