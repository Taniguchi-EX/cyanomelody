//! 曲のデコード。Symphonia で MP3、WAV、`.m4a`（AAC）を読み、ステレオの f32 にする。

use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

use super::PlaybackError;
use super::mp3::Mp3Index;

/// 1 曲ぶんのデコーダ。
pub struct TrackDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    sample_rate: u32,
    duration: Option<f64>,
    /// MP3 で、位置を見積もってシークするための情報
    mp3: Option<Mp3Seek>,
}

struct Mp3Seek {
    media: Arc<Mutex<Box<dyn MediaSource>>>,
    len: u64,
    index: Mp3Index,
}

/// 開いた曲の、フォーマットとデコーダ。
struct Opened {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    sample_rate: u32,
    duration: Option<f64>,
}

fn open_parts(source: Box<dyn MediaSource>, extension: &str) -> Result<Opened, PlaybackError> {
    let mss = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    hint.with_extension(extension);
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(decode_error)?;
    let format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| PlaybackError::Decode("音声のトラックがない".into()))?;
    let params = track.codec_params.clone();
    let decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(decode_error)?;
    let sample_rate = params
        .sample_rate
        .ok_or_else(|| PlaybackError::Decode("サンプルレートが分からない".into()))?;
    let duration = match (params.time_base, params.n_frames) {
        (Some(tb), Some(n)) => Some(to_seconds(tb.calc_time(n))),
        _ => None,
    };
    Ok(Opened {
        track_id: track.id,
        format,
        decoder,
        time_base: params.time_base,
        sample_rate,
        duration,
    })
}

impl TrackDecoder {
    /// `source` を開く。`extension` は形式の推定の手がかり（`mp3`、`wav`、`m4a`）。
    pub fn open(source: Box<dyn MediaSource>, extension: &str) -> Result<Self, PlaybackError> {
        if extension == "mp3"
            && let Some(len) = source.byte_len()
        {
            // MP3 は、あとでファイルの途中から読み直せるよう、共有して開く
            let media = Arc::new(Mutex::new(source));
            let index = Mp3Index::probe(&mut SharedMedia::new(media.clone(), 0, len), len);
            let opened = open_parts(Box::new(SharedMedia::new(media.clone(), 0, len)), extension)?;
            let mut decoder = Self::from_opened(opened);
            if let Some(index) = index {
                decoder.duration = decoder.duration.or(Some(index.duration));
                decoder.mp3 = Some(Mp3Seek { media, len, index });
            }
            return Ok(decoder);
        }
        Ok(Self::from_opened(open_parts(source, extension)?))
    }

    fn from_opened(o: Opened) -> Self {
        Self {
            format: o.format,
            decoder: o.decoder,
            track_id: o.track_id,
            time_base: o.time_base,
            sample_rate: o.sample_rate,
            duration: o.duration,
            mp3: None,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// 曲の長さ（秒）。分からない形式では `None`。
    pub fn duration(&self) -> Option<f64> {
        self.duration
    }

    /// 次の音声を、ステレオで左右交互に並べた f32 で返す。曲の終わりでは `None`。
    pub fn next_frames(&mut self) -> Result<Option<Vec<f32>>, PlaybackError> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(None);
                }
                Err(e) => return Err(decode_error(e)),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                // 壊れたパケットは飛ばして続ける
                Err(SymError::DecodeError(e)) => {
                    log::warn!("壊れたパケットを飛ばした: {e}");
                    continue;
                }
                Err(e) => return Err(decode_error(e)),
            };
            let channels = decoded.spec().channels.count();
            if decoded.frames() == 0 || channels == 0 {
                continue;
            }
            let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            buf.copy_interleaved_ref(decoded);
            let mut out = Vec::with_capacity(buf.samples().len() / channels * 2);
            for frame in buf.samples().chunks(channels) {
                let left = frame[0];
                let right = *frame.get(1).unwrap_or(&left);
                out.extend_from_slice(&[left, right]);
            }
            return Ok(Some(out));
        }
    }

    /// `seconds` 秒の位置に移り、実際に移った位置（秒）を返す。
    /// MP3 は、見積もった位置から読み直す（先頭からたどらないため、Drive でも速い）。
    pub fn seek(&mut self, seconds: f64) -> Result<f64, PlaybackError> {
        let seconds = seconds.max(0.0);
        if let Some(m) = &self.mp3 {
            let seconds = seconds.min(m.index.duration);
            let byte = m.index.byte_for(seconds);
            let opened = open_parts(
                Box::new(SharedMedia::new(m.media.clone(), byte, m.len)),
                "mp3",
            )?;
            self.format = opened.format;
            self.decoder = opened.decoder;
            self.track_id = opened.track_id;
            self.time_base = opened.time_base;
            return Ok(seconds);
        }
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(seconds),
                    track_id: Some(self.track_id),
                },
            )
            .map_err(decode_error)?;
        self.decoder.reset();
        Ok(self
            .time_base
            .map(|tb| to_seconds(tb.calc_time(seeked.actual_ts)))
            .unwrap_or(seconds))
    }
}

