// Outils d'analyse : orchestrent les exports depuis Premiere puis calculent localement.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const png = require("./png");
const { frameStats, consistency } = require("./color");
const { visibleShots, analyzeRhythm } = require("./rhythm");
const { analyzeWav, recommendation } = require("./audio");
const { round, fmtTime } = require("./stats");

const LONG_TIMEOUT = 30 * 60 * 1000;

function tmpFile(ext) {
  const dir = path.join(os.tmpdir(), "premiere-claude-bridge");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

const safeUnlink = (f) => { try { fs.unlinkSync(f); } catch (e) { /* ignoré */ } };
const text = (obj) => ({ type: "text", text: JSON.stringify(obj, null, 2) });

function createAnalyzers({ host, waitForFile }) {
  let cachedWavPreset = null;

  async function sequenceInfo(args) {
    if (args.sequenceId || args.sequenceName) await host("set_active_sequence", { sequenceId: args.sequenceId, sequenceName: args.sequenceName });
    return host("get_sequence_info", {});
  }

  async function wavPreset(args) {
    if (args.presetPath) return args.presetPath;
    if (cachedWavPreset) return cachedWavPreset;
    const found = await host("find_export_presets", { query: "wav", max: 50 }, LONG_TIMEOUT);
    const epr = found.filter((p) => /wav/i.test(path.basename(p)));
    const pick = epr.find((p) => /48\s*k/i.test(p) && /16/.test(p)) || epr.find((p) => /48/.test(p)) || epr[0];
    if (!pick) throw new Error("Aucun préréglage d'export WAV (.epr) trouvé. Créez-en un dans Premiere/Media Encoder " +
      "(format Waveform Audio, 48 kHz, 16 bits) et passez son chemin dans presetPath.");
    cachedWavPreset = pick;
    return pick;
  }

  async function exportWav(args, soloTrackIndex) {
    const out = tmpFile("wav");
    await host("export_audio", { outputPath: out, presetPath: await wavPreset(args), range: args.range || "entire", soloTrackIndex }, LONG_TIMEOUT);
    if (!(await waitForFile(out, 30000))) throw new Error("L'export audio n'a pas produit de fichier WAV.");
    return out;
  }

  async function analyzeAudioFile(args, soloTrackIndex, curveStepSeconds) {
    const file = await exportWav(args, soloTrackIndex);
    try { return analyzeWav(file, { curveStepSeconds }); } finally { safeUnlink(file); }
  }

  // ---------------------------------------------------------------- rythme
  async function analyze_rhythm(args) {
    const info = await sequenceInfo(args);
    let beats = null, musicNote;
    if (args.withMusic) {
      const { beats: b } = await analyzeAudioFile({ ...args, range: "entire" }, args.musicTrackIndex, 5);
      if (b && b.confidence >= 0.25) beats = b;
      else musicNote = "Pas de pulsation musicale nette détectée : calage sur le tempo non évalué.";
    }
    const r = analyzeRhythm(info, { windowSeconds: args.windowSeconds || 10, beats });
    if (musicNote) r.musicSync = { note: musicNote };
    return { content: [text(r)] };
  }

  // ---------------------------------------------------------------- couleur / exposition
  async function analyze_color(args) {
    const info = await sequenceInfo(args);
    const maxFrames = Math.min(60, Math.max(1, args.maxFrames || 24));
    const shots = visibleShots(info).filter((s) => !s.gap);
    let samples = [];
    if (args.mode === "times" && Array.isArray(args.times)) {
      samples = args.times.slice(0, maxFrames).map((t) => ({ t }));
    } else if (args.mode === "uniform" || !shots.length) {
      const d = info.durationSeconds;
      samples = Array.from({ length: maxFrames }, (_, i) => ({ t: ((i + 0.5) * d) / maxFrames }));
    } else {
      const pick = shots.length <= maxFrames ? shots.map((_, i) => i)
        : Array.from({ length: maxFrames }, (_, i) => Math.round((i * (shots.length - 1)) / (maxFrames - 1 || 1)));
      samples = [...new Set(pick)].map((i) => ({ t: (shots[i].start + shots[i].end) / 2 }));
    }
    for (const s of samples) {
      const idx = shots.findIndex((sh) => sh.start <= s.t && sh.end > s.t);
      if (idx >= 0) { s.shot = idx + 1; s.clip = shots[idx].name; }
    }

    const frames = [], thumbs = [], labels = [], errors = [];
    const thumbWidth = Math.min(480, Math.max(120, args.thumbWidth || 240));
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i], file = tmpFile("png");
      try {
        const r = await host("export_frame", { seconds: s.t, outputPath: file });
        if (!(await waitForFile(r.outputPath, 15000))) throw new Error("image non écrite");
        const img = png.decodePNG(fs.readFileSync(r.outputPath));
        const st = frameStats(img);
        frames.push({ index: i + 1, at: fmtTime(s.t), seconds: round(s.t, 2), shot: s.shot, clip: s.clip, stats: st });
        if (args.contactSheet !== false) { thumbs.push(png.resize(img, thumbWidth)); labels.push(String(i + 1)); }
        safeUnlink(r.outputPath);
      } catch (e) {
        errors.push({ at: fmtTime(s.t), error: e.message });
      } finally { safeUnlink(file); }
    }
    if (!frames.length) throw new Error(`Aucune image n'a pu être analysée : ${errors.map((e) => e.error).join(" ; ")}`);

    const summary = {
      sequence: info.name,
      framesAnalyzed: frames.length,
      legend: "luma 0-255 ; temperature > 0 = chaud, < 0 = froid ; tint > 0 = vert, < 0 = magenta ; numéros = vignettes de la planche contact",
      frames: frames.map((f) => ({
        image: f.index, at: f.at, shot: f.shot, clip: f.clip,
        luma: f.stats.luma.mean, contrast: f.stats.contrast, temperature: f.stats.whiteBalance.temperature, tint: f.stats.whiteBalance.tint,
        saturation: f.stats.saturationPercent, clippedPct: f.stats.highlightsClippedPercent, crushedPct: f.stats.shadowsCrushedPercent,
        notes: f.stats.notes,
      })),
      consistency: consistency(frames),
    };
    if (errors.length) summary.errors = errors;
    const content = [text(summary)];
    if (thumbs.length) {
      const sheet = png.contactSheet(thumbs, labels, Math.min(args.columns || 6, 8));
      content.push({ type: "image", data: png.encodePNG(sheet).toString("base64"), mimeType: "image/png" });
    }
    return { content };
  }

  // ---------------------------------------------------------------- audio
  async function analyze_audio(args) {
    const info = await sequenceInfo(args);
    const step = args.curveStepSeconds || 5;
    const mix = await analyzeAudioFile(args, undefined, step);
    const out = {
      sequence: info.name,
      range: args.range === "inout" ? "entrée → sortie (temps relatifs au point d'entrée)" : "séquence entière",
      mix: mix.result,
      targetCheck: recommendation(mix.result, args.target || "web"),
    };
    let tempoSource = { name: "mix", beats: mix.beats };

    if (args.perTrack) {
      const tracks = (info.audioTracks || []).filter((t) => t.clips.length);
      out.tracks = [];
      const curves = {};
      for (const t of tracks) {
        const r = await analyzeAudioFile(args, t.index, step);
        const label = `A${t.index + 1}${t.name && t.name !== `Audio ${t.index + 1}` ? ` (${t.name})` : ""}`;
        out.tracks.push({ track: label, integratedLUFS: r.result.integratedLUFS, loudnessRangeLU: r.result.loudnessRangeLU,
          samplePeakDBFS: r.result.samplePeakDBFS, clippedSamples: r.result.clippedSamples,
          tempoBPM: r.beats && r.beats.confidence >= 0.25 ? r.beats.bpm : null });
        curves[label] = r.result.loudnessCurve;
        if (r.beats && (!tempoSource.beats || r.beats.confidence > tempoSource.beats.confidence)) tempoSource = { name: label, beats: r.beats };
      }
      const labels = Object.keys(curves);
      out.levelsOverTime = (mix.result.loudnessCurve || []).map((w, i) => {
        const row = { from: w.from, mix: w.lufs };
        for (const l of labels) { const v = curves[l][i] && curves[l][i].lufs; row[l] = v !== null && v > -50 ? v : "silence"; }
        return row;
      });
      out.balanceHint = "Repère courant : la voix doit dominer la musique d'environ 10 à 20 dB quand elles se superposent.";
    }
    const b = tempoSource.beats;
    out.tempo = b && b.confidence >= 0.25
      ? { bpm: b.bpm, confidence: b.confidence, detectedOn: tempoSource.name, beats: b.times.length, firstBeats: b.times.slice(0, 8).map((t) => round(t, 2)) }
      : { note: "Pas de pulsation régulière nette (dialogue, ambiance ou musique libre)." };
    return { content: [text(out)] };
  }

  return { analyze_rhythm, analyze_color, analyze_audio };
}

module.exports = { createAnalyzers };
