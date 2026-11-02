//! タグ情報を除いた音声データ部分のハッシュ値（BLAKE3）を計算する。
//! 形式ごとの対象は docs の「ハッシュ値の計算方法」を参照。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// 計算できなかった理由
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashError(pub String);

impl std::fmt::Display for HashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<std::io::Error> for HashError {
    fn from(e: std::io::Error) -> Self {
        HashError(format!("読み込みのエラー: {e}"))
    }
}

type Result<T> = std::result::Result<T, HashError>;

fn broken(message: &str) -> HashError {
    HashError(message.to_owned())
}

/// これ以下の大きさのファイルは、まとめてメモリに読んでから処理する（読む位置を何度も変えるため）
const IN_MEMORY_LIMIT: u64 = 16 * 1024 * 1024;

enum Source {
    Memory(Vec<u8>),
    File(BufReader<File>),
}

struct Reader {
    source: Source,
    len: u64,
}

impl Reader {
    fn open(path: &Path) -> Result<Self> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        let source = if len <= IN_MEMORY_LIMIT {
            let mut buf = Vec::with_capacity(len as usize);
            file.read_to_end(&mut buf)?;
            Source::Memory(buf)
        } else {
            Source::File(BufReader::with_capacity(1 << 16, file))
        };
        Ok(Reader { source, len })
    }

    /// pos から最大 n バイト読む（ファイルの終わりまで）
    fn read_at(&mut self, pos: u64, n: usize) -> Result<Vec<u8>> {
        match &mut self.source {
            Source::Memory(data) => {
                let start = (pos as usize).min(data.len());
                let end = start.saturating_add(n).min(data.len());
                Ok(data[start..end].to_vec())
            }
            Source::File(file) => {
                file.seek(SeekFrom::Start(pos))?;
                let mut buf = Vec::with_capacity(n);
                file.take(n as u64).read_to_end(&mut buf)?;
                Ok(buf)
            }
        }
    }

    fn read_exact_at(&mut self, pos: u64, n: usize) -> Result<Vec<u8>> {
        let buf = self.read_at(pos, n)?;
        if buf.len() < n {
            return Err(broken("ファイルが途中で終わっています"));
        }
        Ok(buf)
    }

    /// [start, end) をハッシュ関数に通す
    fn hash_range(&mut self, hasher: &mut blake3::Hasher, start: u64, end: u64) -> Result<()> {
        if end <= start {
            return Ok(());
        }
        match &mut self.source {
            Source::Memory(data) => {
                let slice = data
                    .get(start as usize..end as usize)
                    .ok_or_else(|| broken("ファイルが途中で終わっています"))?;
                hasher.update(slice);
            }
            Source::File(file) => {
                file.seek(SeekFrom::Start(start))?;
                let mut rest = end - start;
                let mut buf = vec![0u8; 1 << 16];
                while rest > 0 {
                    let n = rest.min(buf.len() as u64) as usize;
                    file.read_exact(&mut buf[..n])?;
                    hasher.update(&buf[..n]);
                    rest -= n as u64;
                }
            }
        }
        Ok(())
    }
}

