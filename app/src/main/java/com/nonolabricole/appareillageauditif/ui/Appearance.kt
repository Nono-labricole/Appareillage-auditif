package com.nonolabricole.appareillageauditif.ui

import android.app.Activity
import androidx.appcompat.app.AppCompatDelegate
import com.google.android.material.color.DynamicColors
import com.nonolabricole.appareillageauditif.Prefs
import com.nonolabricole.appareillageauditif.R

/** Thèmes de l'application : palettes Material 3, couleurs du fond d'écran ou Essential. */
object Appearance {

    data class Theme(val key: String, val label: String)

    val themes = listOf(
        Theme("dynamic", "Material You"),
        Theme("ocean", "Océan"),
        Theme("forest", "Forêt"),
        Theme("lavender", "Lavande"),
        Theme("sunset", "Corail"),
        Theme("essential", "Essential")
    )

    val nightModes = listOf(
        "system" to "Système",
        "light" to "Clair",
        "dark" to "Sombre"
    )

    /** Thèmes proposés sur ce téléphone (« Material You » demande Android 12). */
    fun availableThemes() = themes.filter { it.key != "dynamic" || DynamicColors.isDynamicColorAvailable() }

    fun isEssential(activity: Activity) = Prefs(activity).theme == "essential"

    /** À appeler avant super.onCreate(). */
    fun applyTheme(activity: Activity) {
        when (val key = Prefs(activity).theme) {
            "essential" -> activity.setTheme(R.style.Theme_Appareillage_Essential)
            "dynamic" -> {
                activity.setTheme(R.style.Theme_Appareillage)
                if (DynamicColors.isDynamicColorAvailable()) {
                    DynamicColors.applyToActivityIfAvailable(activity)
                } else {
                    activity.theme.applyStyle(R.style.Palette_Ocean, true)
                }
            }
            else -> {
                activity.setTheme(R.style.Theme_Appareillage)
                activity.theme.applyStyle(paletteFor(key), true)
            }
        }
    }

    private fun paletteFor(key: String) = when (key) {
        "forest" -> R.style.Palette_Forest
        "lavender" -> R.style.Palette_Lavender
        "sunset" -> R.style.Palette_Sunset
        else -> R.style.Palette_Ocean
    }

    fun applyNightMode(mode: String) {
        AppCompatDelegate.setDefaultNightMode(
            when (mode) {
                "light" -> AppCompatDelegate.MODE_NIGHT_NO
                "dark" -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            }
        )
    }
}
