package com.nonolabricole.appareillageauditif.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.nonolabricole.appareillageauditif.HearingState
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Capture le micro, applique le traitement voix et renvoie le son vers l'appareil auditif
 * (micro déporté). Fournit aussi le flux 16 kHz aux sous-titres.
 *
 * Pour minimiser la latence :
 * - choix automatique de la liaison la plus rapide (Bluetooth « appel », LE Audio, ASHA…) ;
 * - fréquence native du téléphone et blocs de la taille du « burst » matériel (chemin rapide) ;
 * - tampon de sortie réduit au minimum et agrandi seulement s'il y a des coupures ;
 * - le retard accumulé côté micro (après un ralentissement) est rattrapé en sautant des blocs.
 */
class AudioEngine(context: Context) {

    data class Config(
        /** Renvoyer le son vers l'appareil auditif (micro déporté). */
        val playback: Boolean,
        /** "auto", "call" ou "quality" (voir Prefs.linkMode). */
        val linkMode: String,
        /** "minimal", "balanced" ou "stable". */
        val bufferMode: String,
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
    @Volatile private var commDeviceType = 0
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
        HearingState.latencyMs.value = -1
        HearingState.activeLink.value = ""
    }

    private fun fail(msg: String) {
        Log.w(TAG, msg)
        onError?.invoke(msg)
    }

    /** Faut-il passer par le profil « appel » (communication) ? */
    private fun wantsComm(cfg: Config): Boolean {
        if (cfg.inputFromHearingAid) return true
        if (!cfg.playback) return false
        return when (cfg.linkMode) {
            "call" -> true
            "quality" -> false
            else -> when (DeviceUtils.findMediaOutput(am, cfg.outputKey)?.type) {
                // Bluetooth classique : le profil « appel » est 3 à 5 fois plus rapide que le profil musique.
                AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> true
                // LE Audio : le mode conversation utilise la configuration LC3 basse latence.
                DeviceUtils.TYPE_BLE_HEADSET -> true
                // ASHA, filaire, USB, Auracast : déjà rapides en mode média.
                else -> false
            }
        }
    }

    private fun linkLabel(comm: Boolean, cfg: Config): String {
        if (comm) {
            return when (commDeviceType) {
                DeviceUtils.TYPE_BLE_HEADSET -> "LE Audio – conversation (basse latence)"
                DeviceUtils.TYPE_HEARING_AID -> "ASHA – appel"
                else -> "Bluetooth classique – mode appel (HFP, basse latence)"
            }
        }
        val out = DeviceUtils.findMediaOutput(am, cfg.outputKey) ?: return "Sortie par défaut"
        return when (out.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth classique – musique (A2DP, latence élevée)"
            DeviceUtils.TYPE_BLE_HEADSET -> "LE Audio – média"
            else -> DeviceUtils.kindLabel(out.type)
        }
    }

    @SuppressLint("MissingPermission")
    private fun runLoop(cfg: Config) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        if (appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail("Autorisation du micro refusée.")
            return
        }

        val useComm = wantsComm(cfg)
        if (useComm && !enableCommRouting(cfg.outputKey)) {
            if (cfg.inputFromHearingAid) {
                fail("Micro de l'appareil auditif indisponible (profil Bluetooth « appel » non trouvé). Utilisez le micro du téléphone.")
                return
            }
            if (cfg.linkMode == "call") {
                HearingState.status.value = "Mode appel indisponible avec cet appareil : liaison musique utilisée."
            }
        }
        val comm = useComm && (commDeviceSet || legacySco)

        // Fréquence native : évite le ré-échantillonnage et permet le chemin audio rapide.
        val native = am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull() ?: 48000
        val fs = if (native in 16000..96000 && native % 16000 == 0) native else 48000
        val burst = (am.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toIntOrNull() ?: 0)
            .takeIf { it > 0 } ?: (fs / 200)
        // Blocs de 2 à 10 ms selon le matériel.
        val frames = burst.coerceIn(fs / 500, fs / 100)

        val record = createRecord(cfg, fs, frames, comm)
        if (record == null) {
            fail("Impossible d'ouvrir le micro (peut-être utilisé par une autre application).")
            return
        }
        // Tampon de sortie, en nombre de blocs ; agrandi automatiquement en cas de coupure.
        val startBlocks = when (cfg.bufferMode) {
            "stable" -> 8
            "balanced" -> 4
            else -> 2
        }
        // Jamais plus de ~100 ms (ou 150 ms en mode stable).
        val maxBlocks = max(startBlocks + 1, (if (cfg.bufferMode == "stable") fs * 3 / 20 else fs / 10) / frames)
        var blocks = startBlocks

