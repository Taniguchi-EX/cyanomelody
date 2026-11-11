package dev.cyanomelody.app

import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // ロック中の再生（PlaybackService.kt）：画面の側から再生の通知を出せるようにする
    MediaBridge.webView = webView
    webView.addJavascriptInterface(MediaJsInterface(applicationContext), "CyanoMedia")
    // 画面が見えない間も、WebView の描画の処理（別のプロセス）の優先度を下げない（鳴らし続けるため）
    if (Build.VERSION.SDK_INT >= 26) webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
  }

  override fun onResume() {
    super.onResume()
    MediaBridge.activityResumed = true
  }

  override fun onPause() {
    super.onPause()
    MediaBridge.activityResumed = false
    // 再生の通知を出している間は、WebView を止めない（土台の onPause が止めるので、起こし直す）
    if (MediaBridge.active) MediaBridge.webView?.onResume()
  }
}
