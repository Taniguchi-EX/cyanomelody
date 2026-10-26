package dev.cyanomelody.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.IBinder
import android.util.Log

/**
 * 再生中のアプリを常駐させるフォアグラウンドサービス（A-2）。
 * 通知とロック画面の操作は MediaSession で受け（A-3）、音声フォーカスもここで扱う（A-6）。
 * 音そのものは Rust の再生エンジンが鳴らす。
 */
class PlaybackService : Service() {
  companion object {
    private const val TAG = "cyanomelody"
    private const val CHANNEL_ID = "playback"
    private const val NOTIFICATION_ID = 1

    /** サービスを起動、または通知の内容を今の状態に更新する。 */
    fun refresh(context: Context) {
      context.startForegroundService(Intent(context, PlaybackService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, PlaybackService::class.java))
    }
  }

  private lateinit var session: MediaSession
  private lateinit var audioManager: AudioManager
  private var focusRequest: AudioFocusRequest? = null
  /** 一時的に音声フォーカスを失って止めたとき、取り戻したら再開する */
  private var resumeOnGain = false

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    Log.i(TAG, "音声フォーカスの変化: $change")
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        resumeOnGain = false
        RustBridge.nativeCommand("pause")
        abandonFocus()
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        resumeOnGain = RustBridge.playing
        RustBridge.nativeCommand("pause")
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        if (resumeOnGain) {
          resumeOnGain = false
          RustBridge.nativeCommand("play")
        }
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "サービス開始")
    audioManager = getSystemService(AudioManager::class.java)
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "再生", NotificationManager.IMPORTANCE_LOW)
    )
    session = MediaSession(this, "cyanomelody").apply {
      setCallback(object : MediaSession.Callback() {
        override fun onPlay() = command("play")
        override fun onPause() = command("pause")
        override fun onSkipToNext() = command("next")
        override fun onSkipToPrevious() = command("prev")
        override fun onStop() = command("stop")
      })
      isActive = true
    }
  }

  private fun command(name: String) {
    Log.i(TAG, "通知・ロック画面からの操作: $name")
    if (name == "play") resumeOnGain = false
    RustBridge.nativeCommand(name)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val playing = RustBridge.playing
    val title = RustBridge.title
    session.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, title)
        .putString(MediaMetadata.METADATA_KEY_ARTIST, "cyanomelody")
        .build()
    )
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP
        )
        .setState(
          if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          PlaybackState.PLAYBACK_POSITION_UNKNOWN,
          1f
        )
        .build()
    )
    val openApp = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
    )
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(title)
      .setContentText("cyanomelody")
      .setContentIntent(openApp)
      .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken))
      .setOngoing(playing)
      .build()
    startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    if (playing) requestFocus()
    Log.i(TAG, "通知を更新: $title / 再生中=$playing")
    return START_NOT_STICKY
  }

  private fun requestFocus() {
    if (focusRequest != null) return
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build()
      )
      .setOnAudioFocusChangeListener(focusListener)
      .build()
    val result = audioManager.requestAudioFocus(request)
    Log.i(TAG, "音声フォーカスを要求: 結果=$result")
    if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focusRequest = request
  }

  private fun abandonFocus() {
    focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    focusRequest = null
  }

  override fun onDestroy() {
    Log.i(TAG, "サービス終了")
    abandonFocus()
    session.release()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