/// 1 つの読み込み口を、開始位置を変えて共有する。MP3 をファイルの途中から開き直すために使う。
struct SharedMedia {
    inner: Arc<Mutex<Box<dyn MediaSource>>>,
    start: u64,
    pos: u64,
    len: u64,
}

impl SharedMedia {
    fn new(inner: Arc<Mutex<Box<dyn MediaSource>>>, start: u64, len: u64) -> Self {
        Self {
            inner,
            start: start.min(len),
            pos: 0,
            len,
        }
    }

    fn view_len(&self) -> u64 {
        self.len - self.start
    }
}

impl Read for SharedMedia {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let remaining = self.view_len().saturating_sub(self.pos);
        if remaining == 0 || out.is_empty() {
            return Ok(0);
        }
        let want = out.len().min(remaining as usize);
        let mut inner = self.inner.lock().unwrap();
        inner.seek(SeekFrom::Start(self.start + self.pos))?;
        let n = inner.read(&mut out[..want])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for SharedMedia {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        let pos = match from {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::End(d) => self.view_len() as i128 + d as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
        };
        if pos < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "負の位置",
            ));
        }
        self.pos = pos as u64;
        Ok(self.pos)
    }
}

impl MediaSource for SharedMedia {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.view_len())
    }
}

fn to_seconds(t: Time) -> f64 {
    t.seconds as f64 + t.frac
}

