/*
 * Claude Bridge – panneau CEP pour Premiere Pro.
 * Ouvre un petit serveur HTTP sur 127.0.0.1 uniquement (aucune connexion externe)
 * et relaie les commandes reçues du serveur MCP local vers ExtendScript (jsx/host.jsx).
 */
(function () {
  "use strict";

  var nodeRequire = (typeof cep_node !== "undefined" && cep_node.require) ? cep_node.require : require;
  var http = nodeRequire("http");
  var fs = nodeRequire("fs");
  var os = nodeRequire("os");
  var path = nodeRequire("path");
  var crypto = nodeRequire("crypto");

  var DEFAULT_PORT = 17830;
  var CONFIG_DIR = path.join(os.homedir(), ".premiere-claude-bridge");
  var CONFIG_FILE = path.join(CONFIG_DIR, "bridge.json");
  var MAX_BODY = 5 * 1024 * 1024;

  var server = null;
  var queue = Promise.resolve();

  function $(id) { return document.getElementById(id); }

  function log(msg) {
    var el = $("log");
    var line = "[" + new Date().toLocaleTimeString() + "] " + msg + "\n";
    el.textContent += line;
    if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-15000);
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(text, state) {
    $("status").textContent = text;
    $("dot").className = "dot" + (state ? " " + state : "");
  }

  function loadConfig() {
    var cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) { /* premier lancement */ }
    var changed = false;
    if (!cfg.port) { cfg.port = DEFAULT_PORT; changed = true; }
    if (!cfg.token) { cfg.token = crypto.randomBytes(24).toString("hex"); changed = true; }
    if (changed) {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 384 /* 0600 */ });
    }
    return cfg;
  }

  function extensionPath() {
    var p = decodeURI(window.__adobe_cep__.getSystemPath("extension"));
    if (/^file:\/\/\/[A-Za-z]:/.test(p)) return p.replace("file:///", "");
    return p.replace(/^file:\/\//, "");
  }

  function evalScript(script) {
    return new Promise(function (resolve) {
      window.__adobe_cep__.evalScript(script, function (result) { resolve(result); });
    });
  }

  function toJsLiteral(value) {
    return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }

  // Les appels ExtendScript sont exécutés un par un.
  function callHost(tool, args) {
    var run = function () {
      var script = "ClaudeBridge.dispatch(" + toJsLiteral(tool) + "," + toJsLiteral(args || {}) + ")";
      return evalScript(script).then(function (raw) {
        if (raw === "EvalScript error." || raw === undefined || raw === null || raw === "") {
          return { ok: false, error: "Erreur ExtendScript (le script hôte n'est peut-être pas chargé). Réponse : " + raw };
        }
        try { return JSON.parse(raw); } catch (e) { return { ok: true, result: raw }; }
      });
    };
    var p = queue.then(run, run);
    queue = p.catch(function () {});
    return p;
  }

  function send(res, status, obj) {
    var body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  }

  function handle(cfg, req, res) {
    if (req.headers["x-bridge-token"] !== cfg.token) return send(res, 401, { ok: false, error: "Jeton invalide" });

    if (req.method === "GET" && req.url === "/health") {
      return callHost("ping", {}).then(function (r) { send(res, 200, r); });
    }
    if (req.method !== "POST" || req.url !== "/call") return send(res, 404, { ok: false, error: "Introuvable" });

    var chunks = [], size = 0;
    req.on("data", function (c) {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () {
      var payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch (e) { return send(res, 400, { ok: false, error: "JSON invalide" }); }
      var started = Date.now();
      callHost(payload.tool, payload.args).then(function (r) {
        log(payload.tool + (r.ok ? " ✓" : " ✗ " + r.error) + " (" + (Date.now() - started) + " ms)");
        send(res, 200, r);
      }, function (err) {
        send(res, 500, { ok: false, error: String(err) });
      });
    });
  }

  function start() {
    var cfg;
    try { cfg = loadConfig(); } catch (e) { setStatus("Config illisible : " + e.message, "err"); return; }

    // (Re)charge le script hôte pour être sûr qu'il est à jour.
    var jsx = path.join(extensionPath(), "jsx", "host.jsx").replace(/\\/g, "/");
    evalScript("$.evalFile(" + toJsLiteral(jsx) + ")").then(function () {
      server = http.createServer(function (req, res) {
        try { handle(cfg, req, res); } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
      });
      server.on("error", function (e) {
        setStatus("Erreur serveur : " + e.message, "err");
        log("Erreur : " + e.message + (e.code === "EADDRINUSE" ? " (changez \"port\" dans " + CONFIG_FILE + ")" : ""));
      });
      server.listen(cfg.port, "127.0.0.1", function () {
        setStatus("En écoute sur 127.0.0.1:" + cfg.port, "on");
        log("Prêt. Config : " + CONFIG_FILE);
      });
    });
  }

  function stop(cb) {
    if (server) { server.close(function () { server = null; cb && cb(); }); }
    else if (cb) cb();
  }

  $("restart").addEventListener("click", function () { stop(start); });
  window.addEventListener("beforeunload", function () { stop(); });
  start();
})();