/// 音声データ部分のハッシュ値を16進数の文字列で返す
pub fn audio_hash(path: &Path) -> Result<String> {
    let mut r = Reader::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let head = r.read_at(0, 12)?;
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE") {
        hash_wav(&mut r, &mut hasher)?;
    } else if head.starts_with(b"OggS") {
        hash_ogg(&mut r, &mut hasher)?;
    } else if head.get(4..8) == Some(b"ftyp") {
        hash_mp4(&mut r, &mut hasher)?;
    } else {
        // MP3とFLACは、先頭にID3v2が付くことがある
        let start = skip_id3v2(&mut r)?;
        let magic = r.read_at(start, 4)?;
        if magic == b"fLaC" {
            hash_flac(&mut r, &mut hasher, start)?;
        } else if magic.len() >= 2 && magic[0] == 0xFF && magic[1] & 0xE0 == 0xE0 {
            hash_mp3(&mut r, &mut hasher, start)?;
        } else {
            return Err(broken("対応していない形式です"));
        }
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// 先頭のID3v2タグ（複数続くこともある）を飛ばした位置を返す
fn skip_id3v2(r: &mut Reader) -> Result<u64> {
    let mut pos = 0;
    loop {
        let h = r.read_at(pos, 10)?;
        if h.len() < 10 || &h[0..3] != b"ID3" {
            return Ok(pos);
        }
        let size = h[6..10].iter().fold(0u64, |acc, b| (acc << 7) | (*b as u64 & 0x7F));
        let footer = if h[5] & 0x10 != 0 { 10 } else { 0 };
        pos += 10 + size + footer;
        if pos > r.len {
            return Err(broken("ID3v2タグの大きさが合いません"));
        }
    }
}

/// 末尾のタグ（ID3v1、APEv2、Lyrics3 v2）を除いた終わりの位置を返す
fn trim_trailing_tags(r: &mut Reader, start: u64) -> Result<u64> {
    let mut end = r.len;
    loop {
        if end >= start + 128 && r.read_at(end - 128, 3)? == b"TAG" {
            end -= 128;
            continue;
        }
        if end >= start + 32 {
            let footer = r.read_at(end - 32, 32)?;
            if footer.starts_with(b"APETAGEX") {
                let size = u32::from_le_bytes(footer[12..16].try_into().unwrap()) as u64;
                let flags = u32::from_le_bytes(footer[20..24].try_into().unwrap());
                let header = if flags & 0x8000_0000 != 0 { 32 } else { 0 };
                let total = size + header;
                if total > end - start {
                    return Err(broken("APEタグの大きさが合いません"));
                }
                end -= total;
                continue;
            }
        }
        if end >= start + 15 && r.read_at(end - 9, 9)? == b"LYRICS200" {
            let digits = r.read_at(end - 15, 6)?;
            let size: u64 = std::str::from_utf8(&digits)
                .ok()
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| broken("Lyrics3タグの大きさが読めません"))?;
            if size + 15 > end - start {
                return Err(broken("Lyrics3タグの大きさが合いません"));
            }
            end -= size + 15;
            continue;
        }
        return Ok(end);
    }
}

