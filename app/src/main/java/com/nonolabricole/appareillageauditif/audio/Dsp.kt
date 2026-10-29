package com.nonolabricole.appareillageauditif.audio

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh

/** Filtre biquad (formules du « Audio EQ Cookbook » de R. Bristow-Johnson). */
class Biquad {
    private var b0 = 1f
    private var b1 = 0f
    private var b2 = 0f
    private var a1 = 0f
    private var a2 = 0f
    private var z1 = 0f
    private var z2 = 0f

    fun process(x: Float): Float {
        val y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        return y
    }

    private fun set(nb0: Double, nb1: Double, nb2: Double, na0: Double, na1: Double, na2: Double) {
        b0 = (nb0 / na0).toFloat()
        b1 = (nb1 / na0).toFloat()
        b2 = (nb2 / na0).toFloat()
        a1 = (na1 / na0).toFloat()
        a2 = (na2 / na0).toFloat()
    }

    fun highPass(fs: Int, f: Double, q: Double = 0.707) {
        val w = 2 * PI * f / fs
        val c = cos(w)
        val alpha = sin(w) / (2 * q)
        set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha)
    }

    fun lowPass(fs: Int, f: Double, q: Double = 0.707) {
        val w = 2 * PI * f / fs
        val c = cos(w)
        val alpha = sin(w) / (2 * q)
        set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha)
    }

    fun peaking(fs: Int, f: Double, q: Double, gainDb: Double) {
        val a = 10.0.pow(gainDb / 40)
        val w = 2 * PI * f / fs
        val c = cos(w)
        val alpha = sin(w) / (2 * q)
        set(1 + alpha * a, -2 * c, 1 - alpha * a, 1 + alpha / a, -2 * c, 1 - alpha / a)
    }

    fun lowShelf(fs: Int, f: Double, gainDb: Double) {
        val a = 10.0.pow(gainDb / 40)
        val w = 2 * PI * f / fs
        val c = cos(w)
        val s = 2 * sqrt(a) * sin(w) / 2 * sqrt(2.0)
        set(
            a * ((a + 1) - (a - 1) * c + s),
            2 * a * ((a - 1) - (a + 1) * c),
            a * ((a + 1) - (a - 1) * c - s),
            (a + 1) + (a - 1) * c + s,
            -2 * ((a - 1) + (a + 1) * c),
            (a + 1) + (a - 1) * c - s
        )
    }

    fun highShelf(fs: Int, f: Double, gainDb: Double) {
        val a = 10.0.pow(gainDb / 40)
        val w = 2 * PI * f / fs
        val c = cos(w)
        val s = 2 * sqrt(a) * sin(w) / 2 * sqrt(2.0)
        set(
            a * ((a + 1) + (a - 1) * c + s),
            -2 * a * ((a - 1) + (a + 1) * c),
            a * ((a + 1) + (a - 1) * c - s),
            (a + 1) - (a - 1) * c + s,
            2 * ((a - 1) - (a + 1) * c),
            (a + 1) - (a - 1) * c - s
        )
    }
}

/** Réglages modifiables en direct depuis l'écran. */
data class DspParams(
    val gainDb: Float = 12f,
    val clarityDb: Float = 6f,
    val noiseReduction: Boolean = true
)

/**
 * Chaîne de traitement « voix » pour le micro déporté :
 * passe-haut → égaliseur de clarté → réducteur de bruit (expanseur) → compresseur → gain → limiteur.
 */
class VoiceProcessor(private val fs: Int) {
    private var current: DspParams? = null
    private val highPass = Biquad()
    private val lowCut = Biquad()
    private val presence = Biquad()
    private val air = Biquad()
    private var makeup = 1f

    private var env = 0f
    private var noiseFloor = 1e-3f
    private var gateGain = 1f
    private var compGain = 1f