fn decode_error(e: SymError) -> PlaybackError {
    match e {
        SymError::IoError(e) => PlaybackError::Io(e.to_string()),
        SymError::Unsupported(what) => PlaybackError::Decode(format!("対応していない形式: {what}")),
        other => PlaybackError::Decode(other.to_string()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;

    /// テスト用の WAV（16 ビット、ステレオ、正弦波）をメモリ上に作る。
    pub(crate) fn wav(sample_rate: u32, seconds: f64) -> Vec<u8> {
        let frames = (sample_rate as f64 * seconds) as u32;
        let data_len = frames * 4;
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&2u16.to_le_bytes()); // ステレオ
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&(sample_rate * 4).to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            let v = ((i as f64 * 440.0 * std::f64::consts::TAU / sample_rate as f64).sin() * 8000.0)
                as i16;
            out.extend_from_slice(&v.to_le_bytes());
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }

    fn open_wav(sample_rate: u32, seconds: f64) -> TrackDecoder {
        TrackDecoder::open(Box::new(Cursor::new(wav(sample_rate, seconds))), "wav").unwrap()
    }

    #[test]
    fn decodes_whole_wav() {
        let mut d = open_wav(44100, 2.0);
        assert_eq!(d.sample_rate(), 44100);
        assert!((d.duration().unwrap() - 2.0).abs() < 0.01);
        let mut samples = 0;
        while let Some(frames) = d.next_frames().unwrap() {
            samples += frames.len();
        }
        assert_eq!(samples, 44100 * 2 * 2, "ステレオで 2 秒ぶん");
    }

    #[test]
    fn seeks_near_target() {
        let mut d = open_wav(48000, 3.0);
        let landed = d.seek(1.5).unwrap();
        assert!((landed - 1.5).abs() < 0.05, "着地 {landed}");
        let mut rest = 0;
        while let Some(frames) = d.next_frames().unwrap() {
            rest += frames.len() / 2;
        }
        assert!(
            (rest as f64 / 48000.0 - 1.5).abs() < 0.05,
            "残り {rest} フレーム"
        );
    }

    /// 左のチャンネルの 0.2〜0.4 秒の、ゼロ交差の数から音の高さ（Hz）を求める。
    /// MP3 を途中から読み始めると、最初の約 0.15 秒は無音になるため、先頭 0.2 秒は使わない。
    fn pitch(frames: &[f32], sample_rate: u32) -> f64 {
        let skip = (sample_rate as f64 * 0.2) as usize;
        let n = (sample_rate as f64 * 0.2) as usize;
        let left: Vec<f32> = frames
            .iter()
            .step_by(2)
            .skip(skip)
            .take(n)
            .copied()
            .collect();
        let crossings = left
            .windows(2)
            .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
            .count();
        crossings as f64 / 2.0 / (left.len() as f64 / sample_rate as f64)
    }

    fn decode_seconds(d: &mut TrackDecoder, seconds: f64) -> Vec<f32> {
        let mut out = Vec::new();
        while out.len() < (d.sample_rate() as f64 * seconds) as usize * 2 {
            out.extend(d.next_frames().unwrap().unwrap());
        }
        out
    }

    #[test]
    fn mp3_seek_lands_near_target() {
        // 1 秒ごとに 100Hz ずつ上がる音。12.3 秒は 1400Hz
        for (name, tolerance) in [
            ("steps_cbr.mp3", 0),
            ("steps_vbr.mp3", 0),
            ("steps_vbr_noxing.mp3", 1),
        ] {
            let data = crate::playback::mp3::tests::fixture(name);
            let mut d = TrackDecoder::open(Box::new(Cursor::new(data)), "mp3").unwrap();
            assert!(d.mp3.is_some(), "{name}: 見積もりを使う");
            let landed = d.seek(12.3).unwrap();
            assert!((landed - 12.3).abs() < 1e-9);
            let hz = pitch(&decode_seconds(&mut d, 0.5), d.sample_rate());
            let second = ((hz - 200.0) / 100.0).round() as i64;
            assert!(
                (second - 12).abs() <= tolerance,
                "{name}: {hz:.0}Hz（{second} 秒目）に着地"
            );
        }
    }

    #[test]
    fn mp3_seek_over_drive_fetches_little() {
        use crate::drive::mock::MockDrive;
        use crate::drive::{DriveClient, RangeReader, StaticToken};
        use std::sync::atomic::Ordering;
        let data = crate::playback::mp3::tests::fixture("steps_cbr.mp3");
        let mock = MockDrive::start();
        let id = mock.add_file("root", "a.mp3", data.clone());
        let client = DriveClient::with_base(&mock.base_url(), Arc::new(StaticToken("t".into())));
        let reader = RangeReader::new(client, &id, data.len() as u64, 4096);
        let mut d = TrackDecoder::open(Box::new(reader), "mp3").unwrap();
        let before = mock.media_requests.load(Ordering::Relaxed);
        d.seek(18.0).unwrap();
        decode_seconds(&mut d, 0.1);
        let requests = mock.media_requests.load(Ordering::Relaxed) - before;
        assert!(requests <= 4, "シーク先の近くだけ取得する: {requests} 回");
    }

    #[test]
    fn rejects_non_audio() {
        let result = TrackDecoder::open(Box::new(Cursor::new(vec![0u8; 1024])), "mp3");
        assert!(result.is_err());
    }
}