/// MPEGのフレームヘッダから、Layer IIIのフレームの長さを求める。Layer III以外や不正な値なら None
fn mp3_frame_len(h: &[u8]) -> Option<u64> {
    if h.len() < 4 || h[0] != 0xFF || h[1] & 0xE0 != 0xE0 {
        return None;
    }
    let version = (h[1] >> 3) & 3; // 3: MPEG1, 2: MPEG2, 0: MPEG2.5
    let layer = (h[1] >> 1) & 3; // 1: Layer III
    if layer != 1 || version == 1 {
        return None;
    }
    const BR_V1: [u64; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const BR_V2: [u64; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let br_index = (h[2] >> 4) as usize;
    let sr_index = ((h[2] >> 2) & 3) as usize;
    if br_index == 0 || br_index == 15 || sr_index == 3 {
        return None;
    }
    let (bitrate, base_rate, coef) = match version {
        3 => (BR_V1[br_index], [44100, 48000, 32000][sr_index], 144),
        2 => (BR_V2[br_index], [22050, 24000, 16000][sr_index], 72),
        _ => (BR_V2[br_index], [11025, 12000, 8000][sr_index], 72),
    };
    let padding = ((h[2] >> 1) & 1) as u64;
    Some(coef * bitrate * 1000 / base_rate + padding)
}

/// 先頭のフレームがXing/Info/VBRIヘッダ（エンコーダの情報などを入れる、音声ではないフレーム）なら、
/// その次の位置を返す。作り直すと書き換わるため対象にしない。
fn skip_vbr_header_frame(r: &mut Reader, start: u64) -> Result<u64> {
    let h = r.read_at(start, 40)?;
    let Some(len) = mp3_frame_len(&h) else {
        return Ok(start);
    };
    let mpeg1 = (h[1] >> 3) & 3 == 3;
    let mono = h[3] >> 6 == 3;
    let side_info = match (mpeg1, mono) {
        (true, true) => 17,
        (true, false) => 32,
        (false, true) => 9,
        (false, false) => 17,
    };
    let xing = h.get(4 + side_info..8 + side_info);
    let is_header = xing == Some(b"Xing") || xing == Some(b"Info") || h.get(36..40) == Some(b"VBRI");
    Ok(if is_header && start + len <= r.len { start + len } else { start })
}

fn hash_mp3(r: &mut Reader, hasher: &mut blake3::Hasher, start: u64) -> Result<()> {
    let start = skip_vbr_header_frame(r, start)?;
    let end = trim_trailing_tags(r, start)?;
    if end <= start {
        return Err(broken("音声データがありません"));
    }
    hasher.update(b"mp3:");
    r.hash_range(hasher, start, end)
}

fn hash_flac(r: &mut Reader, hasher: &mut blake3::Hasher, start: u64) -> Result<()> {
    let mut pos = start + 4;
    loop {
        let h = r.read_exact_at(pos, 4)?;
        let last = h[0] & 0x80 != 0;
        let len = ((h[1] as u64) << 16) | ((h[2] as u64) << 8) | h[3] as u64;
        pos += 4 + len;
        if pos > r.len {
            return Err(broken("FLACのメタデータブロックの大きさが合いません"));
        }
        if last {
            break;
        }
    }
    let end = trim_trailing_tags(r, pos)?;
    if end <= pos {
        return Err(broken("音声データがありません"));
    }
    hasher.update(b"flac:");
    r.hash_range(hasher, pos, end)
}

fn hash_wav(r: &mut Reader, hasher: &mut blake3::Hasher) -> Result<()> {
    hasher.update(b"wav:");
    let mut pos = 12;
    let (mut fmt, mut data) = (false, false);
    while pos + 8 <= r.len {
        let h = r.read_exact_at(pos, 8)?;
        let id: [u8; 4] = h[0..4].try_into().unwrap();
        let size = u32::from_le_bytes(h[4..8].try_into().unwrap()) as u64;
        let body = pos + 8;
        // 書き込み途中のファイルなどで、大きさがファイルの終わりを超えていることがある
        let end = (body + size).min(r.len);
        if &id == b"fmt " || &id == b"data" {
            hasher.update(&id);
            hasher.update(&(end - body).to_le_bytes());
            r.hash_range(hasher, body, end)?;
            fmt |= &id == b"fmt ";
            data |= &id == b"data" && end > body;
        }
        // チャンクは2バイト単位にそろえる
        pos = body + size + (size & 1);
    }
    if !fmt || !data {
        return Err(broken("WAVのfmtチャンクかdataチャンクがありません"));
    }
    Ok(())
}

fn hash_ogg(r: &mut Reader, hasher: &mut blake3::Hasher) -> Result<()> {
    hasher.update(b"ogg:");
    // シリアル番号ごとの、今読んでいるパケットの番号
    let mut packet_index: HashMap<u32, u64> = HashMap::new();
    let mut pos = 0;
    let mut hashed = false;
    while pos < r.len {
        let h = r.read_exact_at(pos, 27)?;
        if &h[0..4] != b"OggS" {
            return Err(broken("OGGのページの区切りが見つかりません"));
        }
        let serial = u32::from_le_bytes(h[14..18].try_into().unwrap());
        let nsegs = h[26] as usize;
        let table = r.read_exact_at(pos + 27, nsegs)?;
        let mut seg_pos = pos + 27 + nsegs as u64;
        let index = packet_index.entry(serial).or_insert(0);
        for &len in &table {
            let len = len as u64;
            if seg_pos + len > r.len {
                return Err(broken("OGGのページが途中で終わっています"));
            }
            // 2番目のパケット（コメントヘッダ）はタグ情報なので除く
            if *index != 1 && len > 0 {
                r.hash_range(hasher, seg_pos, seg_pos + len)?;
                hashed = true;
            }
            seg_pos += len;
            // 255未満のセグメントでパケットが終わる
            if len < 255 {
                *index += 1;
            }
        }
        pos = seg_pos;
    }
    if !hashed {
        return Err(broken("音声データがありません"));
    }
    Ok(())
}

fn hash_mp4(r: &mut Reader, hasher: &mut blake3::Hasher) -> Result<()> {
    hasher.update(b"mp4:");
    let mut pos = 0;
    let mut found = false;
    while pos + 8 <= r.len {
        let h = r.read_exact_at(pos, 8)?;
        let mut size = u32::from_be_bytes(h[0..4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = h[4..8].try_into().unwrap();
        let mut header = 8;
        if size == 1 {
            let large = r.read_exact_at(pos + 8, 8)?;
            size = u64::from_be_bytes(large.try_into().unwrap());
            header = 16;
        } else if size == 0 {
            size = r.len - pos;
        }
        if size < header || pos + size > r.len {
            return Err(broken("MP4のボックスの大きさが合いません"));
        }
        if &kind == b"mdat" && size > header {
            r.hash_range(hasher, pos + header, pos + size)?;
            found = true;
        }
        pos += size;
    }
    if !found {
        return Err(broken("MP4の音声データ（mdat）がありません"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    const FORMATS: &[&str] = &["mp3", "wav", "flac", "ogg", "m4a"];

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    fn hash(name: &str) -> String {
        audio_hash(&fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    fn same_audio_with_different_tags_has_same_hash() {
        for ext in FORMATS {
            assert_eq!(hash(&format!("base.{ext}")), hash(&format!("retag.{ext}")), "{ext}");
        }
    }

    #[test]
    fn different_audio_has_different_hash() {
        for ext in FORMATS {
            assert_ne!(hash(&format!("base.{ext}")), hash(&format!("other.{ext}")), "{ext}");
        }
    }

    #[test]
    fn hashes_differ_between_formats() {
        let mut all: Vec<String> = FORMATS.iter().map(|e| hash(&format!("base.{e}"))).collect();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), FORMATS.len());
    }

    /// base.mp3 の前後にタグを足したファイルを作る
    fn mp3_with_extra_tags(dir: &Path) -> PathBuf {
        let audio = fs::read(fixture("base.mp3")).unwrap();
        let mut out = Vec::new();
        // ID3v2.3（中身は空のパディング20バイト）をもう1つ先頭に足す
        out.extend_from_slice(b"ID3\x03\x00\x00\x00\x00\x00\x14");
        out.extend_from_slice(&[0u8; 20]);
        out.extend_from_slice(&audio);
        // APEv2（ヘッダ付き、項目なし）
        let ape = |is_header: bool| {
            let mut b = b"APETAGEX".to_vec();
            b.extend_from_slice(&2000u32.to_le_bytes());
            b.extend_from_slice(&32u32.to_le_bytes()); // フッタを含み、ヘッダを含まない大きさ
            b.extend_from_slice(&0u32.to_le_bytes());
            let flags = 0x8000_0000u32 | if is_header { 0x2000_0000 } else { 0 };
            b.extend_from_slice(&flags.to_le_bytes());
            b.extend_from_slice(&[0u8; 8]);
            b
        };
        out.extend(ape(true));
        out.extend(ape(false));
        // Lyrics3 v2
        let lyrics = b"LYRICSBEGININD00002";
        out.extend_from_slice(lyrics);
        out.extend_from_slice(format!("{:06}", lyrics.len()).as_bytes());
        out.extend_from_slice(b"LYRICS200");
        // ID3v1
        let mut v1 = b"TAG".to_vec();
        v1.resize(128, b' ');
        out.extend(v1);
        let path = dir.join("extra.mp3");
        fs::write(&path, out).unwrap();
        path
    }

    #[test]
    fn mp3_ignores_id3v1_ape_lyrics3_and_extra_id3v2() {
        let dir = tempfile::tempdir().unwrap();
        let path = mp3_with_extra_tags(dir.path());
        assert_eq!(audio_hash(&path).unwrap(), hash("base.mp3"));
    }

    #[test]
    fn wav_ignores_list_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let mut wav = fs::read(fixture("base.wav")).unwrap();
        // 奇数の大きさのLISTチャンクを足す（2バイト単位のそろえを確かめる）
        let body = b"INFOINAM\x05\x00\x00\x00abcd\x00\x00x";
        wav.extend_from_slice(b"LIST");
        wav.extend_from_slice(&(body.len() as u32).to_le_bytes());
        wav.extend_from_slice(body);
        wav.push(0);
        let riff = (wav.len() - 8) as u32;
        wav[4..8].copy_from_slice(&riff.to_le_bytes());
        let path = dir.path().join("list.wav");
        fs::write(&path, wav).unwrap();
        assert_eq!(audio_hash(&path).unwrap(), hash("base.wav"));
    }

    #[test]
    fn flac_with_leading_id3v2_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let mut data = b"ID3\x04\x00\x00\x00\x00\x00\x0a".to_vec();
        data.extend_from_slice(&[0u8; 10]);
        data.extend(fs::read(fixture("base.flac")).unwrap());
        let path = dir.path().join("id3.flac");
        fs::write(&path, data).unwrap();
        assert_eq!(audio_hash(&path).unwrap(), hash("base.flac"));
    }

    #[test]
    fn detects_format_by_content_not_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wrong.mp3");
        fs::copy(fixture("base.ogg"), &path).unwrap();
        assert_eq!(audio_hash(&path).unwrap(), hash("base.ogg"));
    }

    /// 計算にかかる時間を測る。時間がかかるので通常は実行しない。
    /// cargo test --release hash_speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn hash_speed() {
        let dir = tempfile::tempdir().unwrap();
        // 小さいファイル（3KBのMP3）を3万件
        let small: Vec<PathBuf> = (0..30_000)
            .map(|i| {
                let p = dir.path().join(format!("s{i}.mp3"));
                fs::copy(fixture("base.mp3"), &p).unwrap();
                p
            })
            .collect();
        let t = std::time::Instant::now();
        for p in &small {
            audio_hash(p).unwrap();
        }
        println!("3KBのMP3 3万件（1スレッド、1回目）: {} ms", t.elapsed().as_millis());
        let t = std::time::Instant::now();
        for p in &small {
            audio_hash(p).unwrap();
        }
        println!("3KBのMP3 3万件（1スレッド、2回目）: {} ms", t.elapsed().as_millis());
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let t = std::time::Instant::now();
        std::thread::scope(|s| {
            for chunk in small.chunks(small.len().div_ceil(threads)) {
                s.spawn(move || {
                    for p in chunk {
                        audio_hash(p).unwrap();
                    }
                });
            }
        });
        println!("3KBのMP3 3万件（{threads}スレッド、3回目）: {} ms", t.elapsed().as_millis());

        // 大きいファイル（500MBのWAV）
        let big = dir.path().join("big.wav");
        let data_len: u32 = 500 * 1024 * 1024;
        let mut header = fs::read(fixture("base.wav")).unwrap()[..36].to_vec();
        header[4..8].copy_from_slice(&(data_len + 36).to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&data_len.to_le_bytes());
        {
            use std::io::Write;
            let mut f = fs::File::create(&big).unwrap();
            f.write_all(&header).unwrap();
            let chunk: Vec<u8> = (0..1 << 20).map(|i| (i * 7 % 251) as u8).collect();
            for _ in 0..500 {
                f.write_all(&chunk).unwrap();
            }
        }
        let t = std::time::Instant::now();
        audio_hash(&big).unwrap();
        let ms = t.elapsed().as_millis().max(1);
        println!("500MBのWAV: {ms} ms（{} MB/秒）", 500 * 1000 / ms);
    }

    #[test]
    fn broken_files_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let cases: &[(&str, &[u8])] = &[
            ("text.wav", b"x"),
            ("empty.mp3", b""),
            ("riff_only.wav", b"RIFF\x04\x00\x00\x00WAVE"),
            ("bad.flac", b"fLaC\x80\x00\xff\xff"),
            ("bad.ogg", b"OggS\x00\x02"),
            ("bad.m4a", b"\x00\x00\x00\x08ftyp"),
        ];
        for (name, data) in cases {
            let path = dir.path().join(name);
            fs::write(&path, data).unwrap();
            assert!(audio_hash(&path).is_err(), "{name}");
        }
        // 途中で切れたファイル
        for ext in FORMATS {
            let data = fs::read(fixture(&format!("base.{ext}"))).unwrap();
            let path = dir.path().join(format!("cut.{ext}"));
            fs::write(&path, &data[..data.len() / 2]).unwrap();
            // MP3はフレームが並んでいるだけ、WAVはdataチャンクの大きさをファイルの終わりで切り詰めるので、
            // 途中で切れても計算できる。ほかは構造が壊れているのでエラー
            // （FLACはテスト用の音源だと、先頭のメタデータ（パディング）の途中で切れる）
            let result = audio_hash(&path);
            match *ext {
                "mp3" | "wav" => assert!(result.is_ok(), "{ext}: {result:?}"),
                _ => assert!(result.is_err(), "{ext}"),
            }
        }
    }
}
