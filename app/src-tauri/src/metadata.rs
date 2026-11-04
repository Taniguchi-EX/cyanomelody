//! 音声ファイルのタグ情報（ID3、Vorbis コメント、MP4 のメタデータ、WAV の INFO など）と、長さを読む。

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
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
    // WAV の INFO は、symphonia が UTF-8 として読む（Shift_JIS の文字が失われる）ので、ファイルから直接読む
    if let Some(bytes) = riff_info_title(path) {
        let title = clean(&decode_bytes(&bytes).unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned()));
        if !title.is_empty() {
            return Some(title);
        }
    }
    // ID3 の ISO-8859-1 の項目を読み直すのは MP3 だけ（ほかの形式のタグは UTF-8 と決まっている）
    let id3 = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    let read_title = |revision: &MetadataRevision| title_of(revision, id3);
    let mut probed = probe(path)?;
    // 形式の外側のタグ（MP3 の先頭の ID3v2 など）を先に見て、なければ形式の中のタグを見る
    if let Some(title) = probed.metadata.get().as_ref().and_then(|m| m.current()).and_then(read_title) {
        return Some(title);
    }
    let metadata = probed.format.metadata();
    metadata.current().and_then(read_title)
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

/// 曲名のタグ。id3 なら、ISO-8859-1 として読まれた文字を読み直す
fn title_of(revision: &MetadataRevision, id3: bool) -> Option<String> {
    revision
        .tags()
        .iter()
        .filter(|t| t.std_key == Some(StandardTagKey::TrackTitle))
        .map(|t| {
            let text = t.value.to_string();
            clean(&if id3 { reinterpret_latin1(text) } else { text })
        })
        .find(|t| !t.is_empty())
}

/// 前後の空白と NUL（WAV の INFO などは末尾に付いている）を除く
fn clean(text: &str) -> String {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_owned()
}

/// バイト列の文字コードを判定して文字にする。UTF-8 として正しければ UTF-8、そうでなく Shift_JIS として正しければ
/// Shift_JIS。どちらでもなければ None
fn decode_bytes(bytes: &[u8]) -> Option<String> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Some(text.to_owned());
    }
    encoding_rs::SHIFT_JIS
        .decode_without_bom_handling_and_without_replacement(bytes)
        .map(|text| text.into_owned())
}

/// ID3 の ISO-8859-1 の項目は、symphonia が1バイトを1文字にしている。Shift_JIS や UTF-8 で書かれたものは
/// 文字化けするので、すべて U+00FF 以下で 0x80 以上の文字を含むときは、元のバイト列に戻して判定し直す。
/// 判定できなければ（欧文の ISO-8859-1 など）、そのまま
fn reinterpret_latin1(text: String) -> String {
    if !text.chars().all(|c| (c as u32) <= 0xff) || text.is_ascii() {
        return text;
    }
    let bytes: Vec<u8> = text.chars().map(|c| c as u8).collect();
    decode_bytes(&bytes).unwrap_or(text)
}

