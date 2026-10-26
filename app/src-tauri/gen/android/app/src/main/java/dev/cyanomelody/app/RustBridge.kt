package dev.cyanomelody.app

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.result.IntentSenderRequest
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Rust（`src-tauri/src/android.rs`）と Kotlin のつなぎ目（JNI）。
 * - Kotlin → Rust：nativeCommand で再生の操作（play、pause、next、prev、stop）を送る
 * - Rust → Kotlin：再生の状態が変わると onStateChanged、Google Drive のアクセストークンが要るときは accessToken を呼ぶ
 */
object RustBridge {
  private const val TAG = "cyanomelody"
  private val SCOPES = listOf(
    Scope("https://www.googleapis.com/auth/drive.readonly"),
    Scope("https://www.googleapis.com/auth/drive.file"),
  )

  init {
    System.loadLibrary("cyanomelody_lib")
  }

  private val main = Handler(Looper.getMainLooper())
  private lateinit var appContext: Context
  private var activity: WeakReference<MainActivity>? = null

  @Volatile var title = ""
    private set
  @Volatile var playing = false
    private set

  fun init(activity: MainActivity) {
    appContext = activity.applicationContext
    this.activity = WeakReference(activity)
    nativeInit()
  }

  @JvmStatic external fun nativeInit()

  @JvmStatic external fun nativeCommand(command: String)

  /** Rust のスレッドから呼ばれる。サービスの操作はメインスレッドで行う。 */
  @JvmStatic
  fun onStateChanged(title: String, playing: Boolean, active: Boolean) {
    this.title = title
    this.playing = playing
    main.post {
      if (active) PlaybackService.refresh(appContext) else PlaybackService.stop(appContext)
    }
  }

  /**
   * Google Drive のアクセストークンを返す。Rust のスレッドから呼ばれ、結果が出るまで待つ。
   * `interactive` が真なら、同意の画面を出してログインしてもらう。偽なら、同意済みのときだけ返す。
   */
  @JvmStatic
  fun accessToken(interactive: Boolean): String? {
    val request = AuthorizationRequest.builder().setRequestedScopes(SCOPES).build()
    return try {
      val result = Tasks.await(Identity.getAuthorizationClient(appContext).authorize(request), 30, TimeUnit.SECONDS)
      when {
        result.accessToken != null -> result.accessToken
        result.hasResolution() && interactive -> resolve(result)
        else -> null
      }
    } catch (e: Exception) {
      Log.w(TAG, "アクセストークンを得られない: $e")
      null
    }
  }

  /** 同意の画面を出し、閉じられるまで待つ。 */
  private fun resolve(result: AuthorizationResult): String? {
    val activity = activity?.get() ?: return null
    val pending = result.pendingIntent ?: return null
    val latch = CountDownLatch(1)
    var token: String? = null
    main.post {
      activity.launchAuthorization(IntentSenderRequest.Builder(pending.intentSender).build()) { data ->
        token = try {
          data?.let { Identity.getAuthorizationClient(appContext).getAuthorizationResultFromIntent(it).accessToken }
        } catch (e: Exception) {
          Log.w(TAG, "同意の結果を読めない: $e")
          null
        }
        latch.countDown()
      }
    }
    latch.await(5, TimeUnit.MINUTES)
    return token
  }
}
