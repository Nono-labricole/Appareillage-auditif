package com.nonolabricole.appareillageauditif.captions

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.res.ResourcesCompat
import com.nonolabricole.appareillageauditif.Prefs
import com.nonolabricole.appareillageauditif.R
import kotlin.math.abs

/**
 * Bulle de sous-titres affichée par-dessus toutes les applications (comme le
 * « Sous-titres instantanés » d'Android). Déplaçable verticalement ; un appui
 * agrandit / réduit ; la croix la masque.
 */
class CaptionOverlay(private val context: Context, private val onClose: () -> Unit) {

    private val wm = context.getSystemService(WindowManager::class.java)
    private val prefs = Prefs(context)
    private var root: View? = null
    private var textView: TextView? = null
    private var scroll: ScrollView? = null
    private var params: WindowManager.LayoutParams? = null
    private var expanded = false

    val isShowing get() = root != null

    fun canShow() = Settings.canDrawOverlays(context)

    @SuppressLint("ClickableViewAccessibility")
    fun show(): Boolean {
        if (root != null) return true
        if (!canShow()) return false
        val dp = context.resources.displayMetrics.density
        val essential = prefs.theme == "essential"

        val text = TextView(context).apply {
            setTextColor(0xFFFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            text = "Sous-titres prêts…"
        }
        // Hauteur fixe de quelques lignes, toujours défilée vers la fin (texte le plus récent).
        val scrollView = ScrollView(context).apply {
            isVerticalScrollBarEnabled = false
            addView(text)
        }
        val close = TextView(context).apply {
            text = "✕"
            setTextColor(0xCCFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setPadding((12 * dp).toInt(), 0, (4 * dp).toInt(), 0)
            setOnClickListener { onClose() }
        }
        val header = TextView(context).apply {
            text = if (essential) "SOUS-TITRES" else "Sous-titres"
            setTextColor(if (essential) 0xFFD71921.toInt() else 0xFF9CC0FF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            letterSpacing = 0.08f
            if (essential) typeface = ResourcesCompat.getFont(context, R.font.space_mono)
        }
        val top = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(header, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(close)
        }
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((16 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (12 * dp).toInt())
            background = GradientDrawable().apply {
                cornerRadius = (if (essential) 20 else 24) * dp
                setColor(if (essential) 0xF0000000.toInt() else 0xE6202124.toInt())
                if (essential) setStroke((1 * dp).toInt(), 0xFF2A2A2A.toInt())
            }
            addView(top)
            addView(scrollView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, text.lineHeight * COMPACT_LINES))
        }
        val frame = FrameLayout(context).apply { addView(box) }

        val metrics = context.resources.displayMetrics
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            val margin = (12 * dp).toInt()
            horizontalMargin = 0f
            x = 0
            y = prefs.overlayY.takeIf { it >= 0 } ?: (metrics.heightPixels * 0.62f).toInt()
            frame.setPadding(margin, 0, margin, 0)
        }

        // Glisser pour déplacer, appuyer pour agrandir / réduire.
        val slop = ViewConfiguration.get(context).scaledTouchSlop
        var downY = 0f
        var startY = 0
        var dragging = false
        val touch = View.OnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downY = e.rawY
                    startY = lp.y
                    dragging = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dy = e.rawY - downY
                    if (!dragging && abs(dy) > slop) dragging = true
                    if (dragging) {
                        lp.y = (startY + dy).toInt().coerceIn(0, metrics.heightPixels - box.height)
                        runCatching { wm.updateViewLayout(frame, lp) }
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) prefs.overlayY = lp.y
                    else {
                        expanded = !expanded
                        scrollView.layoutParams = scrollView.layoutParams.apply {
                            height = text.lineHeight * if (expanded) EXPANDED_LINES else COMPACT_LINES
                        }
                        scrollToEnd()
                    }
                }
            }
            true
        }
        box.setOnTouchListener(touch)
        scrollView.setOnTouchListener(touch)

        return try {
            wm.addView(frame, lp)
            root = frame
            textView = text
            scroll = scrollView
            params = lp
            true
        } catch (e: Exception) {
            false
        }
    }

    fun update(content: CharSequence) {
        textView?.text = if (content.isEmpty()) "…" else content
        scrollToEnd()
    }

    private fun scrollToEnd() {
        scroll?.let { s -> s.post { s.fullScroll(View.FOCUS_DOWN) } }
    }

    fun hide() {
        root?.let { runCatching { wm.removeView(it) } }
        root = null
        textView = null
        scroll = null
        params = null
    }

    private companion object {
        const val COMPACT_LINES = 3
        const val EXPANDED_LINES = 8
    }
}
