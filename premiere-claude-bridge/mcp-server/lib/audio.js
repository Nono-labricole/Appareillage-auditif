// Analyse audio d'un fichier WAV en flux (mémoire constante) :
// loudness EBU R128 / BS.1770 (intégrée, court terme, LRA), crêtes, saturation, équilibre G/D, silences, tempo et temps forts.
"use strict";
const fs = require("fs");
const { round, mean, percentile, fmtTime } = require("./stats");

// ------------------------------------------------------------------ lecture WAV
function readHeader(fd, fileSize) {
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  const riff = head.toString("ascii", 0, 4);
  if ((riff !== "RIFF" && riff !== "RF64") || head.toString("ascii", 8, 12) !== "WAVE") throw new Error("Ce n'est pas un fichier WAV");
  let pos = 12, fmt = null, ds64DataSize = null;
  const hdr = Buffer.alloc(8);
  while (pos + 8 <= fileSize) {
    fs.readSync(fd, hdr, 0, 8, pos);
    const id = hdr.toString("ascii", 0, 4), size = hdr.readUInt32LE(4);
    if (id === "ds64") {
      const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, pos + 8);
      ds64DataSize = Number(b.readBigUInt64LE(8));
    } else if (id === "fmt ") {
      const b = Buffer.alloc(Math.min(size, 40)); fs.readSync(fd, b, 0, b.length, pos + 8);
      let format = b.readUInt16LE(0);
      if (format === 0xfffe && b.length >= 26) format = b.readUInt16LE(24);
      fmt = { format, channels: b.readUInt16LE(2), sampleRate: b.readUInt32LE(4), blockAlign: b.readUInt16LE(12), bits: b.readUInt16LE(14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV sans bloc fmt");
      let dataSize = size === 0xffffffff && ds64DataSize !== null ? ds64DataSize : size;
      dataSize = Math.min(dataSize, fileSize - pos - 8);
      return { ...fmt, dataOffset: pos + 8, dataSize };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error("WAV sans données audio");
}

function sampleReader(fmt) {
  const { format, bits } = fmt;
  if (format === 3 && bits === 32) return (b, o) => b.readFloatLE(o);
  if (format === 3 && bits === 64) return (b, o) => b.readDoubleLE(o);
  if (format === 1 && bits === 16) return (b, o) => b.readInt16LE(o) / 32768;
  if (format === 1 && bits === 24) return (b, o) => b.readIntLE(o, 3) / 8388608;
  if (format === 1 && bits === 32) return (b, o) => b.readInt32LE(o) / 2147483648;
  if (format === 1 && bits === 8) return (b, o) => (b[o] - 128) / 128;
  throw new Error(`Format WAV non pris en charge (format ${format}, ${bits} bits)`);
}

// ------------------------------------------------------------------ filtres K (BS.1770) pour toute fréquence
function kWeightingCoefs(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416, a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan((Math.PI * f0) / fs);
  const d = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / d, a2: (1 - K / Q + K * K) / d };
  return [shelf, hp];
}

function biquad(c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

// ------------------------------------------------------------------ FFT pour la détection d'attaques
function makeFFT(N) {
  const levels = Math.log2(N), rev = new Uint32Array(N), cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < levels; b++) r = (r << 1) | ((i >> b) & 1); rev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / N); sin[i] = Math.sin((2 * Math.PI * i) / N); }
  return (re, im) => {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) for (let j = i, k = 0; j < i + half; j++, k += step) {
        const tr = re[j + half] * cos[k] + im[j + half] * sin[k], ti = -re[j + half] * sin[k] + im[j + half] * cos[k];
        re[j + half] = re[j] - tr; im[j + half] = im[j] - ti; re[j] += tr; im[j] += ti;
      }
    }
  };
}

function onsetDetector(N = 512, H = 128) {
  const fft = makeFFT(N), win = new Float64Array(N), buf = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(N / 2), filled = 0, sinceHop = 0, w = 0;
  const env = [];
  return {
    push(x) {
      buf[w] = x; w = (w + 1) % N;
      if (filled < N) filled++;
      if (++sinceHop < H || filled < N) return;
      sinceHop = 0;
      for (let i = 0; i < N; i++) { re[i] = buf[(w + i) % N] * win[i]; im[i] = 0; }
      fft(re, im);
      let flux = 0;
      const cur = new Float64Array(N / 2);
      for (let k = 1; k < N / 2; k++) {
        cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
        const d = cur[k] - prev[k]; if (d > 0) flux += d;
      }
      prev = cur;
      env.push(flux);
    },
    env, hop: H, size: N,
  };
}

