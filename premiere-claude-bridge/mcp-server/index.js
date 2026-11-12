#!/usr/bin/env node
/*
 * Serveur MCP local (stdio) pour piloter Premiere Pro via le panneau "Claude Bridge".
 * Aucune dépendance externe, aucune connexion réseau hors 127.0.0.1.
 * Node.js 18+ requis.
 */
"use strict";

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { createAnalyzers } = require("./lib/analyzers");

const SERVER_INFO = { name: "premiere-claude-bridge", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CONFIG_FILE = process.env.PREMIERE_BRIDGE_CONFIG ||
  path.join(os.homedir(), ".premiere-claude-bridge", "bridge.json");
const ALLOW_SCRIPT = process.env.PREMIERE_BRIDGE_DISABLE_SCRIPT !== "1";
const CALL_TIMEOUT_MS = Number(process.env.PREMIERE_BRIDGE_TIMEOUT_MS || 120000);
const AUTO_CHECKPOINT = process.env.PREMIERE_BRIDGE_AUTO_CHECKPOINT !== "0";
const MAX_CHECKPOINTS = Math.max(1, Number(process.env.PREMIERE_BRIDGE_MAX_CHECKPOINTS || 30));
const CHECKPOINT_ROOT = path.join(path.dirname(CONFIG_FILE), "checkpoints");

// Outils qui modifient le projet : un point de restauration est créé juste avant.
const MUTATING = new Set([
  "import_files", "create_bin", "rename_item", "create_sequence", "create_sequence_from_clips", "set_in_out",
  "insert_clip", "remove_clip", "move_clip", "set_clip_timing", "set_clip_enabled", "razor",
  "set_clip_effect_property", "add_effect", "add_transition", "add_marker", "execute_extendscript",
]);

// ------------------------------------------------------------------ outils
const S = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const seqArgs = {
  sequenceId: { type: "string", description: "ID de séquence (par défaut : séquence active)" },
  sequenceName: { type: "string", description: "Nom de séquence (alternative à sequenceId)" },
};
const clipArgs = {
  ...seqArgs,
  trackType: { type: "string", enum: ["video", "audio"], description: "Type de piste (défaut : video)" },
  trackIndex: { type: "integer", minimum: 0, description: "Index de piste, 0 = V1/A1" },
  clipIndex: { type: "integer", minimum: 0, description: "Index du clip sur la piste (voir get_sequence_info)" },
};
const itemRef = { type: "string", description: "Élément du projet : nodeId, chemin 'Chutier/Sous/nom' ou nom" };

const TOOLS = [
  ["ping", "Vérifie que Premiere Pro et le panneau Claude Bridge répondent.", S({})],
  ["get_project_info", "Infos du projet ouvert : nom, chemin, séquences, séquence active.", S({})],
  ["list_project_items", "Liste les éléments du panneau Projet (chutiers, clips, séquences).", S({
    binPath: { type: "string", description: "Chutier de départ, ex. 'Rushes/Jour1' (défaut : racine)" },
    recursive: { type: "boolean", description: "Parcourir les sous-chutiers (défaut : true)" },
    maxItems: { type: "integer", description: "Limite (défaut : 500)" },
  })],
  ["import_files", "Importe des fichiers médias (chemins absolus) dans le projet.", S({
    paths: { type: "array", items: { type: "string" } },
    binPath: { type: "string", description: "Chutier cible (créé si absent)" },
    asNumberedStills: { type: "boolean" },
  }, ["paths"])],
  ["create_bin", "Crée un chutier.", S({ name: { type: "string" }, parentPath: { type: "string" } }, ["name"])],
  ["rename_item", "Renomme un élément du projet.", S({ item: itemRef, newName: { type: "string" } }, ["item", "newName"])],
  ["list_sequences", "Liste les séquences du projet.", S({})],
  ["set_active_sequence", "Ouvre une séquence dans la timeline.", S(seqArgs)],
  ["create_sequence", "Crée une séquence vide. Avec presetPath (.sqpreset) pas de boîte de dialogue.", S({
    name: { type: "string" }, presetPath: { type: "string", description: "Chemin d'un préréglage .sqpreset" },
  })],
  ["create_sequence_from_clips", "Crée une séquence à partir de clips du projet (réglages du premier clip).", S({
    name: { type: "string" }, items: { type: "array", items: itemRef }, binPath: { type: "string" },
  }, ["items"])],
  ["get_sequence_info", "Détails d'une séquence : fps, taille, durée, tête de lecture, pistes et clips (temps en secondes).", S({
    ...seqArgs, includeClips: { type: "boolean", description: "Défaut : true" },
  })],
  ["get_selection", "Clips sélectionnés dans la timeline.", S(seqArgs)],
  ["set_playhead", "Déplace la tête de lecture.", S({ ...seqArgs, seconds: { type: "number" } }, ["seconds"])],
  ["set_in_out", "Définit les points d'entrée/sortie de la séquence.", S({
    ...seqArgs, inSeconds: { type: "number" }, outSeconds: { type: "number" },
  })],
  ["insert_clip", "Place un élément du projet sur une piste (insertion ou recouvrement).", S({
    ...seqArgs, item: itemRef,
    trackType: { type: "string", enum: ["video", "audio"] }, trackIndex: { type: "integer", minimum: 0 },
    seconds: { type: "number", description: "Position (défaut : tête de lecture)" },
    mode: { type: "string", enum: ["insert", "overwrite"], description: "Défaut : insert" },
  }, ["item"])],
  ["remove_clip", "Supprime un clip de la timeline.", S({ ...clipArgs, ripple: { type: "boolean" } }, ["clipIndex"])],
  ["move_clip", "Décale un clip dans le temps.", S({ ...clipArgs, offsetSeconds: { type: "number" } }, ["clipIndex", "offsetSeconds"])],
  ["set_clip_timing", "Modifie in/out (dans le média) et/ou start/end (dans la séquence) d'un clip, en secondes.", S({
    ...clipArgs, inPoint: { type: "number" }, outPoint: { type: "number" }, start: { type: "number" }, end: { type: "number" },
  }, ["clipIndex"])],
  ["set_clip_enabled", "Active/désactive un clip.", S({ ...clipArgs, enabled: { type: "boolean" } }, ["clipIndex", "enabled"])],
  ["select_clip", "Sélectionne/désélectionne un clip.", S({ ...clipArgs, selected: { type: "boolean" } }, ["clipIndex"])],
  ["razor", "Coupe (outil cutter) à un instant donné sur toutes les pistes ou certaines.", S({
    ...seqArgs, seconds: { type: "number" },
    trackType: { type: "string", enum: ["video", "audio"], description: "Limiter à un type de piste" },
    trackIndices: { type: "array", items: { type: "integer" } },
  }, ["seconds"])],
  ["get_clip_effects", "Liste les effets/composants d'un clip et leurs propriétés (Trajectoire, Opacité, etc.).", S(clipArgs, ["clipIndex"])],
  ["set_clip_effect_property", "Change une propriété d'effet (ex. composant 'Motion'/'Trajectoire', propriété 'Scale'/'Échelle'). Avec atSeconds : crée une image clé.", S({
    ...clipArgs, component: { type: "string" }, property: { type: "string" },
    value: { description: "Nombre, booléen ou tableau (ex. position [0.5, 0.5])" },
    atSeconds: { type: "number", description: "Temps relatif au début du clip pour une image clé" },
  }, ["clipIndex", "component", "property", "value"])],
  ["list_available_effects", "Liste les effets ou transitions disponibles (noms dans la langue de Premiere).", S({
    kind: { type: "string", enum: ["video", "audio", "transition", "audioTransition"] }, query: { type: "string" },
  })],
  ["add_effect", "Applique un effet à un clip (nom exact, voir list_available_effects).", S({ ...clipArgs, effectName: { type: "string" } }, ["clipIndex", "effectName"])],
  ["add_transition", "Ajoute une transition au début ou à la fin d'un clip.", S({
    ...clipArgs, transitionName: { type: "string" }, position: { type: "string", enum: ["start", "end"] },
    durationSeconds: { type: "number" },
  }, ["clipIndex"])],
  ["add_marker", "Ajoute un marqueur de séquence.", S({
    ...seqArgs, seconds: { type: "number" }, name: { type: "string" }, comment: { type: "string" },
    durationSeconds: { type: "number" }, colorIndex: { type: "integer", minimum: 0, maximum: 7 },
  })],
  ["list_markers", "Liste les marqueurs de séquence.", S(seqArgs)],
  ["find_export_presets", "Cherche des préréglages d'export .epr sur la machine.", S({
    query: { type: "string", description: "Filtre sur le nom, ex. 'H.264' ou 'Match Source'" },
    searchFolder: { type: "string" }, max: { type: "integer" },
  })],
  ["export_sequence", "Exporte la séquence avec un préréglage .epr (directement ou via Media Encoder).", S({
    ...seqArgs, outputPath: { type: "string" }, presetPath: { type: "string" },
    range: { type: "string", enum: ["entire", "inout", "workarea"] }, useMediaEncoder: { type: "boolean" },
  }, ["outputPath", "presetPath"])],
  ["export_frame", "Exporte une image PNG de la séquence et la renvoie pour que Claude la voie.", S({
    ...seqArgs, seconds: { type: "number", description: "Défaut : tête de lecture" },
    outputPath: { type: "string", description: "Défaut : dossier temporaire" },
  })],
  ["save_project", "Enregistre le projet (ou 'Enregistrer sous' si path est fourni).", S({ path: { type: "string" } })],
  ["open_project", "Ouvre un fichier .prproj.", S({ path: { type: "string" } }, ["path"])],
  ["analyze_rhythm", "Analyse le rythme du montage : plans visibles, durée moyenne/médiane, coupes par minute, cadence par tranche de temps, " +
    "accélérations, plans flash, plans très longs, trous noirs. Avec withMusic : détecte le tempo de la musique et mesure si les coupes tombent sur les temps.", S({
    ...seqArgs,
    windowSeconds: { type: "number", description: "Taille des tranches pour la cadence (défaut 10 s)" },
    withMusic: { type: "boolean", description: "Analyser aussi le calage des coupes sur le tempo (export audio temporaire)" },
    musicTrackIndex: { type: "integer", minimum: 0, description: "Piste audio de la musique (0 = A1). Défaut : mixage complet" },
    presetPath: { type: "string", description: "Préréglage .epr WAV (sinon recherché automatiquement)" },
  })],
  ["analyze_color", "Analyse l'image : exporte des images de la séquence (une par plan par défaut), mesure exposition, contraste, " +
    "hautes lumières brûlées, noirs bouchés, saturation et balance des blancs (dominante chaude/froide, verte/magenta), " +
    "signale les plans incohérents et les raccords brusques, et renvoie une planche contact numérotée pour les voir.", S({
    ...seqArgs,
    mode: { type: "string", enum: ["shots", "uniform", "times"], description: "shots = milieu de chaque plan (défaut), uniform = réparti, times = instants donnés" },
    maxFrames: { type: "integer", minimum: 1, maximum: 60, description: "Défaut 24" },
    times: { type: "array", items: { type: "number" }, description: "Instants en secondes (mode times)" },
    contactSheet: { type: "boolean", description: "Renvoyer la planche contact (défaut true)" },
    thumbWidth: { type: "integer", description: "Largeur des vignettes (défaut 240)" },
    columns: { type: "integer", description: "Colonnes de la planche (défaut 6)" },
  })],
  ["analyze_audio", "Analyse le son (export WAV temporaire) : loudness intégrée LUFS (EBU R128), plage dynamique LRA, crêtes, saturation, " +
    "équilibre gauche/droite et phase, courbe de niveau, silences, tempo. Avec perTrack : niveaux de chaque piste dans le temps " +
    "(équilibre voix/musique/ambiance). Compare à une cible de diffusion.", S({
    ...seqArgs,
    target: { type: "string", enum: ["web", "podcast", "broadcast", "cinema"], description: "Cible (défaut web = -14 LUFS)" },
    perTrack: { type: "boolean", description: "Analyser chaque piste audio séparément (un export par piste)" },
    range: { type: "string", enum: ["entire", "inout"] },
    curveStepSeconds: { type: "number", description: "Pas de la courbe de niveau (défaut 5 s)" },
    presetPath: { type: "string", description: "Préréglage .epr WAV (sinon recherché automatiquement)" },
  })],
  ["undo", "Annule les dernières actions de Claude en restaurant le projet tel qu'il était avant (le projet est rechargé). " +
    "Réversible avec redo.", S({ steps: { type: "integer", minimum: 1, description: "Nombre d'actions à annuler (défaut : 1)" } })],
  ["redo", "Rétablit ce qui a été annulé par le dernier undo.", S({})],
  ["list_checkpoints", "Liste les points de restauration du projet (du plus ancien au plus récent) et ce qui peut être rétabli.", S({})],
  ["create_checkpoint", "Crée un point de restauration manuel avec un nom (utile avant une série de modifications).", S({
    label: { type: "string" },
  })],
  ["restore_checkpoint", "Restaure un point de restauration précis (id fourni par list_checkpoints). Réversible avec undo.", S({
    id: { type: "string" },
  }, ["id"])],
];
if (ALLOW_SCRIPT) {
  TOOLS.push(["execute_extendscript",
    "Exécute du code ExtendScript (ES3) arbitraire dans Premiere Pro et renvoie la valeur de la dernière expression. " +
    "Objets disponibles : app, app.project, qe (après app.enableQE()), ClaudeBridge.tools. À utiliser quand aucun autre outil ne convient.",
    S({ code: { type: "string" } }, ["code"])]);
}

// ------------------------------------------------------------------ pont HTTP local
function readBridgeConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch (e) {
    throw new Error(`Config du pont introuvable (${CONFIG_FILE}). Ouvrez Premiere Pro puis Fenêtre > Extensions > Claude Bridge.`);
  }
}

