package dev.cyanomelody.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts

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