// ------------------------------------------------------------------ tempo et temps forts (Ellis 2007)
function tempoAndBeats(env, frameRate, offsetSeconds) {
  const n = env.length;
  if (n < frameRate * 8) return null;
  const w = Math.max(1, Math.round(frameRate * 0.5));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1);
    e[i] = Math.max(0, env[i] - (prefix[hi] - prefix[lo]) / (hi - lo));
  }
  const sd = Math.sqrt(mean(Array.from(e, (v) => v * v))) || 1;
  for (let i = 0; i < n; i++) e[i] /= sd;

  const lagMin = Math.floor((frameRate * 60) / 200), lagMax = Math.ceil((frameRate * 60) / 55);
  const acf = new Float64Array(lagMax + 2);
  for (let l = 0; l <= lagMax + 1; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += e[i] * e[i + l]; acf[l] = s / (n - l); }
  let best = -1, bestScore = -Infinity;
  for (let l = lagMin; l <= lagMax; l++) {
    const bpm = (60 * frameRate) / l, weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const s = acf[l] * weight;
    if (s > bestScore) { bestScore = s; best = l; }
  }
  const a = acf[best - 1], b = acf[best], c = acf[best + 1], denom = a - 2 * b + c;
  const lag = best + (denom ? (0.5 * (a - c)) / denom : 0);
  const bpm = (60 * frameRate) / lag;
  const range = Array.from(acf.slice(lagMin, lagMax + 1));
  const confidence = Math.max(0, Math.min(1, (b - mean(range)) / (Math.max(...range) - Math.min(...range) || 1)));
  const strength = b / (acf[0] || 1);

  const period = lag, alpha = 400;
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let bv = -Infinity, bp = -1;
    for (let p = Math.max(0, t - Math.round(2 * period)); p <= t - Math.round(period / 2); p++) {
      const v = score[p] - alpha * Math.log((t - p) / period) ** 2;
      if (v > bv) { bv = v; bp = p; }
    }
    score[t] = e[t] + (bp >= 0 ? Math.max(0, bv) : 0);
    back[t] = bv > 0 ? bp : -1;
  }
  let t = n - 1, bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > bestEnd) { bestEnd = score[i]; t = i; }
  const frames = [];
  while (t >= 0) { frames.push(t); t = back[t]; }
  const times = frames.reverse().map((f) => f / frameRate + offsetSeconds);
  return { bpm: round(bpm, 1), confidence: round(confidence * Math.min(1, strength * 4), 2), times };
}

