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
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.nonolabricole.appareillageauditif.audio.AudioEngine
import com.nonolabricole.appareillageauditif.captions.CaptionFormat
import com.nonolabricole.appareillageauditif.captions.CaptionOverlay
import com.nonolabricole.appareillageauditif.captions.CaptionTranslator
import com.nonolabricole.appareillageauditif.captions.TranscriptionEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.util.Locale
import com.nonolabricole.appareillageauditif.ui.CaptionsTileService
import com.nonolabricole.appareillageauditif.ui.MainActivity

/**
 * Service de premier plan : garde le micro déporté et les sous-titres actifs même
 * écran éteint ou application en arrière-plan.
 */
class HearingService : Service() {

    companion object {
        private const val ACTION_APPLY = "apply"
        private const val ACTION_STOP = "stop"
        private const val ACTION_TOGGLE_CAPTIONS = "toggle_captions"
        private const val ACTION_TOGGLE_OVERLAY = "toggle_overlay"
        private const val EXTRA_REMOTE = "remote"
        private const val EXTRA_CAPTIONS = "captions"
        private const val OLD_CHANNEL_ID = "hearing"
        private const val CHANNEL_ID = "live"
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

        /** Relit les réglages d'affichage (traduction, bulle) sans changer ce qui est actif. */
        fun refresh(context: Context) {
            if (HearingState.serviceRunning.value) {
                apply(context, HearingState.remoteMicOn.value, HearingState.captionsOn.value)
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
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val translator = CaptionTranslator()
    private lateinit var overlay: CaptionOverlay
    private var lastNotify = 0L
    /** Le micro de l'appareil auditif n'a pas pu être ouvert : repli sur celui du téléphone. */
    private var aidMicFailed = false
    private val notifyRunnable = Runnable { updateNotification() }

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
        overlay = CaptionOverlay(this) {
            prefs.overlayEnabled = false
            updateOverlay()
        }
        createChannel()
        am.registerAudioDeviceCallback(deviceCallback, main)
        HearingState.serviceRunning.value = true

        scope.launch {
            HearingState.lines.collect { translator.translatePending() }
        }
        scope.launch {
            HearingState.partial.collect { translator.translatePartial(it) }
        }
        scope.launch {
            combine(
                HearingState.lines, HearingState.partial, HearingState.partialTranslation, HearingState.display
            ) { _, _, _, _ -> }.collect { refreshCaptionViews() }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_APPLY -> {
                aidMicFailed = false
                remoteMic = intent.getBooleanExtra(EXTRA_REMOTE, false)
                captions = intent.getBooleanExtra(EXTRA_CAPTIONS, false)
            }
            // Actions de la notification : le service tourne déjà au premier plan.
            ACTION_TOGGLE_CAPTIONS -> captions = !captions
            ACTION_TOGGLE_OVERLAY -> {
                if (!prefs.overlayEnabled && !overlay.canShow()) {
                    startActivity(
                        Intent(this, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    )
                } else {
                    prefs.overlayEnabled = !prefs.overlayEnabled
                    if (prefs.overlayEnabled) captions = true
                }
            }
            else -> {
                remoteMic = false
                captions = false
            }
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
                linkMode = prefs.linkMode,
                bufferMode = prefs.bufferMode,
                outputKey = prefs.outputKey.ifEmpty { null },
                inputFromHearingAid = !remoteMic && captions && external && prefs.captionSource == "aid" && !aidMicFailed,
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
        HearingState.display.value = prefs.captionDisplay()
        if (captions && prefs.translationEnabled) {
            translator.configure(prefs.language.ifEmpty { Locale.getDefault().toLanguageTag() }, prefs.translationTarget)
        } else {
            translator.close()
        }
        HearingState.remoteMicOn.value = remoteMic
        HearingState.captionsOn.value = captions
        CaptionsTileService.requestUpdate(this)
        updateOverlay()
        updateNotification()
    }

    private fun updateOverlay() {
        if (captions && prefs.overlayEnabled) {
            if (!overlay.show()) {
                prefs.overlayEnabled = false
                HearingState.captionInfo.value =
                    "Autorisez « Affichage par-dessus les autres applis » pour utiliser la bulle de sous-titres."
            }
            refreshCaptionViews()
        } else {
            overlay.hide()
        }
        HearingState.overlayOn.value = overlay.isShowing
        scheduleNotification()
    }

    private fun refreshCaptionViews() {
        if (overlay.isShowing) {
            overlay.update(
                CaptionFormat.styled(
                    HearingState.lines.value.takeLast(30), HearingState.partial.value,
                    HearingState.partialTranslation.value, HearingState.display.value,
                    0xFFB0B0B0.toInt(), if (prefs.theme == "essential") 0xFFFF5A5F.toInt() else 0xFF9CC0FF.toInt()
                )
            )
        }
        if (captions) scheduleNotification()
    }

    /** Les mises à jour de notification sont limitées par Android : au plus ~1 par seconde. */
    private fun scheduleNotification() {
        main.removeCallbacks(notifyRunnable)
        val wait = 1000 - (SystemClock.elapsedRealtime() - lastNotify)
        if (wait <= 0) updateNotification() else main.postDelayed(notifyRunnable, wait)
    }

    private fun onEngineError(message: String) {
        HearingState.status.value = message
        val wasAidMic = engine.config?.inputFromHearingAid == true
        engine.stop()
        if (wasAidMic && captions) {
            // On garde les sous-titres, avec le micro du téléphone.
            aidMicFailed = true
            reapply()
            return
        }
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
        main.removeCallbacks(notifyRunnable)
        remoteMic = false
        captions = false
        overlay.hide()
        HearingState.overlayOn.value = false
        translator.close()
        engine.stop()
        transcription.stop()
        HearingState.remoteMicOn.value = false
        HearingState.captionsOn.value = false
        CaptionsTileService.requestUpdate(this)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacks(restartEngine)
        main.removeCallbacks(notifyRunnable)
        scope.cancel()
        overlay.hide()
        HearingState.overlayOn.value = false
        translator.close()
        am.unregisterAudioDeviceCallback(deviceCallback)
        engine.stop()
        transcription.stop()
        HearingState.remoteMicOn.value = false
        HearingState.captionsOn.value = false
        HearingState.serviceRunning.value = false
        super.onDestroy()
    }

    private fun createChannel() {
        // Importance normale mais silencieuse : visible sur l'écran de verrouillage,
        // contrairement aux notifications « silencieuses » que beaucoup de téléphones y masquent.
        val channel = NotificationChannel(CHANNEL_ID, "Sous-titres et micro déporté", NotificationManager.IMPORTANCE_DEFAULT)
        channel.description = "Affiche les sous-titres en direct et les commandes rapides"
        channel.setSound(null, null)
        channel.enableVibration(false)
        channel.setShowBadge(false)
        channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
        nm.deleteNotificationChannel(OLD_CHANNEL_ID)
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
        val toggleCaptions = PendingIntent.getService(
            this, 2,
            Intent(this, HearingService::class.java).setAction(ACTION_TOGGLE_CAPTIONS),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val toggleOverlay = PendingIntent.getService(
            this, 3,
            Intent(this, HearingService::class.java).setAction(ACTION_TOGGLE_OVERLAY),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val status = parts.joinToString(" · ").ifEmpty { "En veille" }
        val caption = if (captions) CaptionFormat.plainTail(
            HearingState.lines.value, HearingState.partial.value, HearingState.partialTranslation.value,
            HearingState.display.value, 4
        ) else ""
        lastNotify = SystemClock.elapsedRealtime()
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, if (captions) "Pause sous-titres" else "Sous-titres", toggleCaptions)
            .addAction(0, if (overlay.isShowing) "Masquer la bulle" else "Bulle", toggleOverlay)
            .addAction(0, "Arrêter", stop)
        if (caption.isNotBlank()) {
            // Dernière phrase en titre (lisible même replié), l'historique récent en dépliant.
            builder.setContentTitle(caption.lineSequence().last())
                .setContentText(status)
                .setSubText(status)
                .setStyle(NotificationCompat.BigTextStyle().bigText(caption).setSummaryText(status))
        } else {
            builder.setContentTitle(getString(R.string.app_name))
                .setContentText(if (captions) "Sous-titres actifs : en attente de parole…" else status)
        }
        return builder.build()
    }

    private fun startInForeground() {
        val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
    }

    private fun updateNotification() {
        if (!remoteMic && !captions) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }
}
