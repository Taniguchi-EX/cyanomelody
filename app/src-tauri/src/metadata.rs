//! 音声ファイルのタグ情報（ID3、Vorbis コメント、MP4 のメタデータ、WAV の INFO など）と、長さを読む。

use std::collections::HashMap;
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

/// ID3 の ISO-8859-1 の項目を読み直すのは MP3 だけ（ほかの形式のタグは UTF-8 と決まっている）
fn is_mp3(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp3"))
}

/// WAV の INFO の項目の文字。文字コードを判定する（どちらでもなければ UTF-8 として読み、読めない部分は「�」）
fn riff_text(info: &HashMap<[u8; 4], Vec<u8>>, id: &[u8; 4]) -> Option<String> {
    let bytes = info.get(id)?;
    let text = clean(&decode_bytes(bytes).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned()));
    (!text.is_empty()).then_some(text)
}

/// トラック名（タイトル）。読めないファイルや、タイトルがないファイルでは None
pub fn track_title(path: &Path) -> Option<String> {
    // WAV の INFO は、symphonia が UTF-8 として読む（Shift_JIS の文字が失われる）ので、ファイルから直接読む
    if let Some(title) = riff_info(path).and_then(|info| riff_text(&info, b"INAM")) {
        return Some(title);
    }
    let id3 = is_mp3(path);
    let read_title = |revision: &MetadataRevision| title_of(revision, id3);
    let mut probed = probe(path)?;
    // 形式の外側のタグ（MP3 の先頭の ID3v2 など）を先に見て、なければ形式の中のタグを見る
    if let Some(title) = probed.metadata.get().as_ref().and_then(|m| m.current()).and_then(read_title) {
        return Some(title);
    }
    let metadata = probed.format.metadata();
    metadata.current().and_then(read_title)
}

/// 自動タグ付けに使う、ファイルの中の情報。ない項目は None
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileMeta {
    /// アーティスト。なければアルバムアーティスト
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub composer: Option<String>,
}

/// アーティスト・アルバム・ジャンル・作曲者を読む。読めないファイルでは None。
/// 文字コードは曲名と同じく読み直す（MP3 の ISO-8859-1 の項目、WAV の INFO）
pub fn file_meta(path: &Path) -> Option<FileMeta> {
    let id3 = is_mp3(path);
    let mut probed = probe(path)?;
    let mut meta = FileMeta::default();
    let mut album_artist = None;
    let mut take = |revision: &MetadataRevision| {
        for tag in revision.tags() {
            let raw = tag.value.to_string();
            let raw = if id3 { reinterpret_latin1(raw) } else { raw };
            // ID3v2.4 の複数の値は NUL で区切られている。最初の値を使う
            let Some(text) = raw.split('\0').map(clean).find(|t| !t.is_empty()) else { continue };
            let slot = match tag.std_key {
                Some(StandardTagKey::Artist) => &mut meta.artist,
                Some(StandardTagKey::AlbumArtist) => &mut album_artist,
                Some(StandardTagKey::Album) => &mut meta.album,
                Some(StandardTagKey::Genre) => &mut meta.genre,
                Some(StandardTagKey::Composer) => &mut meta.composer,
                _ => continue,
            };
            // 形式の外側のタグ（MP3 の先頭の ID3v2 など）を先に読むので、先に見つかった値を使う
            slot.get_or_insert(text);
        }
    };
    if let Some(revision) = probed.metadata.get().as_ref().and_then(|m| m.current()) {
        take(revision);
    }
    if let Some(revision) = probed.format.metadata().current() {
        take(revision);
    }
    // WAV の INFO は、文字コードを判定するためにファイルから直接読み直す
    if let Some(info) = riff_info(path) {
        for (id, slot) in [(b"IART", &mut meta.artist), (b"IPRD", &mut meta.album), (b"IGNR", &mut meta.genre)] {
            if let Some(text) = riff_text(&info, id) {
                *slot = Some(text);
            }
        }
    }
    meta.artist = meta.artist.or(album_artist);
    meta.genre = meta.genre.map(|g| genre_name(&g));
    Some(meta)
}

/// ID3 のジャンルの番号の書き方（「(17)」「17」「(17)Rock」）をジャンル名にする。番号でなければそのまま
fn genre_name(text: &str) -> String {
    let by_number = |n: &str| -> Option<String> {
        let n: u8 = n.trim().parse().ok()?;
        symphonia_metadata::id3v1::util::genre_name(n).map(|g| g.to_string())
    };
    if let Some(rest) = text.strip_prefix('(') {
        if let Some((number, after)) = rest.split_once(')') {
            let after = after.trim();
            if !after.is_empty() {
                return after.to_string();
            }
            if let Some(name) = by_number(number) {
                return name;
            }
        }
    }
    by_number(text).unwrap_or_else(|| text.to_string())
}

/// 裏で調べて保存する情報（長さとリリース年）
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AudioInfo {
    /// 長さ（秒）
    pub duration: Option<f64>,
    /// リリース年
    pub year: Option<i32>,
}

