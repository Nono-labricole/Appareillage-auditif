package com.nonolabricole.appareillageauditif

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.nonolabricole.appareillageauditif.audio.AudioEngine
import com.nonolabricole.appareillageauditif.captions.TranscriptionEngine
import com.nonolabricole.appareillageauditif.ui.MainActivity

/**
 * Service de premier plan : garde le micro déporté et les sous-titres actifs même
 * écran éteint ou application en arrière-plan.
 */
class HearingService : Service() {

    companion object {
        private const val ACTION_APPLY = "apply"
        private const val ACTION_STOP = "stop"
        private const val EXTRA_REMOTE = "remote"
        private const val EXTRA_CAPTIONS = "captions"
        private const val CHANNEL_ID = "hearing"
        private const val NOTIFICATION_ID = 1

        /** Active / désactive les fonctions ; relit aussi les réglages. */
        fun apply(context: Context, remoteMic: Boolean, captions: Boolean) {
            val intent = Intent(context, HearingService::class.java)
                .setAction(ACTION_APPLY)
                .putExtra(EXTRA_REMOTE, remoteMic)
                .putExtra(EXTRA_CAPTIONS, captions)
            if (remoteMic || captions) {
                ContextCompat.startForegroundService(context, intent)
            } else if (HearingState.serviceRunning.value) {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            if (HearingState.serviceRunning.value) {
                context.startService(Intent(context, HearingService::class.java).setAction(ACTION_STOP))
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: Prefs
    private lateinit var am: AudioManager
    private lateinit var engine: AudioEngine
    private lateinit var transcription: TranscriptionEngine
    private var remoteMic = false
    private var captions = false

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = onDevicesChanged()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = onDevicesChanged()
    }
    private val restartEngine = Runnable {
        // Un appareil Bluetooth a été (re)connecté : on reconstruit le routage audio.
        if (remoteMic || engine.config?.inputFromHearingAid == true) {
            engine.stop()
            reapply()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        am = getSystemService(AudioManager::class.java)
        HearingState.dsp.value = prefs.dspParams()
        engine = AudioEngine(this).apply {
            onError = { msg -> main.post { onEngineError(msg) } }
        }
        transcription = TranscriptionEngine(this) { main.post { reapply() } }
        createChannel()
        am.registerAudioDeviceCallback(deviceCallback, main)
        HearingState.serviceRunning.value = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_APPLY) {
            remoteMic = intent.getBooleanExtra(EXTRA_REMOTE, false)
            captions = intent.getBooleanExtra(EXTRA_CAPTIONS, false)
        } else {
            remoteMic = false
            captions = false
        }
        if (!remoteMic && !captions) {
            shutdown()
            return START_NOT_STICKY
        }
        startInForeground()
        HearingState.status.value = ""
        reapply()
        return START_NOT_STICKY
    }

    private fun reapply() {
        if (!remoteMic && !captions) return
        val external = transcription.externalAudio
        val needEngine = remoteMic || (captions && external)
        val cfg = if (needEngine) {
            AudioEngine.Config(
                playback = remoteMic,
                lowLatency = remoteMic && prefs.lowLatency,
                outputKey = prefs.outputKey.ifEmpty { null },
                inputFromHearingAid = !remoteMic && captions && external && prefs.captionSource == "aid",
                micMode = prefs.micMode
            )
        } else null
        if (cfg != engine.config) {
            engine.stop()
            if (cfg != null) engine.start(cfg)
        }
        engine.transcriptionSink = if (captions && external) transcription::feed else null
        if (captions) transcription.start(prefs.language, prefs.preferOffline) else transcription.stop()

        if (remoteMic && !external && captions) {
            HearingState.captionInfo.value =
                "Sur ce téléphone, les sous-titres et le micro déporté se partagent le micro : les sous-titres peuvent s'interrompre."
        }
        HearingState.remoteMicOn.value = remoteMic
        HearingState.captionsOn.value = captions
        updateNotification()
    }

    private fun onEngineError(message: String) {
        HearingState.status.value = message
        engine.stop()
        if (remoteMic) {
            remoteMic = false
            HearingState.remoteMicOn.value = false
        }
        if (captions && transcription.externalAudio) {
            // Sans flux audio, on garde les sous-titres en leur laissant le micro.
            captions = false
            HearingState.captionsOn.value = false
            transcription.stop()
        }
        if (!remoteMic && !captions) shutdown() else updateNotification()
    }

    private fun onDevicesChanged() {
        main.removeCallbacks(restartEngine)
        main.postDelayed(restartEngine, 1500)
    }

    private fun shutdown() {
        main.removeCallbacks(restartEngine)
        engine.stop()
        transcription.stop()
        HearingState.remoteMicOn.value = false
        HearingState.captionsOn.value = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacks(restartEngine)
        am.unregisterAudioDeviceCallback(deviceCallback)
        engine.stop()
        transcription.stop()
        HearingState.remoteMicOn.value = false
        HearingState.captionsOn.value = false
        HearingState.serviceRunning.value = false
        super.onDestroy()
    }

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Écoute en cours", NotificationManager.IMPORTANCE_LOW)
        channel.description = "Indique que le micro déporté ou les sous-titres sont actifs"
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val parts = buildList {
            if (remoteMic) add("Micro déporté actif")
            if (captions) add("Sous-titres actifs")
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, HearingService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(parts.joinToString(" · ").ifEmpty { "En veille" })
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Arrêter", stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun startInForeground() {
        val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
    }

    private fun updateNotification() {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }
}
