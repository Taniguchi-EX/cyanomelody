package dev.cyanomelody.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * ロック中の再生：画面（WebView の audio 要素）で鳴らしている間、このサービスを動かして、
 * アプリが眠らされないようにし、再生の通知とロック画面の操作（MediaSession）を出す。
 * 画面の側は useMediaSession.ts（window.CyanoMedia を呼び、window.__cyanoMediaCommand で命令を受け取る）
 */
object MediaBridge {
    const val TAG = "CyanoMedia"
    var webView: WebView? = null

    /** 再生の通知を出している（サービスが動いている）。この間は、画面が見えなくても WebView を止めない */
    @Volatile var active = false

    /** 画面（Activity）が前に出ているか。通知を消したとき、出ていなければ WebView を止める */
    @Volatile var activityResumed = false

    /** 通知・ロック画面・イヤホンのボタンや、イヤホンを抜いたことを、画面の側に知らせる。seek の値は秒 */
    fun send(command: String, value: Double = 0.0) {
        val view = webView ?: return
        view.post {
            view.evaluateJavascript("window.__cyanoMediaCommand && window.__cyanoMediaCommand('$command', $value)", null)
        }
    }

    /** 通知を消した後、画面が見えていなければ、ほかのアプリと同じく WebView を止める */
    fun pauseWebViewIfHidden() {
        val view = webView ?: return
        view.post {
            if (!active && !activityResumed) view.onPause()
        }
    }
}

/** 画面の側から呼ぶ口（window.CyanoMedia）。JavaScript の側の型は useMediaSession.ts */
class MediaJsInterface(private val context: Context) {
    /** 再生の通知を出す・書き換える。位置と長さは秒 */
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
        try {
            if (!MediaBridge.active && Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
            MediaBridge.active = true
        } catch (e: Exception) {
            // 裏からはサービスを始められない（Android 12 から）。通知は出さず、画面が見えている間だけ鳴らす
            Log.w(MediaBridge.TAG, "再生のサービスを始められませんでした", e)
        }
    }

    /** 再生の通知を消し、サービスを止める */
    @JavascriptInterface
    fun stop() {
        if (!MediaBridge.active) return
        MediaBridge.active = false
        context.stopService(Intent(context, PlaybackService::class.java))
        MediaBridge.pauseWebViewIfHidden()
    }
}

class PlaybackService : Service() {
    companion object {
        const val ACTION_UPDATE = "dev.cyanomelody.app.playback.UPDATE"
        const val ACTION_COMMAND = "dev.cyanomelody.app.playback.COMMAND"
        const val CHANNEL = "playback"
        const val NOTIFICATION_ID = 1
    }

    private lateinit var session: MediaSession

    /** イヤホンを抜いた・Bluetooth の機器が切れたとき（スピーカーから急に鳴らないよう、一時停止する） */
    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) MediaBridge.send("pause")
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(NotificationChannel(CHANNEL, "再生", NotificationManager.IMPORTANCE_LOW))
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
        registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
        // startForegroundService の後は、すぐ通知を出す決まり（中身は、すぐ届く UPDATE で書き換える）
        startForegroundCompat(build("", "", false))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_UPDATE -> update(intent)
            ACTION_COMMAND -> MediaBridge.send(intent.getStringExtra("command") ?: "")
        }
        // 止められた後に、Android が勝手に起こし直さない（鳴らすのは画面の側なので、起こし直しても鳴らない）
        return START_NOT_STICKY
    }

    private fun update(intent: Intent) {
        val title = intent.getStringExtra("title") ?: ""
        val subtitle = intent.getStringExtra("subtitle") ?: ""
        val playing = intent.getBooleanExtra("playing", false)
        val position = (intent.getDoubleExtra("position", 0.0) * 1000).toLong()
        val duration = (intent.getDoubleExtra("duration", 0.0) * 1000).toLong()
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, duration)
                .build()
        )
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackState.ACTION_STOP or PlaybackState.ACTION_SEEK_TO
                )
                // 鳴らしている間は、Android の側が位置を進めて出す
                .setState(
                    if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    position,
                    if (playing) 1f else 0f,
                    SystemClock.elapsedRealtime()
                )
                .build()
        )
        startForegroundCompat(build(title, subtitle, playing))
    }

    /** 最近使ったアプリの一覧から払って閉じたら、止める（画面がなくなるので、鳴らし続けられない） */
    override fun onTaskRemoved(rootIntent: Intent?) {
        MediaBridge.active = false
        stopSelf()
    }

    override fun onDestroy() {
        unregisterReceiver(noisy)
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

    private fun action(icon: Int, label: String, command: String, code: Int): Notification.Action {
        val intent = Intent(this, PlaybackService::class.java).setAction(ACTION_COMMAND).putExtra("command", command)
        val pending = PendingIntent.getService(this, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Action.Builder(Icon.createWithResource(this, icon), label, pending).build()
    }

    @Suppress("DEPRECATION")
    private fun build(title: String, subtitle: String, playing: Boolean): Notification {
        // 通知を押すと、アプリの画面に戻る
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        return builder
            .setSmallIcon(R.drawable.ic_stat_playback)
            .setContentTitle(title)
            .setContentText(subtitle)
            .setContentIntent(open)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(playing)
            .addAction(action(android.R.drawable.ic_media_previous, "前へ", "prev", 1))
            .addAction(
                if (playing) action(android.R.drawable.ic_media_pause, "一時停止", "pause", 2)
                else action(android.R.drawable.ic_media_play, "再生", "play", 2)
            )
            .addAction(action(android.R.drawable.ic_media_next, "次へ", "next", 3))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }
}
