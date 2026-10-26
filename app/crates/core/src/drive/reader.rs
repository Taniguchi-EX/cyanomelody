//! Drive のファイルを Range 指定で部分取得しながら読む読み込み口。
//!
//! 本物の Drive では、部分取得 1 回に約 1 秒かかる。待ちを減らすため次の 2 つを行う。
//! - まとめて取得：前回の取得の続きを読むときは、取得する大きさを倍々に増やす（最大 4MB）
//! - 先読み：取得した範囲の後半まで読み進めたら、次の範囲を別のスレッドで先に取得しておく

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Condvar, Mutex};

use symphonia::core::io::MediaSource;

use super::{DriveClient, DriveError};
use crate::cache::CacheFile;

/// まとめて取得する大きさの上限。
const MAX_BURST_BYTES: u64 = 4 * 1024 * 1024;
/// 手元に持っておく量の上限。超えたら、読んでいる位置から遠いものから捨てる。
const MAX_CACHED_BYTES: u64 = 32 * 1024 * 1024;

pub struct RangeReader {
    shared: Arc<Shared>,
    pos: u64,
}

struct Shared {
    client: DriveClient,
    file_id: String,
    len: u64,
    /// 取得の単位
    chunk: u64,
    state: Mutex<State>,
    fetched: Condvar,
    /// 取得したものを書き込む曲のキャッシュ。書き込み済みの範囲は通信せずにそこから読む
    cache: Option<Arc<CacheFile>>,
}

#[derive(Default)]
struct State {
    chunks: HashMap<u64, Arc<Vec<u8>>>,
    /// 取得中の単位
    inflight: HashSet<u64>,
    /// 前回の取得の、次の単位
    next_idx: u64,
    /// 前回まとめて取得した単位の数
    burst: u64,
}

impl RangeReader {
    /// `len` バイトのファイル `file_id` を、`chunk` バイト単位で読む。
    /// タグの読み込みは小さめ（64KB）、再生は大きめ（256KB）を使う。
    pub fn new(client: DriveClient, file_id: &str, len: u64, chunk: u64) -> Self {
        Self {
            shared: Arc::new(Shared {
                client,
                file_id: file_id.into(),
                len,
                chunk: chunk.max(1),
                state: Mutex::new(State {
                    next_idx: u64::MAX,
                    burst: 1,
                    ..Default::default()
                }),
                fetched: Condvar::new(),
                cache: None,
            }),
            pos: 0,
        }
    }

    /// 取得したものを `cache` に書き込む。
    pub fn with_cache(
        client: DriveClient,
        file_id: &str,
        len: u64,
        chunk: u64,
        cache: Arc<CacheFile>,
    ) -> Self {
        let mut reader = Self::new(client, file_id, len, chunk);
        Arc::get_mut(&mut reader.shared)
            .expect("作った直後なので共有されていない")
            .cache = Some(cache);
        reader
    }

    pub fn len(&self) -> u64 {
        self.shared.len
    }

    pub fn is_empty(&self) -> bool {
        self.shared.len == 0
    }
}

impl Shared {
    fn chunk_count(&self) -> u64 {
        self.len.div_ceil(self.chunk)
    }

    /// `idx` 番目の単位を返す。手元になければ取得する（ほかのスレッドが取得中なら待つ）。
    fn get(self: &Arc<Self>, idx: u64) -> Result<Arc<Vec<u8>>, DriveError> {
        let mut st = self.state.lock().unwrap();
        loop {
            if let Some(c) = st.chunks.get(&idx) {
                let c = c.clone();
                self.maybe_prefetch(&mut st, idx);
                return Ok(c);
            }
            if st.inflight.contains(&idx) {
                st = self.fetched.wait(st).unwrap();
                continue;
            }
            let count = if idx == st.next_idx {
                (st.burst * 2).min(MAX_BURST_BYTES / self.chunk).max(1)
            } else {
                1
            };
            drop(st);
            self.fetch(idx, count)?;
            st = self.state.lock().unwrap();
        }
    }

    /// 取得した範囲の後半まで読み進めていたら、次の範囲を別のスレッドで取得しておく。
    fn maybe_prefetch(self: &Arc<Self>, st: &mut State, idx: u64) {
        let next = st.next_idx;
        if next == u64::MAX || next >= self.chunk_count() || idx + st.burst / 2 + 1 < next {
            return;
        }
        if st.chunks.contains_key(&next) || st.inflight.contains(&next) {
            return;
        }
        let count = (st.burst * 2).min(MAX_BURST_BYTES / self.chunk).max(1);
        // 取得中の印は、ここで付ける（同じ範囲を二重に取りに行かないため）
        let end = (next + count).min(self.chunk_count());
        st.inflight.extend(next..end);
        let shared = self.clone();
        std::thread::spawn(move || {
            if let Err(e) = shared.fetch_marked(next, end) {
                log::warn!("先読みに失敗した（必要になったときに取り直す）: {e}");
            }
        });
    }

    /// `idx` から `count` 単位を取得する。
    fn fetch(&self, idx: u64, count: u64) -> Result<(), DriveError> {
        let end = (idx + count).min(self.chunk_count());
        self.state.lock().unwrap().inflight.extend(idx..end);
        self.fetch_marked(idx, end)
    }

