package com.nonolabricole.appareillageauditif.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.nonolabricole.appareillageauditif.HearingState
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Capture le micro, applique le traitement voix et renvoie le son vers l'appareil auditif
 * (micro déporté). Fournit aussi le flux 16 kHz aux sous-titres.
 */
class AudioEngine(context: Context) {

    data class Config(
        /** Renvoyer le son vers l'appareil auditif (micro déporté). */
        val playback: Boolean,
        /** Utiliser le profil Bluetooth « appel » (latence plus faible, son 16 kHz). */
        val lowLatency: Boolean,
        val outputKey: String?,
        /** Capter avec le micro de l'appareil auditif au lieu de celui du téléphone. */
        val inputFromHearingAid: Boolean,
        val micMode: String
    )

    private val appContext = context.applicationContext
    private val am = appContext.getSystemService(AudioManager::class.java)

    @Volatile private var running = false
    private var thread: Thread? = null
    var config: Config? = null
        private set

    /** Reçoit l'audio brut en PCM 16 bits mono 16 kHz (appelé depuis le thread audio). */
    @Volatile var transcriptionSink: ((ShortArray) -> Unit)? = null
    /** Erreur bloquante (appelé depuis le thread audio). */
    var onError: ((String) -> Unit)? = null

    @Volatile private var commDeviceSet = false
    @Volatile private var legacySco = false
    @Volatile private var modeChanged = false

    fun start(cfg: Config) {
        stop()
        config = cfg
        running = true
        thread = Thread({ runLoop(cfg) }, "audio-engine").also { it.start() }
    }

    fun stop() {
        running = false
        thread?.join(2000)
        thread = null
        config = null
        releaseRouting()
        HearingState.level.value = 0f
        HearingState.outputBlocked.value = false
    }

    private fun fail(msg: String) {
        Log.w(TAG, msg)
        onError?.invoke(msg)
    }

    @SuppressLint("MissingPermission")
    private fun runLoop(cfg: Config) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        if (appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail("Autorisation du micro refusée.")
            return
        }

        val useComm = cfg.inputFromHearingAid || (cfg.playback && cfg.lowLatency)
        if (useComm && !enableCommRouting(cfg.outputKey)) {
            if (cfg.inputFromHearingAid) {
                fail("Micro de l'appareil auditif indisponible (profil Bluetooth « appel » non trouvé). Utilisez le micro du téléphone.")
                return
            }
            HearingState.status.value = "Mode faible latence indisponible avec cet appareil : mode qualité utilisé."
        }
        val comm = useComm && (commDeviceSet || legacySco)
        val fs = if (comm) 16000 else 48000
        val frames = fs / 100 // blocs de 10 ms

        val record = createRecord(cfg, fs, comm)
        if (record == null) {
            fail("Impossible d'ouvrir le micro (peut-être utilisé par une autre application).")
            return
        }
        val track = if (cfg.playback) createTrack(cfg, fs, comm, frames) else null
        if (cfg.playback && track == null) {
            record.release()
            fail("Impossible d'ouvrir la sortie audio.")
            return
        }
        val suppressor = if (cfg.micMode == "phone_nr" && NoiseSuppressor.isAvailable()) {
            runCatching { NoiseSuppressor.create(record.audioSessionId)?.apply { enabled = true } }.getOrNull()
        } else null

        val processor = VoiceProcessor(fs)
        val decimator = if (fs == 48000) Decimator3() else null
        val shorts = ShortArray(frames)
        val floats = FloatArray(frames)
        var safe = false
        var lastRouteCheck = 0L
        var levelSum = 0f
        var levelCount = 0

        try {
            record.startRecording()
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                fail("Le micro est déjà utilisé par une autre application.")
                return
            }
            track?.play()
            while (running) {
                val n = record.read(shorts, 0, frames)
                if (n < 0) {
                    fail("Erreur du micro ($n).")
                    break
                }
                if (n == 0) continue

                transcriptionSink?.let { sink ->
                    sink(decimator?.process(shorts, n) ?: shorts.copyOf(n))
                }

                for (i in 0 until n) floats[i] = shorts[i] / 32768f
                val rms: Float
                if (track != null) {
                    rms = processor.process(floats, n, HearingState.dsp.value)
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastRouteCheck > 300) {
                        lastRouteCheck = now
                        safe = isRouteSafe(track)
                        HearingState.outputBlocked.value = !safe
                    }
                    for (i in 0 until n) {
                        shorts[i] = if (safe) (floats[i].coerceIn(-1f, 1f) * 32767f).toInt().toShort() else 0
                    }
                    // Non bloquant : si la sortie prend du retard on jette plutôt que d'accumuler de la latence.
                    track.write(shorts, 0, n, AudioTrack.WRITE_NON_BLOCKING)
                } else {
                    var s = 0.0
                    for (i in 0 until n) s += (floats[i] * floats[i]).toDouble()
                    rms = sqrt(s / n).toFloat()
                }

