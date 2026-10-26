//! 再生エンジンの本体。
//!
//! 専用のスレッド（以下、ワーカー）が操作を受け付け、曲を開いてデコードし、サンプルレートを
//! 変換してバッファに積む。出力先はバッファから取り出して鳴らす。デコードや通信で待っても
//! 音が途切れないよう、出力先の処理（`render`）ではバッファから取り出すことしかしない。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use symphonia::core::io::MediaSource;

use super::PlaybackError;
use super::decode::TrackDecoder;
use super::output::{AudioOutput, OutputFormat};
use super::queue::PlayQueue;
use super::resample::StereoResampler;

/// バッファに積んでおく音の長さ（秒）。
const BUFFER_SECONDS: f64 = 0.5;
/// 「前の曲」を押したとき、この秒数より進んでいれば曲の頭に戻す。
const RESTART_THRESHOLD_SECONDS: f64 = 3.0;

/// プレイリストの 1 曲。`key` は音楽ソースが曲を見分けるための値（Drive のファイル ID、ローカルのパスなど）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackRef {
    pub key: String,
    /// 形式の推定の手がかり（`mp3`、`wav`、`m4a`）
    pub extension: String,
}

/// 曲を開く関数。音楽ソースの層が用意する。
pub type TrackOpener = Arc<dyn Fn(&TrackRef) -> Result<Box<dyn MediaSource>, PlaybackError> + Send + Sync>;

/// 再生の状態の変化を受け取る関数。ワーカーのスレッドから呼ばれる。
pub type EventHandler = Arc<dyn Fn(PlayerEvent) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayState {
    Stopped,
    Playing,
    Paused,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlayerEvent {
    /// 再生する曲が変わった（プレイリスト内の位置）
    TrackChanged {
        index: usize,
    },
    StateChanged(PlayState),
    /// 曲を再生できず、飛ばした
    TrackFailed {
        index: usize,
        error: PlaybackError,
    },
    /// 最後まで再生した、またはどの曲も再生できず止まった
    Finished,
}

/// 再生の状態。
#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub state: PlayState,
    /// 再生中の曲のプレイリスト内の位置
    pub index: Option<usize>,
    /// 再生位置（秒）
    pub position: f64,
    /// 曲の長さ（秒）
    pub duration: Option<f64>,
    pub shuffle: bool,
    pub repeat: bool,
    pub volume: f32,
}

enum Command {
    Load { tracks: Vec<TrackRef>, start: usize },
    Play,
    Pause,
    Stop,
    Next,
    Prev,
    JumpTo(usize),
    Seek(f64),
    Shuffle(bool),
    Repeat(bool),
    Shutdown,
}

/// ワーカーと出力先が共有するもの。
struct Shared {
    /// 出力先のサンプルレートに変換済みの、ステレオで左右交互の音
    buffer: Mutex<VecDeque<f32>>,
    /// 今の曲で、出力先に渡したフレーム数（再生位置の計算に使う）
    rendered: AtomicU64,
    /// 音量（f32 のビット列）
    volume: AtomicU32,
}

/// 再生エンジン。操作はすぐに戻り、実際の処理はワーカーが行う。
pub struct Player {
    tx: Sender<Command>,
    shared: Arc<Shared>,
    status: Arc<Mutex<WorkerStatus>>,
    worker: Option<JoinHandle<()>>,
}

/// ワーカーが更新する状態。再生位置は、`base` に出力済みのフレーム数を足して求める。
#[derive(Clone)]
struct WorkerStatus {
    status: Status,
    base: f64,
    sample_rate: u32,
}