function callBridge(tool, args, timeoutMs = CALL_TIMEOUT_MS) {
  const cfg = readBridgeConfig();
  const body = JSON.stringify({ tool, args });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: cfg.port, path: "/call", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Bridge-Token": cfg.token },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(new Error(`Réponse invalide du panneau (HTTP ${res.statusCode})`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Délai dépassé en attendant Premiere Pro.")));
    req.on("error", (e) => reject(e.code === "ECONNREFUSED"
      ? new Error("Premiere Pro ne répond pas. Vérifiez que Premiere est ouvert et que le panneau Fenêtre > Extensions > Claude Bridge est affiché.")
      : e));
    req.end(body);
  });
}

async function waitForFile(file, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < end) {
    try {
      const { size } = fs.statSync(file);
      if (size > 0 && size === lastSize) return true;
      lastSize = size;
    } catch (e) { /* pas encore écrit */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ------------------------------------------------------------------ points de restauration
// Chaque point = copie du .prproj enregistrée juste avant une action.
// history : états "avant action" (le plus récent à la fin). redo : piles { snapshot, undone } pour rétablir.
async function host(tool, args, timeoutMs) {
  const r = await callBridge(tool, args || {}, timeoutMs);
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

function stateFor(projectPath) {
  const key = crypto.createHash("sha1").update(path.resolve(projectPath).toLowerCase()).digest("hex").slice(0, 12);
  const dir = path.join(CHECKPOINT_ROOT, key);
  const file = path.join(dir, "index.json");
  let data = { projectPath, history: [], redo: [] };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, "utf8")), projectPath }; } catch (e) { /* nouveau projet */ }
  return { dir, file, data };
}

