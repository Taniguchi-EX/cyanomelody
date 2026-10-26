//! Android 実機での検証用アプリ。
//! - G-1 / A-1：埋め込んだチャイム音を Symphonia でデコードし、cpal（AAudio）で鳴らす
//! - A-2 / A-3 / A-6：常駐する再生エンジン。状態が変わると Kotlin（RustBridge）に知らせ、
//!   Kotlin のフォアグラウンドサービス、通知、ロック画面、音声フォーカスからの操作を受ける
//! - D-1 / D-2：指定フォルダの曲をファイルパスで一覧にし、再生する
//! - E-2 / G-1：端末 ID をアプリのデータ領域に保存し、上書きインストール後も残るかを見る

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::errors::Error as SymError;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::probe::Hint;
use tauri::Manager;

const CHIME: &[u8] = include_bytes!("../assets/chime.mp3");

/// ステレオの f32 とサンプルレートにデコードする。
fn decode(source: Box<dyn MediaSource>, ext: &str) -> Result<(Vec<f32>, u32), SymError> {
    let mss = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let mut format = symphonia::default::get_probe()
        .format(&hint, mss, &Default::default(), &Default::default())?
        .format;
    let track = format.default_track().ok_or(SymError::Unsupported("トラックがない"))?.clone();
    let rate = track.codec_params.sample_rate.unwrap_or(44100);
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &Default::default())?;
    let mut out = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        };
        if packet.track_id() != track.id {
            continue;
        }
        let decoded = decoder.decode(&packet)?;
        let ch = decoded.spec().channels.count();
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks(ch) {
            out.extend_from_slice(&[frame[0], *frame.get(1).unwrap_or(&frame[0])]);
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

/// 出力先のサンプルレートに合わせ済みの曲。
struct Track {
    title: String,
    samples: Vec<f32>,
}

/// 再生エンジンの状態。出力のコールバックと操作の両方から触る。
#[derive(Default)]
struct State {
    tracks: Vec<Arc<Track>>,
    index: usize,
    pos: usize,
    playing: bool,
    /// 曲を読み込んでから停止するまでの間は真。偽になると Kotlin のサービスを止める
    active: bool,
    repeat: bool,
    /// Kotlin に知らせるべき変化があった
    changed: bool,
}

impl State {
    fn next_frame(&mut self) -> (f32, f32) {
        loop {
            if !self.playing || self.tracks.is_empty() {
                return (0.0, 0.0);
            }
            let samples = &self.tracks[self.index].samples;
            if self.pos + 1 < samples.len() {
                let frame = (samples[self.pos], samples[self.pos + 1]);
                self.pos += 2;
                return frame;
            }
            self.skip(1, true);
        }
    }

    /// 曲を移る。`auto` は曲の終わりで自動的に移る場合で、リピートしないなら最後の曲で止まる。
    fn skip(&mut self, delta: i64, auto: bool) {
        let len = self.tracks.len() as i64;
        let next = self.index as i64 + delta;
        if auto && next >= len && !self.repeat {
            self.playing = false;
            self.active = false;
        } else {
            self.index = next.rem_euclid(len) as usize;
        }
        self.pos = 0;
        self.changed = true;
    }

    fn title(&self) -> String {
        self.tracks.get(self.index).map(|t| t.title.clone()).unwrap_or_default()
    }
}

struct Engine {
    state: Arc<Mutex<State>>,
    rate: u32,
    info: String,
}

static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();

/// 再生エンジンを起動する（初回だけ）。出力のストリームは開いたまま、止めているときは無音を流す。
fn engine() -> Result<&'static Engine, String> {
    ENGINE
        .get_or_init(|| {
            let state = Arc::new(Mutex::new(State::default()));
            let callbacks = Arc::new(AtomicU64::new(0));
            let (tx, rx) = mpsc::channel();
            let (st, cb) = (state.clone(), callbacks.clone());
            std::thread::spawn(move || {
                let opened = (|| -> Result<(cpal::Stream, u32, String), String> {
                    let host = cpal::default_host();
                    let device = host.default_output_device().ok_or("出力先がない")?;
                    let config = device.default_output_config().map_err(|e| e.to_string())?;
                    let rate = config.sample_rate().0;
                    let out_ch = config.channels() as usize;
                    let info = format!("{:?} / {}Hz {}ch {:?}", host.id(), rate, out_ch, config.sample_format());
                    let stream = device
                        .build_output_stream(
                            &config.into(),
                            move |data: &mut [f32], _| {
                                cb.fetch_add(1, Ordering::Relaxed);
                                let mut s = st.lock().unwrap();
                                for frame in data.chunks_mut(out_ch) {
                                    let (l, r) = s.next_frame();
                                    for (i, v) in frame.iter_mut().enumerate() {
                                        *v = if i % 2 == 0 { l } else { r };
                                    }
                                }
                            },
                            |e| println!("[cyanomelody] 出力エラー: {e}"),
                            None,
                        )
                        .map_err(|e| e.to_string())?;
                    stream.play().map_err(|e| e.to_string())?;
                    Ok((stream, rate, info))
                })();
                match opened {
                    Ok((stream, rate, info)) => {
                        let _ = tx.send(Ok((rate, info)));
                        // ストリームはこのスレッドが持ち続ける
                        let _keep = stream;
                        loop {
                            std::thread::park();
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                    }
                }
            });
            let (rate, info) = rx.recv().map_err(|e| e.to_string())??;
            spawn_monitor(state.clone(), callbacks);
            Ok(Engine { state, rate, info })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// 状態の変化を Kotlin に知らせ、10 秒ごとに再生の様子をログに出す。
fn spawn_monitor(state: Arc<Mutex<State>>, callbacks: Arc<AtomicU64>) {
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut next_log = 10;
        loop {
            let notice = {
                let mut s = state.lock().unwrap();
                std::mem::take(&mut s.changed).then(|| (s.title(), s.playing, s.active))
            };
            if let Some((title, playing, active)) = notice {
                println!("[cyanomelody] 状態: {title} / 再生中={playing} / 有効={active}");
                android::notify(&title, playing, active);
            }
            let elapsed = started.elapsed().as_secs();
            if elapsed >= next_log {
                let s = state.lock().unwrap();
                if s.active {
                    println!(
                        "[cyanomelody] 経過 {elapsed}秒 / {} / 再生中={} / 出力コールバック {}回",
                        s.title(),
                        s.playing,
                        callbacks.load(Ordering::Relaxed)
                    );
                }
                next_log += 10;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

fn load(tracks: Vec<Track>, repeat: bool) -> Result<String, String> {
    let engine = engine()?;
    let mut s = engine.state.lock().unwrap();
    s.tracks = tracks.into_iter().map(Arc::new).collect();
    s.index = 0;
    s.pos = 0;
    s.repeat = repeat;
    s.playing = true;
    s.active = true;
    s.changed = true;
    Ok(engine.info.clone())
}

/// 再生の操作。画面と Kotlin（通知、ロック画面、音声フォーカス）の両方から呼ばれる。
fn command(cmd: &str) {
    let Ok(engine) = engine() else { return };
    let mut s = engine.state.lock().unwrap();
    match cmd {
        "play" if !s.tracks.is_empty() => {
            s.playing = true;
            s.active = true;
        }
        "pause" => s.playing = false,
        "next" if !s.tracks.is_empty() => s.skip(1, false),
        "prev" if !s.tracks.is_empty() => s.skip(-1, false),
        "stop" => {
            s.playing = false;
            s.active = false;
            s.pos = 0;
        }
        _ => println!("[cyanomelody] 受け付けない操作: {cmd}"),
    }
    s.changed = true;
}

/// チャイムを、音の高さを `ratio` 倍にした曲にする。
fn chime_track(title: &str, ratio: f64, rate: u32) -> Result<Track, String> {
    let (samples, from) = decode(Box::new(Cursor::new(CHIME)), "mp3").map_err(|e| e.to_string())?;
    let mut samples = resample(&samples, (from as f64 * ratio) as u32, rate);
    // 曲の間に 1 秒の無音を入れる
    samples.extend(std::iter::repeat(0.0).take(rate as usize * 2));
    Ok(Track { title: title.into(), samples })
}

#[tauri::command]
fn play_chime() -> Result<String, String> {
    let rate = engine()?.rate;
    load(vec![chime_track("チャイム", 1.0, rate)?], false)
}

/// 音の高さを変えたチャイム 3 曲を、止めるまで繰り返す。
#[tauri::command]
fn play_playlist() -> Result<String, String> {
    let rate = engine()?.rate;
    let tracks = vec![
        chime_track("チャイム（ド）", 1.0, rate)?,
        chime_track("チャイム（ミ）", 1.26, rate)?,
        chime_track("チャイム（ソ）", 1.5, rate)?,
    ];
    load(tracks, true)
}

#[tauri::command]
fn player_command(cmd: String) {
    command(&cmd);
}

#[tauri::command]
fn player_state() -> String {
    let Some(Ok(engine)) = ENGINE.get() else { return "未起動".into() };
    let s = engine.state.lock().unwrap();
    if !s.active {
        return "停止中".into();
    }
    format!(
        "{} / {} / {}曲目",
        s.title(),
        if s.playing { "再生中" } else { "一時停止" },
        s.index + 1
    )
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            walk(&path, out)?;
        } else if matches!(
            path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
            Some("mp3" | "wav" | "m4a")
        ) {
            out.push(path);
        }
    }
    Ok(())
}

/// 指定フォルダとサブフォルダの曲を、ファイルパスで一覧にする。
#[tauri::command]
fn list_music(dir: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    walk(Path::new(&dir), &mut files).map_err(|e| format!("{dir}: {e}"))?;
    files.sort();
    Ok(files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// ファイルパスで曲を開いて再生する。
#[tauri::command]
fn play_file(path: String) -> Result<String, String> {
    let rate = engine()?.rate;
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let file = std::fs::File::open(&path).map_err(|e| format!("開けない: {e}"))?;
    let (samples, from) = decode(Box::new(file), &ext).map_err(|e| e.to_string())?;
    let title = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    load(vec![Track { title, samples: resample(&samples, from, rate) }], false)
}

/// アプリのデータ領域に端末 ID を保存し、既にあればそれを返す。
#[tauri::command]
fn device_id(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join("device_id.txt");
    if let Ok(id) = std::fs::read_to_string(&file) {
        return Ok(format!("既存: {id} ({})", file.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let id = format!("{:032x}", nanos ^ ((std::process::id() as u128) << 64));
    std::fs::write(&file, &id).map_err(|e| e.to_string())?;
    Ok(format!("新規: {id} ({})", file.display()))
}

/// Kotlin とのつなぎ目（JNI）。Kotlin 側は `RustBridge.kt`。
#[cfg(target_os = "android")]
mod android {
    use std::sync::OnceLock;

    use jni::objects::{GlobalRef, JClass, JString, JValue};
    use jni::{JNIEnv, JavaVM};

    static BRIDGE: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

    /// Kotlin の `RustBridge.nativeInit()`。Rust のスレッドから Kotlin を呼べるよう、VM とクラスを控える。
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_dev_cyanomelody_proto_RustBridge_nativeInit(env: JNIEnv, class: JClass) {
        let (Ok(vm), Ok(class)) = (env.get_java_vm(), env.new_global_ref(class)) else {
            println!("[cyanomelody] Kotlin とつなげなかった");
            return;
        };
        let _ = BRIDGE.set((vm, class));
        println!("[cyanomelody] Kotlin とつながった");
    }

    /// Kotlin の `RustBridge.nativeCommand(command)`。通知、ロック画面、音声フォーカスからの操作。
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_dev_cyanomelody_proto_RustBridge_nativeCommand(
        mut env: JNIEnv,
        _class: JClass,
        command: JString,
    ) {
        let cmd: String = env.get_string(&command).map(Into::into).unwrap_or_default();
        println!("[cyanomelody] Kotlin からの操作: {cmd}");
        super::command(&cmd);
    }

    /// Kotlin の `RustBridge.onStateChanged(title, playing, active)` を呼ぶ。
    pub fn notify(title: &str, playing: bool, active: bool) {
        let Some((vm, class)) = BRIDGE.get() else { return };
        let mut env = match vm.attach_current_thread_permanently() {
            Ok(env) => env,
            Err(e) => return println!("[cyanomelody] JNI に入れない: {e}"),
        };
        let Ok(title) = env.new_string(title) else { return };
        let class: &JClass = class.as_obj().into();
        let result = env.call_static_method(
            class,
            "onStateChanged",
            "(Ljava/lang/String;ZZ)V",
            &[JValue::Object(&title), JValue::Bool(playing.into()), JValue::Bool(active.into())],
        );
        if let Err(e) = result {
            println!("[cyanomelody] Kotlin を呼べない: {e}");
            let _ = env.exception_clear();
        }
    }
}

#[cfg(not(target_os = "android"))]
mod android {
    pub fn notify(_title: &str, _playing: bool, _active: bool) {}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            play_chime,
            play_playlist,
            player_command,
            player_state,
            list_music,
            play_file,
            device_id
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
