package com.nonolabricole.appareillageauditif.captions

import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.graphics.Typeface
import com.nonolabricole.appareillageauditif.Caption
import com.nonolabricole.appareillageauditif.CaptionDisplay

/** Mise en forme commune des sous-titres (écran, plein écran, bulle, notification). */
object CaptionFormat {

    fun styled(
        lines: List<Caption>,
        partial: String,
        partialTranslation: String,
        display: CaptionDisplay,
        partialColor: Int,
        translationColor: Int
    ): CharSequence {
        val sb = SpannableStringBuilder()
        fun newLine() {
            if (sb.isNotEmpty()) sb.append("\n")
        }
        fun appendColored(text: String, color: Int, italic: Boolean = false) {
            newLine()
            val start = sb.length
            sb.append(text)
            sb.setSpan(ForegroundColorSpan(color), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (italic) sb.setSpan(StyleSpan(Typeface.ITALIC), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }

        for (c in lines) {
            val tr = c.translation
            when {
                !display.translate -> {
                    newLine()
                    sb.append(c.text)
                }
                display.translationOnly -> {
                    if (tr.isNullOrBlank()) appendColored(c.text, partialColor) else {
                        newLine()
                        sb.append(tr)
                    }
                }
                else -> {
                    newLine()
                    sb.append(c.text)
                    if (!tr.isNullOrBlank()) appendColored("→ $tr", translationColor, italic = true)
                }
            }
        }
        if (partial.isNotBlank()) {
            when {
                !display.translate -> appendColored(partial, partialColor)
                display.translationOnly -> appendColored(partialTranslation.ifBlank { partial }, partialColor)
                else -> {
                    appendColored(partial, partialColor)
                    if (partialTranslation.isNotBlank()) appendColored("→ $partialTranslation", translationColor, italic = true)
                }
            }
        }
        return sb
    }

    /** Dernières lignes en texte brut (notification). */
    fun plainTail(lines: List<Caption>, partial: String, partialTranslation: String, display: CaptionDisplay, max: Int): String {
        val out = ArrayList<String>()
        for (c in lines.takeLast(max)) {
            val tr = c.translation
            when {
                !display.translate -> out += c.text
                display.translationOnly -> out += if (tr.isNullOrBlank()) c.text else tr
                else -> {
                    out += c.text
                    if (!tr.isNullOrBlank()) out += "→ $tr"
                }
            }
        }
        if (partial.isNotBlank()) {
            when {
                !display.translate -> out += partial
                display.translationOnly -> out += partialTranslation.ifBlank { partial }
                else -> {
                    out += partial
                    if (partialTranslation.isNotBlank()) out += "→ $partialTranslation"
                }
            }
        }
        return out.takeLast(max).joinToString("\n")
    }
}
