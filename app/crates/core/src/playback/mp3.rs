//! MP3 のシークの位置の見積もり。
//!
//! Symphonia の MP3 のシークは、先頭からフレームをたどって位置を探すため、Drive では
//! シーク先までのデータをすべて取得することになり、数秒かかる。そこで、最初のフレームの
//! ヘッダ（ビットレート）と Xing ヘッダの目次から、ファイル上の位置を見積もる。

use std::io::{Read, Seek, SeekFrom};

/// MP3 の、時間とファイル上の位置の対応。
#[derive(Debug, Clone, PartialEq)]
pub struct Mp3Index {
    /// 最初のフレームの位置（ID3v2 タグの後ろ）
    pub data_start: u64,
    /// 音声のデータの長さ
    pub data_len: u64,
    /// 曲の長さ（秒）
    pub duration: f64,
    /// Xing ヘッダの目次（曲の 1% ごとの位置を、データの長さの 256 分率で表したもの）
    toc: Option<[u8; 100]>,
}

struct FrameHeader {
    sample_rate: u32,
    /// kbps
    bitrate: u32,
    samples_per_frame: u32,
    frame_len: usize,
    /// Xing ヘッダの位置（フレームの先頭から）
    xing_offset: usize,
}

const BITRATES_V1: [u32; 15] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const BITRATES_V2: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/// MPEG Audio Layer III のフレームのヘッダを読む。
fn parse_header(b: &[u8]) -> Option<FrameHeader> {
    if b.len() < 4 || b[0] != 0xFF || b[1] & 0xE0 != 0xE0 {
        return None;
    }
    let version = (b[1] >> 3) & 3; // 3: MPEG1、2: MPEG2、0: MPEG2.5
    let layer = (b[1] >> 1) & 3; // 1: Layer III
    let bitrate_idx = (b[2] >> 4) as usize;
    let rate_idx = ((b[2] >> 2) & 3) as usize;
    if version == 1 || layer != 1 || bitrate_idx == 0 || bitrate_idx == 15 || rate_idx == 3 {
        return None;
    }
    let mpeg1 = version == 3;
    let base_rate = [44100, 48000, 32000][rate_idx];
    let sample_rate = match version {
        3 => base_rate,
        2 => base_rate / 2,
        _ => base_rate / 4,
    };
    let bitrate = if mpeg1 {
        BITRATES_V1[bitrate_idx]
    } else {
        BITRATES_V2[bitrate_idx]
    };
    let samples_per_frame = if mpeg1 { 1152 } else { 576 };
    let padding = ((b[2] >> 1) & 1) as usize;
    let frame_len = (samples_per_frame / 8 * bitrate * 1000 / sample_rate) as usize + padding;
    let mono = b[3] >> 6 == 3;
    let side_info = match (mpeg1, mono) {
        (true, false) => 32,
        (true, true) => 17,
        (false, false) => 17,
        (false, true) => 9,
    };
    Some(FrameHeader {
        sample_rate,
        bitrate,
        samples_per_frame,
        frame_len,
        xing_offset: 4 + side_info,
    })
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

impl Mp3Index {
    /// 先頭を読んで、見積もりに必要な情報を集める。MP3 として読めなければ `None`。
    pub fn probe<R: Read + Seek>(reader: &mut R, total_len: u64) -> Option<Self> {
        reader.seek(SeekFrom::Start(0)).ok()?;
        let mut head = [0u8; 10];
        reader.read_exact(&mut head).ok()?;
        let mut data_start = 0u64;
        if &head[..3] == b"ID3" {
            let size = head[6..10]
                .iter()
                .fold(0u64, |acc, b| (acc << 7) | (*b & 0x7F) as u64);
            let footer = if head[5] & 0x10 != 0 { 10 } else { 0 };
            data_start = 10 + size + footer;
        }
        // タグの後ろの最初のフレームを探す。次のフレームのヘッダも正しいものだけを信じる
        reader.seek(SeekFrom::Start(data_start)).ok()?;
        let mut buf = vec![0u8; 64 * 1024];
        let n = read_up_to(reader, &mut buf);
        let buf = &buf[..n];
        let (offset, header) = (0..buf.len().saturating_sub(4)).find_map(|i| {
            let h = parse_header(&buf[i..])?;
            let next = buf.get(i + h.frame_len..)?;
            parse_header(next).map(|_| (i, h))
        })?;
        data_start += offset as u64;
        let data_len = total_len.checked_sub(data_start)?;

        let frame = &buf[offset..];
        // 目次がないときの長さの見積もり：読んだ範囲のフレームの平均（可変ビットレートでも大きく外さない）
        let mut duration = average_duration(frame, data_len)
            .unwrap_or(data_len as f64 * 8.0 / (header.bitrate as f64 * 1000.0));
        let mut toc = None;
        let mut xing_bytes = None;
        if let Some(x) = frame.get(header.xing_offset..header.xing_offset + 120)
            && (&x[..4] == b"Xing" || &x[..4] == b"Info")
        {
            let flags = be32(&x[4..8]);
            let mut p = 8;
            if flags & 1 != 0 {
                let frames = be32(&x[p..p + 4]);
                duration =
                    frames as f64 * header.samples_per_frame as f64 / header.sample_rate as f64;
                p += 4;
            }
            if flags & 2 != 0 {
                xing_bytes = Some(be32(&x[p..p + 4]) as u64);
                p += 4;
            }
            if flags & 4 != 0 {
                let mut t = [0u8; 100];
                t.copy_from_slice(&x[p..p + 100]);
                toc = Some(t);
            }
        }
        Some(Self {
            data_start,
            data_len: xing_bytes.unwrap_or(data_len).min(data_len),
            duration,
            toc,
        })
    }

    /// `seconds` 秒の音があるファイル上の位置。
    pub fn byte_for(&self, seconds: f64) -> u64 {
        if self.duration <= 0.0 {
            return self.data_start;
        }
        let ratio = (seconds / self.duration).clamp(0.0, 1.0);
        let fraction = match &self.toc {
            Some(toc) => {
                let pct = (ratio * 100.0).min(99.999);
                let a = pct.floor() as usize;
                let fa = toc[a] as f64;
                let fb = if a < 99 { toc[a + 1] as f64 } else { 256.0 };
                (fa + (fb - fa) * (pct - a as f64)) / 256.0
            }
            None => ratio,
        };
        self.data_start + (fraction * self.data_len as f64) as u64
    }
}

/// `frames` に並ぶフレームの平均から、`data_len` バイトぶんの長さ（秒）を見積もる。
fn average_duration(frames: &[u8], data_len: u64) -> Option<f64> {
    let (mut pos, mut bytes, mut seconds) = (0usize, 0u64, 0f64);
    while let Some(h) = frames.get(pos..).and_then(parse_header) {
        if pos + h.frame_len > frames.len() {
            break;
        }
        bytes += h.frame_len as u64;
        seconds += h.samples_per_frame as f64 / h.sample_rate as f64;
        pos += h.frame_len;
    }
    (bytes > 0).then(|| data_len as f64 / (bytes as f64 / seconds))
}

fn read_up_to<R: Read>(reader: &mut R, buf: &mut [u8]) -> usize {
    let mut n = 0;
    while n < buf.len() {
        match reader.read(&mut buf[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => n += k,
        }
    }
    n
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;

    pub(crate) fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn probes_fixtures() {
        for (name, has_toc) in [
            ("steps_cbr.mp3", true),
            ("steps_vbr.mp3", true),
            ("steps_vbr_noxing.mp3", false),
        ] {
            let data = fixture(name);
            let index = Mp3Index::probe(&mut Cursor::new(&data), data.len() as u64).unwrap();
            assert!(index.data_start > 10, "{name}: ID3 タグを飛ばす");
            assert_eq!(index.toc.is_some(), has_toc, "{name}");
            if has_toc {
                assert!(
                    (index.duration - 20.0).abs() < 0.1,
                    "{name}: 長さ {}",
                    index.duration
                );
            }
            assert_eq!(index.byte_for(0.0), index.data_start);
            assert!(
                index.byte_for(10.0) > index.byte_for(5.0),
                "{name}: {index:?}"
            );
        }
    }

    #[test]
    fn rejects_non_mp3() {
        let data = vec![0u8; 4096];
        assert!(Mp3Index::probe(&mut Cursor::new(&data), 4096).is_none());
    }
}