/// WAV（RIFF）の LIST/INFO の曲名（INAM）のバイト列。WAV でないファイルや、曲名がないときは None
fn riff_info_title(path: &Path) -> Option<Vec<u8>> {
    let mut file = BufReader::new(File::open(path).ok()?);
    let mut header = [0u8; 12];
    file.read_exact(&mut header).ok()?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return None;
    }
    // チャンクを順にたどる（大きさが奇数のチャンクの後には、1バイトの詰め物がある）
    let read_chunk_header = |file: &mut BufReader<File>| -> Option<([u8; 4], u64)> {
        let mut h = [0u8; 8];
        file.read_exact(&mut h).ok()?;
        let len = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as u64;
        Some(([h[0], h[1], h[2], h[3]], len))
    };
    while let Some((id, len)) = read_chunk_header(&mut file) {
        let padded = len + (len & 1);
        if &id == b"LIST" && len >= 4 {
            let mut kind = [0u8; 4];
            file.read_exact(&mut kind).ok()?;
            if &kind == b"INFO" {
                let mut rest = len - 4;
                while rest >= 8 {
                    let (sub, sub_len) = read_chunk_header(&mut file)?;
                    let sub_padded = sub_len + (sub_len & 1);
                    if sub_len > rest - 8 {
                        return None;
                    }
                    if &sub == b"INAM" {
                        let mut value = vec![0u8; sub_len as usize];
                        file.read_exact(&mut value).ok()?;
                        return Some(value);
                    }
                    file.seek(SeekFrom::Current(sub_padded as i64)).ok()?;
                    rest = rest.saturating_sub(8 + sub_padded);
                }
                return None;
            }
            file.seek(SeekFrom::Current(padded as i64 - 4)).ok()?;
        } else {
            file.seek(SeekFrom::Current(padded as i64)).ok()?;
        }
    }
    None
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

    /// タグのない WAV に、曲名（INAM）だけの LIST/INFO を加えたファイルを作る
    fn wav_with_title(dir: &Path, name: &str, title: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        crate::effects::write_wav(&path, &crate::effects::decode(&fixture("base.wav")).unwrap()).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let mut inam = title.to_vec();
        inam.push(0);
        let mut list = b"INFO".to_vec();
        list.extend(b"INAM");
        list.extend((inam.len() as u32).to_le_bytes());
        list.extend(&inam);
        if inam.len() % 2 == 1 {
            list.push(0);
        }
        bytes.extend(b"LIST");
        bytes.extend((list.len() as u32).to_le_bytes());
        bytes.extend(&list);
        let riff_len = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_len.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        path
    }

    /// テスト用の MP3 の先頭の ID3v2 を、曲名（TIT2、文字コードは ISO-8859-1）だけのものに差し替えたファイルを作る
    fn mp3_with_latin1_title(dir: &Path, name: &str, title: &[u8]) -> std::path::PathBuf {
        let base = fs::read(fixture("base.mp3")).unwrap();
        assert_eq!(&base[0..3], b"ID3");
        let size = base[6..10].iter().fold(0usize, |n, &b| (n << 7) | b as usize);
        let audio = &base[10 + size..];
        let mut frame = b"TIT2".to_vec();
        frame.extend(((title.len() + 1) as u32).to_be_bytes());
        frame.extend([0, 0, 0]);
        frame.extend(title);
        let mut tag = b"ID3\x03\x00\x00".to_vec();
        let n = frame.len();
        tag.extend([(n >> 21) as u8 & 0x7f, (n >> 14) as u8 & 0x7f, (n >> 7) as u8 & 0x7f, n as u8 & 0x7f]);
        tag.extend(frame);
        tag.extend(audio);
        let path = dir.join(name);
        fs::write(&path, tag).unwrap();
        path
    }

    #[test]
    fn reads_shift_jis_and_utf8_titles() {
        let dir = tempfile::tempdir().unwrap();
        let sjis = |s: &str| encoding_rs::SHIFT_JIS.encode(s).0.into_owned();
        // WAV の INFO：Shift_JIS・UTF-8 のどちらでも読める（奇数の長さの詰め物も）
        let wav = wav_with_title(dir.path(), "sjis.wav", &sjis("爆発音・大"));
        assert_eq!(track_title(&wav).as_deref(), Some("爆発音・大"));
        let wav = wav_with_title(dir.path(), "utf8.wav", "足音（砂利）".as_bytes());
        assert_eq!(track_title(&wav).as_deref(), Some("足音（砂利）"));
        let wav = wav_with_title(dir.path(), "odd.wav", b"abc");
        assert_eq!(track_title(&wav).as_deref(), Some("abc"));
        // MP3 の ID3v2（ISO-8859-1 と書かれた項目）：Shift_JIS・UTF-8 のバイト列なら読み直す。欧文はそのまま
        let mp3 = mp3_with_latin1_title(dir.path(), "sjis.mp3", &sjis("チャイム"));
        assert_eq!(track_title(&mp3).as_deref(), Some("チャイム"));
        let mp3 = mp3_with_latin1_title(dir.path(), "utf8.mp3", "雨音".as_bytes());
        assert_eq!(track_title(&mp3).as_deref(), Some("雨音"));
        let mp3 = mp3_with_latin1_title(dir.path(), "latin1.mp3", b"Caf\xe9 au lait");
        assert_eq!(track_title(&mp3).as_deref(), Some("Café au lait"));
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
