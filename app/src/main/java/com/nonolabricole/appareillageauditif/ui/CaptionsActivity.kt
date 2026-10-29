package com.nonolabricole.appareillageauditif.ui

import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.button.MaterialButton
import com.nonolabricole.appareillageauditif.HearingService
import com.nonolabricole.appareillageauditif.HearingState
import com.nonolabricole.appareillageauditif.Prefs
import com.nonolabricole.appareillageauditif.R
import com.nonolabricole.appareillageauditif.captions.CaptionFormat
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** Sous-titres en grand, écran toujours allumé. */
class CaptionsActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        if (Appearance.isEssential(this)) setTheme(R.style.Theme_Appareillage_Fullscreen_Essential)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_captions)
        MainActivity.applySystemBarInsets(findViewById(R.id.captionsRoot))
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        prefs = Prefs(this)

        val scroll = findViewById<ScrollView>(R.id.scroll)
        val captions = findViewById<TextView>(R.id.captions)
        val info = findViewById<TextView>(R.id.captionInfo)
        val toggle = findViewById<MaterialButton>(R.id.toggle)
        captions.textSize = prefs.textSize

        findViewById<View>(R.id.smaller).setOnClickListener {
            prefs.textSize = (prefs.textSize - 4f).coerceAtLeast(16f)
            captions.textSize = prefs.textSize
        }
        findViewById<View>(R.id.bigger).setOnClickListener {
            prefs.textSize = (prefs.textSize + 4f).coerceAtMost(56f)
            captions.textSize = prefs.textSize
        }
        findViewById<View>(R.id.close).setOnClickListener { finish() }
        toggle.setOnClickListener {
            // Les permissions ont déjà été accordées depuis l'écran principal.
            HearingService.apply(this, HearingState.remoteMicOn.value, !HearingState.captionsOn.value)
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    combine(
                        HearingState.lines, HearingState.partial, HearingState.partialTranslation, HearingState.display
                    ) { lines, partial, partialTr, display ->
                        CaptionFormat.styled(
                            lines, partial, partialTr, display, 0xFF9E9E9E.toInt(),
                            if (Appearance.isEssential(this@CaptionsActivity)) 0xFFFF5A5F.toInt() else 0xFF9CC0FF.toInt()
                        )
                    }.collect { text ->
                        val atBottom = !scroll.canScrollVertically(1)
                        captions.text = text
                        if (atBottom) scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
                    }
                }
                launch {
                    HearingState.captionsOn.collect { on ->
                        toggle.text = if (on) "Pause" else "Reprendre"
                    }
                }
                launch {
                    HearingState.captionInfo.collect {
                        info.text = it
                        info.visibility = if (it.isEmpty()) View.GONE else View.VISIBLE
                    }
                }
            }
        }
    }
}
