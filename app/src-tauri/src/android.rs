//! Android だけの処理。Kotlin（`gen/android/.../RustBridge.kt`）と JNI でつなぐ。
//!
//! - 再生の状態が変わったら Kotlin に知らせ、フォアグラウンドサービスと通知・ロック画面を更新する
//! - 通知・ロック画面・音声フォーカスからの操作を受けて、再生エンジンを動かす
//! - Google Drive のアクセストークンを、Kotlin の Google Identity Services から得る

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cyanomelody_core::drive::{DriveError, TokenProvider};
use jni::objects::{GlobalRef, JClass, JString, JValue};
use jni::{JNIEnv, JavaVM};

use crate::core::AppCore;

static BRIDGE: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();
/// Kotlin からの操作を渡す先。起動時に設定する。
pub static CORE: OnceLock<Arc<AppCore>> = OnceLock::new();

/// Kotlin の `RustBridge.nativeInit()`。Rust のスレッドから Kotlin を呼べるよう、VM とクラスを控える。
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_cyanomelody_app_RustBridge_nativeInit(env: JNIEnv, class: JClass) {
    match (env.get_java_vm(), env.new_global_ref(class)) {
        (Ok(vm), Ok(class)) => {
            let _ = BRIDGE.set((vm, class));
        }
        _ => log::error!("Kotlin とつなげなかった"),
    }
}

/// Kotlin の `RustBridge.nativeCommand(command)`。通知、ロック画面、音声フォーカスからの操作。
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_cyanomelody_app_RustBridge_nativeCommand(
    mut env: JNIEnv,
    _class: JClass,
    command: JString,
) {
    let command: String = env.get_string(&command).map(Into::into).unwrap_or_default();
    let Some(core) = CORE.get() else { return };
    match command.as_str() {
        "play" => core.player.play(),
        "pause" => core.player.pause(),
        "next" => core.player.next(),
        "prev" => core.player.prev(),
        "stop" => core.player.stop(),
        other => log::warn!("知らない操作: {other}"),
    }
}

fn with_env<T>(f: impl FnOnce(&mut JNIEnv, &JClass) -> jni::errors::Result<T>) -> Option<T> {
    let (vm, class) = BRIDGE.get()?;
    let mut env = vm.attach_current_thread_permanently().ok()?;
    let class: &JClass = class.as_obj().into();
    match f(&mut env, class) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("Kotlin を呼べない: {e}");
            let _ = env.exception_clear();
            None
        }
    }
}

/// 再生の状態を Kotlin に知らせる。`active` が偽ならフォアグラウンドサービスを止める。
pub fn notify(title: &str, playing: bool, active: bool) {
    with_env(|env, class| {
        let title = env.new_string(title)?;
        env.call_static_method(
            class,
            "onStateChanged",
            "(Ljava/lang/String;ZZ)V",
            &[JValue::Object(&title), JValue::Bool(playing.into()), JValue::Bool(active.into())],
        )?;
        Ok(())
    });
}

/// Kotlin の `RustBridge.accessToken(interactive)`。結果が出るまで待つ。
fn call_access_token(interactive: bool) -> Option<String> {
    with_env(|env, class| {
        let value = env
            .call_static_method(
                class,
                "accessToken",
                "(Z)Ljava/lang/String;",
                &[JValue::Bool(interactive.into())],
            )?
            .l()?;
        if value.is_null() {
            return Ok(None);
        }
        let s: String = env.get_string(&JString::from(value))?.into();
        Ok(Some(s))
    })
    .flatten()
}

/// Android の Google Drive のアクセストークン。Google Identity Services が更新を受け持つため、
/// リフレッシュトークンは持たない。期限（1 時間）の少し前まで使い回す。
pub struct AndroidToken {
    cached: Mutex<Option<(String, Instant)>>,
    /// ログイン済みの印（ファイルがあればログイン済み）
    marker: PathBuf,
}

impl AndroidToken {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self { cached: Mutex::new(None), marker: data_dir.join("android_logged_in") }
    }

    pub fn is_logged_in(&self) -> bool {
        self.marker.exists()
    }

    /// 同意の画面を出してログインする。
    pub fn login(&self) -> Result<(), DriveError> {
        let token = call_access_token(true)
            .ok_or_else(|| DriveError::Auth("ログインできなかった（同意されなかった）".into()))?;
        *self.cached.lock().unwrap() = Some((token, Instant::now() + Duration::from_secs(50 * 60)));
        let _ = std::fs::write(&self.marker, b"1");
        Ok(())
    }

    pub fn logout(&self) {
        let _ = std::fs::remove_file(&self.marker);
        self.invalidate();
    }
}

impl TokenProvider for AndroidToken {
    fn access_token(&self) -> Result<String, DriveError> {
        let mut cached = self.cached.lock().unwrap();
        if let Some((token, expires)) = cached.as_ref()
            && Instant::now() < *expires
        {
            return Ok(token.clone());
        }
        if !self.is_logged_in() {
            return Err(DriveError::Auth("ログインしていない".into()));
        }
        let token =
            call_access_token(false).ok_or_else(|| DriveError::Auth("ログインし直してください".into()))?;
        *cached = Some((token.clone(), Instant::now() + Duration::from_secs(50 * 60)));
        Ok(token)
    }

    fn invalidate(&self) {
        *self.cached.lock().unwrap() = None;
    }
}
