//! サンプルレートの変換。曲と出力先のサンプルレートが違うとき（Windows の 48kHz など）に使う。

use rubato::{FftFixedIn, Resampler as _};

use super::PlaybackError;

/// 1 回に変換する入力のフレーム数。
const CHUNK: usize = 1024;

/// ステレオの音を、左右交互に並べた f32 のまま変換する。
pub enum StereoResampler {
    /// 同じサンプルレートなので変換しない
    Passthrough,
    Fft {
        inner: Box<FftFixedIn<f32>>,
        /// まだ変換していない入力（左右に分けたもの）
        pending: [Vec<f32>; 2],
    },
}

impl StereoResampler {
    pub fn new(from: u32, to: u32) -> Result<Self, PlaybackError> {
        if from == to {
            return Ok(Self::Passthrough);
        }
        let inner =
            FftFixedIn::<f32>::new(from as usize, to as usize, CHUNK, 2, 2).map_err(|e| {
                PlaybackError::Output(format!("サンプルレートの変換を準備できない: {e}"))
            })?;
        Ok(Self::Fft {
            inner: Box::new(inner),
            pending: [Vec::new(), Vec::new()],
        })
    }

    /// 入力を受け取り、変換できたぶんを返す。端数は次の呼び出しまで持ち越す。
    pub fn process(&mut self, interleaved: &[f32]) -> Vec<f32> {
        match self {
            Self::Passthrough => interleaved.to_vec(),
            Self::Fft { inner, pending } => {
                for frame in interleaved.as_chunks::<2>().0 {
                    pending[0].push(frame[0]);
                    pending[1].push(frame[1]);
                }
                let mut out = Vec::new();
                while pending[0].len() >= inner.input_frames_next() {
                    let n = inner.input_frames_next();
                    let input = [&pending[0][..n], &pending[1][..n]];
                    match inner.process(&input, None) {
                        Ok(converted) => interleave(&converted, &mut out),
                        Err(e) => log::warn!("サンプルレートの変換に失敗した: {e}"),
                    }
                    pending[0].drain(..n);
                    pending[1].drain(..n);
                }
                out
            }
        }
    }

    /// 曲の終わりに、持ち越した端数を変換して返す。
    pub fn flush(&mut self) -> Vec<f32> {
        match self {
            Self::Passthrough => Vec::new(),
            Self::Fft { inner, pending } => {
                let mut out = Vec::new();
                if !pending[0].is_empty() {
                    let input = [&pending[0][..], &pending[1][..]];
                    if let Ok(converted) = inner.process_partial(Some(&input), None) {
                        interleave(&converted, &mut out);
                    }
                    pending[0].clear();
                    pending[1].clear();
                }
                out
            }
        }
    }
}

fn interleave(channels: &[Vec<f32>], out: &mut Vec<f32>) {
    for (l, r) in channels[0].iter().zip(&channels[1]) {
        out.extend_from_slice(&[*l, *r]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_when_same_rate() {
        let mut r = StereoResampler::new(44100, 44100).unwrap();
        assert_eq!(r.process(&[0.1, 0.2, 0.3, 0.4]), vec![0.1, 0.2, 0.3, 0.4]);
    }

    #[test]
    fn converts_44100_to_48000_with_matching_length() {
        let mut r = StereoResampler::new(44100, 48000).unwrap();
        let input: Vec<f32> = (0..44100)
            .flat_map(|i| {
                let v = (i as f32 * 440.0 * std::f32::consts::TAU / 44100.0).sin() * 0.5;
                [v, v]
            })
            .collect();
        let mut out = Vec::new();
        for chunk in input.chunks(2 * 1152) {
            out.extend(r.process(chunk));
        }
        out.extend(r.flush());
        let frames = out.len() / 2;
        // 1 秒ぶんの入力が、ほぼ 1 秒ぶん（48000 フレーム）になる。変換の遅れぶんの差は許す
        assert!((frames as i64 - 48000).abs() < 2048, "{frames} フレーム");
        let peak = out.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!((0.4..0.6).contains(&peak), "音量が保たれる: {peak}");
    }
}
