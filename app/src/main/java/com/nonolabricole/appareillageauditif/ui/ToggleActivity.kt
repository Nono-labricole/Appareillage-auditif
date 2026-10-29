package com.nonolabricole.appareillageauditif.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import com.nonolabricole.appareillageauditif.HearingService
import com.nonolabricole.appareillageauditif.HearingState

/**
 * Activité invisible : Android n'autorise l'accès au micro en arrière-plan que si le
 * service est lancé depuis un écran visible (tuile des réglages rapides, raccourci…).
 */
class ToggleActivity : Activity() {

    companion object {
        const val EXTRA_CAPTIONS = "captions"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            val captions = intent.getBooleanExtra(EXTRA_CAPTIONS, true)
            HearingService.apply(this, HearingState.remoteMicOn.value, captions)
        } else {
            // Première utilisation : il faut accorder le micro depuis l'application.
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        finish()
    }
}
