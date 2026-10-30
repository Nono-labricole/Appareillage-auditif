package com.nonolabricole.appareillageauditif.captions

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import com.nonolabricole.appareillageauditif.HearingState
import java.io.IOException
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.BlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Sous-titres en continu avec le moteur de reconnaissance vocale du téléphone
 * (Google, Samsung…). Sur Android 13+, l'audio lui est fourni par [feed] : le même
 * micro sert alors au micro déporté et aux sous-titres. Sinon le moteur écoute
 * lui-même le micro.
 *
 * Toutes les méthodes publiques sauf [feed] s'appellent depuis le thread principal.
 */
class TranscriptionEngine(private val context: Context, private val onExternalAudioUnsupported: () -> Unit) {

    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var onDevice = false
    private var onDeviceFailed = false
    private var modelDownloadRequested = false
    @Volatile private var running = false

    /** Vrai si l'audio est fourni par l'application (Android 13+ et moteur compatible). */
    var externalAudio = Build.VERSION.SDK_INT >= 33
        private set

    /**
     * Écoute continue en une seule session (Android 13+) : plus de coupure ni de redémarrage
     * entre les phrases. Désactivée automatiquement si le moteur ne la gère pas.
     */
    private var segmented = Build.VERSION.SDK_INT >= 33
    private var segmentedErrors = 0

    private var language = ""
    private var preferOffline = true
    private var consecutiveErrors = 0

    private val queue: BlockingQueue<ShortArray> = ArrayBlockingQueue(300) // ~3 s d'avance
    private var session: PipeSession? = null

    fun start(language: String, preferOffline: Boolean) {
        if (running && language == this.language && preferOffline == this.preferOffline) return
        stop()
        this.language = language
        this.preferOffline = preferOffline
        onDeviceFailed = false
        consecutiveErrors = 0
        segmented = Build.VERSION.SDK_INT >= 33
        segmentedErrors = 0
        running = true
        queue.clear()
        createRecognizer()
        listen()
    }

    fun stop() {
        running = false
        main.removeCallbacksAndMessages(null)
        recognizer?.let {
            runCatching { it.cancel() }
            runCatching { it.destroy() }
        }
        recognizer = null
        session?.close()
        session = null
        queue.clear()
        commitPartial()
    }

    /** Audio PCM 16 bits mono 16 kHz, appelé depuis le thread audio. */
    fun feed(pcm: ShortArray) {
        if (!running || !externalAudio) return
        if (!queue.offer(pcm)) {
            queue.poll()
            queue.offer(pcm)
        }
    }

    private fun createRecognizer() {
        recognizer?.let { runCatching { it.destroy() } }
        recognizer = null
        val r = when {
            preferOffline && !onDeviceFailed && Build.VERSION.SDK_INT >= 31 &&
                SpeechRecognizer.isOnDeviceRecognitionAvailable(context) -> {
                onDevice = true
                SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            }
            SpeechRecognizer.isRecognitionAvailable(context) -> {
                onDevice = false
                SpeechRecognizer.createSpeechRecognizer(context)
            }
            else -> null
        }
        if (r == null) {
            HearingState.captionInfo.value =
                "Aucun service de reconnaissance vocale sur ce téléphone. Installez l'application « Google » " +
                    "ou « Services de reconnaissance vocale de Google » depuis le Play Store."
            return
        }
        r.setRecognitionListener(listener)
        recognizer = r
    }

