//! C-4（ストリーミング再生とシーク）、B-2（音声形式）、C-5（タグの部分読み込み）の検証。
//! HTTP の Range 指定で必要な部分だけを取得しながら、タグの読み込み、デコード、シークを行い、
//! 通信の回数と量を数える。Google Drive の `files.get?alt=media` も Range 指定に対応している。

use std::collections::HashMap;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use lofty::config::ParseOptions;
use lofty::prelude::*;
use lofty::probe::Probe;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;


/// 1回の通信で取得する単位。環境変数 CHUNK_KB で変えられる。
static CHUNK: LazyLock<u64> = LazyLock::new(|| {
    std::env::var("CHUNK_KB").ok().and_then(|v| v.parse().ok()).unwrap_or(256) * 1024
});

#[derive(Default)]
struct Stats {
    requests: AtomicU64,
    bytes: AtomicU64,
}

impl Stats {
    fn snapshot(&self) -> (u64, u64) {
        (self.requests.load(Ordering::Relaxed), self.bytes.load(Ordering::Relaxed))
    }
}

/// Range 指定で CHUNK 単位に取得し、取得済みの部分は使い回す読み込み口。
struct HttpRangeSource {
    url: String,
    len: u64,
    pos: u64,
    chunks: HashMap<u64, Vec<u8>>,
    stats: Arc<Stats>,
}

impl HttpRangeSource {
    fn open(url: &str, stats: Arc<Stats>) -> io::Result<Self> {
        let resp = ureq::head(url).call().map_err(io::Error::other)?;
        let len = resp
            .header("Content-Length")
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| io::Error::other("Content-Length がない"))?;
        Ok(Self { url: url.to_string(), len, pos: 0, chunks: HashMap::new(), stats })
    }

    fn chunk(&mut self, idx: u64) -> io::Result<&Vec<u8>> {
        if !self.chunks.contains_key(&idx) {
            let start = idx * *CHUNK;
            let end = (start + *CHUNK).min(self.len) - 1;
            let resp = ureq::get(&self.url)
                .set("Range", &format!("bytes={start}-{end}"))
                .call()
                .map_err(io::Error::other)?;
            if resp.status() != 206 {
                return Err(io::Error::other(format!("Range に対応していない: {}", resp.status())));
            }
            let mut buf = Vec::with_capacity((end - start + 1) as usize);
            resp.into_reader().read_to_end(&mut buf)?;
            self.stats.requests.fetch_add(1, Ordering::Relaxed);
            self.stats.bytes.fetch_add(buf.len() as u64, Ordering::Relaxed);
            self.chunks.insert(idx, buf);
        }
        Ok(&self.chunks[&idx])
    }
}

