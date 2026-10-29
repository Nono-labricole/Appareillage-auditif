package com.nonolabricole.appareillageauditif.ui

import android.animation.ArgbEvaluator
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.res.ColorStateList
import android.view.MotionEvent
import android.view.View
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import android.widget.ImageView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors

/**
 * Grande commande animée façon Material 3 « expressive » : forme festonnée qui tourne
 * doucement quand la fonction est active, rebond au toucher, couleurs et arrondis qui
 * se transforment, et pulsation au rythme du son.
 */
class HeroTile(
    private val card: MaterialCardView,
    private val shape: ImageView,
    private val icon: ImageView,
    private val state: TextView,
    private val onText: String,
    private val offText: String
) {
    private val bgOff = MaterialColors.getColor(card, com.google.android.material.R.attr.colorSurfaceContainerHigh)
    private val bgOn = MaterialColors.getColor(card, com.google.android.material.R.attr.colorPrimaryContainer)
    private val shapeOff = MaterialColors.getColor(card, com.google.android.material.R.attr.colorSecondaryContainer)
    private val shapeOn = MaterialColors.getColor(card, androidx.appcompat.R.attr.colorPrimary)
    private val iconOff = MaterialColors.getColor(card, com.google.android.material.R.attr.colorOnSecondaryContainer)
    private val iconOn = MaterialColors.getColor(card, com.google.android.material.R.attr.colorOnPrimary)
    private val textOff = MaterialColors.getColor(card, com.google.android.material.R.attr.colorOnSurfaceVariant)
    private val textOn = MaterialColors.getColor(card, com.google.android.material.R.attr.colorOnPrimaryContainer)
    private val density = card.resources.displayMetrics.density
    private val radiusOff = 32 * density
    private val radiusOn = 48 * density

    private var active: Boolean? = null
    private var progress = 0f
    private var morph: ValueAnimator? = null
    private val evaluator = ArgbEvaluator()
    // Courbe « emphasized » de Material 3.
    private val emphasized = PathInterpolator(0.2f, 0f, 0f, 1f)

    private val spin = ObjectAnimator.ofFloat(shape, View.ROTATION, 0f, 360f).apply {
        duration = 14_000
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
    }
    private val pressX = spring(card, DynamicAnimation.SCALE_X, SpringForce.STIFFNESS_MEDIUM)
    private val pressY = spring(card, DynamicAnimation.SCALE_Y, SpringForce.STIFFNESS_MEDIUM)
    private val pulseX = spring(shape, DynamicAnimation.SCALE_X, SpringForce.STIFFNESS_LOW)
    private val pulseY = spring(shape, DynamicAnimation.SCALE_Y, SpringForce.STIFFNESS_LOW)

    private fun spring(view: View, property: DynamicAnimation.ViewProperty, stiffness: Float) =
        SpringAnimation(view, property, 1f).apply {
            spring = SpringForce(1f).setStiffness(stiffness).setDampingRatio(SpringForce.DAMPING_RATIO_MEDIUM_BOUNCY)
        }

    init {
        apply(0f)
        installPressFeedback()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun installPressFeedback() {
        card.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    pressX.animateToFinalPosition(0.94f)
                    pressY.animateToFinalPosition(0.94f)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    pressX.animateToFinalPosition(1f)
                    pressY.animateToFinalPosition(1f)
                }
            }
            false // laisse le clic et l'effet d'encre se faire normalement
        }
    }

    fun setActive(on: Boolean) {
        if (active == on) return
        val first = active == null
        active = on
        state.text = if (on) onText else offText
        ViewCompat.setStateDescription(card, state.text)
        morph?.cancel()
        if (first) {
            apply(if (on) 1f else 0f)
        } else {
            morph = ValueAnimator.ofFloat(progress, if (on) 1f else 0f).apply {
                duration = 450
                interpolator = emphasized
                addUpdateListener { apply(it.animatedValue as Float) }
                start()
            }
            // Petit rebond de la forme pour accompagner le changement.
            pulseX.setStartValue(if (on) 0.7f else 1.15f).animateToFinalPosition(1f)
            pulseY.setStartValue(if (on) 0.7f else 1.15f).animateToFinalPosition(1f)
        }
        if (on) {
            if (spin.isPaused) spin.resume() else if (!spin.isStarted) spin.start()
        } else {
            spin.pause()
        }
    }

    /** Pulsation selon le niveau sonore (0..1). */
    fun setLevel(level: Float) {
        if (active != true) return
        val target = 1f + 0.22f * level.coerceIn(0f, 1f)
        pulseX.animateToFinalPosition(target)
        pulseY.animateToFinalPosition(target)
    }

    private fun apply(f: Float) {
        progress = f
        card.setCardBackgroundColor(evaluator.evaluate(f, bgOff, bgOn) as Int)
        card.radius = radiusOff + (radiusOn - radiusOff) * f
        shape.imageTintList = ColorStateList.valueOf(evaluator.evaluate(f, shapeOff, shapeOn) as Int)
        icon.imageTintList = ColorStateList.valueOf(evaluator.evaluate(f, iconOff, iconOn) as Int)
        state.setTextColor(evaluator.evaluate(f, textOff, textOn) as Int)
    }

    fun release() {
        spin.cancel()
        morph?.cancel()
    }
}