// ------------------------------------------------------------------ analyse principale
function analyzeWav(file, { curveStepSeconds = 5 } = {}) {
  const fd = fs.openSync(file, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const fmt = readHeader(fd, fileSize);
    const read = sampleReader(fmt), C = fmt.channels, sr = fmt.sampleRate, bytes = fmt.bits / 8;
    const weights = Array.from({ length: C }, (_, ch) => (C === 6 ? [1, 1, 1, 0, 1.41, 1.41][ch] : 1));
    const filters = Array.from({ length: C }, () => kWeightingCoefs(sr).map(biquad));
    const bucketLen = Math.round(sr / 10);
    const ms = Array.from({ length: C }, () => []), kAcc = new Float64Array(C);
    const peak = new Float64Array(C), sumSq = new Float64Array(C), clips = new Float64Array(C);
    let sumLR = 0, inBucket = 0, frames = 0;

    const D = Math.max(1, Math.floor(sr / 11000)), fsd = sr / D, onset = onsetDetector();
    let dAcc = 0, dCount = 0;

    const CHUNK = fmt.blockAlign * 16384, buf = Buffer.alloc(CHUNK);
    let remaining = fmt.dataSize - (fmt.dataSize % fmt.blockAlign), pos = fmt.dataOffset;
    while (remaining > 0) {
      const len = fs.readSync(fd, buf, 0, Math.min(CHUNK, remaining), pos);
      if (len <= 0) break;
      pos += len; remaining -= len;
      for (let o = 0; o + fmt.blockAlign <= len; o += fmt.blockAlign) {
        let mono = 0, l = 0, r = 0;
        for (let ch = 0; ch < C; ch++) {
          const x = read(buf, o + ch * bytes), ax = Math.abs(x);
          if (ax > peak[ch]) peak[ch] = ax;
          if (ax >= 0.999) clips[ch]++;
          sumSq[ch] += x * x;
          const k = filters[ch][1](filters[ch][0](x));
          kAcc[ch] += k * k;
          mono += x;
          if (ch === 0) l = x; else if (ch === 1) r = x;
        }
        sumLR += l * r;
        if (++inBucket === bucketLen) {
          for (let ch = 0; ch < C; ch++) { ms[ch].push(kAcc[ch] / bucketLen); kAcc[ch] = 0; }
          inBucket = 0;
        }
        dAcc += mono / C;
        if (++dCount === D) { onset.push(dAcc / D); dAcc = 0; dCount = 0; }
        frames++;
      }
    }
    const duration = frames / sr;
    const nb = ms[0].length;
    const power = (from, to) => {
      let p = 0;
      for (let ch = 0; ch < C; ch++) { let s = 0; for (let i = from; i < to; i++) s += ms[ch][i]; p += weights[ch] * (s / (to - from)); }
      return p;
    };
    const lufs = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);

    // Intégrée (blocs de 400 ms, recouvrement 75 %, double porte -70 LUFS / -10 LU)
    const blocks = [];
    for (let j = 4; j <= nb; j++) blocks.push(power(j - 4, j));
    const absGated = blocks.filter((p) => lufs(p) > -70);
    const relGate = lufs(mean(absGated)) - 10;
    const integrated = lufs(mean(absGated.filter((p) => lufs(p) > relGate)));

    // Court terme (3 s) toutes les 100 ms, LRA (EBU 3342)
    const st = [];
    for (let j = 30; j <= nb; j++) st.push({ t: j / 10, l: lufs(power(j - 30, j)) });
    const stAbs = st.map((s) => s.l).filter((l) => l > -70);
    const stRel = lufs(mean(stAbs.map((l) => 10 ** ((l + 0.691) / 10)))) - 20;
    const stGated = stAbs.filter((l) => l > stRel);
    const lra = stGated.length ? percentile(stGated, 0.95) - percentile(stGated, 0.1) : 0;

    const curve = [];
    for (let t = curveStepSeconds; t <= duration + 0.01; t += curveStepSeconds) {
      const from = Math.max(0, Math.round((t - curveStepSeconds) * 10)), to = Math.min(nb, Math.round(t * 10));
      if (to > from) curve.push({ from: fmtTime(t - curveStepSeconds), lufs: round(lufs(power(from, to)), 1) });
    }

    // Silences (momentané < -50 LUFS pendant au moins 1 s)
    const silences = [];
    let runStart = null;
    for (let j = 4; j <= nb + 1; j++) {
      const silent = j <= nb && lufs(power(j - 4, j)) < -50;
      if (silent && runStart === null) runStart = (j - 4) / 10;
      if (!silent && runStart !== null) {
        const end = (j - 1) / 10;
        if (end - runStart >= 1) silences.push({ from: fmtTime(runStart), to: fmtTime(end), seconds: round(end - runStart, 1) });
        runStart = null;
      }
    }

    const loudest = st.reduce((a, b) => (b.l > a.l ? b : a), { l: -Infinity, t: 0 });
    const audible = st.filter((s) => s.l > -50);
    const quietest = audible.reduce((a, b) => (b.l < a.l ? b : a), { l: Infinity, t: 0 });
    const db = (v) => (v > 0 ? round(20 * Math.log10(v), 1) : -Infinity);
    const maxPeak = Math.max(...peak);

    const result = {
      durationSeconds: round(duration, 2), sampleRate: sr, channels: C,
      integratedLUFS: round(integrated, 1),
      loudnessRangeLU: round(lra, 1),
      samplePeakDBFS: db(maxPeak),
      peakPerChannelDBFS: Array.from(peak, db),
      clippedSamples: Array.from(clips).reduce((a, b) => a + b, 0),
      loudestMoment: isFinite(loudest.l) ? { around: fmtTime(Math.max(0, loudest.t - 1.5)), shortTermLUFS: round(loudest.l, 1) } : null,
      quietestAudibleMoment: isFinite(quietest.l) ? { around: fmtTime(Math.max(0, quietest.t - 1.5)), shortTermLUFS: round(quietest.l, 1) } : null,
      loudnessCurve: curve,
      silences: silences.slice(0, 30),
    };
    if (C >= 2) {
      const rmsL = Math.sqrt(sumSq[0] / frames), rmsR = Math.sqrt(sumSq[1] / frames);
      result.stereo = {
        balanceDB: rmsL && rmsR ? round(20 * Math.log10(rmsL / rmsR), 1) : null,
        balanceNote: "> 0 : penche à gauche, < 0 : penche à droite",
        correlation: round(sumLR / frames / ((rmsL * rmsR) || 1), 2),
        correlationNote: "1 = mono, ~0 = stéréo large, < 0 = problème de phase",
      };
    }
    const frameRate = fsd / onset.hop;
    const beats = tempoAndBeats(onset.env, frameRate, onset.size / 2 / fsd);
    return { result, beats };
  } finally {
    fs.closeSync(fd);
  }
}

const TARGETS = {
  web: { lufs: -14, peak: -1, label: "YouTube / réseaux sociaux" },
  podcast: { lufs: -16, peak: -1, label: "podcast / mobile" },
  broadcast: { lufs: -23, peak: -1, label: "télévision EBU R128" },
  cinema: { lufs: -27, peak: -1, label: "cinéma / dialogue (indicatif)" },
};

function recommendation(r, targetName) {
  const t = TARGETS[targetName] || TARGETS.web;
  if (!isFinite(r.integratedLUFS)) return { target: t.label, note: "Pas de son mesurable." };
  const gain = round(t.lufs - r.integratedLUFS, 1);
  const peakAfter = round(r.samplePeakDBFS + gain, 1);
  return {
    target: `${t.label} : ${t.lufs} LUFS, crête ≤ ${t.peak} dBFS`,
    gainNeededDB: gain,
    peakAfterGainDBFS: peakAfter,
    limiterNeeded: peakAfter > t.peak,
    verdict: Math.abs(gain) <= 1 ? "niveau conforme" : gain > 0 ? `trop faible de ${gain} dB` : `trop fort de ${-gain} dB`,
  };
}

module.exports = { analyzeWav, recommendation, TARGETS };
