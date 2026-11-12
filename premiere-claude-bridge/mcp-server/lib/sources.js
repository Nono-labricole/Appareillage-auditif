// Accès aux sources : fiche d'un rush, aperçu (planche contact + analyses) et fichiers du projet.
// L'accès disque est limité au dossier du projet et aux dossiers contenant ses médias.
"use strict";
const fs = require("fs");
const path = require("path");
const png = require("./png");

const TEXT_EXT = new Set([".txt", ".srt", ".vtt", ".ass", ".ssa", ".sbv", ".md", ".csv", ".tsv", ".json", ".xml", ".edl",
  ".fcpxml", ".ale", ".log", ".cue", ".html", ".htm", ".rtf", ".yaml", ".yml", ".ini", ".lut", ".cube"]);
const BINARY_EXT = new Set([".mp4", ".mov", ".mxf", ".avi", ".mkv", ".m4v", ".mts", ".m2ts", ".braw", ".r3d", ".ari", ".dng", ".wav",
  ".mp3", ".aif", ".aiff", ".m4a", ".aac", ".flac", ".ogg", ".prproj", ".psd", ".ai", ".tif", ".tiff", ".exr", ".heic", ".pdf", ".zip", ".mogrt", ".aep"]);
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

const text = (obj) => ({ type: "text", text: JSON.stringify(obj, null, 2) });

function parseProjectMetadata(xml) {
  const out = {};
  if (!xml) return out;
  const re = /<[\w]*:?Column\.([\w.]+)>([^<]*)<\//g;
  let m;
  while ((m = re.exec(xml))) {
    const key = m[1].replace(/^(Intrinsic|PropertyText|PropertyBool|PropertyNumber)\./, "");
    if (m[2].trim()) out[key] = m[2].trim();
  }
  return out;
}

function parseXMP(xml) {
  const out = {};
  if (!xml) return out;
  const skip = /^(?:(?:stEvt|stRef|xmpMM|rdf|x|xml|creatorAtom):|photoshop:DocumentAncestors)/;
  const put = (k, v) => { v = String(v).trim(); if (v && !skip.test(k) && !(k in out) && Object.keys(out).length < 60 && v.length < 500) out[k] = v; };
  let m;
  const attr = /\s([\w]+:[\w]+)="([^"]*)"/g;
  while ((m = attr.exec(xml))) put(m[1], m[2]);
  const elem = /<([\w]+:[\w]+)>([^<]+)<\/\1>/g;
  while ((m = elem.exec(xml))) put(m[1], m[2]);
  const alt = /<([\w]+:[\w]+)>\s*<rdf:(?:Alt|Seq|Bag)>\s*<rdf:li[^>]*>([^<]*)<\/rdf:li>/g;
  while ((m = alt.exec(xml))) put(m[1], m[2]);
  return out;
}

const norm = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch (e) { /* inexistant */ }
  return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
};

