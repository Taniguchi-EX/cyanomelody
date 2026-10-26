package dev.cyanomelody.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var onAuthorized: ((Intent?) -> Unit)? = null
  private lateinit var authorization: ActivityResultLauncher<IntentSenderRequest>

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    authorization = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
      onAuthorized?.invoke(result.data)
      onAuthorized = null
    }
    RustBridge.init(this)
    requestAudioPermission()
    keepClearOfSystemBars()
  }

  /**
   * Android 15 以降は画面の端まで描く方式が必ず有効になり、画面が状態バーと操作バーの下に潜り込む。
   * その分の余白を取る。
   */
  private fun keepClearOfSystemBars() {
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  /** この端末の音楽ファイルを読む権限。ローカルの指定フォルダの曲を、ファイルパスで読むために要る。 */
  private fun requestAudioPermission() {
    if (checkSelfPermission(Manifest.permission.READ_MEDIA_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.READ_MEDIA_AUDIO), 1)
    }
  }

  /** Google のログインの同意の画面を出す（RustBridge から呼ぶ）。 */
  fun launchAuthorization(request: IntentSenderRequest, done: (Intent?) -> Unit) {
    onAuthorized = done
    authorization.launch(request)
  }
}
