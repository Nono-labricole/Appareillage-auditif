#!/usr/bin/env node
/*
 * Serveur MCP local (stdio) pour piloter Premiere Pro via le panneau "Claude Bridge".
 * Aucune dépendance externe, aucune connexion réseau hors 127.0.0.1.
 * Node.js 18+ requis.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const SERVER_INFO = { name: "premiere-claude-bridge", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CONFIG_FILE = process.env.PREMIERE_BRIDGE_CONFIG ||
  path.join(os.homedir(), ".premiere-claude-bridge", "bridge.json");
const ALLOW_SCRIPT = process.env.PREMIERE_BRIDGE_DISABLE_SCRIPT !== "1";
const CALL_TIMEOUT_MS = Number(process.env.PREMIERE_BRIDGE_TIMEOUT_MS || 120000);

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

function callBridge(tool, args) {
  const cfg = readBridgeConfig();
  const body = JSON.stringify({ tool, args });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: cfg.port, path: "/call", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Bridge-Token": cfg.token },
      timeout: CALL_TIMEOUT_MS,
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

async function runTool(name, args) {
  if (!TOOLS.some((t) => t[0] === name)) throw new Error(`Outil inconnu : ${name}`);
  args = { ...(args || {}) };

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
            "Les temps sont en secondes. Les index de pistes/clips commencent à 0.",
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
