package com.nonolabricole.appareillageauditif

import android.app.Application
import com.nonolabricole.appareillageauditif.ui.Appearance

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Appearance.applyNightMode(Prefs(this).nightMode)
    }
}