    private val envAttack = coef(0.005)
    private val envRelease = coef(0.120)
    private val gateAttack = coef(0.010)
    private val gateRelease = coef(0.200)
    private val compAttack = coef(0.005)
    private val compRelease = coef(0.250)
    // Le plancher de bruit remonte lentement (~4 dB/s) et redescend instantanément.
    private val noiseRise = 10.0.pow(4.0 / 20 / fs).toFloat()

    private fun coef(seconds: Double) = exp(-1.0 / (seconds * fs)).toFloat()

    private fun configure(p: DspParams) {
        val clarity = p.clarityDb.toDouble()
        highPass.highPass(fs, 120.0)
        lowCut.lowShelf(fs, 250.0, -clarity * 0.5)
        presence.peaking(fs, 2800.0, 0.8, clarity)
        air.highShelf(fs, min(6000.0, fs * 0.4), clarity * 0.4)
        makeup = 10f.pow(p.gainDb / 20f)
    }

    /** Traite [n] échantillons de [buf] sur place et renvoie le niveau RMS de sortie. */
    fun process(buf: FloatArray, n: Int, p: DspParams): Float {
        if (p != current) {
            configure(p)
            current = p
        }
        var sum = 0.0
        for (i in 0 until n) {
            var x = highPass.process(buf[i])
            x = lowCut.process(x)
            x = presence.process(x)
            x = air.process(x)

            val a = abs(x)
            env = if (a > env) envAttack * env + (1 - envAttack) * a else envRelease * env + (1 - envRelease) * a
            noiseFloor = if (env < noiseFloor) env else noiseFloor * noiseRise
            noiseFloor = noiseFloor.coerceIn(1e-5f, 0.05f)

            val gateTarget = if (p.noiseReduction) {
                // Expanseur doux (-8 dB au plus) pour ne pas « hacher » la parole.
                val ratio = env / (noiseFloor * 2f)
                if (ratio >= 1f) 1f else max(0.4f, ratio)
            } else 1f
            gateGain = if (gateTarget > gateGain) gateAttack * gateGain + (1 - gateAttack) * gateTarget
            else gateRelease * gateGain + (1 - gateRelease) * gateTarget

            val compTarget = if (env > COMP_THRESHOLD) (COMP_THRESHOLD / env).pow(1f - 1f / COMP_RATIO) else 1f
            compGain = if (compTarget < compGain) compAttack * compGain + (1 - compAttack) * compTarget
            else compRelease * compGain + (1 - compRelease) * compTarget

            var y = x * gateGain * compGain * makeup
            val ay = abs(y)
            if (ay > LIMIT_KNEE) {
                val shaped = LIMIT_KNEE + (1f - LIMIT_KNEE) * tanh((ay - LIMIT_KNEE) / (1f - LIMIT_KNEE))
                y = if (y > 0) shaped else -shaped
            }
            buf[i] = y
            sum += (y * y).toDouble()
        }
        return if (n > 0) sqrt(sum / n).toFloat() else 0f
    }

    private companion object {
        const val COMP_THRESHOLD = 0.03f // ≈ -30 dBFS
        const val COMP_RATIO = 3f
        const val LIMIT_KNEE = 0.8f
    }
}

/** Ramène l'audio à 16 kHz (format attendu par la reconnaissance vocale). */
class Decimator(fs: Int) {
    private val factor = (fs / 16000).coerceAtLeast(1)
    // Butterworth d'ordre 4 à 7 kHz, en deux sections.
    private val lp1 = Biquad().apply { lowPass(fs, 7000.0, 0.541) }
    private val lp2 = Biquad().apply { lowPass(fs, 7000.0, 1.307) }
    private var phase = 0

    fun process(input: ShortArray, n: Int): ShortArray {
        if (factor == 1) return input.copyOf(n)
        val out = ShortArray(n / factor + 1)
        var k = 0
        for (i in 0 until n) {
            val y = lp2.process(lp1.process(input[i].toFloat()))
            if (phase == 0) out[k++] = y.coerceIn(-32768f, 32767f).toInt().toShort()
            phase = (phase + 1) % factor
        }
        return out.copyOf(k)
    }
}
