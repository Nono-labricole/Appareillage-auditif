package com.nonolabricole.appareillageauditif

import android.content.Context
import com.nonolabricole.appareillageauditif.audio.DspParams

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var gainDb: Float
        get() = sp.getFloat("gainDb", 12f)
        set(v) = sp.edit().putFloat("gainDb", v).apply()

    var clarityDb: Float
        get() = sp.getFloat("clarityDb", 6f)
        set(v) = sp.edit().putFloat("clarityDb", v).apply()

    var noiseReduction: Boolean
        get() = sp.getBoolean("noiseReduction", true)
        set(v) = sp.edit().putBoolean("noiseReduction", v).apply()

    /**
     * "auto" (liaison la plus rapide disponible), "call" (Bluetooth « appel » HFP / LE Audio
     * conversation) ou "quality" (Bluetooth « musique » A2DP / LE Audio média).
     */
    var linkMode: String
        get() = sp.getString("linkMode", null)
            ?: if (sp.getBoolean("lowLatency", false)) "call" else "auto"
        set(v) = sp.edit().putString("linkMode", v).apply()

    /** Taille du tampon de sortie : "minimal", "balanced" ou "stable". */
    var bufferMode: String
        get() = sp.getString("bufferMode", "minimal").orEmpty()
        set(v) = sp.edit().putString("bufferMode", v).apply()

    /** Clé de l'appareil de sortie choisi, vide = automatique. */
    var outputKey: String
        get() = sp.getString("outputKey", "").orEmpty()
        set(v) = sp.edit().putString("outputKey", v).apply()

    /** "natural", "phone_nr" ou "raw". */
    var micMode: String
        get() = sp.getString("micMode", "natural").orEmpty()
        set(v) = sp.edit().putString("micMode", v).apply()

    /** "phone" ou "aid" : micro utilisé pour les sous-titres quand le micro déporté est coupé. */
    var captionSource: String
        get() = sp.getString("captionSource", "phone").orEmpty()
        set(v) = sp.edit().putString("captionSource", v).apply()

    /** Code de langue BCP-47, vide = langue du téléphone. */
    var language: String
        get() = sp.getString("language", "").orEmpty()
        set(v) = sp.edit().putString("language", v).apply()

    var preferOffline: Boolean
        get() = sp.getBoolean("preferOffline", true)
        set(v) = sp.edit().putBoolean("preferOffline", v).apply()

    var textSize: Float
        get() = sp.getFloat("textSize", 28f)
        set(v) = sp.edit().putFloat("textSize", v).apply()

    /** "dynamic", "ocean", "forest", "lavender", "sunset" ou "essential". */
    var theme: String
        get() = sp.getString("theme", "dynamic").orEmpty()
        set(v) = sp.edit().putString("theme", v).apply()

    /** "system", "light" ou "dark". */
    var nightMode: String
        get() = sp.getString("nightMode", "system").orEmpty()
        set(v) = sp.edit().putString("nightMode", v).apply()

    /** Bulle de sous-titres par-dessus les autres applications. */
    var overlayEnabled: Boolean
        get() = sp.getBoolean("overlayEnabled", false)
        set(v) = sp.edit().putBoolean("overlayEnabled", v).apply()

    var overlayY: Int
        get() = sp.getInt("overlayY", -1)
        set(v) = sp.edit().putInt("overlayY", v).apply()

    var translationEnabled: Boolean
        get() = sp.getBoolean("translationEnabled", false)
        set(v) = sp.edit().putBoolean("translationEnabled", v).apply()

    /** Langue cible de la traduction (code ISO 639-1, ex. "en"). */
    var translationTarget: String
        get() = sp.getString("translationTarget", "en").orEmpty()
        set(v) = sp.edit().putString("translationTarget", v).apply()

    var translationOnly: Boolean
        get() = sp.getBoolean("translationOnly", false)
        set(v) = sp.edit().putBoolean("translationOnly", v).apply()

    fun captionDisplay() = CaptionDisplay(translationEnabled, translationEnabled && translationOnly)

    fun dspParams() = DspParams(gainDb, clarityDb, noiseReduction)
}