    private fun buildIntent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, language.ifEmpty { Locale.getDefault().toLanguageTag() })
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline)
        // Valide une phrase dès une courte pause : le texte définitif (et sa traduction) arrive plus vite.
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 900L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 700L)
    }

    private fun listen() {
        if (!running) return
        val r = recognizer ?: return
        val intent = buildIntent()
        if (externalAudio && Build.VERSION.SDK_INT >= 33) {
            session?.close()
            val s = PipeSession(queue)
            session = s
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, s.readSide)
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16000)
            // La session dure tant que notre flux audio reste ouvert : écoute continue.
            if (segmented) intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
            s.start()
        }
        try {
            r.startListening(intent)
        } catch (e: Exception) {
            Log.w(TAG, "startListening", e)
            scheduleRestart(1000, recreate = true)
        }
    }

    private fun scheduleRestart(delayMs: Long, recreate: Boolean = false) {
        session?.close()
        session = null
        main.removeCallbacksAndMessages(null)
        main.postDelayed({
            if (!running) return@postDelayed
            if (recreate || recognizer == null) createRecognizer()
            listen()
        }, delayMs)
    }

    private fun commitPartial() {
        val p = HearingState.partial.value
        if (p.isNotBlank()) HearingState.addLine(p)
        HearingState.partial.value = ""
    }

    private fun firstResult(bundle: Bundle?): String =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().trim()

    private fun handleError(error: Int) {
        if (!running) return
        commitPartial()
        when (error) {
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> scheduleRestart(50)

            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> {
                runCatching { recognizer?.cancel() }
                scheduleRestart(500)
            }

            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                HearingState.captionInfo.value = "Le service de reconnaissance vocale n'a pas accès au micro."
                scheduleRestart(5000)
            }

            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
            SpeechRecognizer.ERROR_SERVER -> {
                HearingState.captionInfo.value =
                    "Pas de connexion Internet : activez « Hors connexion » et téléchargez la langue dans les paramètres de reconnaissance vocale."
                scheduleRestart(3000)
            }

            ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE -> {
                if (onDevice) {
                    if (Build.VERSION.SDK_INT >= 33 && !modelDownloadRequested) {
                        modelDownloadRequested = true
                        runCatching { recognizer?.triggerModelDownload(buildIntent()) }
                    }
                    onDeviceFailed = true
                    HearingState.captionInfo.value =
                        "Langue non téléchargée pour le mode hors connexion : utilisation de la reconnaissance en ligne."
                    scheduleRestart(300, recreate = true)
                } else {
                    HearingState.captionInfo.value = "Cette langue n'est pas prise en charge par le moteur de reconnaissance."
                    scheduleRestart(5000)
                }
            }

            ERROR_SERVER_DISCONNECTED -> scheduleRestart(500, recreate = true)

            else -> { // ERROR_AUDIO, ERROR_CLIENT, …
                consecutiveErrors++
                when {
                    externalAudio && segmented && ++segmentedErrors >= 2 -> {
                        // Le moteur ne gère pas l'écoute continue : retour aux sessions phrase par phrase.
                        segmented = false
                        consecutiveErrors = 0
                        scheduleRestart(300, recreate = true)
                    }
                    externalAudio && consecutiveErrors >= 3 -> {
                        // Le moteur n'accepte pas l'audio fourni par l'application.
                        externalAudio = false
                        queue.clear()
                        HearingState.captionInfo.value =
                            "Le moteur vocal de ce téléphone utilise son propre accès au micro. " +
                                "Avec le micro déporté actif, les sous-titres peuvent s'interrompre."
                        onExternalAudioUnsupported()
                        scheduleRestart(300, recreate = true)
                    }
                    onDevice && consecutiveErrors >= 5 -> {
                        onDeviceFailed = true
                        scheduleRestart(300, recreate = true)
                    }
                    else -> scheduleRestart(minOf(500L * consecutiveErrors, 5000L), recreate = consecutiveErrors >= 2)
                }
            }
        }
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            // Le service a sa propre copie du descripteur : on libère la nôtre.
            session?.releaseReadSide()
        }

        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            val text = firstResult(partialResults)
            if (text.isNotEmpty()) {
                HearingState.partial.value = text
                consecutiveErrors = 0
                if (HearingState.captionInfo.value.isNotEmpty() && !onDeviceFailed && externalAudio) {
                    HearingState.captionInfo.value = ""
                }
            }
        }

        // Écoute continue : chaque phrase arrive ici sans que la session s'arrête.
        override fun onSegmentResults(segmentResults: Bundle) {
            val text = firstResult(segmentResults)
            HearingState.partial.value = ""
            if (text.isNotEmpty()) HearingState.addLine(text)
            consecutiveErrors = 0
            segmentedErrors = 0
        }

        override fun onEndOfSegmentedSession() {
            commitPartial()
            scheduleRestart(30)
        }

        override fun onResults(results: Bundle?) {
            val text = firstResult(results)
            HearingState.partial.value = ""
            if (text.isNotEmpty()) HearingState.addLine(text)
            consecutiveErrors = 0
            scheduleRestart(30)
        }

        override fun onError(error: Int) = handleError(error)
    }

    /** Tuyau vers le service de reconnaissance, alimenté par un thread dédié. */
    private class PipeSession(private val queue: BlockingQueue<ShortArray>) {
        private val pipe = ParcelFileDescriptor.createPipe()
        val readSide: ParcelFileDescriptor = pipe[0]
        private val out = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
        @Volatile private var active = true
        private var readClosed = false
        private val thread = Thread({ loop() }, "caption-pipe")

        fun start() = thread.start()

        private fun loop() {
            var bytes = ByteArray(0)
            try {
                while (active) {
                    val buf = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                    if (!active) break
                    if (bytes.size < buf.size * 2) bytes = ByteArray(buf.size * 2)
                    for (i in buf.indices) {
                        val v = buf[i].toInt()
                        bytes[2 * i] = (v and 0xff).toByte()
                        bytes[2 * i + 1] = ((v shr 8) and 0xff).toByte()
                    }
                    out.write(bytes, 0, buf.size * 2)
                }
            } catch (_: IOException) {
            } catch (_: InterruptedException) {
            }
        }

        @Synchronized
        fun releaseReadSide() {
            if (!readClosed) {
                readClosed = true
                runCatching { readSide.close() }
            }
        }

        fun close() {
            active = false
            releaseReadSide()
            runCatching { out.close() }
            thread.interrupt()
        }
    }

    private companion object {
        const val TAG = "Transcription"
        // Constantes de SpeechRecognizer ajoutées dans Android 12.
        const val ERROR_SERVER_DISCONNECTED = 11
        const val ERROR_LANGUAGE_NOT_SUPPORTED = 12
        const val ERROR_LANGUAGE_UNAVAILABLE = 13
    }
}
