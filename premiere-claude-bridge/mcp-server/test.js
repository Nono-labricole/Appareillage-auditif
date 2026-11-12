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
  getFormatted() { return "t=" + this.seconds; } }
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pcb-"));
const projFile = path.join(tmp, "Test.prproj");
fs.writeFileSync(projFile, "v1");
const events = [];
const app = { version: "25.0", build: "1", path: "/nonexistent",
  openDocument(p) { events.push("open:" + fs.readFileSync(p, "utf8")); return true; },
  project: { name: "Test.prproj", path: projFile, rootItem: root,
  activeSequence: seq, sequences: coll([seq], "numSequences"), openSequence(id) { events.push("seq:" + id); }, save() {},
  closeDocument() { events.push("close"); } } };

// ---- 2e séquence pour les analyses : plans de 2 s, un plan flash, une coupe à contretemps, un raccord invisible, un plan orangé
const png = require("./lib/png");
const mkClip = (name, nodeId, start, end, inPoint = 0) => ({ name, start: T(start), end: T(end), inPoint: T(inPoint), outPoint: T(inPoint + end - start),
  duration: T(end - start), projectItem: { nodeId }, isSelected: () => false, disabled: false, components: coll([]) });
const v1 = [], cutsAt = [0, 2, 4, 4.04, 6, 8, 10, 12, 14.2, 16, 18, 20, 22, 24, 26, 28, 30];
for (let i = 0; i < cutsAt.length - 1; i++) {
  const a = cutsAt[i], b = cutsAt[i + 1];
  if (a === 18) v1.push(mkClip("Suite.mp4", "same", 18, 20, 2)); // raccord invisible avec le plan précédent
  else if (a === 16) v1.push(mkClip("Suite.mp4", "same", 16, 18, 0));
  else v1.push(mkClip(`Plan${i}.mp4`, "c" + i, a, b));
}
const mkAudioTrack = (name) => { const t = { name, clips: coll([mkClip(name, name, 0, 30)]), _muted: false, isLocked: () => false };
  t.isMuted = () => t._muted; t.setMute = (m) => { t._muted = !!m; }; return t; };
const seq2 = { ...seq, name: "Seq Rythme", sequenceID: "s2", end: String(30 * TICKS),
  videoTracks: coll([{ name: "V1", clips: coll(v1), isMuted: () => false, isLocked: () => false },
    { name: "V2", clips: coll([mkClip("Titre.png", "t", 20.5, 21.5)]), isMuted: () => false, isLocked: () => false }], "numTracks"),
  audioTracks: coll([mkAudioTrack("Voix"), mkAudioTrack("Musique")], "numTracks"),
  exportAsMediaDirect(out) {
    const sr = 48000, n = sr * 30, b = Buffer.alloc(44 + n * 4);
    b.write("RIFF", 0); b.writeUInt32LE(36 + n * 4, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
    b.writeUInt16LE(2, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 4, 40);
    const voice = !this.audioTracks[0]._muted, music = !this.audioTracks[1]._muted;
    let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < n; i++) {
      const t = i / sr, ph = t % 0.5;
      let v = 0;
      if (music) v += 0.12 * Math.exp(-ph * 30) * rnd() + 0.05 * Math.sin(2 * Math.PI * 110 * t);
      if (voice && t > 3 && t < 25) v += 0.3 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
      const x = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
      b.writeInt16LE(x, 44 + i * 4); b.writeInt16LE(x, 46 + i * 4);
    }
    fs.writeFileSync(out, b);
    return "ok";
  } };
app.project.sequences.push(seq2); app.project.sequences.numSequences = 2;
const openSeq = app.project.openSequence;
app.project.openSequence = (id) => { openSeq(id); app.project.activeSequence = app.project.sequences.find((x) => x.sequenceID === id); };
app.enableQE = () => {};
const qe = { project: { getActiveSequence: () => ({
  exportFramePNG(tc, base) {
    const t = Number(tc.slice(2)), w = 64, h = 36, data = new Uint8Array(w * h * 3);
    const orange = t > 12 && t < 14.2; // plan avec une forte dominante chaude
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = 30 + Math.round((200 * x) / w), o = (y * w + x) * 3;
      data[o] = orange ? Math.min(255, v + 45) : v; data[o + 1] = v; data[o + 2] = orange ? Math.max(0, v - 45) : v;
    }
    fs.writeFileSync(base + ".png", png.encodePNG({ width: w, height: h, data }));
  } }) } };