function saveState(st) {
  fs.mkdirSync(st.dir, { recursive: true });
  fs.writeFileSync(st.file, JSON.stringify(st.data, null, 2));
}

function deleteCheckpointFile(st, cp) {
  try { fs.unlinkSync(path.join(st.dir, cp.file)); } catch (e) { /* déjà supprimé */ }
}

function clearRedo(st) {
  for (const r of st.data.redo) deleteCheckpointFile(st, r.snapshot);
  // Les entrées "undone" ont été rendues à l'historique ou sont perdues : on ne garde que celles encore référencées.
  const kept = new Set(st.data.history.map((c) => c.file));
  for (const r of st.data.redo) for (const c of r.undone) if (!kept.has(c.file)) deleteCheckpointFile(st, c);
  st.data.redo = [];
}

function prune(st) {
  while (st.data.history.length > MAX_CHECKPOINTS) deleteCheckpointFile(st, st.data.history.shift());
}

// Enregistre le projet et en garde une copie.
async function snapshot(label) {
  const info = await host("checkpoint_prepare");
  const st = stateFor(info.path);
  fs.mkdirSync(st.dir, { recursive: true });
  const id = Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
  const cp = { id, label, createdAt: new Date().toISOString(), file: id + ".prproj", activeSequenceId: info.activeSequenceId || null };
  fs.copyFileSync(info.path, path.join(st.dir, cp.file));
  return { st, cp };
}

