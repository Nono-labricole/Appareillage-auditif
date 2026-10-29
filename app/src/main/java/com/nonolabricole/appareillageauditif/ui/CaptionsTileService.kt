package com.nonolabricole.appareillageauditif.ui

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.nonolabricole.appareillageauditif.HearingService
import com.nonolabricole.appareillageauditif.HearingState

/** Tuile des réglages rapides : active / coupe les sous-titres d'un geste. */
class CaptionsTileService : TileService() {

    companion object {
        fun requestUpdate(context: Context) {
            runCatching {
                requestListeningState(context, ComponentName(context, CaptionsTileService::class.java))
            }
        }
    }

    override fun onStartListening() {
        super.onStartListening()
        updateTile(HearingState.captionsOn.value)
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        super.onClick()
        if (HearingState.captionsOn.value) {
            HearingService.apply(this, HearingState.remoteMicOn.value, captions = false)
            updateTile(false)
            return
        }
        // Le micro ne peut être démarré que depuis l'écran : on passe par une activité invisible.
        val intent = Intent(this, ToggleActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(ToggleActivity.EXTRA_CAPTIONS, true)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun updateTile(on: Boolean) {
        val tile = qsTile ?: return
        tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = "Sous-titres"
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = if (on) "Activés" else "Désactivés"
        tile.updateTile()
    }
}
