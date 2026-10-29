package com.nonolabricole.appareillageauditif.audio

import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * Détection des sorties audio « sûres » (qui ne passent pas par le haut-parleur du
 * téléphone, ce qui provoquerait un larsen) et des appareils auditifs, toutes marques.
 */
object DeviceUtils {
    // Constantes ajoutées dans des versions récentes d'Android (valeurs fixes du SDK).
    const val TYPE_HEARING_AID = 23        // ASHA (Android 9+)
    const val TYPE_BUILTIN_SPEAKER_SAFE = 24
    const val TYPE_BLE_HEADSET = 26        // Bluetooth LE Audio (Android 12+)
    const val TYPE_BLE_BROADCAST = 30      // Auracast (Android 13+)

    private val SAFE_OUTPUT_TYPES = setOf(
        TYPE_HEARING_AID,
        TYPE_BLE_HEADSET,
        TYPE_BLE_BROADCAST,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_USB_HEADSET
    )

    val UNSAFE_OUTPUT_TYPES = setOf(
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
        TYPE_BUILTIN_SPEAKER_SAFE
    )

    /** Types utilisables en « mode appel » (faible latence, micro de l'appareil disponible). */
    val COMM_TYPES = setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, TYPE_BLE_HEADSET, TYPE_HEARING_AID)

    data class OutputDevice(val key: String, val name: String, val type: Int) {
        val kind: String get() = kindLabel(type)
        val isNativeHearingAid: Boolean get() = type == TYPE_HEARING_AID || type == TYPE_BLE_HEADSET
    }

    // Plus petit = préféré quand un même appareil apparaît sous plusieurs profils.
    private fun priority(type: Int): Int = when (type) {
        TYPE_HEARING_AID -> 0
        TYPE_BLE_HEADSET -> 1
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> 2
        TYPE_BLE_BROADCAST -> 3
        AudioDeviceInfo.TYPE_USB_HEADSET -> 4
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> 5
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 6
        else -> 9
    }

    fun kindLabel(type: Int): String = when (type) {
        TYPE_HEARING_AID -> "Appareil auditif ASHA"
        TYPE_BLE_HEADSET -> "Bluetooth LE Audio"
        TYPE_BLE_BROADCAST -> "Auracast"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth classique"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth casque (profil appel)"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Filaire"
        else -> "Autre"
    }

    /** Identifiant stable d'un appareil (l'id Android change à chaque reconnexion). */
    fun keyOf(d: AudioDeviceInfo): String {
        val address = if (Build.VERSION.SDK_INT >= 28) d.address.orEmpty() else ""
        return address.ifEmpty { d.productName?.toString().orEmpty() + "#" + d.type }
    }

    private fun safeOutputs(am: AudioManager): List<AudioDeviceInfo> =
        am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { it.type in SAFE_OUTPUT_TYPES }

    fun listOutputs(am: AudioManager): List<OutputDevice> =
        safeOutputs(am)
            .groupBy { keyOf(it) }
            .map { (key, list) ->
                val best = list.minBy { priority(it.type) }
                val name = best.productName?.toString()?.takeIf { it.isNotBlank() } ?: kindLabel(best.type)
                OutputDevice(key, name, best.type)
            }
            .sortedBy { priority(it.type) }

    fun hasSafeOutput(am: AudioManager): Boolean = safeOutputs(am).isNotEmpty()

    /** Un appareil utilisable en mode « appel » est connecté. */
    fun hasCommOutput(am: AudioManager): Boolean =
        am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in COMM_TYPES }

    /** Sortie « média » à utiliser pour l'appareil choisi (ou la meilleure disponible). */
    fun findMediaOutput(am: AudioManager, key: String?): AudioDeviceInfo? {
        val outs = safeOutputs(am).filter { it.type != AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        val chosen = if (key.isNullOrEmpty()) outs else outs.filter { keyOf(it) == key }.ifEmpty { outs }
        return chosen.minByOrNull { priority(it.type) }
    }

    fun findBuiltinMic(am: AudioManager): AudioDeviceInfo? =
        am.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }

    /** Micro de l'appareil auditif / casque (via le profil « appel »). */
    fun findHeadsetMic(am: AudioManager, key: String?): AudioDeviceInfo? {
        val ins = am.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.type in COMM_TYPES }
        return ins.firstOrNull { !key.isNullOrEmpty() && keyOf(it) == key } ?: ins.firstOrNull()
    }
}
