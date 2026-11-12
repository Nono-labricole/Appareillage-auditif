// Mesures d'exposition et d'équilibre des couleurs sur des images RVB 8 bits, et cohérence entre plans.
"use strict";
const { round, median } = require("./stats");

function frameStats(img) {
  const { width, height, data } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 250000)));
  const hist = new Uint32Array(256);
  let n = 0, sr = 0, sg = 0, sb = 0, sat = 0, clipped = 0, crushed = 0;
  let nn = 0, nr = 0, ng = 0, nb = 0;
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const o = (y * width + x) * 3, r = data[o], g = data[o + 1], b = data[o + 2];
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0;
    hist[Math.min(255, Math.round(Y))]++;
    sr += r; sg += g; sb += b; sat += s; n++;
    if (mx >= 253) clipped++;
    if (Y <= 4) crushed++;
    // Pixels quasi neutres et bien exposés : servent à estimer la dominante (balance des blancs).
    if (s < 0.3 && Y > 35 && Y < 225) { nr += r; ng += g; nb += b; nn++; }
  }
  const pct = (p) => { let acc = 0; const target = p * n; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; } return 255; };
  const useNeutral = nn > n * 0.02;
  const cr = useNeutral ? nr / nn : sr / n, cg = useNeutral ? ng / nn : sg / n, cb = useNeutral ? nb / nn : sb / n;
  const lumaMean = (0.2126 * sr + 0.7152 * sg + 0.0722 * sb) / n;
  const temperature = cr - cb; // > 0 : chaud, < 0 : froid
  const tint = cg - (cr + cb) / 2; // > 0 : vert, < 0 : magenta
  const p2 = pct(0.02), p50 = pct(0.5), p98 = pct(0.98);

  const notes = [];
  if (lumaMean < 55) notes.push("sombre"); else if (lumaMean > 185) notes.push("très clair");
  if (clipped / n > 0.02) notes.push(`hautes lumières brûlées (${round((100 * clipped) / n, 1)} %)`);
  if (crushed / n > 0.05) notes.push(`noirs bouchés (${round((100 * crushed) / n, 1)} %)`);
  if (p98 - p2 < 120) notes.push("contraste faible / image plate");
  if (temperature > 12) notes.push("dominante chaude"); else if (temperature < -12) notes.push("dominante froide");
  if (tint > 8) notes.push("dominante verte"); else if (tint < -8) notes.push("dominante magenta");
  if (sat / n < 0.08) notes.push("très désaturé");

  return {
    luma: { mean: round(lumaMean, 1), p2, median: p50, p98 },
    contrast: p98 - p2,
    highlightsClippedPercent: round((100 * clipped) / n, 2),
    shadowsCrushedPercent: round((100 * crushed) / n, 2),
    saturationPercent: round((100 * sat) / n, 1),
    averageRGB: [round(sr / n, 1), round(sg / n, 1), round(sb / n, 1)],
    whiteBalance: { temperature: round(temperature, 1), tint: round(tint, 1), basedOn: useNeutral ? "zones neutres" : "image entière" },
    notes,
  };
}

/** Compare les images entre elles : écarts à la médiane et sauts brusques entre plans consécutifs. */
function consistency(frames) {
  const key = { luma: (f) => f.stats.luma.mean, temp: (f) => f.stats.whiteBalance.temperature, tint: (f) => f.stats.whiteBalance.tint, sat: (f) => f.stats.saturationPercent };
  const med = Object.fromEntries(Object.entries(key).map(([k, fn]) => [k, median(frames.map(fn))]));
  const limits = { luma: 22, temp: 9, tint: 6, sat: 12 };
  const words = { luma: ["plus clair", "plus sombre"], temp: ["plus chaud", "plus froid"], tint: ["plus vert", "plus magenta"], sat: ["plus saturé", "moins saturé"] };

  const outliers = [];
  for (const f of frames) {
    const diffs = [];
    for (const k of Object.keys(key)) {
      const d = key[k](f) - med[k];
      if (Math.abs(d) > limits[k]) diffs.push(`${d > 0 ? words[k][0] : words[k][1]} (${d > 0 ? "+" : ""}${round(d, 1)})`);
    }
    if (diffs.length) outliers.push({ image: f.index, at: f.at, shot: f.shot, differsFromRest: diffs });
  }

  const jumps = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (a.shot && b.shot && a.shot === b.shot) continue;
    const diffs = [];
    for (const k of Object.keys(key)) {
      const d = key[k](b) - key[k](a);
      if (Math.abs(d) > limits[k] * 1.2) diffs.push(`${d > 0 ? words[k][0] : words[k][1]} (${d > 0 ? "+" : ""}${round(d, 1)})`);
    }
    if (diffs.length) jumps.push({ between: [a.index, b.index], at: b.at, secondImageIs: diffs });
  }

  return {
    medians: { luma: round(med.luma, 1), temperature: round(med.temp, 1), tint: round(med.tint, 1), saturationPercent: round(med.sat, 1) },
    thresholds: limits,
    outliers,
    abruptChangesBetweenShots: jumps,
  };
}

module.exports = { frameStats, consistency };