function createSources({ host, analyzers, extraRoots = [] }) {
  async function allowedRoots() {
    const { projectPath, mediaPaths } = await host("list_media_paths");
    const roots = new Set();
    if (projectPath) roots.add(path.dirname(projectPath));
    for (const m of mediaPaths) roots.add(path.dirname(m));
    for (const r of extraRoots) roots.add(r);
    return { projectDir: projectPath ? path.dirname(projectPath) : null, roots: [...roots] };
  }

  async function checkAllowed(p) {
    const { roots, projectDir } = await allowedRoots();
    const target = norm(p);
    const ok = roots.some((r) => { const n = norm(r); return target === n || target.startsWith(n.endsWith(path.sep) ? n : n + path.sep); });
    if (!ok) throw new Error(`Accès refusé : ${p} n'est ni dans le dossier du projet ni dans un dossier de médias du projet. ` +
      `Dossiers autorisés : ${roots.join(" ; ")}`);
    return { roots, projectDir };
  }

  // ---------------------------------------------------------------- fiche d'un rush
  async function get_source_info(args) {
    const d = await host("get_source_info", { item: args.item });
    const meta = parseProjectMetadata(d.projectMetadata);
    const xmp = parseXMP(d.xmpMetadata);
    delete d.projectMetadata; delete d.xmpMetadata;
    if (d.mediaPath) {
      try {
        const st = fs.statSync(d.mediaPath);
        d.file = { exists: true, sizeMB: Math.round(st.size / 10485.76) / 100, modified: st.mtime.toISOString() };
      } catch (e) { d.file = { exists: false }; }
    }
    d.premiereMetadata = meta;
    if (Object.keys(xmp).length) d.fileMetadata = xmp;
    return { content: [text(d)] };
  }

  // ---------------------------------------------------------------- aperçu d'un rush
  async function preview_source(args) {
    const tmp = await host("create_temp_sequence", { item: args.item });
    try {
      const dur = tmp.durationSeconds;
      const from = Math.max(0, args.fromSeconds || 0), to = Math.min(dur, args.toSeconds || dur);
      if (!(to > from)) throw new Error(`Plage invalide (le rush dure ${dur} s).`);
      const n = Math.min(60, Math.max(1, args.maxFrames || 12));
      const times = Array.from({ length: n }, (_, i) => from + ((i + 0.5) * (to - from)) / n);
      const content = [];
      const header = { source: args.item, durationSeconds: dur, note: "Les temps sont comptés depuis le début du rush (ou de son point d'entrée s'il est marqué)." };
      try {
        const color = await analyzers.analyze_color({ sequenceId: tmp.sequenceId, mode: "times", times, maxFrames: n, columns: args.columns || 4, thumbWidth: args.thumbWidth || 320 });
        const summary = JSON.parse(color.content[0].text);
        delete summary.sequence;
        content.push(text({ ...header, image: summary }), ...color.content.slice(1));
      } catch (e) {
        content.push(text({ ...header, image: `pas d'image analysable (${e.message})` }));
      }
      if (args.analyzeAudio) {
        try {
          const audio = await analyzers.analyze_audio({ sequenceId: tmp.sequenceId, target: args.target, presetPath: args.presetPath, curveStepSeconds: args.curveStepSeconds });
          const a = JSON.parse(audio.content[0].text);
          delete a.sequence; delete a.range;
          content.push(text({ audio: a }));
        } catch (e) {
          content.push(text({ audio: `pas de son analysable (${e.message})` }));
        }
      }
      return { content };
    } finally {
      await host("delete_temp_sequence", { sequenceId: tmp.sequenceId, previousSequenceId: tmp.previousSequenceId }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- fichiers
  async function list_files(args) {
    const { roots, projectDir } = args.path ? await checkAllowed(args.path) : await allowedRoots();
    const dir = args.path || projectDir;
    if (!dir) throw new Error("Le projet n'a pas encore de dossier (enregistrez-le).");
    const max = Math.min(2000, args.maxEntries || 300), depthMax = args.recursive ? 4 : 0, entries = [];
    (function walk(d, depth) {
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of list) {
        if (entries.length >= max) return;
        if (e.name.startsWith(".")) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          entries.push({ path: full, type: "dossier" });
          if (depth < depthMax) walk(full, depth + 1);
        } else if (e.isFile()) {
          let st = null; try { st = fs.statSync(full); } catch (err) { /* ignoré */ }
          entries.push({ path: full, type: "fichier", sizeKB: st ? Math.round(st.size / 1024) : null, modified: st ? st.mtime.toISOString().slice(0, 16) : null });
        }
      }
    })(dir, 0);
    return { content: [text({ folder: dir, allowedRoots: roots, entries, truncated: entries.length >= max })] };
  }

  async function read_file(args) {
    if (!args.path) throw new Error('"path" requis.');
    await checkAllowed(args.path);
    const st = fs.statSync(args.path);
    if (!st.isFile()) throw new Error("Ce n'est pas un fichier.");
    const ext = path.extname(args.path).toLowerCase();

    if (IMAGE_MIME[ext]) {
      let data = fs.readFileSync(args.path), mime = IMAGE_MIME[ext];
      if (data.length > MAX_IMAGE_BYTES) {
        if (ext !== ".png") throw new Error(`Image trop lourde (${Math.round(data.length / 1048576)} Mo) pour être transmise ; utilisez import_files puis preview_source.`);
        const img = png.decodePNG(data);
        data = png.encodePNG(img.width > 1600 ? png.resize(img, 1600) : img);
        if (data.length > MAX_IMAGE_BYTES) data = png.encodePNG(png.resize(img, 900));
      }
      return { content: [text({ path: args.path, sizeKB: Math.round(st.size / 1024) }), { type: "image", data: data.toString("base64"), mimeType: mime }] };
    }

    const maxBytes = Math.min(1024 * 1024, args.maxBytes || 100 * 1024);
    const fd = fs.openSync(args.path, "r");
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const looksText = TEXT_EXT.has(ext) || (!BINARY_EXT.has(ext) && !buf.subarray(0, 8192).includes(0));
    if (!looksText) {
      return { content: [text({ path: args.path, sizeMB: Math.round(st.size / 10485.76) / 100, binary: true,
        hint: "Fichier binaire (vidéo, audio…) : s'il est dans le projet, utilisez get_source_info ou preview_source ; sinon import_files d'abord." })] };
    }
    let content = buf.toString("utf8");
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    const truncated = st.size > buf.length;
    return { content: [{ type: "text", text: `Fichier : ${args.path}${truncated ? ` (tronqué à ${buf.length} octets sur ${st.size})` : ""}\n\n${content}` }] };
  }

  return { get_source_info, preview_source, list_files, read_file };
}

module.exports = { createSources, parseProjectMetadata, parseXMP };