    /// 取得中の印を付けた `[idx, end)` を取得して手元に置く。失敗しても印は外す。
    fn fetch_marked(&self, idx: u64, end: u64) -> Result<(), DriveError> {
        let start_byte = idx * self.chunk;
        let end_byte = (end * self.chunk).min(self.len) - 1;
        let result = match &self.cache {
            Some(cache) => {
                let mut buf = vec![0u8; (end_byte - start_byte + 1) as usize];
                if cache.read(start_byte, &mut buf) {
                    Ok(buf)
                } else {
                    let fetched = self.client.read_range(&self.file_id, start_byte, end_byte);
                    if let Ok(data) = &fetched {
                        cache.write(start_byte, data);
                    }
                    fetched
                }
            }
            None => self.client.read_range(&self.file_id, start_byte, end_byte),
        };
        let mut st = self.state.lock().unwrap();
        for i in idx..end {
            st.inflight.remove(&i);
        }
        let outcome = match result {
            Ok(data) => {
                for (i, part) in data.chunks(self.chunk as usize).enumerate() {
                    st.chunks
                        .entry(idx + i as u64)
                        .or_insert_with(|| Arc::new(part.to_vec()));
                }
                st.burst = end - idx;
                st.next_idx = end;
                self.evict(&mut st, idx);
                Ok(())
            }
            Err(e) => Err(e),
        };
        self.fetched.notify_all();
        outcome
    }

    /// 手元に持つ量が上限を超えたら、`around` から遠い単位から捨てる。
    fn evict(&self, st: &mut State, around: u64) {
        let limit = (MAX_CACHED_BYTES / self.chunk) as usize;
        if st.chunks.len() <= limit {
            return;
        }
        let mut keys: Vec<u64> = st.chunks.keys().copied().collect();
        keys.sort_by_key(|k| std::cmp::Reverse(k.abs_diff(around)));
        let excess = st.chunks.len() - limit;
        for k in keys.into_iter().take(excess) {
            st.chunks.remove(&k);
        }
    }
}

impl Read for RangeReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.shared.len || out.is_empty() {
            return Ok(0);
        }
        let idx = self.pos / self.shared.chunk;
        let chunk = self.shared.get(idx).map_err(io::Error::other)?;
        let offset = (self.pos % self.shared.chunk) as usize;
        let n = out.len().min(chunk.len() - offset);
        out[..n].copy_from_slice(&chunk[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for RangeReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let pos = match from {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::End(d) => self.shared.len as i128 + d as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
        };
        if pos < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "負の位置にはシークできない",
            ));
        }
        self.pos = pos as u64;
        Ok(self.pos)
    }
}

impl MediaSource for RangeReader {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.shared.len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive::StaticToken;
    use crate::drive::mock::MockDrive;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    fn reader(mock: &MockDrive, data: Vec<u8>, chunk: u64) -> RangeReader {
        let id = mock.add_file("root", "a.wav", data.clone());
        let client = DriveClient::with_base(&mock.base_url(), Arc::new(StaticToken("t".into())));
        RangeReader::new(client, &id, data.len() as u64, chunk)
    }

    #[test]
    fn reads_whole_file_with_growing_bursts() {
        let mock = MockDrive::start();
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let mut r = reader(&mock, data.clone(), 64 * 1024);
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!(out, data);
        let requests = mock.media_requests.load(Ordering::Relaxed);
        // 1, 2, 4, 8, 16, 32... 単位とまとめて取るので、46 単位でも数回で済む
        assert!(requests <= 7, "{requests} 回");
    }

    #[test]
    fn seeks_and_reads_from_middle_and_end() {
        let mock = MockDrive::start();
        let data: Vec<u8> = (0..500_000u32).map(|i| (i % 253) as u8).collect();
        let mut r = reader(&mock, data.clone(), 64 * 1024);
        let mut buf = [0u8; 10];
        r.seek(SeekFrom::End(-10)).unwrap();
        r.read_exact(&mut buf).unwrap();
        assert_eq!(&buf[..], &data[data.len() - 10..]);
        r.seek(SeekFrom::Start(200_000)).unwrap();
        r.read_exact(&mut buf).unwrap();
        assert_eq!(&buf[..], &data[200_000..200_010]);
        assert!(r.seek(SeekFrom::Current(-1_000_000)).is_err());
    }

    #[test]
    fn prefetch_hides_latency_for_sequential_reads() {
        let mock = MockDrive::start();
        mock.set_latency(Duration::from_millis(200));
        let data = vec![7u8; 2_000_000];
        let mut r = reader(&mock, data, 64 * 1024);
        let mut buf = vec![0u8; 16 * 1024];
        // 最初の取得のあとは、少しずつ読み進めても待たされにくい
        r.read_exact(&mut buf).unwrap();
        let started = Instant::now();
        let mut waited_long = 0;
        for _ in 0..100 {
            let t = Instant::now();
            r.read_exact(&mut buf).unwrap();
            if t.elapsed() > Duration::from_millis(150) {
                waited_long += 1;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        assert!(
            waited_long <= 2,
            "先読みが効いていれば、長く待つのは数回まで: {waited_long} 回 / {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn errors_are_reported_and_retried() {
        let mock = MockDrive::start();
        let mut r = reader(&mock, vec![1u8; 1000], 100);
        mock.reject_next_requests(2);
        let mut buf = [0u8; 10];
        assert!(
            r.read_exact(&mut buf).is_err(),
            "やり直しても拒否されたらエラー"
        );
        r.seek(SeekFrom::Start(0)).unwrap();
        r.read_exact(&mut buf).unwrap();
        assert_eq!(buf, [1u8; 10], "次は取り直して読める");
    }
}