/// 長さとリリース年を、ファイルを1回開いて調べる。読めないファイルでは両方とも None
pub fn audio_info(path: &Path) -> AudioInfo {
    let Some(mut probed) = probe(path) else { return AudioInfo::default() };
    // 形式の外側のタグ（MP3 の先頭の ID3v2 など）と、形式の中のタグの両方から、項目の順に探す
    let mut dates: Vec<(StandardTagKey, String)> = Vec::new();
    let mut collect = |revision: &MetadataRevision| {
        for tag in revision.tags() {
            if let Some(key @ (StandardTagKey::Date | StandardTagKey::ReleaseDate | StandardTagKey::OriginalDate)) = tag.std_key {
                dates.push((key, tag.value.to_string()));
            }
        }
    };
    if let Some(revision) = probed.metadata.get().as_ref().and_then(|m| m.current()) {
        collect(revision);
    }
    if let Some(revision) = probed.format.metadata().current() {
        collect(revision);
    }
    let year = [StandardTagKey::Date, StandardTagKey::ReleaseDate, StandardTagKey::OriginalDate]
        .iter()
        .find_map(|key| dates.iter().filter(|(k, _)| k == key).find_map(|(_, v)| parse_year(v)))
        // WAV の INFO の日付（ICRD）は、ファイルから直接読む（WAV でないファイルは開き直さない）
        .or_else(|| {
            let wav = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("wav"));
            wav.then(|| riff_info(path)).flatten().and_then(|info| riff_text(&info, b"ICRD")).and_then(|v| parse_year(&v))
        });
    AudioInfo { duration: duration_of(probed.format), year }
}

/// 日付の値から年を取り出す（「2006」「2026-04-14」「20160219」など、先頭の4桁の数字。1000〜2999 のときだけ）
fn parse_year(text: &str) -> Option<i32> {
    let t = text.trim();
    let digits: String = t.chars().take(4).collect();
    if digits.len() != 4 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let year: i32 = digits.parse().ok()?;
    (1000..=2999).contains(&year).then_some(year)
}

/// 長さ（秒）。音声ファイルの情報（全体のフレーム数）から求め、情報にないとき（一部の MP3 など）は
/// 音声データのパケットを最後までたどって（デコードはせずに）足し合わせる。読めないファイルでは None
#[cfg(test)]
pub fn duration(path: &Path) -> Option<f64> {
    duration_of(probe(path)?.format)
}