impl Read for HttpRangeSource {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || out.is_empty() {
            return Ok(0);
        }
        let idx = self.pos / *CHUNK;
        let offset = (self.pos % *CHUNK) as usize;
        let chunk = self.chunk(idx)?;
        let n = out.len().min(chunk.len() - offset);
        out[..n].copy_from_slice(&chunk[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeSource {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let pos = match from {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::End(d) => self.len as i64 + d,
            SeekFrom::Current(d) => self.pos as i64 + d,
        };
        if pos < 0 {
            return Err(io::Error::other("負の位置にはシークできない"));
        }
        self.pos = pos as u64;
        Ok(self.pos)
    }
}

impl MediaSource for HttpRangeSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

fn kb(b: u64) -> String {
    format!("{:.0}KB", b as f64 / 1024.0)
}

fn check_tags(url: &str) -> io::Result<()> {
    let stats = Arc::new(Stats::default());
    let src = HttpRangeSource::open(url, stats.clone())?;
    let started = Instant::now();
    let tagged = Probe::new(src)
        .options(ParseOptions::new().read_properties(false))
        .guess_file_type()?
        .read()
        .map_err(io::Error::other)?;
    let (req, bytes) = stats.snapshot();
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let field = |f: Option<std::borrow::Cow<str>>| f.map(|s| s.into_owned()).unwrap_or_else(|| "(なし)".into());
    println!(
        "  タグ    : 曲名={} / アーティスト={} / アルバム={}",
        field(tag.and_then(|t| t.title())),
        field(tag.and_then(|t| t.artist())),
        field(tag.and_then(|t| t.album())),
    );
    println!("            通信 {req}回 {} / {:?}", kb(bytes), started.elapsed());
    Ok(())
}

fn check_decode(url: &str, ext: &str) -> Result<(), SymError> {
    let stats = Arc::new(Stats::default());
    let src = HttpRangeSource::open(url, stats.clone())?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let probed = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions { enable_gapless: false, ..Default::default() },
        &MetadataOptions::default(),
    )?;
    let mut format = probed.format;
    let track = format.default_track().ok_or(SymError::Unsupported("トラックがない"))?.clone();
    let tb = track.codec_params.time_base.ok_or(SymError::Unsupported("time_base がない"))?;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let to_sec = |ts: u64| {
        let t = tb.calc_time(ts);
        t.seconds as f64 + t.frac
    };
    let duration = track.codec_params.n_frames.map(|n| format!("{:.1}秒", to_sec(n))).unwrap_or("不明".into());

    // 再生開始：最初の音が出せるまでに必要な通信
    let packet = format.next_packet()?;
    decoder.decode(&packet)?;
    let (req, bytes) = stats.snapshot();
    println!(
        "  再生開始: {} {}Hz 長さ{} / 最初の音まで 通信 {req}回 {}",
        symphonia::default::get_codecs().get_codec(track.codec_params.codec).map_or("?", |d| d.short_name),
        track.codec_params.sample_rate.unwrap_or(0),
        duration,
        kb(bytes)
    );

    // シーク：前方（120秒）と後方（30秒）
    for target in [120.0, 30.0] {
        let (req0, bytes0) = stats.snapshot();
        let seeked = format.seek(
            SeekMode::Accurate,
            SeekTo::Time { time: Time::from(target), track_id: Some(track.id) },
        )?;
        decoder.reset();
        // シーク後に最初にデコードできたパケットの位置
        let first_ts = loop {
            let p = format.next_packet()?;
            if p.track_id() != track.id {
                continue;
            }
            decoder.decode(&p)?;
            break p.ts();
        };
        let (req1, bytes1) = stats.snapshot();
        println!(
            "  シーク  : {target:>5.1}秒へ → 着地 {:.3}秒 / 最初のパケット {:.3}秒 / 通信 {}回 {}",
            to_sec(seeked.actual_ts),
            to_sec(first_ts),
            req1 - req0,
            kb(bytes1 - bytes0)
        );
    }

    // 最後までデコードして、エラーなく読み切れるか
    let mut decoded_frames = 0u64;
    let mut last_ts = 0;
    loop {
        match format.next_packet() {
            Ok(p) => {
                if p.track_id() != track.id {
                    continue;
                }
                last_ts = p.ts() + p.dur();
                decoded_frames += decoder.decode(&p)?.frames() as u64;
            }
            Err(SymError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        }
    }
    let (req, bytes) = stats.snapshot();
    println!(
        "  読み切り: 30秒から末尾 {:.1}秒までデコード（{decoded_frames}フレーム）/ 合計 通信 {req}回 {}",
        to_sec(last_ts),
        kb(bytes)
    );
    Ok(())
}

fn main() {
    let base = std::env::args().nth(1).unwrap_or("http://cm-media".into());
    for name in ["cbr.mp3", "vbr.mp3", "song.wav", "notag.wav", "faststart.m4a", "moov_end.m4a"] {
        let url = format!("{base}/{name}");
        let ext = name.rsplit('.').next().unwrap();
        println!("■ {name}");
        if let Err(e) = check_tags(&url) {
            println!("  タグ    : 失敗 {e}");
        }
        if let Err(e) = check_decode(&url, ext) {
            println!("  デコード: 失敗 {e}");
        }
    }
}