async function restore(st, cp) {
  const src = path.join(st.dir, cp.file);
  if (!fs.existsSync(src)) throw new Error(`Fichier du point de restauration manquant : ${src}`);
  await host("close_project");
  try {
    fs.copyFileSync(src, st.data.projectPath);
  } finally {
    await host("reopen_project", { path: st.data.projectPath, activeSequenceId: cp.activeSequenceId });
  }
}

const describeCp = (c) => ({ id: c.id, label: c.label, createdAt: c.createdAt });
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

async function checkpointTool(name, args) {
  if (name === "create_checkpoint") {
    const { st, cp } = await snapshot(args.label || "Point manuel");
    clearRedo(st); st.data.history.push(cp); prune(st); saveState(st);
    return ok({ created: describeCp(cp) });
  }

  if (name === "list_checkpoints") {
    const info = await host("get_project_info");
    const st = stateFor(info.path);
    return ok({
      project: info.path,
      checkpoints: st.data.history.map(describeCp),
      redoAvailable: st.data.redo.length > 0 ? st.data.redo[st.data.redo.length - 1].undone.map((c) => c.label) : [],
    });
  }

  if (name === "undo") {
    const steps = Math.max(1, Number(args.steps || 1));
    const { st, cp: current } = await snapshot("État avant annulation");
    if (st.data.history.length < steps) {
      deleteCheckpointFile(st, current);
      throw new Error(`Impossible d'annuler ${steps} action(s) : seulement ${st.data.history.length} point(s) de restauration disponible(s).`);
    }
    const undone = st.data.history.splice(-steps);
    st.data.redo.push({ snapshot: current, undone });
    saveState(st);
    await restore(st, undone[0]);
    return ok({ restoredTo: describeCp(undone[0]), undoneActions: undone.map((c) => c.label), redoPossible: true });
  }

  if (name === "redo") {
    const info = await host("get_project_info");
    const st = stateFor(info.path);
    const r = st.data.redo.pop();
    if (!r) throw new Error("Rien à rétablir.");
    st.data.history.push(...r.undone);
    saveState(st);
    await restore(st, r.snapshot);
    deleteCheckpointFile(st, r.snapshot);
    saveState(st);
    return ok({ redoneActions: r.undone.map((c) => c.label) });
  }

  if (name === "restore_checkpoint") {
    const info = await host("get_project_info");
    const target = stateFor(info.path).data.history.find((c) => c.id === args.id);
    if (!target) throw new Error(`Point de restauration introuvable : ${args.id}. Utilisez list_checkpoints.`);
    const { st, cp } = await snapshot(`Avant restauration de « ${target.label} »`);
    clearRedo(st); st.data.history.push(cp); prune(st); saveState(st);
    await restore(st, target);
    return ok({ restoredTo: describeCp(target), undoWith: "undo" });
  }
}

