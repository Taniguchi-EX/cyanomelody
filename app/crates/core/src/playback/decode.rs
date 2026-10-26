//! 曲のデコード。Symphonia で MP3、WAV、`.m4a`（AAC）を読み、ステレオの f32 にする。

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

use super::PlaybackError;

/// 1 曲ぶんのデコーダ。
pub struct TrackDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    sample_rate: u32,
    duration: Option<f64>,
}

impl TrackDecoder {
    /// `source` を開く。`extension` は形式の推定の手がかり（`mp3`、`wav`、`m4a`）。
    pub fn open(source: Box<dyn MediaSource>, extension: &str) -> Result<Self, PlaybackError> {
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
        Ok(Self {
            track_id: track.id,
            format,
            decoder,
            time_base: params.time_base,
            sample_rate,
            duration,
        })
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
    pub fn seek(&mut self, seconds: f64) -> Result<f64, PlaybackError> {
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(seconds.max(0.0)),
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

    #[test]
    fn rejects_non_audio() {
        let result = TrackDecoder::open(Box::new(Cursor::new(vec![0u8; 1024])), "mp3");
        assert!(result.is_err());
    }
}
