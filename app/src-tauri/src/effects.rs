//! エフェクトの処理：音声ファイルを波形に読み、エフェクトを順にかけ、WAVに書き出す
//!
//! 元のファイルは変更しない。再生とプレイリストの出力で、同じ処理を使う。

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// 波形。チャンネルごとの標本（-1.0〜1.0）
#[derive(Debug, Clone, PartialEq)]
pub struct Audio {
    pub rate: u32,
    pub channels: Vec<Vec<f32>>,
}

impl Audio {
    pub fn len(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }

    #[cfg(test)]
    pub fn seconds(&self) -> f64 {
        self.len() as f64 / self.rate as f64
    }
}

/// 音量調整（自動）のそろえ方
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NormalizeMethod {
    /// いちばん大きい所
    Peak,
    /// 平均の大きさ（RMS）
    Rms,
}

/// エフェクト1つと、その設定（範囲は docs の「エフェクトの種類と設定」）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Effect {
    /// 音量調整（dB）
    Gain { db: f32 },
    /// 音量調整（自動）。目標は dBFS
    Normalize { method: NormalizeMethod, target_db: f32 },
    /// 再生速度（倍）・音程（半音）。別々に変えられる
    SpeedPitch { speed: f32, semitones: f32 },
    /// リバーブ。残響の長さ（秒）、混ぜる割合（0〜1）
    Reverb { seconds: f32, mix: f32 },
    /// エコー。遅れ（秒）、繰り返しの強さ（0〜0.9）、混ぜる割合（0〜1）
    Echo { delay: f32, feedback: f32, mix: f32 },
    /// フェードイン（秒）
    FadeIn { seconds: f32 },
    /// フェードアウト（秒）
    FadeOut { seconds: f32 },
    /// 簡易オフボーカル。真ん中の音のうち、下〜上の周波数（Hz）の音を、強さ（0〜1）の分だけ弱める
    OffVocal { strength: f32, low_hz: f32, high_hz: f32 },
}

impl Effect {
    /// 設定を決められた範囲に収める（画面での入力の誤りや、古いデータに備える）
    pub fn clamped(&self) -> Effect {
        match *self {
            Effect::Gain { db } => Effect::Gain { db: db.clamp(-30.0, 12.0) },
            Effect::Normalize { method, target_db } => Effect::Normalize { method, target_db: target_db.clamp(-40.0, 0.0) },
            Effect::SpeedPitch { speed, semitones } => {
                Effect::SpeedPitch { speed: speed.clamp(0.5, 2.0), semitones: semitones.clamp(-12.0, 12.0) }
            }
            Effect::Reverb { seconds, mix } => Effect::Reverb { seconds: seconds.clamp(0.1, 5.0), mix: mix.clamp(0.0, 1.0) },
            Effect::Echo { delay, feedback, mix } => Effect::Echo {
                delay: delay.clamp(0.05, 2.0),
                feedback: feedback.clamp(0.0, 0.9),
                mix: mix.clamp(0.0, 1.0),
            },
            Effect::FadeIn { seconds } => Effect::FadeIn { seconds: seconds.clamp(0.0, 600.0) },
            Effect::FadeOut { seconds } => Effect::FadeOut { seconds: seconds.clamp(0.0, 600.0) },
            Effect::OffVocal { strength, low_hz, high_hz } => Effect::OffVocal {
                strength: strength.clamp(0.0, 1.0),
                low_hz: low_hz.clamp(50.0, 500.0),
                high_hz: high_hz.clamp(2000.0, 16000.0),
            },
        }
    }
}