const analyzers = createAnalyzers({ host, waitForFile });

const CHECKPOINT_TOOLS = new Set(["undo", "redo", "list_checkpoints", "create_checkpoint", "restore_checkpoint"]);

function summarize(name, args) {
  const s = JSON.stringify(args || {});
  return `${name} ${s.length > 100 ? s.slice(0, 97) + "…" : s}`;
}

// Les appels sont sérialisés pour que chaque point de restauration corresponde exactement à une action.
let lock = Promise.resolve();
function runTool(name, args) {
  const p = lock.then(() => runToolUnlocked(name, args));
  lock = p.catch(() => {});
  return p;
}

async function runToolUnlocked(name, args) {
  if (!TOOLS.some((t) => t[0] === name)) throw new Error(`Outil inconnu : ${name}`);
  args = { ...(args || {}) };

  if (CHECKPOINT_TOOLS.has(name)) return checkpointTool(name, args);
  if (analyzers[name]) return analyzers[name](args);

  let pre = null, warning = "";
  if (AUTO_CHECKPOINT && MUTATING.has(name)) {
    try { pre = await snapshot(summarize(name, args)); }
    catch (e) { warning = `Attention : aucun point de restauration créé — ${e.message}`; }
  }
  const result = await runBridgeTool(name, args);
  if (pre) {
    if (result.isError) deleteCheckpointFile(pre.st, pre.cp);
    else {
      clearRedo(pre.st); pre.st.data.history.push(pre.cp); prune(pre.st); saveState(pre.st);
      result.content.push({ type: "text", text: `Point de restauration ${pre.cp.id} créé : utilisez undo pour annuler cette action.` });
    }
  }
  if (warning) result.content.push({ type: "text", text: warning });
  return result;
}

