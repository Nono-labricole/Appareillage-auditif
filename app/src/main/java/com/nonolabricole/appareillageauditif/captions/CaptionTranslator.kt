package com.nonolabricole.appareillageauditif.captions

import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import com.nonolabricole.appareillageauditif.HearingState
import java.util.Locale

/**
 * Traduction en direct des sous-titres avec ML Kit : tout se fait sur le téléphone.
 * Chaque langue (~30 Mo) est téléchargée une seule fois, ensuite ça marche hors connexion.
 * À utiliser depuis le thread principal.
 */
class CaptionTranslator {

    private var translator: Translator? = null
    private var pair: Pair<String, String>? = null
    private var ready = false
    private val requested = HashSet<Long>()
    private var partialBusy = false
    private var partialPending: String? = null

    /** [sourceTag] : langue des sous-titres (BCP-47), [target] : code ISO 639-1. */
    fun configure(sourceTag: String, target: String) {
        val source = TranslateLanguage.fromLanguageTag(Locale.forLanguageTag(sourceTag).language)
        val dest = TranslateLanguage.fromLanguageTag(target)
        if (source == null || dest == null) {
            close()
            HearingState.captionInfo.value = "Traduction impossible pour cette paire de langues."
            return
        }
        if (pair == source to dest) return
        close()
        pair = source to dest
        if (source == dest) {
            ready = false
            HearingState.captionInfo.value = "La langue de traduction est la même que celle des sous-titres."
            return
        }
        val t = Translation.getClient(
            TranslatorOptions.Builder().setSourceLanguage(source).setTargetLanguage(dest).build()
        )
        translator = t
        HearingState.captionInfo.value = "Préparation de la traduction (téléchargement de la langue la première fois)…"
        t.downloadModelIfNeeded(DownloadConditions.Builder().build())
            .addOnSuccessListener {
                if (translator !== t) return@addOnSuccessListener
                ready = true
                if (HearingState.captionInfo.value.startsWith("Préparation de la traduction")) {
                    HearingState.captionInfo.value = ""
                }
                translatePending()
            }
            .addOnFailureListener {
                if (translator !== t) return@addOnFailureListener
                HearingState.captionInfo.value =
                    "Téléchargement de la langue de traduction impossible : vérifiez la connexion Internet (une seule fois)."
                pair = null
            }
    }

    fun close() {
        translator?.close()
        translator = null
        pair = null
        ready = false
        requested.clear()
        partialBusy = false
        partialPending = null
        HearingState.partialTranslation.value = ""
    }

    /** Traduit les lignes terminées qui ne le sont pas encore. */
    fun translatePending() {
        val t = translator ?: return
        if (!ready) return
        for (c in HearingState.lines.value) {
            if (c.translation != null || !requested.add(c.id)) continue
            t.translate(c.text).addOnSuccessListener { HearingState.setTranslation(c.id, it) }
        }
    }

    /** Traduit la phrase en cours ; une seule requête à la fois, la plus récente gagne. */
    fun translatePartial(text: String) {
        val t = translator ?: return
        if (!ready) return
        if (text.isBlank()) {
            partialPending = null
            HearingState.partialTranslation.value = ""
            return
        }
        if (partialBusy) {
            partialPending = text
            return
        }
        partialBusy = true
        t.translate(text).addOnCompleteListener { task ->
            partialBusy = false
            if (translator !== t) return@addOnCompleteListener
            if (task.isSuccessful && HearingState.partial.value.isNotBlank()) {
                HearingState.partialTranslation.value = task.result
            }
            partialPending?.let {
                partialPending = null
                translatePartial(it)
            }
        }
    }
}