/// 音声ファイルを読んで波形にする（MP3・WAV・FLAC・OGG・M4A）
pub fn decode(path: &Path) -> Result<Audio, String> {
    let file = File::open(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("形式を判定できません: {e}"))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("音声のトラックがありません")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("この形式は読めません: {e}"))?;
    let mut rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut channels: Vec<Vec<f32>> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // ファイルの終わり
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(format!("読み込みに失敗しました: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // 壊れたパケットは飛ばす
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("読み込みに失敗しました: {e}")),
        };
        let spec = *decoded.spec();
        rate = spec.rate;
        let n = spec.channels.count();
        if channels.is_empty() {
            channels = vec![Vec::new(); n];
        }
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        for (i, s) in buf.samples().iter().enumerate() {
            if let Some(ch) = channels.get_mut(i % n) {
                ch.push(*s);
            }
        }
    }
    if channels.is_empty() || channels[0].is_empty() {
        return Err("音声のデータがありません".into());
    }
    Ok(Audio { rate, channels })
}

/// 16bitのWAVに書き出す。-1.0〜1.0を超える所は切り詰める
pub fn write_wav(path: &Path, audio: &Audio) -> std::io::Result<()> {
    let ch = audio.channels.len() as u16;
    let len = audio.len();
    let data_bytes = (len * ch as usize * 2) as u32;
    let mut w = BufWriter::new(File::create(path)?);
    w.write_all(b"RIFF")?;
    w.write_all(&(36 + data_bytes).to_le_bytes())?;
    w.write_all(b"WAVEfmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?; // PCM
    w.write_all(&ch.to_le_bytes())?;
    w.write_all(&audio.rate.to_le_bytes())?;
    w.write_all(&(audio.rate * ch as u32 * 2).to_le_bytes())?;
    w.write_all(&(ch * 2).to_le_bytes())?;
    w.write_all(&16u16.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&data_bytes.to_le_bytes())?;
    for i in 0..len {
        for c in &audio.channels {
            let v = (c[i].clamp(-1.0, 1.0) * 32767.0).round() as i16;
            w.write_all(&v.to_le_bytes())?;
        }
    }
    w.flush()
}

/// エフェクトを順にかける
pub fn apply_all(mut audio: Audio, effects: &[Effect]) -> Audio {
    for e in effects {
        audio = apply(audio, &e.clamped());
    }
    audio
}

fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn apply(mut audio: Audio, effect: &Effect) -> Audio {
    let rate = audio.rate as f32;
    match *effect {
        Effect::Gain { db } => {
            let g = db_to_gain(db);
            for c in &mut audio.channels {
                c.iter_mut().for_each(|s| *s *= g);
            }
            audio
        }
        Effect::Normalize { method, target_db } => normalize(audio, method, target_db),
        Effect::SpeedPitch { speed, semitones } => speed_pitch(audio, speed, semitones),
        Effect::Reverb { seconds, mix } => reverb(audio, seconds, mix),
        Effect::Echo { delay, feedback, mix } => echo(audio, delay, feedback, mix),
        Effect::FadeIn { seconds } => {
            let n = ((seconds * rate) as usize).min(audio.len());
            for c in &mut audio.channels {
                for (i, s) in c.iter_mut().take(n).enumerate() {
                    *s *= i as f32 / n as f32;
                }
            }
            audio
        }
        Effect::OffVocal { strength, low_hz, high_hz } => off_vocal(audio, strength, low_hz, high_hz),
        Effect::FadeOut { seconds } => {
            let len = audio.len();
            let n = ((seconds * rate) as usize).min(len);
            for c in &mut audio.channels {
                for i in 0..n {
                    c[len - 1 - i] *= i as f32 / n as f32;
                }
            }
            audio
        }
    }
}

/// ピーク（いちばん大きい所）か平均の大きさ（RMS）を目標にそろえる。
/// RMSでそろえて大きくなりすぎるときは、ピークが0dBFSを超えないところで止める
fn normalize(mut audio: Audio, method: NormalizeMethod, target_db: f32) -> Audio {
    let peak = audio.channels.iter().flatten().fold(0f32, |m, s| m.max(s.abs()));
    if peak <= 1e-6 {
        return audio; // 無音
    }
    let target = db_to_gain(target_db);
    let mut gain = match method {
        NormalizeMethod::Peak => target / peak,
        NormalizeMethod::Rms => {
            let n = audio.channels.iter().map(Vec::len).sum::<usize>() as f64;
            let rms = (audio.channels.iter().flatten().map(|s| (*s as f64).powi(2)).sum::<f64>() / n).sqrt() as f32;
            target / rms
        }
    };
    gain = gain.min(1.0 / peak);
    for c in &mut audio.channels {
        c.iter_mut().for_each(|s| *s *= gain);
    }
    audio
}

/// 速度と音程を別々に変える。
/// 時間の伸び縮み（WSOLA：音程を変えずに長さを変える）と、標本の補間（長さと音程を一緒に変える）を組み合わせる。
/// 音程の比 p、速度 s のとき、まず長さを p/s 倍に伸ばし、次に p 倍の速さで読み直すと、長さは 1/s 倍、音程は p 倍になる
fn speed_pitch(audio: Audio, speed: f32, semitones: f32) -> Audio {
    let p = 2f64.powf(semitones as f64 / 12.0);
    let stretch = p / speed as f64;
    let mut audio = if (stretch - 1.0).abs() > 1e-3 { time_stretch(&audio, stretch) } else { audio };
    if (p - 1.0).abs() > 1e-3 {
        audio = resample(&audio, p);
    }
    audio
}

/// 読む速さを step 倍にする（長さは 1/step、音程は step 倍）。4点の補間（Catmull-Rom）
fn resample(audio: &Audio, step: f64) -> Audio {
    let len = audio.len();
    let out_len = ((len as f64) / step).floor() as usize;
    let channels = audio
        .channels
        .iter()
        .map(|c| {
            let at = |i: isize| -> f32 { c[i.clamp(0, len as isize - 1) as usize] };
            (0..out_len)
                .map(|k| {
                    let x = k as f64 * step;
                    let i = x.floor() as isize;
                    let t = (x - i as f64) as f32;
                    let (p0, p1, p2, p3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
                    0.5 * (2.0 * p1
                        + (-p0 + p2) * t
                        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t
                        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t)
                })
                .collect()
        })
        .collect();
    Audio { rate: audio.rate, channels }
}

/// 音程を変えずに長さを stretch 倍にする（WSOLA）。
/// 窓をずらして重ねるとき、前の窓の続きといちばん似た位置を少しの範囲で探して、つなぎ目の濁りを減らす
fn time_stretch(audio: &Audio, stretch: f64) -> Audio {
    let len = audio.len();
    let rate = audio.rate as f64;
    let n = ((rate * 0.04) as usize).max(64); // 窓の長さ（40ms）
    let hop_out = n / 2;
    let delta = (rate * 0.008) as isize; // 探す範囲（±8ms）
    let out_len = (len as f64 * stretch) as usize;
    // 似ている位置を探すための、チャンネルを混ぜた波形
    let mono: Vec<f32> = (0..len)
        .map(|i| audio.channels.iter().map(|c| c[i]).sum::<f32>() / audio.channels.len() as f32)
        .collect();
    let window: Vec<f32> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()).collect();
    let mut out = vec![vec![0f32; out_len + n]; audio.channels.len()];
    let mut norm = vec![0f32; out_len + n];
    let get = |i: isize| -> f32 { if i >= 0 && (i as usize) < len { mono[i as usize] } else { 0.0 } };
    let mut prev: isize = 0;
    let mut k = 0usize;
    loop {
        let out_pos = k * hop_out;
        if out_pos >= out_len {
            break;
        }
        let nominal = (out_pos as f64 / stretch) as isize;
        let pos = if k == 0 {
            0
        } else {
            // 前の窓の自然な続き（prev + hop_out）と、いちばん似ている位置を探す。速さのため、重なる半分だけを4つおきに比べる
            let natural = prev + hop_out as isize;
            let mut best = nominal;
            let mut best_score = f32::MIN;
            let mut cand = nominal - delta;
            while cand <= nominal + delta {
                let mut score = 0f32;
                let mut j = 0;
                while j < hop_out {
                    score += get(cand + j as isize) * get(natural + j as isize);
                    j += 4;
                }
                if score > best_score {
                    best_score = score;
                    best = cand;
                }
                cand += 2;
            }
            best.max(0)
        };
        for (ci, c) in audio.channels.iter().enumerate() {
            for i in 0..n {
                let src = pos as usize + i;
                if src < len {
                    out[ci][out_pos + i] += c[src] * window[i];
                }
            }
        }
        for i in 0..n {
            norm[out_pos + i] += window[i];
        }
        prev = pos;
        k += 1;
    }
    for c in &mut out {
        for (s, w) in c.iter_mut().zip(&norm) {
            if *w > 1e-3 {
                *s /= w;
            }
        }
        c.truncate(out_len);
    }
    Audio { rate: audio.rate, channels: out }
}

/// 残響の分だけ後ろに無音を足す
fn extend(audio: &mut Audio, seconds: f32) {
    let extra = (seconds * audio.rate as f32) as usize;
    for c in &mut audio.channels {
        c.extend(std::iter::repeat_n(0.0, extra));
    }
}

/// エコー。遅れ d ごとに、強さ feedback で繰り返す。混ぜる割合 mix で、元の音とエコーを足した音に近づける
fn echo(mut audio: Audio, delay: f32, feedback: f32, mix: f32) -> Audio {
    let d = ((delay * audio.rate as f32) as usize).max(1);
    // 繰り返しが -60dB より小さくなるまでの長さを足す（最長10秒）
    let repeats = if feedback > 0.0 { ((0.001f32).ln() / feedback.ln()).ceil() } else { 1.0 };
    extend(&mut audio, (delay * repeats).min(10.0));
    for c in &mut audio.channels {
        let mut e = vec![0f32; c.len()];
        for i in d..c.len() {
            e[i] = c[i - d] + feedback * e[i - d];
        }
        for (s, e) in c.iter_mut().zip(e) {
            *s += mix * e;
        }
    }
    audio
}

/// リバーブ（Schroeder型：並べた櫛形フィルタと、続けた全域通過フィルタ）。
/// 櫛形フィルタの帰還の強さは、残響が seconds で -60dB になるように決める
fn reverb(mut audio: Audio, seconds: f32, mix: f32) -> Audio {
    let rate = audio.rate as f32;
    extend(&mut audio, seconds);
    // 44.1kHzでの遅れ（標本数）。左右で少しずらして広がりを出す
    const COMBS: [f32; 8] = [1116.0, 1188.0, 1277.0, 1356.0, 1422.0, 1491.0, 1557.0, 1617.0];
    const ALLPASS: [f32; 4] = [556.0, 441.0, 341.0, 225.0];
    let scale = rate / 44_100.0;
    for (ci, c) in audio.channels.iter_mut().enumerate() {
        let spread = if ci % 2 == 1 { 23.0 } else { 0.0 };
        let mut wet = vec![0f32; c.len()];
        for base in COMBS {
            let d = (((base + spread) * scale) as usize).max(1);
            let g = 10f32.powf(-3.0 * d as f32 / (seconds * rate));
            let mut buf = vec![0f32; c.len()];
            let mut lp = 0f32; // 高い音を少しずつ弱める（こもった残響にする）
            for i in 0..c.len() {
                let fb = if i >= d { buf[i - d] } else { 0.0 };
                lp = fb * 0.8 + lp * 0.2;
                buf[i] = c[i] + g * lp;
                wet[i] += buf[i] * 0.125;
            }
        }
        for base in ALLPASS {
            let d = (((base + spread) * scale) as usize).max(1);
            let mut out = vec![0f32; c.len()];
            for i in 0..c.len() {
                let delayed = if i >= d { out[i - d] } else { 0.0 };
                let x_d = if i >= d { wet[i - d] } else { 0.0 };
                out[i] = -0.5 * wet[i] + x_d + 0.5 * delayed;
            }
            wet = out;
        }
        for (s, w) in c.iter_mut().zip(wet) {
            *s = (1.0 - mix) * *s + mix * w * 0.5;
        }
    }
    audio
}

/// 2次の IIR フィルター（Butterworth の低域・高域通過と、同じ形の全域通過）。状態は f64 で持つ（低い周波数でも崩れないように）
#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

#[derive(Clone, Copy, PartialEq)]
enum BiquadKind {
    LowPass,
    HighPass,
    /// 大きさは変えず、位相だけを変える。Linkwitz-Riley（4次）の低域と高域を足したものと同じ
    AllPass,
}

impl Biquad {
    /// Q は 1/√2（Butterworth）
    fn new(kind: BiquadKind, freq: f64, rate: f64) -> Biquad {
        let w = 2.0 * std::f64::consts::PI * freq / rate;
        let (sin, cos) = w.sin_cos();
        let alpha = sin / std::f64::consts::SQRT_2;
        let a0 = 1.0 + alpha;
        let b = match kind {
            BiquadKind::LowPass => [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0],
            BiquadKind::HighPass => [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0],
            BiquadKind::AllPass => [1.0 - alpha, -2.0 * cos, 1.0 + alpha],
        };
        Biquad { b: [b[0] / a0, b[1] / a0, b[2] / a0], a: [-2.0 * cos / a0, (1.0 - alpha) / a0], z: [0.0; 2] }
    }

    /// 1標本を通す（直接形 II の転置）
    fn step(&mut self, v: f64) -> f64 {
        let y = self.b[0] * v + self.z[0];
        self.z[0] = self.b[1] * v - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * v - self.a[1] * y;
        y
    }
}

/// 簡易オフボーカル。左右を真ん中（M）と左右の差（S）に分け、真ん中のうち low_hz〜high_hz の音（ボーカルの音域）だけを
/// strength の分だけ弱める。モノラルの音は、ボーカルを選べないのでそのまま。
/// Linkwitz-Riley（4次）で低い音・ボーカルの音域・高い音に分けて足し戻すと、2つの分け目の全域通過を続けてかけたものになる。
/// そこで M′ = 全域通過(M) − 強さ × ボーカルの音域、S′ = 全域通過(S) として、少ないフィルターで同じ結果を得る（S にも同じ
/// 全域通過をかけて、位相をそろえる）
fn off_vocal(mut audio: Audio, strength: f32, low_hz: f32, high_hz: f32) -> Audio {
    if audio.channels.len() < 2 || audio.len() == 0 {
        return audio;
    }
    let rate = audio.rate as f64;
    // 上の周波数は、ナイキスト周波数より十分に下に収める（低い標本化周波数の音のため）
    let high = (high_hz as f64).min(rate * 0.45);
    let low = (low_hz as f64).min(high * 0.5);
    let strength = strength as f64;
    use BiquadKind::*;
    // M の全域通過（下・上の分け目）、ボーカルの音域（下の分け目の高域 → 上の分け目の低域。どちらも4次）、S の全域通過
    let mut m_ap = [Biquad::new(AllPass, low, rate), Biquad::new(AllPass, high, rate)];
    let hp = Biquad::new(HighPass, low, rate);
    let lp = Biquad::new(LowPass, high, rate);
    let mut band = [hp, hp, lp, lp];
    let mut s_ap = m_ap;
    let (left, right) = audio.channels.split_at_mut(1);
    for (l, r) in left[0].iter_mut().zip(right[0].iter_mut()) {
        let m = (*l as f64 + *r as f64) / 2.0;
        let s = (*l as f64 - *r as f64) / 2.0;
        let m_all = m_ap.iter_mut().fold(m, |v, f| f.step(v));
        let mid = band.iter_mut().fold(m, |v, f| f.step(v));
        let s_all = s_ap.iter_mut().fold(s, |v, f| f.step(v));
        let mm = m_all - strength * mid;
        *l = (mm + s_all) as f32;
        *r = (mm - s_all) as f32;
    }
    audio
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;

    fn sine(freq: f32, seconds: f32, amp: f32) -> Audio {
        let n = (seconds * RATE as f32) as usize;
        let c: Vec<f32> = (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / RATE as f32).sin()).collect();
        Audio { rate: RATE, channels: vec![c.clone(), c] }
    }

    /// 0を負から正へまたぐ回数から求めた周波数（真ん中の部分で数える）
    fn freq(audio: &Audio) -> f32 {
        let c = &audio.channels[0];
        let (a, b) = (c.len() / 4, c.len() * 3 / 4);
        let crossings = (a + 1..b).filter(|&i| c[i - 1] < 0.0 && c[i] >= 0.0).count();
        crossings as f32 / ((b - a) as f32 / audio.rate as f32)
    }

    fn peak(audio: &Audio) -> f32 {
        audio.channels.iter().flatten().fold(0f32, |m, s| m.max(s.abs()))
    }

    #[test]
    fn gain_and_normalize() {
        let a = apply_all(sine(440.0, 1.0, 0.5), &[Effect::Gain { db: -6.0206 }]);
        assert!((peak(&a) - 0.25).abs() < 0.01);
        let a = apply_all(sine(440.0, 1.0, 0.1), &[Effect::Normalize { method: NormalizeMethod::Peak, target_db: -1.0 }]);
        assert!((peak(&a) - db_to_gain(-1.0)).abs() < 0.01);
        // サイン波の RMS はピークの 1/√2。RMSで -3dBFS にそろえると、ピークは約1.0（0dBFSを超えない）
        let a = apply_all(sine(440.0, 1.0, 0.1), &[Effect::Normalize { method: NormalizeMethod::Rms, target_db: -3.0 }]);
        assert!(peak(&a) <= 1.0 + 1e-4 && peak(&a) > 0.95, "{}", peak(&a));
        // 無音は変えない
        let silent = Audio { rate: RATE, channels: vec![vec![0.0; 100]] };
        assert_eq!(apply_all(silent.clone(), &[Effect::Normalize { method: NormalizeMethod::Peak, target_db: -1.0 }]), silent);
    }

    #[test]
    fn speed_changes_length_but_not_pitch() {
        let src = sine(440.0, 2.0, 0.5);
        let fast = apply_all(src.clone(), &[Effect::SpeedPitch { speed: 2.0, semitones: 0.0 }]);
        assert!((fast.seconds() - 1.0).abs() < 0.02, "{}", fast.seconds());
        assert!((freq(&fast) - 440.0).abs() < 10.0, "{}", freq(&fast));
        let slow = apply_all(src, &[Effect::SpeedPitch { speed: 0.5, semitones: 0.0 }]);
        assert!((slow.seconds() - 4.0).abs() < 0.05, "{}", slow.seconds());
        assert!((freq(&slow) - 440.0).abs() < 10.0, "{}", freq(&slow));
    }

    #[test]
    fn pitch_changes_pitch_but_not_length() {
        let src = sine(440.0, 2.0, 0.5);
        let up = apply_all(src.clone(), &[Effect::SpeedPitch { speed: 1.0, semitones: 12.0 }]);
        assert!((up.seconds() - 2.0).abs() < 0.02, "{}", up.seconds());
        assert!((freq(&up) - 880.0).abs() < 15.0, "{}", freq(&up));
        let down = apply_all(src.clone(), &[Effect::SpeedPitch { speed: 1.0, semitones: -12.0 }]);
        assert!((down.seconds() - 2.0).abs() < 0.02, "{}", down.seconds());
        assert!((freq(&down) - 220.0).abs() < 10.0, "{}", freq(&down));
        // 両方を変える
        let both = apply_all(src, &[Effect::SpeedPitch { speed: 1.5, semitones: 7.0 }]);
        assert!((both.seconds() - 2.0 / 1.5).abs() < 0.03, "{}", both.seconds());
        assert!((freq(&both) - 440.0 * 2f32.powf(7.0 / 12.0)).abs() < 15.0, "{}", freq(&both));
    }

    #[test]
    fn reverb_and_echo_extend_the_tail() {
        let src = sine(440.0, 0.5, 0.5);
        let r = apply_all(src.clone(), &[Effect::Reverb { seconds: 1.0, mix: 0.5 }]);
        assert!((r.seconds() - 1.5).abs() < 0.01);
        // 元の音が終わった後にも残響がある
        let tail = &r.channels[0][(0.6 * RATE as f32) as usize..(0.7 * RATE as f32) as usize];
        assert!(tail.iter().any(|s| s.abs() > 1e-3));
        let e = apply_all(src, &[Effect::Echo { delay: 0.25, feedback: 0.0, mix: 1.0 }]);
        assert!((e.seconds() - 0.75).abs() < 0.01, "{}", e.seconds());
        // 0.25秒後に同じ大きさの音が足される
        let i = (0.6 * RATE as f32) as usize;
        assert!(e.channels[0][i..i + 200].iter().any(|s| s.abs() > 0.4));
    }

    #[test]
    fn fades() {
        let a = apply_all(sine(440.0, 1.0, 0.5), &[Effect::FadeIn { seconds: 0.5 }, Effect::FadeOut { seconds: 0.2 }]);
        assert_eq!(a.channels[0][0], 0.0);
        // 0.5秒（22050標本）かけて大きくなるので、最初の1000標本は元の 1000/22050 倍以下
        assert!(a.channels[0][..1000].iter().all(|s| s.abs() < 0.03));
        assert!(a.channels[0][a.len() - 100..].iter().all(|s| s.abs() < 0.01));
        // 音より長いフェードでも壊れない
        let b = apply_all(sine(440.0, 0.1, 0.5), &[Effect::FadeIn { seconds: 5.0 }, Effect::FadeOut { seconds: 5.0 }]);
        assert_eq!(b.len(), (0.1 * RATE as f32) as usize);
    }

    #[test]
    fn decode_all_formats_and_write_wav() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        for ext in ["mp3", "wav", "flac", "ogg", "m4a"] {
            let a = decode(&dir.join(format!("base.{ext}"))).unwrap_or_else(|e| panic!("{ext}: {e}"));
            assert!(a.seconds() > 0.1, "{ext}: {}", a.seconds());
            assert!(peak(&a) > 0.01, "{ext}");
        }
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("out.wav");
        let a = sine(440.0, 0.5, 0.5);
        write_wav(&out, &a).unwrap();
        let back = decode(&out).unwrap();
        assert_eq!((back.rate, back.channels.len(), back.len()), (RATE, 2, a.len()));
        assert!(decode(&tmp.path().join("none.wav")).is_err());
    }

    /// 左を l、右を r の大きさにした同じ周波数のサイン波（l = r なら真ん中、l = -r なら左右の差だけ）
    fn panned(freq: f32, l: f32, r: f32) -> Audio {
        let a = sine(freq, 1.0, 1.0);
        let c = &a.channels[0];
        Audio { rate: RATE, channels: vec![c.iter().map(|s| s * l).collect(), c.iter().map(|s| s * r).collect()] }
    }

    /// 真ん中の部分（フィルターの立ち上がりを除く）の、左の RMS
    fn rms(audio: &Audio) -> f32 {
        let c = &audio.channels[0];
        let part = &c[c.len() / 4..c.len() * 3 / 4];
        (part.iter().map(|s| s * s).sum::<f32>() / part.len() as f32).sqrt()
    }

    #[test]
    fn off_vocal_removes_center_in_vocal_range() {
        let fx = |strength: f32| [Effect::OffVocal { strength, low_hz: 120.0, high_hz: 9000.0 }];
        let base = rms(&panned(1000.0, 0.5, 0.5));
        // 真ん中のボーカルの音域（1kHz）は消える
        let center = apply_all(panned(1000.0, 0.5, 0.5), &fx(1.0));
        assert!(rms(&center) < base * 0.05, "真ん中 {} / {base}", rms(&center));
        // 強さ 50% なら半分
        let half = apply_all(panned(1000.0, 0.5, 0.5), &fx(0.5));
        assert!((rms(&half) / base - 0.5).abs() < 0.05, "半分 {}", rms(&half) / base);
        // 強さ 0% なら大きさは変わらない（位相だけずれる）
        let none = apply_all(panned(1000.0, 0.5, 0.5), &fx(0.0));
        assert!((rms(&none) / base - 1.0).abs() < 0.02, "0% {}", rms(&none) / base);
        // 左右の差の音（左右に振った音）は残る
        let side = apply_all(panned(1000.0, 0.5, -0.5), &fx(1.0));
        assert!((rms(&side) / base - 1.0).abs() < 0.02, "左右の差 {}", rms(&side) / base);
        // 片方だけの音は、真ん中の分だけ減る（左だけ 0.5 = 真ん中 0.25 + 差 0.25 → 差の 0.25 が残る）
        let left = apply_all(panned(1000.0, 0.5, 0.0), &fx(1.0));
        assert!((rms(&left) / base - 0.5).abs() < 0.05, "左だけ {}", rms(&left) / base);
        // 真ん中でも、音域の外（60Hz・14kHz）は残る
        for f in [60.0, 14000.0] {
            let b = rms(&panned(f, 0.5, 0.5));
            let out = apply_all(panned(f, 0.5, 0.5), &fx(1.0));
            assert!((rms(&out) / b - 1.0).abs() < 0.1, "{f}Hz {}", rms(&out) / b);
        }
        // モノラルの音はそのまま
        let mono = Audio { rate: RATE, channels: vec![sine(1000.0, 0.5, 0.5).channels[0].clone()] };
        assert_eq!(apply_all(mono.clone(), &fx(1.0)), mono);
        // 長さは変わらない
        assert_eq!(center.len(), panned(1000.0, 0.5, 0.5).len());
    }

    #[test]
    fn settings_are_clamped() {
        assert_eq!(
            Effect::OffVocal { strength: 2.0, low_hz: 1.0, high_hz: 99999.0 }.clamped(),
            Effect::OffVocal { strength: 1.0, low_hz: 50.0, high_hz: 16000.0 }
        );
        assert_eq!(Effect::Gain { db: 99.0 }.clamped(), Effect::Gain { db: 12.0 });
        assert_eq!(
            Effect::SpeedPitch { speed: 9.0, semitones: -40.0 }.clamped(),
            Effect::SpeedPitch { speed: 2.0, semitones: -12.0 }
        );
    }

    /// 長さの違う音に8つのエフェクトをかける時間を測る。cargo test --release effect_speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn effect_speed() {
        use std::time::Instant;
        let all = [
            Effect::Gain { db: -3.0 },
            Effect::Normalize { method: NormalizeMethod::Rms, target_db: -16.0 },
            Effect::SpeedPitch { speed: 1.2, semitones: 3.0 },
            Effect::Reverb { seconds: 1.5, mix: 0.3 },
            Effect::Echo { delay: 0.3, feedback: 0.4, mix: 0.3 },
            Effect::FadeIn { seconds: 1.0 },
            Effect::FadeOut { seconds: 1.0 },
            Effect::OffVocal { strength: 1.0, low_hz: 120.0, high_hz: 9000.0 },
        ];
        for seconds in [5.0, 60.0, 300.0] {
            let src = sine(440.0, seconds, 0.5);
            let t0 = Instant::now();
            let out = apply_all(src.clone(), &all);
            let all_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let t1 = Instant::now();
            apply_all(src.clone(), &all[2..3]);
            let sp_ms = t1.elapsed().as_secs_f64() * 1000.0;
            let t2 = Instant::now();
            apply_all(src.clone(), &all[3..4]);
            let rv_ms = t2.elapsed().as_secs_f64() * 1000.0;
            let t4 = Instant::now();
            apply_all(src, &all[7..8]);
            let ov_ms = t4.elapsed().as_secs_f64() * 1000.0;
            let tmp = std::env::temp_dir().join("cyanomelody_effect_speed.wav");
            let t3 = Instant::now();
            write_wav(&tmp, &out).unwrap();
            let w_ms = t3.elapsed().as_secs_f64() * 1000.0;
            println!(
                "{seconds}秒（ステレオ44.1kHz）：8つすべて {all_ms:.0}ms（速度・音程 {sp_ms:.0}ms、リバーブ {rv_ms:.0}ms、簡易オフボーカル {ov_ms:.0}ms）、WAVの書き出し {w_ms:.0}ms"
            );
        }
    }
}
