package com.nonolabricole.appareillageauditif.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.RadioGroup
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.slider.Slider
import com.nonolabricole.appareillageauditif.HearingService
import com.nonolabricole.appareillageauditif.HearingState
import com.nonolabricole.appareillageauditif.Prefs
import com.nonolabricole.appareillageauditif.R
import com.nonolabricole.appareillageauditif.audio.DeviceUtils
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var am: AudioManager

    private lateinit var statusText: TextView
    private lateinit var deviceSpinner: Spinner
    private lateinit var deviceInfo: TextView
    private lateinit var remoteSwitch: MaterialSwitch
    private lateinit var levelMeter: LinearProgressIndicator
    private lateinit var gainLabel: TextView
    private lateinit var gainSlider: Slider
    private lateinit var clarityLabel: TextView
    private lateinit var claritySlider: Slider
    private lateinit var noiseSwitch: MaterialSwitch
    private lateinit var linkSpinner: Spinner
    private lateinit var linkHelp: TextView
    private lateinit var bufferSpinner: Spinner
    private lateinit var linkText: TextView
    private lateinit var micSpinner: Spinner
    private lateinit var captionsSwitch: MaterialSwitch
    private lateinit var captionInfo: TextView
    private lateinit var transcript: TextView
    private lateinit var sourceGroup: RadioGroup
    private lateinit var languageSpinner: Spinner
    private lateinit var offlineSwitch: MaterialSwitch
    private lateinit var textSizeLabel: TextView
    private lateinit var textSizeSlider: Slider

    private var devices: List<DeviceUtils.OutputDevice> = emptyList()
    private var updatingUi = false
    private var pendingAction: (() -> Unit)? = null

    private val micModes = listOf(
        "natural" to "Naturel (recommandé)",
        "phone_nr" to "Filtre anti-bruit du téléphone",
        "raw" to "Micro brut"
    )
    private val linkModes = listOf(
        "auto" to "Automatique – la plus rapide (recommandé)",
        "call" to "Mode appel (basse latence, son 16 kHz)",
        "quality" to "Mode musique (son riche, plus de latence)"
    )
    private val linkHelps = mapOf(
        "auto" to "Choisit la liaison la plus rapide selon l'appareil : mode appel pour le Bluetooth classique " +
            "(Phonak, la plupart des marques), conversation LE Audio, ASHA ou filaire tels quels.",
        "call" to "Profil « appel téléphonique » : 3 à 5 fois moins de décalage que le mode musique. " +
            "Certains appareils baissent un peu leurs propres micros pendant un « appel ».",
        "quality" to "Profil « musique » : meilleur son, mais 150 à 250 ms de décalage en Bluetooth classique " +
            "(écho possible avec les micros des appareils)."
    )
    private val bufferModes = listOf(
        "minimal" to "Minimal – le plus rapide (s'agrandit seul en cas de craquements)",
        "balanced" to "Équilibré",
        "stable" to "Stable – pour les téléphones lents"
    )
    private val languages = listOf(
        "" to "Langue du téléphone",
        "fr-FR" to "Français",
        "en-US" to "English",
        "es-ES" to "Español",
        "de-DE" to "Deutsch",
        "it-IT" to "Italiano",
        "pt-PT" to "Português",
        "nl-NL" to "Nederlands",
        "ar-SA" to "العربية"
    )

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        val action = pendingAction
        pendingAction = null
        if (hasMicPermission()) {
            action?.invoke()
        } else {
            Toast.makeText(this, "L'accès au micro est nécessaire.", Toast.LENGTH_LONG).show()
            syncSwitches()
        }
    }

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refreshDevices()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refreshDevices()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        Appearance.applyTheme(this)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        applySystemBarInsets(findViewById(R.id.root))
        am = getSystemService(AudioManager::class.java)
        HearingState.dsp.value = prefs.dspParams()

        statusText = findViewById(R.id.statusText)
        deviceSpinner = findViewById(R.id.deviceSpinner)
        deviceInfo = findViewById(R.id.deviceInfo)
        remoteSwitch = findViewById(R.id.remoteSwitch)
        levelMeter = findViewById(R.id.levelMeter)
        gainLabel = findViewById(R.id.gainLabel)
        gainSlider = findViewById(R.id.gainSlider)
        clarityLabel = findViewById(R.id.clarityLabel)
        claritySlider = findViewById(R.id.claritySlider)
        noiseSwitch = findViewById(R.id.noiseSwitch)
        linkSpinner = findViewById(R.id.linkSpinner)
        linkHelp = findViewById(R.id.linkHelp)
        bufferSpinner = findViewById(R.id.bufferSpinner)
        linkText = findViewById(R.id.linkText)
        micSpinner = findViewById(R.id.micSpinner)
        captionsSwitch = findViewById(R.id.captionsSwitch)
        captionInfo = findViewById(R.id.captionInfo)
        transcript = findViewById(R.id.transcript)
        sourceGroup = findViewById(R.id.sourceGroup)
        languageSpinner = findViewById(R.id.languageSpinner)
        offlineSwitch = findViewById(R.id.offlineSwitch)
        textSizeLabel = findViewById(R.id.textSizeLabel)
        textSizeSlider = findViewById(R.id.textSizeSlider)

        setupDeviceSection()
        setupRemoteSection()
        setupCaptionSection()
        setupAppearanceSection()
        setupHelpSection()
        observeState()
    }

    override fun onStart() {
        super.onStart()
        am.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
        refreshDevices()
    }

    override fun onStop() {
        am.unregisterAudioDeviceCallback(deviceCallback)
        super.onStop()
    }

    // ---- Appareil -------------------------------------------------------------------------

    private fun setupDeviceSection() {
        deviceSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (updatingUi) return
                val key = if (position == 0) "" else devices.getOrNull(position - 1)?.key.orEmpty()
                if (key != prefs.outputKey) {
                    prefs.outputKey = key
                    reapplyIfRunning()
                }
                updateDeviceInfo()
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        findViewById<View>(R.id.bluetoothButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
        }
    }

    private fun refreshDevices() {
        devices = DeviceUtils.listOutputs(am)
        val labels = listOf("Automatique (sortie audio actuelle)") + devices.map { "${it.name} — ${it.kind}" }
        updatingUi = true
        deviceSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
        val index = devices.indexOfFirst { it.key == prefs.outputKey }
        deviceSpinner.setSelection(if (index >= 0) index + 1 else 0, false)
        updatingUi = false
        updateDeviceInfo()
    }

    private fun updateDeviceInfo() {
        val selected = devices.firstOrNull { it.key == prefs.outputKey } ?: devices.firstOrNull()
        deviceInfo.text = when {
            selected == null ->
                "Aucun appareil auditif ni écouteur connecté. Connectez-le en Bluetooth (il doit apparaître comme sortie audio)."
            selected.isNativeHearingAid ->
                "« ${selected.name} » utilise un protocole d'appareil auditif reconnu par Android (${selected.kind}) : " +
                    "liaison rapide, l'application l'utilise directement."
            selected.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ->
                "« ${selected.name} » est connecté en Bluetooth classique (cas des Phonak Marvel, Paradise, Lumity…). " +
                    "Android ne le considère pas comme un appareil auditif : cette application prend le relais. " +
                    "Pour le moins de décalage, gardez la liaison « Automatique » ou « Mode appel »."
            else ->
                "« ${selected.name} » (${selected.kind}) : liaison directe, faible décalage."
        }
    }

    // ---- Micro déporté --------------------------------------------------------------------

    private fun setupRemoteSection() {
        gainSlider.value = prefs.gainDb.coerceIn(0f, 30f).let { Math.round(it).toFloat() }
        claritySlider.value = prefs.clarityDb.coerceIn(0f, 12f).let { Math.round(it).toFloat() }
        noiseSwitch.isChecked = prefs.noiseReduction
        updateSliderLabels()

        gainSlider.addOnChangeListener { _, value, _ ->
            prefs.gainDb = value
            updateDsp()
        }
        claritySlider.addOnChangeListener { _, value, _ ->
            prefs.clarityDb = value
            updateDsp()
        }
        noiseSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.noiseReduction = checked
            updateDsp()
        }

        setupChoice(linkSpinner, linkModes, prefs.linkMode) {
            prefs.linkMode = it
            linkHelp.text = linkHelps[it]
            reapplyIfRunning()
        }
        linkHelp.text = linkHelps[prefs.linkMode]
        setupChoice(bufferSpinner, bufferModes, prefs.bufferMode) {
            prefs.bufferMode = it
            reapplyIfRunning()
        }

        micSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, micModes.map { it.second })
        micSpinner.setSelection(micModes.indexOfFirst { it.first == prefs.micMode }.coerceAtLeast(0), false)
        micSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val mode = micModes[position].first
                if (mode != prefs.micMode) {
                    prefs.micMode = mode
                    reapplyIfRunning()
                }
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        remoteSwitch.setOnCheckedChangeListener { _, checked ->
            if (updatingUi) return@setOnCheckedChangeListener
            if (checked && !DeviceUtils.hasSafeOutput(am)) {
                syncSwitches()
                AlertDialog.Builder(this)
                    .setTitle("Appareil auditif non connecté")
                    .setMessage(
                        "Connectez d'abord vos appareils auditifs (ou des écouteurs) en Bluetooth. " +
                            "Sans eux, le son sortirait par le haut-parleur du téléphone et provoquerait un larsen."
                    )
                    .setPositiveButton("Réglages Bluetooth") { _, _ ->
                        startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
                    }
                    .setNegativeButton("Annuler", null)
                    .show()
                return@setOnCheckedChangeListener
            }
            applyService()
        }
    }

    /** Menu déroulant simple : [onChange] reçoit la clé choisie quand elle change. */
    private fun setupChoice(spinner: Spinner, choices: List<Pair<String, String>>, current: String, onChange: (String) -> Unit) {
        spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, choices.map { it.second })
        var selected = choices.indexOfFirst { it.first == current }.coerceAtLeast(0)
        spinner.setSelection(selected, false)
        spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (position == selected) return
                selected = position
                onChange(choices[position].first)
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
    }

    private fun updateDsp() {
        HearingState.dsp.value = prefs.dspParams()
        updateSliderLabels()
    }

    private fun updateSliderLabels() {
        gainLabel.text = "Volume : +${gainSlider.value.toInt()} dB"
        clarityLabel.text = "Clarté de la voix : ${claritySlider.value.toInt()}"
        textSizeLabel.text = "Taille du texte : ${textSizeSlider.value.toInt()}"
    }

    // ---- Sous-titres ----------------------------------------------------------------------

    private fun setupCaptionSection() {
        textSizeSlider.value = (Math.round(prefs.textSize / 2f) * 2f).coerceIn(16f, 56f)
        transcript.textSize = textSizeSlider.value * 0.75f
        textSizeSlider.addOnChangeListener { _, value, _ ->
            prefs.textSize = value
            transcript.textSize = value * 0.75f
            updateSliderLabels()
        }
        updateSliderLabels()

        sourceGroup.check(if (prefs.captionSource == "aid") R.id.sourceAid else R.id.sourcePhone)
        sourceGroup.setOnCheckedChangeListener { _, checkedId ->
            prefs.captionSource = if (checkedId == R.id.sourceAid) "aid" else "phone"
            if (checkedId == R.id.sourceAid && Build.VERSION.SDK_INT < 33) {
                Toast.makeText(this, "Nécessite Android 13 ou plus récent.", Toast.LENGTH_LONG).show()
            }
            reapplyIfRunning()
        }

        languageSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, languages.map { it.second })
        languageSpinner.setSelection(languages.indexOfFirst { it.first == prefs.language }.coerceAtLeast(0), false)
        languageSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val lang = languages[position].first
                if (lang != prefs.language) {
                    prefs.language = lang
                    reapplyIfRunning()
                }
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        offlineSwitch.isChecked = prefs.preferOffline
        offlineSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.preferOffline = checked
            reapplyIfRunning()
        }

        captionsSwitch.setOnCheckedChangeListener { _, _ ->
            if (updatingUi) return@setOnCheckedChangeListener
            applyService()
        }

        findViewById<View>(R.id.fullscreenButton).setOnClickListener {
            startActivity(Intent(this, CaptionsActivity::class.java))
        }
        findViewById<View>(R.id.clearButton).setOnClickListener { HearingState.clearTranscript() }
        findViewById<View>(R.id.shareButton).setOnClickListener {
            val text = HearingState.transcriptText()
            if (text.isBlank()) {
                Toast.makeText(this, "Rien à partager pour l'instant.", Toast.LENGTH_SHORT).show()
            } else {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                startActivity(Intent.createChooser(send, "Partager la transcription"))
            }
        }
    }

    private fun setupAppearanceSection() {
        fillChips(findViewById(R.id.themeChips), Appearance.availableThemes().map { it.key to it.label }, prefs.theme) {
            prefs.theme = it
            recreate()
        }
        fillChips(findViewById(R.id.nightChips), Appearance.nightModes, prefs.nightMode) {
            prefs.nightMode = it
            Appearance.applyNightMode(it)
        }
    }

    private fun fillChips(group: ChipGroup, choices: List<Pair<String, String>>, current: String, onPick: (String) -> Unit) {
        var selected = if (choices.any { it.first == current }) current else choices.first().first
        val initial = selected
        for ((key, label) in choices) {
            val chip = layoutInflater.inflate(R.layout.item_chip, group, false) as Chip
            chip.id = View.generateViewId()
            chip.text = label
            chip.isChecked = key == initial
            chip.setOnCheckedChangeListener { _, checked ->
                if (checked && key != selected) {
                    selected = key
                    onPick(key)
                }
            }
            group.addView(chip)
        }
    }

    private fun setupHelpSection() {
        val liveTranscribe = packageManager.getLaunchIntentForPackage(LIVE_TRANSCRIBE_PACKAGE)
        val button = findViewById<View>(R.id.liveTranscribeButton)
        if (liveTranscribe != null) {
            button.visibility = View.VISIBLE
            button.setOnClickListener { startActivity(liveTranscribe) }
        }
    }

    // ---- Service --------------------------------------------------------------------------

    private fun hasMicPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun withPermissions(action: () -> Unit) {
        val needed = buildList {
            if (!hasMicPermission()) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (needed.isEmpty()) {
            action()
        } else {
            pendingAction = action
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun applyService() {
        val remote = remoteSwitch.isChecked
        val captions = captionsSwitch.isChecked
        if (!remote && !captions) {
            HearingService.apply(this, remoteMic = false, captions = false)
            return
        }
        HearingState.status.value = ""
        withPermissions {
            HearingService.apply(this, remoteSwitch.isChecked, captionsSwitch.isChecked)
        }
    }

    private fun reapplyIfRunning() {
        if (HearingState.remoteMicOn.value || HearingState.captionsOn.value) applyService()
    }

    private fun syncSwitches() {
        updatingUi = true
        remoteSwitch.isChecked = HearingState.remoteMicOn.value
        captionsSwitch.isChecked = HearingState.captionsOn.value
        updatingUi = false
    }

    private fun observeState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    combine(HearingState.remoteMicOn, HearingState.captionsOn) { a, b -> a to b }
                        .collect { syncSwitches() }
                }
                launch {
                    combine(HearingState.level, HearingState.remoteMicOn) { l, on -> if (on) l else 0f }
                        .collect { levelMeter.setProgressCompat((it * 100).toInt(), true) }
                }
                launch {
                    combine(HearingState.status, HearingState.outputBlocked) { s, blocked ->
                        when {
                            s.isNotEmpty() -> s
                            blocked -> "Sortie coupée : le son partirait sur le haut-parleur du téléphone (risque de larsen). Reconnectez vos appareils auditifs."
                            else -> ""
                        }
                    }.collect {
                        statusText.text = it
                        statusText.visibility = if (it.isEmpty()) View.GONE else View.VISIBLE
                    }
                }
                launch {
                    combine(HearingState.activeLink, HearingState.latencyMs) { link, ms -> link to ms }
                        .collect { (link, ms) ->
                            val text = buildString {
                                if (link.isNotEmpty()) append("Liaison : ").append(link)
                                if (ms > 0) append("\nDécalage estimé : ≈ ").append(ms).append(" ms")
                            }
                            linkText.text = text
                            linkText.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
                        }
                }
                launch {
                    HearingState.captionInfo.collect {
                        captionInfo.text = it
                        captionInfo.visibility = if (it.isEmpty()) View.GONE else View.VISIBLE
                    }
                }
                launch {
                    combine(HearingState.lines, HearingState.partial) { lines, partial -> lines to partial }
                        .collect { (lines, partial) ->
                            transcript.text = formatTranscript(lines.takeLast(8), partial, getColor(R.color.caption_partial))
                        }
                }
            }
        }
    }

    companion object {
        /** Évite que le contenu passe sous les barres système (affichage bord à bord). */
        fun applySystemBarInsets(view: View) {
            val start = view.paddingLeft
            val top = view.paddingTop
            val end = view.paddingRight
            val bottom = view.paddingBottom
            ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                v.updatePadding(left = start + bars.left, top = top + bars.top, right = end + bars.right, bottom = bottom + bars.bottom)
                insets
            }
        }

        const val LIVE_TRANSCRIBE_PACKAGE = "com.google.audio.hearing.visualization.accessibility.scribe"

        fun formatTranscript(lines: List<String>, partial: String, partialColor: Int): CharSequence {
            val sb = SpannableStringBuilder(lines.joinToString("\n"))
            if (partial.isNotBlank()) {
                if (sb.isNotEmpty()) sb.append("\n")
                val start = sb.length
                sb.append(partial)
                sb.setSpan(ForegroundColorSpan(partialColor), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            return sb
        }
    }
}