const ctx = vm.createContext({ app, qe, Time, ProjectItemType, File: function (p) { this.exists = true; }, Folder: Object.assign(function () { this.exists = false; }, { myDocuments: { fsName: "/aucun" } }) });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/jsx/host.jsx"), "utf8"), ctx);

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

    // --- annulation / rétablissement
    const cpDir = () => { const d = path.join(tmp, "checkpoints"); return path.join(d, fs.readdirSync(d)[0]); };
    let lc = JSON.parse((await call("list_checkpoints", {})).text);
    assert.strictEqual(lc.checkpoints.length, 4, "insert x2, marker, script (pas l'insert échoué)");
    fs.writeFileSync(projFile, "v2"); // le projet a évolué
    r = await call("undo", {});
    assert.ok(!r.isError, r.text);
    assert.strictEqual(fs.readFileSync(projFile, "utf8"), "v1");
    assert.deepStrictEqual(events.slice(-3), ["close", "open:v1", "seq:s1"]);
    r = await call("redo", {});
    assert.ok(!r.isError, r.text);
    assert.strictEqual(fs.readFileSync(projFile, "utf8"), "v2");
    r = await call("redo", {});
    assert.ok(r.isError && /Rien à rétablir/.test(r.text));
    r = await call("undo", { steps: 3 });
    assert.ok(!r.isError, r.text);
    assert.strictEqual(JSON.parse(r.text).undoneActions.length, 3);
    r = await call("undo", { steps: 5 });
    assert.ok(r.isError && /seulement 1/.test(r.text), r.text);
    lc = JSON.parse((await call("list_checkpoints", {})).text);
    assert.strictEqual(lc.checkpoints.length, 1);
    assert.strictEqual(lc.redoAvailable.length, 3);
    r = await call("add_marker", { seconds: 1 }); // une nouvelle action vide la pile de rétablissement
    lc = JSON.parse((await call("list_checkpoints", {})).text);
    assert.strictEqual(lc.redoAvailable.length, 0);
    assert.strictEqual(lc.checkpoints.length, 2);
    r = await call("restore_checkpoint", { id: lc.checkpoints[0].id });
    assert.ok(!r.isError, r.text);
    lc = JSON.parse((await call("list_checkpoints", {})).text);
    assert.strictEqual(lc.checkpoints.length, 3);
    const files = fs.readdirSync(cpDir()).filter((f) => f.endsWith(".prproj"));
    assert.strictEqual(files.length, 3, "fichiers orphelins supprimés : " + files);

    // --- analyses
    const callFull = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
    let full = await callFull("analyze_rhythm", { sequenceName: "Seq Rythme", withMusic: true, musicTrackIndex: 1, presetPath: "/x/wav.epr" });
    assert.ok(!full.isError, full.content[0].text);
    const rh = JSON.parse(full.content[0].text);
    assert.strictEqual(app.project.activeSequence.name, "Seq Rythme");
    // 16 plans sur V1, -1 raccord invisible fusionné, +2 pour le titre en V2 qui coupe un plan en trois
    assert.strictEqual(rh.shotCount, 17, JSON.stringify(rh.shots.map((x) => x.at)));
    assert.strictEqual(rh.flashFrames.length, 1);
    assert.strictEqual(rh.flashFrames[0].frames, 1);
    assert.ok(Math.abs(rh.musicSync.bpm - 120) < 1.5, "bpm " + rh.musicSync.bpm);
    assert.ok(rh.musicSync.offBeatCuts.some((c) => c.at === "0:14.2"), JSON.stringify(rh.musicSync));
    assert.ok(seq2.audioTracks.every((t) => !t._muted), "les mutes doivent être restaurés");

    full = await callFull("analyze_color", { sequenceName: "Seq Rythme" });
    assert.ok(!full.isError, full.content[0].text);
    const col = JSON.parse(full.content[0].text);
    assert.strictEqual(col.framesAnalyzed, 17);
    const warm = col.consistency.outliers.find((o) => o.differsFromRest.some((d) => d.startsWith("plus chaud")));
    assert.ok(warm && warm.at === "0:13.1", JSON.stringify(col.consistency));
    assert.ok(col.consistency.abruptChangesBetweenShots.length >= 2);
    assert.strictEqual(full.content[1].type, "image");
    const sheet = png.decodePNG(Buffer.from(full.content[1].data, "base64"));
    assert.ok(sheet.width > 0 && sheet.height > 0);

    full = await callFull("analyze_audio", { sequenceName: "Seq Rythme", perTrack: true, presetPath: "/x/wav.epr" });
    assert.ok(!full.isError, full.content[0].text);
    const au = JSON.parse(full.content[0].text);
    assert.ok(isFinite(au.mix.integratedLUFS) && au.mix.integratedLUFS < -5 && au.mix.integratedLUFS > -40, String(au.mix.integratedLUFS));
    assert.strictEqual(au.tracks.length, 2);
    assert.ok(au.tracks[0].integratedLUFS > au.tracks[1].integratedLUFS, "la voix est plus forte que la musique");
    assert.strictEqual(au.levelsOverTime[5]["A1 (Voix)"], "silence", JSON.stringify(au.levelsOverTime)); // la voix s'arrête à 25 s
    assert.ok(Math.abs(au.tempo.bpm - 120) < 1.5, JSON.stringify(au.tempo));
    assert.strictEqual(au.mix.stereo.correlation, 1);
    assert.ok(au.targetCheck.gainNeededDB !== undefined);

    full = await callFull("analyze_audio", { sequenceName: "Seq Rythme" });
    assert.ok(full.isError && /préréglage/i.test(full.content[0].text), full.content[0].text);

    fs.writeFileSync(cfgFile, JSON.stringify({ port: server.address().port, token: "mauvais" }));
    r = await call("ping", {});
    assert.ok(r.isError && /Jeton|token/i.test(r.text), r.text);

    console.log("OK – tous les tests passent");
  } catch (e) { console.error(e); process.exitCode = 1; }
  child.kill(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