impl Player {
    /// 再生エンジンを起動する。`output` は出力先を作る関数で、ワーカーのスレッドで呼ばれる
    /// （cpal の出力先はスレッドをまたいで渡せないことがあるため）。
    pub fn new<F>(output: F, opener: TrackOpener, events: EventHandler) -> Self
    where
        F: FnOnce() -> Box<dyn AudioOutput> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            buffer: Mutex::new(VecDeque::new()),
            rendered: AtomicU64::new(0),
            volume: AtomicU32::new(1.0f32.to_bits()),
        });
        let status = Arc::new(Mutex::new(WorkerStatus {
            status: Status {
                state: PlayState::Stopped,
                index: None,
                position: 0.0,
                duration: None,
                shuffle: false,
                repeat: false,
                volume: 1.0,
            },
            base: 0.0,
            sample_rate: 0,
        }));
        let worker = {
            let (shared, status) = (shared.clone(), status.clone());
            std::thread::Builder::new()
                .name("cyanomelody-player".into())
                .spawn(move || {
                    Worker {
                        rx,
                        shared,
                        status,
                        output: output(),
                        format: None,
                        opener,
                        events,
                        tracks: Vec::new(),
                        queue: PlayQueue::new(0, 0, false, false),
                        decoder: None,
                        resampler: None,
                        draining: false,
                        failures: 0,
                    }
                    .run()
                })
                .expect("再生のスレッドを起動できない")
        };
        Self { tx, shared, status, worker: Some(worker) }
    }

    /// プレイリストを読み込み、`start` 番目の曲から再生する。
    pub fn load(&self, tracks: Vec<TrackRef>, start: usize) {
        self.send(Command::Load { tracks, start });
    }

    pub fn play(&self) {
        self.send(Command::Play);
    }

    pub fn pause(&self) {
        self.send(Command::Pause);
    }

    pub fn stop(&self) {
        self.send(Command::Stop);
    }

    pub fn next(&self) {
        self.send(Command::Next);
    }

    /// 前の曲へ。再生位置が 3 秒より後なら、今の曲の頭に戻る。
    pub fn prev(&self) {
        self.send(Command::Prev);
    }

    /// プレイリストの `index` 番目の曲を再生する。
    pub fn jump_to(&self, index: usize) {
        self.send(Command::JumpTo(index));
    }

    pub fn seek(&self, seconds: f64) {
        self.send(Command::Seek(seconds));
    }

    pub fn set_shuffle(&self, shuffle: bool) {
        self.send(Command::Shuffle(shuffle));
    }

    pub fn set_repeat(&self, repeat: bool) {
        self.send(Command::Repeat(repeat));
    }

    /// アプリ内の音量（0.0〜1.0）。Android では OS の音量を使うため、1.0 のままにする。
    pub fn set_volume(&self, volume: f32) {
        let volume = volume.clamp(0.0, 1.0);
        self.shared.volume.store(volume.to_bits(), Ordering::Relaxed);
        self.status.lock().unwrap().status.volume = volume;
    }

    pub fn status(&self) -> Status {
        let ws = self.status.lock().unwrap().clone();
        let mut status = ws.status;
        if ws.sample_rate > 0 && status.index.is_some() {
            status.position =
                ws.base + self.shared.rendered.load(Ordering::Relaxed) as f64 / ws.sample_rate as f64;
            if let Some(d) = status.duration {
                status.position = status.position.min(d);
            }
        }
        status
    }

    fn send(&self, command: Command) {
        // ワーカーが終わっているときは何もしない
        let _ = self.tx.send(command);
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.send(Command::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Worker {
    rx: Receiver<Command>,
    shared: Arc<Shared>,
    status: Arc<Mutex<WorkerStatus>>,
    output: Box<dyn AudioOutput>,
    format: Option<OutputFormat>,
    opener: TrackOpener,
    events: EventHandler,
    tracks: Vec<TrackRef>,
    queue: PlayQueue,
    decoder: Option<TrackDecoder>,
    resampler: Option<StereoResampler>,
    /// 今の曲を最後までデコードし、バッファが空になるのを待っている
    draining: bool,
    /// 続けて再生できなかった曲の数
    failures: usize,
}

impl Worker {
    fn run(mut self) {
        loop {
            let command = if self.state() == PlayState::Playing {
                match self.rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(c) => Some(c),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match self.rx.recv() {
                    Ok(c) => Some(c),
                    Err(_) => break,
                }
            };
            if let Some(command) = command {
                if matches!(command, Command::Shutdown) {
                    break;
                }
                self.handle(command);
            }
            if self.state() == PlayState::Playing {
                self.fill();
            }
        }
        self.output.close();
    }

    fn state(&self) -> PlayState {
        self.status.lock().unwrap().status.state
    }

    fn set_state(&mut self, state: PlayState) {
        let changed = {
            let mut ws = self.status.lock().unwrap();
            let changed = ws.status.state != state;
            ws.status.state = state;
            if state == PlayState::Stopped {
                ws.status.index = None;
                ws.status.duration = None;
                ws.base = 0.0;
            }
            changed
        };
        if changed {
            (self.events)(PlayerEvent::StateChanged(state));
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Load { tracks, start } => {
                let (shuffle, repeat) = (self.queue.shuffle(), self.queue.repeat());
                self.tracks = tracks;
                self.queue = PlayQueue::new(self.tracks.len(), start, shuffle, repeat);
                self.failures = 0;
                match self.queue.current() {
                    Some(index) => {
                        if self.ensure_output() {
                            self.set_state(PlayState::Playing);
                            self.start_track(index);
                        }
                    }
                    None => self.stop(),
                }
            }
            Command::Play => match self.state() {
                PlayState::Paused => {
                    if self.ensure_output() {
                        self.set_state(PlayState::Playing);
                    }
                }
                PlayState::Stopped => {
                    if let Some(index) = self.queue.current()
                        && self.ensure_output()
                    {
                        self.set_state(PlayState::Playing);
                        self.start_track(index);
                    }
                }
                PlayState::Playing => {}
            },
            Command::Pause => {
                if self.state() == PlayState::Playing {
                    // 止めている間は出力先を閉じる（Android で電池を使わないため）。積んだ音は残す
                    self.output.close();
                    self.set_state(PlayState::Paused);
                }
            }
            Command::Stop => self.stop(),
            Command::Next => {
                if self.state() != PlayState::Stopped {
                    self.play_next();
                }
            }
            Command::Prev => {
                if self.state() != PlayState::Stopped {
                    let position = self.position();
                    if position > RESTART_THRESHOLD_SECONDS {
                        self.seek(0.0);
                    } else if let Some(index) = self.queue.go_back() {
                        self.start_track(index);
                    }
                }
            }
            Command::JumpTo(index) => {
                if self.queue.jump_to(index).is_some() && self.ensure_output() {
                    self.failures = 0;
                    if self.state() != PlayState::Playing {
                        self.set_state(PlayState::Playing);
                    }
                    self.start_track(index);
                }
            }
            Command::Seek(seconds) => self.seek(seconds),
            Command::Shuffle(shuffle) => {
                self.queue.set_shuffle(shuffle);
                self.status.lock().unwrap().status.shuffle = shuffle;
            }
            Command::Repeat(repeat) => {
                self.queue.set_repeat(repeat);
                self.status.lock().unwrap().status.repeat = repeat;
            }
            Command::Shutdown => {}
        }
    }

    /// 出力先が開いていなければ開く。開けなければ止めて偽を返す。
    fn ensure_output(&mut self) -> bool {
        if self.output.is_open() {
            return true;
        }
        let shared = self.shared.clone();
        let render = Box::new(move |out: &mut [f32], channels: usize| render(&shared, out, channels));
        match self.output.open(render) {
            Ok(format) => {
                if self.format.is_some_and(|f| f.sample_rate != format.sample_rate) {
                    // 出力先のサンプルレートが変わったら、今の位置からデコードし直す
                    let position = self.position();
                    self.format = Some(format);
                    self.seek(position);
                } else {
                    self.format = Some(format);
                }
                self.status.lock().unwrap().sample_rate = format.sample_rate;
                true
            }
            Err(e) => {
                log::error!("{e}");
                self.stop();
                false
            }
        }
    }

    fn position(&self) -> f64 {
        let ws = self.status.lock().unwrap();
        if ws.sample_rate == 0 {
            return ws.base;
        }
        ws.base + self.shared.rendered.load(Ordering::Relaxed) as f64 / ws.sample_rate as f64
    }

    fn clear_buffer(&self, base: f64) {
        self.shared.buffer.lock().unwrap().clear();
        self.shared.rendered.store(0, Ordering::Relaxed);
        self.status.lock().unwrap().base = base;
    }

    /// `index` 番目の曲を開いて再生を始める。開けなければ次の曲に進む。
    fn start_track(&mut self, mut index: usize) {
        loop {
            self.decoder = None;
            self.resampler = None;
            self.draining = false;
            self.clear_buffer(0.0);
            {
                let mut ws = self.status.lock().unwrap();
                ws.status.index = Some(index);
                ws.status.duration = None;
            }
            (self.events)(PlayerEvent::TrackChanged { index });
            match self.open(index) {
                Ok(()) => return,
                Err(error) => match self.skip_failed(index, error) {
                    Some(next) => index = next,
                    None => return,
                },
            }
        }
    }

    /// 曲を再生できなかった（開けない、途中で読めなくなった）。知らせて次の曲に進み、その位置を返す。
    /// 続けて全曲が再生できなかったとき（リピート中でも）と、最後の曲だったときは止めて `None` を返す。
    fn skip_failed(&mut self, index: usize, error: PlaybackError) -> Option<usize> {
        log::warn!("{index} 番目の曲を再生できない: {error}");
        (self.events)(PlayerEvent::TrackFailed { index, error });
        self.failures += 1;
        let next = if self.failures >= self.queue.len() {
            log::warn!("どの曲も再生できないため止める");
            None
        } else {
            self.queue.advance()
        };
        if next.is_none() {
            self.finish();
        }
        next
    }

    /// 次の曲を再生する。最後の曲の次がなければ（リピートしないとき）終える。
    fn play_next(&mut self) {
        match self.queue.advance() {
            Some(index) => self.start_track(index),
            None => self.finish(),
        }
    }

    fn open(&mut self, index: usize) -> Result<(), PlaybackError> {
        let track = &self.tracks[index];
        let source = (self.opener)(track)?;
        let decoder = TrackDecoder::open(source, &track.extension)?;
        let out_rate = self.format.map(|f| f.sample_rate).unwrap_or(decoder.sample_rate());
        self.resampler = Some(StereoResampler::new(decoder.sample_rate(), out_rate)?);
        self.status.lock().unwrap().status.duration = decoder.duration();
        self.decoder = Some(decoder);
        Ok(())
    }

    fn seek(&mut self, seconds: f64) {
        let (Some(decoder), Some(format)) = (self.decoder.as_mut(), self.format) else {
            return;
        };
        match decoder.seek(seconds) {
            Ok(landed) => {
                let in_rate = decoder.sample_rate();
                self.draining = false;
                self.clear_buffer(landed);
                match StereoResampler::new(in_rate, format.sample_rate) {
                    Ok(r) => self.resampler = Some(r),
                    Err(e) => log::error!("{e}"),
                }
            }
            Err(e) => log::warn!("シークできない: {e}"),
        }
    }

    /// バッファが少なくなっていれば、デコードして積む。
    fn fill(&mut self) {
        let Some(format) = self.format else { return };
        let target = (format.sample_rate as f64 * BUFFER_SECONDS) as usize * 2;
        loop {
            let buffered = self.shared.buffer.lock().unwrap().len();
            if self.draining {
                // 曲を最後まで鳴らし終えたら次の曲へ
                if buffered == 0 {
                    self.play_next();
                }
                return;
            }
            if buffered >= target {
                return;
            }
            let (Some(decoder), Some(resampler)) = (self.decoder.as_mut(), self.resampler.as_mut()) else {
                return;
            };
            match decoder.next_frames() {
                Ok(Some(frames)) => {
                    self.failures = 0;
                    let converted = resampler.process(&frames);
                    self.shared.buffer.lock().unwrap().extend(converted);
                }
                Ok(None) => {
                    let rest = resampler.flush();
                    self.shared.buffer.lock().unwrap().extend(rest);
                    self.draining = true;
                }
                Err(error) => {
                    // 途中で読めなくなった曲（通信が切れたなど）は飛ばす
                    let index = self.queue.current().unwrap_or_default();
                    if let Some(next) = self.skip_failed(index, error) {
                        self.start_track(next);
                    }
                    return;
                }
            }
        }
    }

    fn stop(&mut self) {
        self.output.close();
        self.decoder = None;
        self.resampler = None;
        self.draining = false;
        self.clear_buffer(0.0);
        self.set_state(PlayState::Stopped);
    }

    /// プレイリストの最後まで再生した（またはどの曲も再生できなかった）。
    fn finish(&mut self) {
        self.stop();
        (self.events)(PlayerEvent::Finished);
    }
}

/// 出力先の処理。バッファから取り出して音量を掛けるだけにする（待たない、重い処理をしない）。
fn render(shared: &Shared, out: &mut [f32], channels: usize) {
    let volume = f32::from_bits(shared.volume.load(Ordering::Relaxed));
    let mut buffer = shared.buffer.lock().unwrap();
    let mut rendered = 0;
    for frame in out.chunks_mut(channels.max(1)) {
        let (left, right) = match (buffer.pop_front(), buffer.pop_front()) {
            (Some(l), Some(r)) => {
                rendered += 1;
                (l * volume, r * volume)
            }
            _ => (0.0, 0.0),
        };
        match frame.len() {
            1 => frame[0] = (left + right) * 0.5,
            _ => {
                frame[0] = left;
                frame[1] = right;
                for s in &mut frame[2..] {
                    *s = 0.0;
                }
            }
        }
    }
    shared.rendered.fetch_add(rendered, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::decode::tests::wav;
    use crate::playback::output::RenderFn;
    use std::io::Cursor;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    /// 実際より速く `render` を呼び続ける偽の出力先。
    struct FakeOutput {
        sample_rate: u32,
        running: Option<(Arc<AtomicBool>, JoinHandle<()>)>,
        opens: Arc<AtomicUsize>,
        rendered_samples: Arc<AtomicU64>,
    }

    use std::sync::atomic::AtomicBool;

    impl AudioOutput for FakeOutput {
        fn open(&mut self, mut render: RenderFn) -> Result<OutputFormat, PlaybackError> {
            self.close();
            self.opens.fetch_add(1, Ordering::Relaxed);
            let stop = Arc::new(AtomicBool::new(false));
            let (s, rendered) = (stop.clone(), self.rendered_samples.clone());
            let handle = std::thread::spawn(move || {
                let mut buf = vec![0.0f32; 2048];
                while !s.load(Ordering::Relaxed) {
                    render(&mut buf, 2);
                    rendered.fetch_add(buf.iter().filter(|v| **v != 0.0).count() as u64, Ordering::Relaxed);
                    std::thread::sleep(Duration::from_millis(1));
                }
            });
            self.running = Some((stop, handle));
            Ok(OutputFormat { sample_rate: self.sample_rate, channels: 2 })
        }

        fn close(&mut self) {
            if let Some((stop, handle)) = self.running.take() {
                stop.store(true, Ordering::Relaxed);
                let _ = handle.join();
            }
        }

        fn is_open(&self) -> bool {
            self.running.is_some()
        }
    }

    struct Harness {
        player: Player,
        events: Arc<Mutex<Vec<PlayerEvent>>>,
        opens: Arc<AtomicUsize>,
    }

    /// `keys` の曲を持つ再生エンジンを作る。`bad` で始まる key は開けない曲にする。
    fn harness(out_rate: u32) -> Harness {
        let events = Arc::new(Mutex::new(Vec::new()));
        let opens = Arc::new(AtomicUsize::new(0));
        let opener: TrackOpener = Arc::new(|track: &TrackRef| {
            if track.key.starts_with("bad") {
                return Err(PlaybackError::Open(format!("{} がない", track.key)));
            }
            let seconds: f64 = track.key.trim_start_matches("ok").parse().unwrap_or(0.2);
            Ok(Box::new(Cursor::new(wav(44100, seconds))) as Box<dyn MediaSource>)
        });
        let ev = events.clone();
        let handler: EventHandler = Arc::new(move |e| ev.lock().unwrap().push(e));
        let o = opens.clone();
        let player = Player::new(
            move || {
                Box::new(FakeOutput {
                    sample_rate: out_rate,
                    running: None,
                    opens: o,
                    rendered_samples: Arc::new(AtomicU64::new(0)),
                })
            },
            opener,
            handler,
        );
        Harness { player, events, opens }
    }

    fn tracks(keys: &[&str]) -> Vec<TrackRef> {
        keys.iter().map(|k| TrackRef { key: k.to_string(), extension: "wav".into() }).collect()
    }

    fn wait_for(h: &Harness, what: &str, cond: impl Fn(&[PlayerEvent]) -> bool) {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            if cond(&h.events.lock().unwrap()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{what} を待ちきれなかった: {:?}", h.events.lock().unwrap());
    }

    fn changed(events: &[PlayerEvent]) -> Vec<usize> {
        events
            .iter()
            .filter_map(|e| match e {
                PlayerEvent::TrackChanged { index } => Some(*index),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn plays_tracks_in_order_and_finishes() {
        let h = harness(48000);
        h.player.load(tracks(&["ok0.2", "ok0.2", "ok0.2"]), 0);
        wait_for(&h, "最後まで再生", |e| e.contains(&PlayerEvent::Finished));
        let events = h.events.lock().unwrap();
        assert_eq!(changed(&events), vec![0, 1, 2]);
        assert_eq!(events.first(), Some(&PlayerEvent::StateChanged(PlayState::Playing)));
        assert!(events.contains(&PlayerEvent::StateChanged(PlayState::Stopped)));
        assert_eq!(h.player.status().state, PlayState::Stopped);
    }

    #[test]
    fn skips_tracks_that_cannot_be_opened() {
        let h = harness(44100);
        h.player.load(tracks(&["ok0.1", "bad1", "ok0.1"]), 0);
        wait_for(&h, "最後まで再生", |e| e.contains(&PlayerEvent::Finished));
        let events = h.events.lock().unwrap();
        assert_eq!(changed(&events), vec![0, 1, 2]);
        assert!(events.iter().any(|e| matches!(e, PlayerEvent::TrackFailed { index: 1, .. })));
    }

    #[test]
    fn stops_after_every_track_fails_even_with_repeat() {
        let h = harness(44100);
        h.player.set_repeat(true);
        h.player.load(tracks(&["bad1", "bad2", "bad3"]), 1);
        wait_for(&h, "止まる", |e| e.contains(&PlayerEvent::Finished));
        let events = h.events.lock().unwrap();
        let failed = events.iter().filter(|e| matches!(e, PlayerEvent::TrackFailed { .. })).count();
        assert_eq!(failed, 3, "一周だけ試して止まる");
    }

    #[test]
    fn repeat_loops_back_to_first() {
        let h = harness(44100);
        h.player.set_repeat(true);
        h.player.load(tracks(&["ok0.1", "ok0.1"]), 0);
        wait_for(&h, "2 周目", |e| changed(e).len() >= 4);
        assert_eq!(&changed(&h.events.lock().unwrap())[..4], &[0, 1, 0, 1]);
        h.player.stop();
    }

    #[test]
    fn pause_closes_output_and_play_reopens() {
        let h = harness(44100);
        h.player.load(tracks(&["ok5"]), 0);
        wait_for(&h, "再生", |e| e.contains(&PlayerEvent::StateChanged(PlayState::Playing)));
        h.player.pause();
        wait_for(&h, "一時停止", |e| e.contains(&PlayerEvent::StateChanged(PlayState::Paused)));
        let paused_at = h.player.status().position;
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(h.player.status().position, paused_at, "止めている間は進まない");
        h.player.play();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(h.opens.load(Ordering::Relaxed), 2, "再開で出力先を開き直す");
        assert!(h.player.status().position > paused_at);
    }

    #[test]
    fn seek_moves_position() {
        let h = harness(44100);
        h.player.load(tracks(&["ok5"]), 0);
        wait_for(&h, "再生", |e| e.contains(&PlayerEvent::StateChanged(PlayState::Playing)));
        h.player.pause();
        h.player.seek(3.0);
        std::thread::sleep(Duration::from_millis(100));
        let status = h.player.status();
        assert!((status.position - 3.0).abs() < 0.1, "位置 {}", status.position);
        assert!((status.duration.unwrap() - 5.0).abs() < 0.01);
    }

    #[test]
    fn prev_restarts_track_after_three_seconds() {
        let h = harness(44100);
        h.player.load(tracks(&["ok1", "ok5"]), 1);
        wait_for(&h, "再生", |e| changed(e) == vec![1]);
        h.player.pause();
        h.player.seek(4.0);
        h.player.prev();
        std::thread::sleep(Duration::from_millis(100));
        let status = h.player.status();
        assert_eq!(status.index, Some(1), "同じ曲のまま");
        assert!(status.position < 0.5, "頭に戻る: {}", status.position);
        h.player.prev();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(h.player.status().index, Some(0), "頭なら前の曲へ");
    }

    #[test]
    fn next_at_last_track_without_repeat_finishes() {
        let h = harness(44100);
        h.player.load(tracks(&["ok5"]), 0);
        wait_for(&h, "再生", |e| changed(e) == vec![0]);
        h.player.next();
        wait_for(&h, "終わり", |e| e.contains(&PlayerEvent::Finished));
    }

    #[test]
    fn render_applies_volume_and_fills_silence() {
        let shared = Shared {
            buffer: Mutex::new(VecDeque::from(vec![0.5, -0.5])),
            rendered: AtomicU64::new(0),
            volume: AtomicU32::new(0.5f32.to_bits()),
        };
        let mut out = vec![9.0; 6];
        render(&shared, &mut out, 2);
        assert_eq!(out, vec![0.25, -0.25, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(shared.rendered.load(Ordering::Relaxed), 1);
    }
}