        val track = if (cfg.playback) createTrack(cfg, fs, frames * (maxBlocks + 2), comm) else null
        if (cfg.playback && track == null) {
            record.release()
            fail("Impossible d'ouvrir la sortie audio.")
            return
        }
        val suppressor = if (cfg.micMode == "phone_nr" && NoiseSuppressor.isAvailable()) {
            runCatching { NoiseSuppressor.create(record.audioSessionId)?.apply { enabled = true } }.getOrNull()
        } else null
        if (cfg.playback) HearingState.activeLink.value = linkLabel(comm, cfg)

        track?.let { setOutputBuffer(it, frames * blocks) }

        val processor = VoiceProcessor(fs)
        val decimator = Decimator(fs)
        val shorts = ShortArray(frames)
        val floats = FloatArray(frames)
        val recordTs = AudioTimestamp()
        val trackTs = AudioTimestamp()
        var framesRead = 0L
        var framesWritten = 0L
        var safe = false
        var lastRouteCheck = 0L
        var lastTune = 0L
        var lastUnderruns = 0
        var lastUnderrunTime = SystemClock.elapsedRealtime()
        var lastLatency = 0L
        var latencyAvg = -1f
        var levelSum = 0f
        var levelCount = 0

        try {
            record.startRecording()
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                fail("Le micro est déjà utilisé par une autre application.")
                return
            }
            if (track != null) {
                // Pré-remplissage pour démarrer sans coupure.
                val silence = ShortArray(frames * blocks)
                framesWritten += max(0, track.write(silence, 0, silence.size, AudioTrack.WRITE_NON_BLOCKING))
                track.play()
            }
            while (running) {
                val n = record.read(shorts, 0, frames)
                if (n < 0) {
                    fail("Erreur du micro ($n).")
                    break
                }
                if (n == 0) continue
                framesRead += n
                transcriptionSink?.let { it(decimator.process(shorts, n)) }

                val now = SystemClock.elapsedRealtime()

                // Rattrapage : si le micro a pris de l'avance (après un ralentissement), on saute
                // les blocs en retard pour la sortie (les sous-titres, eux, reçoivent tout).
                if (track != null && now - lastTune > 100) {
                    val backlog = inputBacklog(record, recordTs, framesRead, fs)
                    if (backlog > frames * 2) {
                        var toSkip = backlog / frames - 1
                        while (toSkip-- > 0 && running) {
                            val m = record.read(shorts, 0, frames)
                            if (m <= 0) break
                            framesRead += m
                            transcriptionSink?.let { it(decimator.process(shorts, m)) }
                        }
                        continue
                    }
                }

                for (i in 0 until n) floats[i] = shorts[i] / 32768f
                val rms: Float
                if (track != null) {
                    rms = processor.process(floats, n, HearingState.dsp.value)
                    if (now - lastRouteCheck > 300) {
                        lastRouteCheck = now
                        safe = isRouteSafe(track)
                        HearingState.outputBlocked.value = !safe
                    }
                    for (i in 0 until n) {
                        shorts[i] = if (safe) (floats[i].coerceIn(-1f, 1f) * 32767f).toInt().toShort() else 0
                    }
                    // Non bloquant : si la sortie est pleine on jette plutôt que d'accumuler du retard.
                    val w = track.write(shorts, 0, n, AudioTrack.WRITE_NON_BLOCKING)
                    if (w > 0) framesWritten += w

                    if (now - lastTune > 200) {
                        lastTune = now
                        val underruns = track.underrunCount
                        if (underruns > lastUnderruns) {
                            lastUnderrunTime = now
                            if (blocks < maxBlocks) {
                                blocks++
                                setOutputBuffer(track, frames * blocks)
                            }
                        } else if (blocks > startBlocks && now - lastUnderrunTime > 30_000) {
                            // Stable depuis 30 s : on retente un tampon plus petit.
                            blocks--
                            setOutputBuffer(track, frames * blocks)
                            lastUnderrunTime = now
                        }
                        lastUnderruns = underruns
                    }
                    if (now - lastLatency > 500) {
                        lastLatency = now
                        val l = estimateLatencyMs(record, recordTs, framesRead, track, trackTs, framesWritten, fs)
                        if (l > 0) {
                            latencyAvg = if (latencyAvg < 0) l else latencyAvg * 0.7f + l * 0.3f
                            HearingState.latencyMs.value = latencyAvg.toInt()
                        }
                    }
                } else {
                    var s = 0.0
                    for (i in 0 until n) s += (floats[i] * floats[i]).toDouble()
                    rms = sqrt(s / n).toFloat()
                }

                levelSum += rms
                if (++levelCount >= 20) {
                    // ~ -60 dBFS → 0, 0 dBFS → 1
                    val db = 20 * log10(max(levelSum / levelCount, 1e-6f))
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

    private fun setOutputBuffer(track: AudioTrack, sizeFrames: Int) {
        runCatching { track.setBufferSizeInFrames(sizeFrames) }
    }

    /** Nombre d'images captées par le micro mais pas encore lues. */
    private fun inputBacklog(record: AudioRecord, ts: AudioTimestamp, framesRead: Long, fs: Int): Int {
        if (record.getTimestamp(ts, AudioTimestamp.TIMEBASE_MONOTONIC) != AudioRecord.SUCCESS) return 0
        val captured = ts.framePosition + (System.nanoTime() - ts.nanoTime) * fs / 1_000_000_000L
        return (captured - framesRead).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
    }

    /**
     * Latence micro → oreille estimée par Android : attente côté micro + file de sortie
     * (qui inclut la latence Bluetooth déclarée par le téléphone).
     */
    private fun estimateLatencyMs(
        record: AudioRecord, recordTs: AudioTimestamp, framesRead: Long,
        track: AudioTrack, trackTs: AudioTimestamp, framesWritten: Long, fs: Int
    ): Float {
        if (!track.getTimestamp(trackTs) || trackTs.nanoTime == 0L) return -1f
        val now = System.nanoTime()
        val outMs = (framesWritten - trackTs.framePosition) * 1000f / fs - (now - trackTs.nanoTime) / 1_000_000f
        var inMs = 0f
        if (record.getTimestamp(recordTs, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
            val lastFrameCaptured = recordTs.nanoTime + (framesRead - recordTs.framePosition) * 1_000_000_000L / fs
            inMs = ((now - lastFrameCaptured) / 1_000_000f).coerceIn(0f, 500f)
        }
        return if (outMs > 0) outMs + inMs else -1f
    }

    private fun isRouteSafe(track: AudioTrack): Boolean {
        val routed = track.routedDevice
        if (routed != null) return routed.type !in DeviceUtils.UNSAFE_OUTPUT_TYPES
        return DeviceUtils.hasSafeOutput(am)
    }

    @SuppressLint("MissingPermission")
    private fun createRecord(cfg: Config, fs: Int, frames: Int, comm: Boolean): AudioRecord? {
        val source = when {
            cfg.inputFromHearingAid -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
            cfg.micMode == "phone_nr" -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
            cfg.micMode == "raw" -> MediaRecorder.AudioSource.MIC
            // Peu de traitement par le téléphone : plus naturel et plus rapide.
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
                // Capacité seulement : le retard réel est maintenu bas par le rattrapage.
                .setBufferSizeInBytes(max(min * 2, frames * 2 * 16))
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

    private fun createTrack(cfg: Config, fs: Int, capacityFrames: Int, comm: Boolean): AudioTrack? {
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
                // Capacité maximale ; la taille utilisée est réglée ensuite (bufferSizeInFrames).
                .setBufferSizeInBytes(max(min, capacityFrames * 2))
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
                ?: candidates.minByOrNull { commPriority(it.type) }
            commDeviceSet = device != null && am.setCommunicationDevice(device)
            commDeviceType = if (commDeviceSet) device!!.type else 0
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
        commDeviceType = AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        // Laisse le temps à la liaison « appel » de s'établir.
        val deadline = SystemClock.elapsedRealtime() + 3000
        while (running && SystemClock.elapsedRealtime() < deadline &&
            am.getDevices(AudioManager.GET_DEVICES_INPUTS).none { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        ) {
            SystemClock.sleep(min(100L, deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
        }
        SystemClock.sleep(300)
        return true
    }

    private fun commPriority(type: Int) = when (type) {
        DeviceUtils.TYPE_BLE_HEADSET -> 0
        DeviceUtils.TYPE_HEARING_AID -> 1
        else -> 2
    }

    @Suppress("DEPRECATION")
    private fun releaseRouting() {
        if (commDeviceSet && Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice()
        commDeviceSet = false
        commDeviceType = 0
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
