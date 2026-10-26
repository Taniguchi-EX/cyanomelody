//! B-1（デスクトップで同じコードで鳴らせるか）の検証。
//! Symphonia でデコードした音を cpal で既定の出力先から鳴らす。音量はアプリ内で変える。
//! 使い方: play_local <ファイル> [音量 0.0〜1.0]

use std::collections::VecDeque;
use std::fs::File;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;

/// ファイルを最後までデコードし、ステレオの f32 とサンプルレートを返す。
fn decode(path: &str) -> Result<(Vec<f32>, u32), SymError> {
    let mss = MediaSourceStream::new(Box::new(File::open(path)?), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.rsplit('.').next() {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .format(&hint, mss, &Default::default(), &Default::default())?
        .format;
    let track = format.default_track().ok_or(SymError::Unsupported("トラックがない"))?.clone();
    let rate = track.codec_params.sample_rate.unwrap_or(44100);
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let mut out = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        };
        let decoded = decoder.decode(&packet)?;
        let ch = decoded.spec().channels.count();
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks(ch) {
            let (l, r) = (frame[0], *frame.get(1).unwrap_or(&frame[0]));
            out.extend_from_slice(&[l, r]);
        }
    }
    Ok((out, rate))
}

/// ステレオの音を、出力先のサンプルレートに線形補間で合わせる。
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return input.to_vec();
    }
    let frames = input.len() / 2;
    let out_frames = (frames as u64 * to as u64 / from as u64) as usize;
    let mut out = Vec::with_capacity(out_frames * 2);
    for i in 0..out_frames {
        let pos = i as f64 * from as f64 / to as f64;
        let j = pos as usize;
        let t = (pos - j as f64) as f32;
        for c in 0..2 {
            let a = input[j * 2 + c];
            let b = input.get((j + 1) * 2 + c).copied().unwrap_or(a);
            out.push(a + (b - a) * t);
        }
    }
    out
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("ファイルを指定してください")?;
    let volume: f32 = args.next().map(|v| v.parse()).transpose()?.unwrap_or(0.5);

    let (samples, rate) = decode(&path)?;
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("出力先がない")?;
    let config = device.default_output_config()?;
    let out_rate = config.sample_rate().0;
    let out_ch = config.channels() as usize;
    println!(
        "出力: {:?} / {} / {}Hz {}ch {:?} / ファイル {}Hz {:.1}秒",
        host.id(),
        device.name()?,
        out_rate,
        out_ch,
        config.sample_format(),
        rate,
        samples.len() as f64 / 2.0 / rate as f64
    );

    let queue = Arc::new(Mutex::new(VecDeque::from(resample(&samples, rate, out_rate))));
    let q = queue.clone();
    let stream = device.build_output_stream(
        &config.into(),
        move |data: &mut [f32], _| {
            let mut q = q.lock().unwrap();
            for frame in data.chunks_mut(out_ch) {
                let (l, r) = (q.pop_front().unwrap_or(0.0), q.pop_front().unwrap_or(0.0));
                for (i, s) in frame.iter_mut().enumerate() {
                    *s = if i % 2 == 0 { l } else { r } * volume;
                }
            }
        },
        |e| eprintln!("出力エラー: {e}"),
        None,
    )?;
    stream.play()?;
    while !queue.lock().unwrap().is_empty() {
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_millis(300));
    println!("再生完了");
    Ok(())
}
