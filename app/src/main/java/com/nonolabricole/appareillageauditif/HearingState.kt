package com.nonolabricole.appareillageauditif

import com.nonolabricole.appareillageauditif.audio.DspParams
import kotlinx.coroutines.flow.MutableStateFlow

/** État partagé entre le service (moteur audio, sous-titres) et les écrans. */
object HearingState {
    val serviceRunning = MutableStateFlow(false)
    val remoteMicOn = MutableStateFlow(false)
    val captionsOn = MutableStateFlow(false)

    /** Niveau sonore 0..1 pour le vumètre. */
    val level = MutableStateFlow(0f)
    /** Vrai quand la sortie est coupée pour éviter un larsen (aucun appareil connecté). */
    val outputBlocked = MutableStateFlow(false)
    val status = MutableStateFlow("")
    /** Latence estimée micro → sortie, en ms (-1 = inconnue). */
    val latencyMs = MutableStateFlow(-1)
    /** Liaison réellement utilisée par le micro déporté. */
    val activeLink = MutableStateFlow("")
    val captionInfo = MutableStateFlow("")

    val lines = MutableStateFlow<List<String>>(emptyList())
    val partial = MutableStateFlow("")

    val dsp = MutableStateFlow(DspParams())

    fun addLine(text: String) {
        lines.value = (lines.value + text).takeLast(MAX_LINES)
    }

    fun clearTranscript() {
        lines.value = emptyList()
        partial.value = ""
    }

    fun transcriptText(): String =
        (lines.value + partial.value).filter { it.isNotBlank() }.joinToString("\n")

    private const val MAX_LINES = 500
}
