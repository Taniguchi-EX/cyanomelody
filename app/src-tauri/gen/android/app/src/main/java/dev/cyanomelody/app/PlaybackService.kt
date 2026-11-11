package dev.cyanomelody.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView

/** 画面（WebView）と再生のサービスの間のやり取り */
object MediaBridge {
    const val TAG = "CyanoMedia"
    var webView: WebView? = null

    /** 再生の通知を出している（サービスが動いている） */
    @Volatile var active = false

    /** Android の側で押されたボタンなどを、画面の側に知らせる */
    fun send(command: String, value: Double = 0.0) {
        Log.i(TAG, "send $command $value")
        val view = webView ?: return
        view.post {
            view.evaluateJavascript("window.__cyanoMediaCommand && window.__cyanoMediaCommand('$command', $value)", null)
        }
    }
}

/** 画面の側から呼ぶ口（window.CyanoMedia） */
class MediaJsInterface(private val context: Context) {
    @JavascriptInterface
    fun update(title: String, subtitle: String, playing: Boolean, position: Double, duration: Double) {
        val intent = Intent(context, PlaybackService::class.java).apply {
            action = PlaybackService.ACTION_UPDATE
            putExtra("title", title)
            putExtra("subtitle", subtitle)
            putExtra("playing", playing)
            putExtra("position", position)
            putExtra("duration", duration)
        }
        if (!MediaBridge.active) {
            MediaBridge.active = true
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        } else {
            context.startService(intent)
        }
    }

    @JavascriptInterface
    fun stop() {
        if (!MediaBridge.active) return
        MediaBridge.active = false
        context.stopService(Intent(context, PlaybackService::class.java))
    }

    @JavascriptInterface
    fun log(text: String) {
        Log.i(MediaBridge.TAG, "js $text")
    }
}

/** 鳴らしている間、アプリを眠らせないためのサービス。再生の通知とロック画面の操作（MediaSession）を持つ */
class PlaybackService : Service() {
    companion object {
        const val ACTION_UPDATE = "dev.cyanomelody.app.UPDATE"
        const val ACTION_COMMAND = "dev.cyanomelody.app.COMMAND"
        const val CHANNEL = "playback"
        const val NOTIFICATION_ID = 1
    }

    private lateinit var session: MediaSession

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "再生", NotificationManager.IMPORTANCE_LOW))
        }
        session = MediaSession(this, "cyanomelody").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = MediaBridge.send("play")
                override fun onPause() = MediaBridge.send("pause")
                override fun onSkipToNext() = MediaBridge.send("next")
                override fun onSkipToPrevious() = MediaBridge.send("prev")
                override fun onStop() = MediaBridge.send("stop")
                override fun onSeekTo(pos: Long) = MediaBridge.send("seek", pos / 1000.0)
            })
            isActive = true
        }
        // 最初の通知は、すぐ出す（startForegroundService の後、5秒以内に出す決まり）
        startForegroundCompat(build("cyanomelody", "", false))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_UPDATE -> {
                val title = intent.getStringExtra("title") ?: ""
                val subtitle = intent.getStringExtra("subtitle") ?: ""
                val playing = intent.getBooleanExtra("playing", false)
                val position = intent.getDoubleExtra("position", 0.0)
                val duration = intent.getDoubleExtra("duration", 0.0)
                session.setMetadata(
                    MediaMetadata.Builder()
                        .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                        .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                        .putLong(MediaMetadata.METADATA_KEY_DURATION, (duration * 1000).toLong())
                        .build()
                )
                session.setPlaybackState(
                    PlaybackState.Builder()
                        .setActions(
                            PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                                PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                                PlaybackState.ACTION_STOP or PlaybackState.ACTION_SEEK_TO
                        )
                        .setState(
                            if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                            (position * 1000).toLong(),
                            if (playing) 1f else 0f,
                            SystemClock.elapsedRealtime()
                        )
                        .build()
                )
                startForegroundCompat(build(title, subtitle, playing))
            }
            ACTION_COMMAND -> MediaBridge.send(intent.getStringExtra("command") ?: "")
        }
        return START_NOT_STICKY
    }

    /** 最近使ったアプリの一覧から払って閉じたら、止める */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(MediaBridge.TAG, "task removed")
        MediaBridge.active = false
        stopSelf()
    }

    override fun onDestroy() {
        session.release()
        super.onDestroy()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun commandIntent(command: String, code: Int): PendingIntent {
        val intent = Intent(this, PlaybackService::class.java).setAction(ACTION_COMMAND).putExtra("command", command)
        return PendingIntent.getService(this, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun build(title: String, subtitle: String, playing: Boolean): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        return builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(subtitle)
            .setContentIntent(open)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(playing)
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "前へ", commandIntent("prev", 1)).build())
            .addAction(
                Notification.Action.Builder(
                    if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                    if (playing) "一時停止" else "再生",
                    commandIntent(if (playing) "pause" else "play", 2)
                ).build()
            )
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "次へ", commandIntent("next", 3)).build())
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }
}