                levelSum += rms
                if (++levelCount >= 5) {
                    // ~ -60 dBFS → 0, 0 dBFS → 1
                    val db = 20 * kotlin.math.log10(max(levelSum / levelCount, 1e-6f))
                    HearingState.level.value = ((db + 60f) / 60f).coerceIn(0f, 1f)
                    levelSum = 0f
                    levelCount = 0
                }
            }
        } catch (e: Exception) {
            fail("Erreur audio : ${e.message}")
        } finally {
            runCatching { record.stop() }
            record.release()
            suppressor?.release()
            track?.let {
                runCatching { it.pause(); it.flush(); it.stop() }
                it.release()
            }
        }
    }

    private fun isRouteSafe(track: AudioTrack): Boolean {
        val routed = track.routedDevice
        if (routed != null) return routed.type !in DeviceUtils.UNSAFE_OUTPUT_TYPES
        return DeviceUtils.hasSafeOutput(am)
    }

    @SuppressLint("MissingPermission")
    private fun createRecord(cfg: Config, fs: Int, comm: Boolean): AudioRecord? {
        val source = when {
            cfg.inputFromHearingAid -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
            cfg.micMode == "phone_nr" -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
            cfg.micMode == "raw" -> MediaRecorder.AudioSource.MIC
            else -> MediaRecorder.AudioSource.VOICE_RECOGNITION
        }
        val min = AudioRecord.getMinBufferSize(fs, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return null
        val record = try {
            AudioRecord.Builder()
                .setAudioSource(source)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(fs)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(max(min * 2, fs / 10 * 2))
                .build()
        } catch (e: Exception) {
            Log.w(TAG, "AudioRecord", e)
            return null
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return null
        }
        val input = if (cfg.inputFromHearingAid) DeviceUtils.findHeadsetMic(am, cfg.outputKey)
        else DeviceUtils.findBuiltinMic(am)
        // En mode appel, Android enverrait sinon la capture vers le micro du casque.
        if (input != null && (comm || cfg.inputFromHearingAid)) record.setPreferredDevice(input)
        return record
    }

    private fun createTrack(cfg: Config, fs: Int, comm: Boolean, frames: Int): AudioTrack? {
        val attrs = AudioAttributes.Builder()
            .setUsage(if (comm) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val format = AudioFormat.Builder()
            .setSampleRate(fs)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .build()
        val min = AudioTrack.getMinBufferSize(fs, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return null
        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setBufferSizeInBytes(max(min, frames * 2 * 4))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
                .build()
        } catch (e: Exception) {
            Log.w(TAG, "AudioTrack", e)
            return null
        }
        if (track.state != AudioTrack.STATE_INITIALIZED) {
            track.release()
            return null
        }
        if (!comm) DeviceUtils.findMediaOutput(am, cfg.outputKey)?.let { track.setPreferredDevice(it) }
        return track
    }

    @Suppress("DEPRECATION")
    private fun enableCommRouting(key: String?): Boolean {
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        modeChanged = true
        if (Build.VERSION.SDK_INT >= 31) {
            val candidates = am.availableCommunicationDevices.filter { it.type in DeviceUtils.COMM_TYPES }
            val device = candidates.firstOrNull { !key.isNullOrEmpty() && DeviceUtils.keyOf(it) == key }
                ?: candidates.firstOrNull()
            commDeviceSet = device != null && am.setCommunicationDevice(device)
            if (!commDeviceSet) restoreMode()
            return commDeviceSet
        }
        if (!am.isBluetoothScoAvailableOffCall) {
            restoreMode()
            return false
        }
        am.startBluetoothSco()
        am.isBluetoothScoOn = true
        legacySco = true
        // Laisse le temps à la liaison « appel » de s'établir.
        val deadline = SystemClock.elapsedRealtime() + 3000
        while (running && SystemClock.elapsedRealtime() < deadline &&
            am.getDevices(AudioManager.GET_DEVICES_INPUTS).none { it.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        ) {
            SystemClock.sleep(min(100L, deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
        }
        SystemClock.sleep(300)
        return true
    }

    @Suppress("DEPRECATION")
    private fun releaseRouting() {
        if (commDeviceSet && Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice()
        commDeviceSet = false
        if (legacySco) {
            am.isBluetoothScoOn = false
            am.stopBluetoothSco()
            legacySco = false
        }
        restoreMode()
    }

    private fun restoreMode() {
        if (modeChanged) {
            am.mode = AudioManager.MODE_NORMAL
            modeChanged = false
        }
    }

    private companion object {
        const val TAG = "AudioEngine"
    }
}