async function runBridgeTool(name, args) {

  if (name === "export_frame" && !args.outputPath) {
    const dir = path.join(os.tmpdir(), "premiere-claude-bridge");
    fs.mkdirSync(dir, { recursive: true });
    args.outputPath = path.join(dir, `frame-${Date.now()}.png`);
  }

  const r = await callBridge(name, args);
  if (!r.ok) return { content: [{ type: "text", text: `Erreur : ${r.error}` }], isError: true };

  const text = { type: "text", text: JSON.stringify(r.result, null, 2) };
  if (name === "export_frame" && r.result && r.result.outputPath) {
    const file = r.result.outputPath;
    if (await waitForFile(file, 15000)) {
      const data = fs.readFileSync(file).toString("base64");
      return { content: [text, { type: "image", data, mimeType: "image/png" }] };
    }
    text.text += "\n(L'image n'a pas encore été écrite sur le disque.)";
  }
  return { content: [text] };
}

// ------------------------------------------------------------------ JSON-RPC / MCP sur stdio
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize": {
        const requested = params && params.protocolVersion;
        return reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "Pilote Adobe Premiere Pro en local. Commencez par get_project_info puis get_sequence_info. " +
            "Les temps sont en secondes. Les index de pistes/clips commencent à 0. " +
            "Chaque action qui modifie le projet crée un point de restauration : en cas d'erreur, utilisez undo (puis redo si besoin).",
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: TOOLS.map(([name, description, inputSchema]) => ({ name, description, inputSchema })) });
      case "tools/call": {
        let result;
        try { result = await runTool(params.name, params.arguments); }
        catch (e) { result = { content: [{ type: "text", text: `Erreur : ${e.message}` }], isError: true }; }
        return reply(id, result);
      }
      default:
        if (isRequest) return replyError(id, -32601, `Méthode non prise en charge : ${method}`);
    }
  } catch (e) {
    if (isRequest) replyError(id, -32603, e.message);
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return replyError(null, -32700, "JSON invalide"); }
    if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
  });
  rl.on("close", () => process.exit(0));
}

module.exports = { TOOLS, runTool, handle };
