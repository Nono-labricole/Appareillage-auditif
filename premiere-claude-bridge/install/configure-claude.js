// Ajoute le serveur MCP "premiere" à la config de Claude Desktop (avec sauvegarde).
// Usage : node configure-claude.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const serverPath = path.resolve(__dirname, "..", "mcp-server", "index.js");
const cfgPath = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
  : path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

let cfg = {};
if (fs.existsSync(cfgPath)) {
  const raw = fs.readFileSync(cfgPath, "utf8");
  try { cfg = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) { console.error(`Config Claude illisible (${cfgPath}) : ${e.message}. Rien n'a été modifié.`); process.exit(1); }
  fs.copyFileSync(cfgPath, cfgPath + ".bak");
}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.premiere = { command: process.execPath, args: [serverPath] };
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

console.log(`Claude Desktop configuré : ${cfgPath}`);
console.log(`\nPour Claude Code, lancez plutôt :\n  claude mcp add premiere -- "${process.execPath}" "${serverPath}"`);
