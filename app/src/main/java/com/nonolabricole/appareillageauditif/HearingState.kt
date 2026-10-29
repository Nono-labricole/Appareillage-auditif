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

    val lines = MutableStateFlow<List<Caption>>(emptyList())
    val partial = MutableStateFlow("")
    val partialTranslation = MutableStateFlow("")
    /** Options d'affichage des sous-titres (traduction, etc.). */
    val display = MutableStateFlow(CaptionDisplay())
    /** Bulle flottante par-dessus les autres applications. */
    val overlayOn = MutableStateFlow(false)

    val dsp = MutableStateFlow(DspParams())

    private var nextId = 0L

    @Synchronized
    fun addLine(text: String): Long {
        val id = nextId++
        lines.value = (lines.value + Caption(id, text)).takeLast(MAX_LINES)
        return id
    }

    @Synchronized
    fun setTranslation(id: Long, translation: String) {
        lines.value = lines.value.map { if (it.id == id) it.copy(translation = translation) else it }
    }

    fun clearTranscript() {
        lines.value = emptyList()
        partial.value = ""
        partialTranslation.value = ""
    }

    fun transcriptText(): String = buildString {
        for (c in lines.value) {
            appendLine(c.text)
            if (!c.translation.isNullOrBlank()) appendLine("→ " + c.translation)
        }
        if (partial.value.isNotBlank()) appendLine(partial.value)
    }.trim()

    private const val MAX_LINES = 500
}

data class Caption(val id: Long, val text: String, val translation: String? = null)

data class CaptionDisplay(
    /** Traduction active : afficher les traductions. */
    val translate: Boolean = false,
    /** N'afficher que la traduction (l'original reste visible tant qu'elle n'est pas prête). */
    val translationOnly: Boolean = false
)
