// Analyse du rythme de montage à partir de la timeline (plans visibles, cadence, plans flash, calage sur le tempo).
"use strict";
const { round, mean, median, stdev, percentile, fmtTime } = require("./stats");

/**
 * Plans réellement visibles : à chaque instant, le clip actif de la piste vidéo la plus haute.
 * Les coupes "invisibles" (même média, continuité de source) sont fusionnées.
 */
function visibleShots(info) {
  const fps = info.fps || 25, eps = 0.5 / fps;
  const tracks = (info.videoTracks || []).filter((t) => !t.muted);
  const points = new Set([0, info.durationSeconds]);
  for (const t of tracks) for (const c of t.clips) if (!c.disabled) { points.add(c.start); points.add(c.end); }
  const sorted = [...points].filter((p) => p >= 0 && p <= info.durationSeconds).sort((a, b) => a - b);
  const bounds = sorted.filter((p, i) => i === 0 || p - sorted[i - 1] > eps);

  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1], mid = (a + b) / 2;
    let found = null;
    for (let ti = tracks.length - 1; ti >= 0 && !found; ti--) {
      const c = tracks[ti].clips.find((cl) => !cl.disabled && cl.start <= mid && cl.end > mid);
      if (c) found = { track: tracks[ti].index, clip: c };
    }
    const seg = { start: a, end: b, gap: !found };
    if (found) Object.assign(seg, {
      track: found.track, clipIndex: found.clip.index, name: found.clip.name, nodeId: found.clip.projectItemNodeId,
      srcStart: found.clip.inPoint + (a - found.clip.start), srcEnd: found.clip.inPoint + (b - found.clip.start),
    });
    segs.push(seg);
  }

  const shots = [];
  for (const s of segs) {
    const last = shots[shots.length - 1];
    const continuous = last && !s.gap && !last.gap && (
      (last.track === s.track && last.clipIndex === s.clipIndex) ||
      (last.nodeId && last.nodeId === s.nodeId && Math.abs(last.srcEnd - s.srcStart) <= eps * 2));
    const bothGaps = last && s.gap && last.gap;
    if (continuous || bothGaps) { last.end = s.end; last.srcEnd = s.srcEnd; }
    else shots.push({ ...s });
  }
  return shots.map((s) => ({ ...s, duration: s.end - s.start }));
}

function paceLabel(asl) {
  if (!isFinite(asl)) return "—";
  if (asl < 1.5) return "très rapide";
  if (asl < 3) return "rapide";
  if (asl < 6) return "modéré";
  if (asl < 12) return "lent";
  return "très lent";
}

function analyzeRhythm(info, { windowSeconds = 10, beats = null } = {}) {
  const fps = info.fps || 25;
  const all = visibleShots(info);
  const shots = all.filter((s) => !s.gap);
  const durs = shots.map((s) => s.duration);
  const total = info.durationSeconds;
  const cuts = shots.slice(1).map((s) => s.start);
  const asl = mean(durs);

  const windows = [];
  for (let t = 0; t < total; t += windowSeconds) {
    const end = Math.min(total, t + windowSeconds);
    const inWin = shots.filter((s) => s.end > t && s.start < end);
    const nCuts = cuts.filter((c) => c >= t && c < end).length;
    const winAsl = inWin.length ? (end - t) / Math.max(1, nCuts + 1) : NaN;
    windows.push({ from: fmtTime(t), to: fmtTime(end), cuts: nCuts, avgShotSeconds: round(winAsl, 1), pace: inWin.length ? paceLabel(winAsl) : "vide" });
  }

  const half = total / 2;
  const aslFirst = mean(shots.filter((s) => s.start < half).map((s) => s.duration));
  const aslSecond = mean(shots.filter((s) => s.start >= half).map((s) => s.duration));
  const med = median(durs);

  const fmtShot = (s, i) => ({ shot: i + 1, at: fmtTime(s.start), seconds: round(s.duration, 2), frames: Math.round(s.duration * fps), clip: s.name, track: `V${s.track + 1}` });
  const indexed = shots.map((s, i) => ({ s, i }));

  const result = {
    sequence: info.name,
    durationSeconds: round(total, 2),
    fps,
    shotCount: shots.length,
    cutsPerMinute: round(cuts.length / (total / 60), 1),
    averageShotSeconds: round(asl, 2),
    medianShotSeconds: round(med, 2),
    shortestShotSeconds: round(Math.min(...durs), 2),
    longestShotSeconds: round(Math.max(...durs), 2),
    variability: round(stdev(durs) / asl, 2),
    overallPace: paceLabel(asl),
    trend: !isFinite(aslFirst) || !isFinite(aslSecond) ? null
      : aslSecond < aslFirst * 0.8 ? `accélère (plan moyen ${round(aslFirst, 1)} s → ${round(aslSecond, 1)} s)`
      : aslSecond > aslFirst * 1.25 ? `ralentit (plan moyen ${round(aslFirst, 1)} s → ${round(aslSecond, 1)} s)` : "stable",
    paceByWindow: windows,
    flashFrames: indexed.filter(({ s }) => s.duration * fps <= 3).map(({ s, i }) => fmtShot(s, i)),
    veryShortShots: indexed.filter(({ s }) => s.duration * fps > 3 && s.duration < Math.min(0.6, med / 3)).map(({ s, i }) => fmtShot(s, i)),
    longShots: indexed.filter(({ s }) => s.duration > Math.max(8, med * 3)).map(({ s, i }) => fmtShot(s, i)),
    gaps: all.filter((s) => s.gap && s.duration > 0.5 / fps && s.end < total - 0.5 / fps).map((s) => ({ at: fmtTime(s.start), seconds: round(s.duration, 2) })),
    shots: shots.map(fmtShot),
  };

  if (beats && beats.times && beats.times.length > 1 && cuts.length) {
    const tol = Math.max(2 / fps, 0.06);
    const offsets = cuts.map((c) => {
      let best = Infinity;
      for (const b of beats.times) { const d = c - b; if (Math.abs(d) < Math.abs(best)) best = d; }
      return best;
    });
    const onBeat = offsets.filter((o) => Math.abs(o) <= tol).length;
    const beatPeriod = 60 / beats.bpm;
    result.musicSync = {
      bpm: beats.bpm,
      tempoConfidence: beats.confidence,
      cutsOnBeat: onBeat,
      cutsOnBeatPercent: round((100 * onBeat) / cuts.length, 0),
      toleranceMs: Math.round(tol * 1000),
      medianOffsetMs: Math.round(median(offsets.map((o) => Math.abs(o))) * 1000),
      averageShotInBeats: round(asl / beatPeriod, 2),
      offBeatCuts: cuts.map((c, i) => ({ cut: i + 1, at: fmtTime(c), offsetMs: Math.round(offsets[i] * 1000) }))
        .filter((c) => Math.abs(c.offsetMs) > tol * 1000 && Math.abs(c.offsetMs) < beatPeriod * 500).slice(0, 40),
      note: "offsetMs > 0 : la coupe arrive après le temps ; < 0 : avant.",
    };
  }
  if (result.shots.length > 150) { result.shots = result.shots.slice(0, 150); result.shotsTruncated = true; }
  return result;
}

module.exports = { visibleShots, analyzeRhythm, percentile };
