// Test de bout en bout sans Premiere : host.jsx est exécuté dans une VM Node avec une API Premiere simulée,
// derrière un faux panneau HTTP, et le serveur MCP est piloté via stdio.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");

const TICKS = 254016000000;
class Time { constructor() { this.seconds = 0; } get ticks() { return String(Math.round(this.seconds * TICKS)); }
  getFormatted() { const s = this.seconds; return `00:00:${String(Math.floor(s)).padStart(2, "0")}:00`; } }
const T = (s) => { const t = new Time(); t.seconds = s; return t; };
const coll = (arr, key = "numItems") => Object.assign(arr, { [key]: arr.length });
const ProjectItemType = { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 };

function mkItem(name, type, nodeId, children) {
  return { name, type, nodeId, treePath: "\\p\\" + name, children: coll(children || []), getMediaPath: () => "/media/" + name,
    isSequence: () => false, createBin(n) { const b = mkItem(n, 2, "bin-" + n, []); this.children.push(b); this.children.numItems++; return b; } };
}
const clipA = mkItem("A.mp4", 1, "n1"), clipB = mkItem("B.mp4", 1, "n2");
const root = mkItem("root", 3, "root", [mkItem("Rushes", 2, "n0", [clipA]), clipB]);
function mkTrack(name) {
  const clips = coll([]);
  return { name, clips, isMuted: () => false, isLocked: () => false,
    insertClip(item, t) { clips.push({ name: item.name, start: T(t.seconds), end: T(t.seconds + 5), inPoint: T(0), outPoint: T(5),
      duration: T(5), projectItem: item, isSelected: () => false, disabled: false, components: coll([]) }); clips.numItems++; } };
}
const markers = [];
const seq = { name: "Seq 1", sequenceID: "s1", timebase: String(TICKS / 25), end: String(10 * TICKS),
  frameSizeHorizontal: 1920, frameSizeVertical: 1080, _pos: 0,
  videoTracks: coll([mkTrack("V1"), mkTrack("V2")], "numTracks"), audioTracks: coll([mkTrack("A1")], "numTracks"),
  getPlayerPosition() { return T(this._pos); }, setPlayerPosition(t) { this._pos = Number(t) / TICKS; },
  getInPoint: () => "0", getOutPoint: () => "10", getSettings: () => ({}),
  markers: { createMarker(s) { const m = { name: "", comments: "", start: T(s), end: T(s), type: "Comment" }; markers.push(m); return m; },
    getFirstMarker: () => markers[0], getNextMarker: (m) => markers[markers.indexOf(m) + 1] } };
const app = { version: "25.0", build: "1", path: "/nonexistent", project: { name: "Test.prproj", path: "/tmp/Test.prproj", rootItem: root,
  activeSequence: seq, sequences: coll([seq], "numSequences"), openSequence() {}, save() {} } };

const ctx = vm.createContext({ app, Time, ProjectItemType, File: function (p) { this.exists = true; }, Folder: function () { this.exists = false; } });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/jsx/host.jsx"), "utf8"), ctx);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pcb-"));
const cfgFile = path.join(tmp, "bridge.json");
const token = "secret";

const server = http.createServer((req, res) => {
  if (req.headers["x-bridge-token"] !== token) { res.writeHead(401); return res.end('{"ok":false,"error":"token"}'); }
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { tool, args } = JSON.parse(body);
    ctx.__tool = tool; ctx.__args = args;
    res.end(vm.runInContext("ClaudeBridge.dispatch(__tool, __args)", ctx));
  });
});

server.listen(0, "127.0.0.1", async () => {
  fs.writeFileSync(cfgFile, JSON.stringify({ port: server.address().port, token }));
  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], { env: { ...process.env, PREMIERE_BRIDGE_CONFIG: cfgFile } });
  let buf = ""; const pending = new Map(); let nextId = 1;
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(msg.id)(msg); } });
  const rpc = (method, params) => new Promise((r) => { const id = nextId++; pending.set(id, r);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args });
    return { isError: !!r.result.isError, text: r.result.content[0].text }; };

  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.strictEqual(init.result.serverInfo.name, "premiere-claude-bridge");
    const list = await rpc("tools/list", {});
    assert.ok(list.result.tools.length >= 30);

    let r = await call("get_project_info", {});
    assert.ok(!r.isError, r.text); assert.strictEqual(JSON.parse(r.text).activeSequence.name, "Seq 1");

    r = await call("insert_clip", { item: "Rushes/A.mp4", trackIndex: 1, seconds: 2 });
    assert.ok(!r.isError, r.text);
    r = await call("insert_clip", { item: "n2", seconds: 7 });
    assert.ok(!r.isError, r.text);

    r = await call("get_sequence_info", {});
    const info = JSON.parse(r.text);
    assert.strictEqual(info.fps, 25);
    assert.strictEqual(info.videoTracks[1].clips[0].name, "A.mp4");
    assert.strictEqual(info.videoTracks[0].clips[0].start, 7);

    r = await call("set_playhead", { seconds: 3.5 });
    assert.strictEqual(JSON.parse(r.text).playheadSeconds, 3.5);

    r = await call("add_marker", { seconds: 4, name: "Titre", comment: "à revoir", durationSeconds: 2 });
    assert.deepStrictEqual(JSON.parse(r.text), { name: "Titre", start: 4, end: 6 });
    r = await call("list_markers", {});
    assert.strictEqual(JSON.parse(r.text)[0].comment, "à revoir");

    r = await call("insert_clip", { item: "inexistant.mov" });
    assert.ok(r.isError && /introuvable/.test(r.text), r.text);

    r = await call("execute_extendscript", { code: "app.project.name + ' / ' + app.version" });
    assert.strictEqual(JSON.parse(r.text), "Test.prproj / 25.0");

    fs.writeFileSync(cfgFile, JSON.stringify({ port: server.address().port, token: "mauvais" }));
    r = await call("ping", {});
    assert.ok(r.isError && /Jeton|token/i.test(r.text), r.text);

    console.log("OK – tous les tests passent");
  } catch (e) { console.error(e); process.exitCode = 1; }
  child.kill(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
