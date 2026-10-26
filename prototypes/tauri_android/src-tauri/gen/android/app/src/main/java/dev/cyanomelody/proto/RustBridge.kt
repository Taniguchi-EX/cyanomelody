package dev.cyanomelody.proto

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Rust の再生エンジンと Kotlin のつなぎ目（JNI）。
 * - Kotlin → Rust：nativeCommand で再生の操作（play、pause、next、prev、stop）を送る
 * - Rust → Kotlin：再生の状態が変わると Rust が onStateChanged を呼ぶ
 */
object RustBridge {
  init {
    System.loadLibrary("tauri_android_lib")
  }

  private val main = Handler(Looper.getMainLooper())
  private lateinit var appContext: Context

  @Volatile var title = ""
    private set
  @Volatile var playing = false
    private set

  fun init(context: Context) {
    appContext = context.applicationContext
    nativeInit()
  }

  @JvmStatic external fun nativeInit()

  @JvmStatic external fun nativeCommand(command: String)

  /** Rust のスレッドから呼ばれる。サービスの操作はメインスレッドで行う。 */
  @JvmStatic
  fun onStateChanged(title: String, playing: Boolean, active: Boolean) {
    this.title = title
    this.playing = playing
    Log.i("cyanomelody", "Rust からの状態: $title / 再生中=$playing / 有効=$active")
    main.post {
      if (active) PlaybackService.refresh(appContext) else PlaybackService.stop(appContext)
    }
  }
}