fn duration_of(mut format: Box<dyn symphonia::core::formats::FormatReader>) -> Option<f64> {
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

/// WAV（RIFF）の LIST/INFO の項目（INAM・IART など）のバイト列。WAV でないファイルや、INFO がないときは None
fn riff_info(path: &Path) -> Option<HashMap<[u8; 4], Vec<u8>>> {
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
                let mut items = HashMap::new();
                while rest >= 8 {
                    let Some((sub, sub_len)) = read_chunk_header(&mut file) else { break };
                    let sub_padded = sub_len + (sub_len & 1);
                    if sub_len > rest - 8 {
                        break;
                    }
                    let mut value = vec![0u8; sub_len as usize];
                    if file.read_exact(&mut value).is_err() {
                        break;
                    }
                    items.entry(sub).or_insert(value);
                    if sub_len & 1 == 1 {
                        file.seek(SeekFrom::Current(1)).ok()?;
                    }
                    rest = rest.saturating_sub(8 + sub_padded);
                }
                return Some(items);
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

    /// タグのない WAV に、items（INAM・IART など）の LIST/INFO を加えたファイルを作る
    fn wav_with_info(dir: &Path, name: &str, items: &[(&[u8; 4], &[u8])]) -> std::path::PathBuf {
        let path = dir.join(name);
        crate::effects::write_wav(&path, &crate::effects::decode(&fixture("base.wav")).unwrap()).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let mut list = b"INFO".to_vec();
        for (id, value) in items {
            let mut v = value.to_vec();
            v.push(0);
            list.extend(*id);
            list.extend((v.len() as u32).to_le_bytes());
            list.extend(&v);
            if v.len() % 2 == 1 {
                list.push(0);
            }
        }
        bytes.extend(b"LIST");
        bytes.extend((list.len() as u32).to_le_bytes());
        bytes.extend(&list);
        let riff_len = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_len.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        path
    }

    fn wav_with_title(dir: &Path, name: &str, title: &[u8]) -> std::path::PathBuf {
        wav_with_info(dir, name, &[(b"INAM", title)])
    }

    /// テスト用の MP3 の先頭の ID3v2 を、frames（文字コードは ISO-8859-1）だけのものに差し替えたファイルを作る
    fn mp3_with_frames(dir: &Path, name: &str, frames: &[(&[u8; 4], &[u8])]) -> std::path::PathBuf {
        let base = fs::read(fixture("base.mp3")).unwrap();
        assert_eq!(&base[0..3], b"ID3");
        let size = base[6..10].iter().fold(0usize, |n, &b| (n << 7) | b as usize);
        let audio = &base[10 + size..];
        let mut body = vec![];
        for (id, value) in frames {
            body.extend(*id);
            body.extend(((value.len() + 1) as u32).to_be_bytes());
            body.extend([0, 0, 0]);
            body.extend(*value);
        }
        let mut tag = b"ID3\x03\x00\x00".to_vec();
        let n = body.len();
        tag.extend([(n >> 21) as u8 & 0x7f, (n >> 14) as u8 & 0x7f, (n >> 7) as u8 & 0x7f, n as u8 & 0x7f]);
        tag.extend(body);
        tag.extend(audio);
        let path = dir.join(name);
        fs::write(&path, tag).unwrap();
        path
    }

    fn mp3_with_latin1_title(dir: &Path, name: &str, title: &[u8]) -> std::path::PathBuf {
        mp3_with_frames(dir, name, &[(b"TIT2", title)])
    }

    #[test]
    fn reads_release_year() {
        let dir = tempfile::tempdir().unwrap();
        // MP3：TYER（日付）。リリース日（TDRL）より日付が先
        let mp3 = mp3_with_frames(dir.path(), "a.mp3", &[(b"TDRL", b"1999"), (b"TYER", b"2006")]);
        let info = audio_info(&mp3);
        assert_eq!(info.year, Some(2006));
        assert!(info.duration.is_some_and(|d| d > 0.1), "{:?}", info.duration);
        // 日付がなければリリース日
        let mp3 = mp3_with_frames(dir.path(), "b.mp3", &[(b"TDRL", b"2016-02-19")]);
        assert_eq!(audio_info(&mp3).year, Some(2016));
        // WAV の INFO（ICRD）
        let wav = wav_with_info(dir.path(), "c.wav", &[(b"ICRD", b"20160219")]);
        assert_eq!(audio_info(&wav).year, Some(2016));
        // 年のないファイル・読めないファイル
        assert_eq!(audio_info(&fixture("base.flac")).year, None);
        let text = dir.path().join("text.mp3");
        fs::write(&text, "not audio").unwrap();
        assert_eq!(audio_info(&text), AudioInfo::default());
        // 年の取り出し方
        assert_eq!(parse_year("2026-04-14"), Some(2026));
        assert_eq!(parse_year(" 2016/02/19"), Some(2016));
        assert_eq!(parse_year("06"), None);
        assert_eq!(parse_year("0999"), None);
        assert_eq!(parse_year("abcd"), None);
    }

    #[test]
    fn reads_meta_for_autotag() {
        let dir = tempfile::tempdir().unwrap();
        let sjis = |s: &str| encoding_rs::SHIFT_JIS.encode(s).0.into_owned();
        let some = |s: &str| Some(s.to_string());
        // MP3：Shift_JIS の値も読み直す。アーティストが空ならアルバムアーティスト。ジャンルの番号の書き方はジャンル名に
        let mp3 = mp3_with_frames(
            dir.path(),
            "a.mp3",
            &[(b"TPE2", &sjis("ゲームフリーク")), (b"TALB", &sjis("ポケモン")), (b"TCON", b"(17)"), (b"TCOM", &sjis("増田順一"))],
        );
        assert_eq!(
            file_meta(&mp3).unwrap(),
            FileMeta { artist: some("ゲームフリーク"), album: some("ポケモン"), genre: some("Rock"), composer: some("増田順一") }
        );
        // アーティストがあれば、アルバムアーティストは使わない。「(13)Pop」のように名前が続けばその名前
        let mp3 = mp3_with_frames(dir.path(), "b.mp3", &[(b"TPE1", b"Artist"), (b"TPE2", b"Album Artist"), (b"TCON", b"(13)Pop")]);
        let m = file_meta(&mp3).unwrap();
        assert_eq!((m.artist.as_deref(), m.genre.as_deref(), m.album), (Some("Artist"), Some("Pop"), None));
        // WAV の INFO（Shift_JIS）
        let wav = wav_with_info(dir.path(), "c.wav", &[(b"IART", &sjis("黒魔")), (b"IPRD", &sjis("アルバム名")), (b"IGNR", b"Techno")]);
        assert_eq!(
            file_meta(&wav).unwrap(),
            FileMeta { artist: some("黒魔"), album: some("アルバム名"), genre: some("Techno"), composer: None }
        );
        // テスト用の素材（ffmpeg で作ったもの）は曲名だけで、ほかの項目はない
        for ext in ["flac", "ogg", "m4a"] {
            assert_eq!(file_meta(&fixture(&format!("base.{ext}"))).unwrap(), FileMeta::default(), "{ext}");
        }
        // 読めないファイル
        let text = dir.path().join("text.mp3");
        fs::write(&text, "not audio").unwrap();
        assert_eq!(file_meta(&text), None);
        // 番号でないジャンルはそのまま
        assert_eq!(genre_name("J-POP"), "J-POP");
        assert_eq!(genre_name("17"), "Rock");
        assert_eq!(genre_name("(999)"), "(999)");
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
