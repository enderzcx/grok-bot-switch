// grok-switch web panel. Listens on 127.0.0.1 inside the Grok Bot cloud
// machine; the user reaches it through Grok Bot's cloud desktop browser.
// Appended by build.mjs before cli.cjs; cli* helpers are in scope.

var uiHttp = require("node:http");
var uiCrypto = require("node:crypto");
var uiChild = require("node:child_process");

var UI_DEFAULT_PORT = 18990;
var UI_STATE_PATH = GROK_SWITCH_DIR + "/ui.json";
var UI_LOG_PATH = GROK_SWITCH_DIR + "/ui.log";
var UI_JOB_MAX_OUTPUT = 20000;

// Long-running shell jobs the panel can start (Codex login / install).
var uiJobs = {};
// Mutations run one at a time so captured output never interleaves.
var uiQueue = Promise.resolve();

function uiStripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function uiStartJob(id, command, args, onExit) {
  if (uiJobs[id] != null && uiJobs[id].status === "running") return uiJobs[id];
  var job = { id: id, status: "running", startedAt: new Date().toISOString(), output: "", url: null, code: null, exitCode: null, error: null };
  uiJobs[id] = job;
  var child;
  try {
    child = uiChild.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    return job;
  }
  var onData = function (chunk) {
    job.output = (job.output + uiStripAnsi(chunk.toString())).slice(-UI_JOB_MAX_OUTPUT);
    var url = /https?:\/\/\S+\/device\S*/.exec(job.output);
    var code = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/.exec(job.output);
    if (url) job.url = url[0];
    if (code) job.code = code[1];
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", function (error) {
    job.status = "failed";
    job.error = error.code === "ENOENT" ? command + " is not installed" : error.message;
  });
  child.on("exit", function (exitCode) {
    if (job.status === "failed") return;
    job.exitCode = exitCode;
    job.status = exitCode === 0 ? "done" : "failed";
    if (exitCode !== 0 && job.error == null) job.error = command + " exited with code " + exitCode;
    if (onExit) onExit(job);
  });
  job.kill = function () {
    try {
      child.kill();
    } catch (_error) {}
  };
  return job;
}

function uiCodexState() {
  var installed = false;
  try {
    installed = uiChild.spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0;
  } catch (_error) {}
  var loggedIn = false;
  var account = null;
  try {
    var credentials = grokSwitchCodexCredentials();
    loggedIn = true;
    account = credentials.accountId;
  } catch (_error) {}
  var jobs = {};
  var ids = Object.keys(uiJobs);
  for (var i = 0; i < ids.length; i += 1) {
    var job = uiJobs[ids[i]];
    jobs[ids[i]] = { status: job.status, url: job.url, code: job.code, error: job.error, output: job.output.slice(-1500), startedAt: job.startedAt };
  }
  return { installed: installed, loggedIn: loggedIn, account: account, defaultModel: cliCodexConfiguredModel(), jobs: jobs };
}

function uiMaskedProviders(config) {
  var out = {};
  var names = Object.keys(config.providers);
  for (var i = 0; i < names.length; i += 1) {
    var raw = config.providers[names[i]];
    var entry = JSON.parse(JSON.stringify(raw));
    entry.hasKey = typeof raw.apiKey === "string" && raw.apiKey.length > 0;
    delete entry.apiKey;
    try {
      var normalized = grokSwitchNormalizeProvider(names[i], raw);
      entry.summary = cliDescribeProvider(normalized);
      entry.valid = true;
    } catch (error) {
      entry.summary = error.message;
      entry.valid = false;
    }
    out[names[i]] = entry;
  }
  return out;
}

function uiState() {
  var config = cliReadRawConfig();
  var route = grokSwitchResolveRoute();
  return {
    version: CLI_VERSION,
    host: cliHostState(),
    active: config.active,
    route: route.kind,
    routeError: route.kind === "error" ? route.message : null,
    providers: uiMaskedProviders(config),
    usage: cliUsageTotals(),
    recent: cliReadLog(8),
    codex: uiCodexState(),
    configPath: CLI_CONFIG_PATH
  };
}

function uiFlagsFromBody(body) {
  var flags = {};
  if (body.baseUrl) flags.url = String(body.baseUrl);
  if (body.model) flags.model = String(body.model);
  if (body.protocol) flags.protocol = String(body.protocol);
  if (body.apiKey) flags.key = String(body.apiKey);
  if (body.authType) flags.auth = String(body.authType);
  if (body.endpointPath) flags.endpoint = String(body.endpointPath);
  if (body.reasoning) flags.reasoning = String(body.reasoning);
  if (body.maxTokens) flags["max-tokens"] = String(body.maxTokens);
  if (Array.isArray(body.headers)) flags.header = body.headers.map(String);
  return flags;
}

async function uiHandleApi(method, pathname, body) {
  if (method === "GET" && pathname === "/api/state") return uiState();
  if (method === "POST" && pathname === "/api/providers") {
    var name = cliRequireProviderName(body.name);
    var config = cliReadRawConfig();
    var flags = uiFlagsFromBody(body);
    if (body.authType === "none") config.providers[name] = Object.assign({}, config.providers[name], { apiKey: "" });
    config.providers[name] = cliProviderFromFlags(name, flags, config.providers[name]);
    cliWriteConfig(config);
    var probe = body.test === false ? null : await cliProbeProvider(grokSwitchNormalizeProvider(name, config.providers[name]));
    return { saved: name, probe: probe, state: uiState() };
  }
  if (method === "POST" && pathname === "/api/providers/delete") {
    var lines = await cliCapture(function () {
      cliCommandRemove({ positional: ["remove", body.name], flags: {} });
    });
    return { lines: lines, state: uiState() };
  }
  if (method === "POST" && pathname === "/api/test") {
    var testConfig = cliReadRawConfig();
    if (testConfig.providers[body.name] == null) throw new CliError("no provider named " + body.name);
    return { probe: await cliProbeProvider(grokSwitchNormalizeProvider(body.name, testConfig.providers[body.name])) };
  }
  if (method === "POST" && pathname === "/api/use") {
    var useLines = await cliCapture(function () {
      return cliCommandUse({ positional: ["use", body.name], flags: {} });
    });
    return { lines: useLines, state: uiState() };
  }
  if (method === "POST" && pathname === "/api/official") {
    var officialLines = await cliCapture(function () {
      cliCommandOfficial();
    });
    return { lines: officialLines, state: uiState() };
  }
  if (method === "POST" && pathname === "/api/restart") {
    var restartLines = await cliCapture(function () {
      cliCommandRestart();
    });
    return { lines: restartLines, state: uiState() };
  }
  if (method === "POST" && pathname === "/api/restore") {
    var restoreLines = await cliCapture(function () {
      cliCommandRestore();
    });
    return { lines: restoreLines, state: uiState() };
  }
  if (method === "POST" && pathname === "/api/codex/install") {
    uiStartJob("codex-install", "npm", ["install", "-g", "@openai/codex"]);
    return { state: uiState() };
  }
  if (method === "POST" && pathname === "/api/codex/login") {
    var model = body.model ? String(body.model) : null;
    uiStartJob("codex-login", "codex", ["login", "--device-auth"], function (job) {
      if (job.status !== "done") return;
      try {
        var cfg = cliReadRawConfig();
        var providerName = body.name ? String(body.name) : "chatgpt";
        cfg.providers[providerName] = cliProviderFromFlags(providerName, Object.assign({ auth: "codex" }, model ? { model: model } : {}), cfg.providers[providerName]);
        cliWriteConfig(cfg);
      } catch (error) {
        job.error = "signed in, but saving the provider failed: " + error.message;
      }
    });
    return { state: uiState() };
  }
  if (method === "POST" && pathname === "/api/codex/cancel") {
    var running = uiJobs["codex-login"];
    if (running && running.status === "running") running.kill();
    return { state: uiState() };
  }
  throw new CliError("not found");
}

function uiReadBody(request) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total = 0;
    request.on("data", function (chunk) {
      total += chunk.length;
      if (total > 256 * 1024) {
        reject(new CliError("request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", function () {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_error) {
        reject(new CliError("invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function uiCreateServer(token) {
  return uiHttp.createServer(function (request, response) {
    var url = new URL(request.url, "http://127.0.0.1");
    var send = function (status, payload, type) {
      var data = type ? payload : JSON.stringify(payload);
      response.writeHead(status, { "content-type": type || "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(data);
    };
    if (url.pathname === "/" && request.method === "GET") return send(200, UI_HTML, "text/html; charset=utf-8");
    if (url.pathname.indexOf("/api/") !== 0) return send(404, { error: "not found" });
    if (request.headers["x-gs-token"] !== token) return send(403, { error: "bad token; reopen the panel from the URL printed by `ui`" });
    var run = function () {
      return uiReadBody(request).then(function (body) {
        return uiHandleApi(request.method, url.pathname, body);
      });
    };
    var task = request.method === "GET" ? run() : (uiQueue = uiQueue.then(run, run));
    task.then(function (result) {
      send(200, result);
    }, function (error) {
      send(error instanceof CliError ? 400 : 500, { error: error && error.message ? error.message : String(error) });
    });
  });
}

function uiReadState() {
  try {
    var state = JSON.parse(cliFs.readFileSync(UI_STATE_PATH, "utf8"));
    process.kill(state.pid, 0);
    return state;
  } catch (_error) {
    return null;
  }
}

function uiServe(port) {
  var token = uiCrypto.randomBytes(16).toString("hex");
  var server = uiCreateServer(token);
  return new Promise(function (resolve, reject) {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", function () {
      var actualPort = server.address().port;
      var panelUrl = "http://127.0.0.1:" + actualPort + "/?t=" + token;
      cliFs.mkdirSync(CLI_CONFIG_DIR, { recursive: true, mode: 448 });
      cliFs.writeFileSync(UI_STATE_PATH, JSON.stringify({ pid: process.pid, port: actualPort, url: panelUrl, version: CLI_VERSION, startedAt: new Date().toISOString() }), { mode: 384 });
      resolve({ server: server, url: panelUrl });
    });
  });
}

async function uiCommand(args) {
  var sub = args.positional[1];
  var existing = uiReadState();
  if (sub === "stop") {
    if (existing == null) return cliPrint("panel is not running");
    process.kill(existing.pid, "SIGTERM");
    try {
      cliFs.unlinkSync(UI_STATE_PATH);
    } catch (_error) {}
    return cliPrint("panel stopped (pid " + existing.pid + ")");
  }
  if (sub === "status") {
    return cliPrint(existing == null ? "panel is not running" : "panel running: " + existing.url + " (pid " + existing.pid + ", version " + (existing.version || "unknown") + ")");
  }
  if (existing != null && existing.version !== CLI_VERSION) {
    cliPrint("replacing stale panel version " + (existing.version || "unknown") + " with " + CLI_VERSION);
    process.kill(existing.pid, "SIGTERM");
    for (var wait = 0; wait < 40; wait += 1) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 50);
      });
      try {
        process.kill(existing.pid, 0);
      } catch (_stopped) {
        break;
      }
    }
    try {
      cliFs.unlinkSync(UI_STATE_PATH);
    } catch (_error) {}
    existing = null;
  }
  if (existing != null) {
    cliPrint("panel already running: " + existing.url);
    cliPrint("open this URL in the browser on the cloud machine (not on your own computer).");
    return;
  }
  var port = args.flags.port != null ? Number(args.flags.port) : UI_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError("--port must be 0-65535");
  if (args.flags.background) {
    cliFs.mkdirSync(CLI_CONFIG_DIR, { recursive: true, mode: 448 });
    var log = cliFs.openSync(UI_LOG_PATH, "a", 384);
    var child = uiChild.spawn(process.execPath, [__filename, "ui", "--port", String(port)], { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
    for (var i = 0; i < 50; i += 1) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 100);
      });
      var started = uiReadState();
      if (started != null && started.pid === child.pid) {
        cliPrint("panel running: " + started.url);
        cliPrint("open this URL in the browser on the cloud machine (not on your own computer). `ui stop` stops it.");
        return;
      }
    }
    throw new CliError("panel did not start; see " + UI_LOG_PATH);
  }
  var served = await uiServe(port);
  cliPrint("panel running: " + served.url);
  cliPrint("open this URL in the browser on the cloud machine (not on your own computer). Ctrl+C stops it.");
  var stop = function () {
    try {
      cliFs.unlinkSync(UI_STATE_PATH);
    } catch (_error) {}
    served.server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(function () {});
}

var UI_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grok Bot Switch</title>
<style>
:root{
  --bg:#f5f6f8;--card:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--line-strong:#d1d5db;
  --primary:#2563eb;--primary-text:#fff;--primary-soft:rgba(37,99,235,.10);
  --ok:#15803d;--ok-soft:rgba(21,128,61,.12);--bad:#dc2626;--bad-soft:rgba(220,38,38,.10);--warn:#b45309;--warn-soft:rgba(180,83,9,.12);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius:14px;--shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -12px rgba(0,0,0,.12)
}
@media(prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#151922;--text:#e5e7eb;--muted:#9ca3af;--line:#262b36;--line-strong:#343a47;--primary:#3b82f6;--primary-soft:rgba(59,130,246,.16);--ok:#22c55e;--ok-soft:rgba(34,197,94,.14);--bad:#f87171;--bad-soft:rgba(248,113,113,.14);--warn:#f59e0b;--warn-soft:rgba(245,158,11,.14);--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -12px rgba(0,0,0,.6)}}
*{box-sizing:border-box}html,body{margin:0}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans SC",sans-serif;background:var(--bg);color:var(--text)}
button{font:inherit;cursor:pointer}
.app{max-width:760px;margin:0 auto;padding:20px 16px 96px}
/* top bar */
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#2563eb,#7c3aed);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px}
.brand h1{font-size:17px;margin:0;line-height:1.2}.brand small{color:var(--muted);font-size:12px}
.icon-btn{border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:10px;padding:7px 10px;font-size:13px}
.icon-btn:hover{color:var(--text);border-color:var(--line-strong)}
/* status strip */
.status{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px;margin-bottom:18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.status .now{flex:1;min-width:200px}
.status .now .label{font-size:12px;color:var(--muted)}
.status .now .value{font-size:16px;font-weight:650;margin-top:2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.status .now .sub{font-size:12px;color:var(--muted);font-family:var(--mono);word-break:break-all;margin-top:2px}
.dots{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.dot{display:inline-flex;align-items:center;gap:6px}
.dot::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--line-strong)}
.dot.ok::before{background:var(--ok)}.dot.warn::before{background:var(--warn)}.dot.bad::before{background:var(--bad)}
/* section headers */
.section{display:flex;align-items:center;justify-content:space-between;margin:6px 2px 10px}
.section h2{font-size:13px;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);margin:0;font-weight:600}
/* cards */
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px;margin-bottom:10px;position:relative;transition:border-color .15s}
.card.active{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft),var(--shadow)}
.card-row{display:flex;gap:12px;align-items:flex-start}
.avatar{width:38px;height:38px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;background:var(--bg);border:1px solid var(--line);color:var(--text)}
.avatar.grok{background:#111;color:#fff;border-color:#111}.avatar.oa{background:#0f9d7a;color:#fff;border-color:#0f9d7a}.avatar.an{background:#d97757;color:#fff;border-color:#d97757}.avatar.gpt{background:#000;color:#fff;border-color:#000}
.card-main{flex:1;min-width:0}
.title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.title h3{font-size:15px;margin:0;font-weight:650;word-break:break-all}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--bg);border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}.badge.warn{background:var(--warn-soft);color:var(--warn);border-color:transparent}.badge.bad{background:var(--bad-soft);color:var(--bad);border-color:transparent}.badge.info{background:var(--primary-soft);color:var(--primary);border-color:transparent}
.endpoint{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:4px;word-break:break-all}
.meta{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:4px}
.actions{display:flex;gap:6px;flex:none;align-items:center}
.btn{border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:9px;padding:7px 12px;font-size:13px;white-space:nowrap}
.btn:hover{border-color:var(--line-strong);background:var(--bg)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-text)}.btn.primary:hover{filter:brightness(1.05);background:var(--primary)}
.btn.ghost{border-color:transparent;color:var(--muted);padding:7px 8px}.btn.ghost:hover{color:var(--text);background:var(--bg)}
.btn.danger{color:var(--bad)}.btn.danger:hover{background:var(--bad-soft)}
.btn:disabled{opacity:.45;cursor:default;filter:none}
.btn.lg{padding:10px 16px;font-size:14px}
@media(max-width:560px){.card-row{flex-wrap:wrap}.actions{width:100%;justify-content:flex-end;margin-top:6px}}
.empty{text-align:center;color:var(--muted);padding:28px 16px;border:1px dashed var(--line-strong);border-radius:var(--radius);margin-bottom:10px}
/* codex card */
.code{font-family:var(--mono);font-size:28px;letter-spacing:3px;font-weight:700;color:var(--primary)}
.steps{margin:10px 0 0;padding-left:18px;font-size:13px}.steps li{margin:4px 0}
/* fab */
.fab{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:12px 22px;border-radius:999px;background:var(--primary);color:#fff;border:0;font-size:15px;font-weight:600;box-shadow:0 10px 30px -8px rgba(37,99,235,.6);z-index:5}
.fab:hover{filter:brightness(1.06)}
/* dialogs */
dialog{border:0;border-radius:16px;padding:0;background:var(--card);color:var(--text);box-shadow:0 30px 80px -20px rgba(0,0,0,.4);width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 40px)}
dialog::backdrop{background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}
.dlg-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 0}
.dlg-head h2{font-size:17px;margin:0}
.dlg-body{padding:16px 20px 4px;overflow:auto;max-height:calc(100vh - 190px)}
.dlg-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px 18px;border-top:1px solid var(--line);margin-top:8px}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px;font-weight:500}
input,select{font:inherit;width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
input:focus,select:focus{outline:2px solid var(--primary-soft);border-color:var(--primary)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:480px){.grid2{grid-template-columns:1fr}}
.presets{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.preset{border:1px solid var(--line);background:var(--bg);border-radius:999px;padding:5px 11px;font-size:12px;color:var(--text)}
.preset.on{background:var(--primary);color:#fff;border-color:var(--primary)}
.hint{font-size:12px;color:var(--muted);margin-top:5px;word-break:break-all}
details.adv summary{cursor:pointer;color:var(--muted);font-size:13px;margin:4px 0 10px;list-style:none}
details.adv summary::before{content:"▸ "}details.adv[open] summary::before{content:"▾ "}
.form-msg{font-size:13px;margin-top:6px;min-height:18px}.form-msg.ok{color:var(--ok)}.form-msg.bad{color:var(--bad)}
/* toast */
.toasts{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:20;width:min(520px,calc(100vw - 32px))}
.toast{background:#111827;color:#f9fafb;padding:11px 14px;border-radius:12px;font-size:13px;box-shadow:0 12px 30px -10px rgba(0,0,0,.5);animation:in .18s ease-out;word-break:break-all}
.toast.ok{background:#14532d}.toast.bad{background:#7f1d1d}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
/* footer sections */
.usage{width:100%;border-collapse:collapse;font-size:13px}.usage th,.usage td{text-align:left;padding:8px 8px;border-top:1px solid var(--line)}.usage th{border-top:0;color:var(--muted);font-weight:500;font-size:12px}
.usage td:not(:first-child),.usage th:not(:first-child){text-align:right}
pre.log{font-family:var(--mono);font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto;margin:10px 0 0}
details.more summary{cursor:pointer;list-style:none;padding:4px 2px;color:var(--muted);font-size:13px}
details.more summary::before{content:"▸ "}details.more[open] summary::before{content:"▾ "}
.help{font-size:13px;color:var(--muted);line-height:1.7}.help code{font-family:var(--mono);background:var(--bg);padding:1px 6px;border-radius:6px;border:1px solid var(--line)}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="brand"><div class="logo">GS</div><div><h1>Grok Bot Switch</h1><small id="version"></small></div></div>
    <div style="display:flex;gap:6px">
      <button class="icon-btn" id="btn-help">聊天命令</button>
      <button class="icon-btn" id="btn-refresh">刷新</button>
    </div>
  </div>

  <div class="status" id="status"></div>

  <div class="section"><h2>模型来源</h2><span id="count" style="font-size:12px;color:var(--muted)"></span></div>
  <div id="list"></div>

  <div class="section" style="margin-top:22px"><h2>ChatGPT 订阅</h2></div>
  <div class="card" id="codex"></div>

  <div class="section" style="margin-top:22px"><h2>用量与记录</h2></div>
  <div class="card" id="usage"></div>

  <details class="more" style="margin-top:14px"><summary>主程序与补丁状态 · 维护操作</summary>
    <div class="card" style="margin-top:8px" id="host"></div>
  </details>
</div>

<button class="fab" id="fab">＋ 添加模型来源</button>

<dialog id="dlg-provider">
  <div class="dlg-head"><h2 id="dlg-title">添加模型来源</h2><button class="btn ghost" data-close>✕</button></div>
  <form id="form" class="dlg-body" novalidate>
    <div class="presets" id="presets"></div>
    <div class="grid2">
      <div class="field"><label>名字（用于 /gs use 名字）</label><input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="myapi" autocomplete="off"></div>
      <div class="field"><label>协议</label><select name="protocol"><option value="openai-chat">OpenAI Chat Completions（推荐，兼容最广）</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages（Claude）</option></select></div>
    </div>
    <div class="field"><label>接口根地址</label><input name="baseUrl" required placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"><div class="hint" id="url-hint"></div></div>
    <div class="grid2">
      <div class="field"><label>模型</label><input name="model" required placeholder="gpt-5" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label>API key <span id="key-note" style="color:var(--muted)"></span></label><input name="apiKey" type="password" autocomplete="new-password" placeholder="sk-..."></div>
    </div>
    <details class="adv"><summary>高级选项</summary>
      <div class="grid2">
        <div class="field"><label>认证方式</label><select name="authType"><option value="">按协议默认</option><option value="bearer">Authorization: Bearer</option><option value="x-api-key">x-api-key</option><option value="none">无</option></select></div>
        <div class="field"><label>自定义请求路径</label><input name="endpointPath" placeholder="/v1/chat/completions" autocomplete="off"></div>
        <div class="field"><label>reasoning effort（OpenAI）</label><input name="reasoning" placeholder="medium" autocomplete="off"></div>
        <div class="field"><label>max tokens</label><input name="maxTokens" type="number" min="1" placeholder="Anthropic 默认 8192"></div>
      </div>
      <div class="field"><label>额外请求头（每行一个，Name: value）</label><input name="headers" placeholder="X-Team: blue" autocomplete="off"></div>
    </details>
    <div class="form-msg" id="form-msg"></div>
  </form>
  <div class="dlg-foot"><button class="btn" data-close>取消</button><button class="btn" id="btn-save-only">测试并保存</button><button class="btn primary" id="btn-save-use">测试、保存并使用</button></div>
</dialog>

<dialog id="dlg-confirm">
  <div class="dlg-head"><h2 id="confirm-title">确认</h2></div>
  <div class="dlg-body" id="confirm-body" style="font-size:14px"></div>
  <div class="dlg-foot"><button class="btn" data-close>取消</button><button class="btn danger" id="confirm-ok">确定</button></div>
</dialog>

<dialog id="dlg-help">
  <div class="dlg-head"><h2>在聊天里切换</h2><button class="btn ghost" data-close>✕</button></div>
  <div class="dlg-body help">
    这些消息在云端主程序里直接处理，不发给任何模型、不花 token，任何平台都一样：<br>
    <code>/gs use 名字</code> 切到某个模型来源，下一条消息生效<br>
    <code>/gs official</code> 切回官方 Grok<br>
    <code>/gs status</code> 看当前走哪里、保存了哪些来源<br><br>
    添加来源（带 key）只能在这个面板或云端终端里做；<code>/gs</code> 命令不接受 key。
  </div>
  <div class="dlg-foot"><button class="btn primary" data-close>知道了</button></div>
</dialog>

<div class="toasts" id="toasts"></div>

<script>
const token=new URLSearchParams(location.search).get("t")||"";
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let state=null,timer=null,editing=null;
const PRESETS=[
  {id:"custom",label:"自定义 / 中转站",protocol:"openai-chat",url:"",model:""},
  {id:"openai",label:"OpenAI",protocol:"openai-chat",url:"https://api.openai.com/v1",model:"gpt-5",avatar:"oa"},
  {id:"deepseek",label:"DeepSeek",protocol:"openai-chat",url:"https://api.deepseek.com",model:"deepseek-chat"},
  {id:"xai",label:"xAI",protocol:"openai-chat",url:"https://api.x.ai/v1",model:"grok-4",avatar:"grok"},
  {id:"kimi",label:"Kimi",protocol:"openai-chat",url:"https://api.moonshot.cn/v1",model:"kimi-k2-0905-preview"},
  {id:"qwen",label:"通义千问",protocol:"openai-chat",url:"https://dashscope.aliyuncs.com/compatible-mode/v1",model:"qwen3-max"},
  {id:"openrouter",label:"OpenRouter",protocol:"openai-chat",url:"https://openrouter.ai/api/v1",model:"openai/gpt-5"},
  {id:"anthropic",label:"Anthropic",protocol:"anthropic-messages",url:"https://api.anthropic.com/v1",model:"claude-sonnet-4-5",avatar:"an"}
];
const DEFAULT_PATH={"openai-chat":"/chat/completions","openai-responses":"/responses","anthropic-messages":"/messages"};

async function api(path,body){const r=await fetch(path,{method:body===undefined?"GET":"POST",headers:{"x-gs-token":token,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||r.statusText);return j;}
function toast(text,cls){const el=document.createElement("div");el.className="toast "+(cls||"");el.textContent=text;$("#toasts").appendChild(el);setTimeout(()=>el.remove(),cls==="bad"?7000:3500);}
function confirmDlg(title,body){return new Promise(res=>{$("#confirm-title").textContent=title;$("#confirm-body").textContent=body;const d=$("#dlg-confirm");const ok=$("#confirm-ok");const done=v=>{d.close();ok.onclick=null;res(v)};ok.onclick=()=>done(true);d.onclose=()=>res(false);d.showModal();});}
function avatarFor(name,p){if(p&&p.authType==="codex")return{cls:"gpt",text:"AI"};const u=(p&&p.baseUrl||"").toLowerCase();if(u.includes("openai.com"))return{cls:"oa",text:"O"};if(u.includes("anthropic"))return{cls:"an",text:"A"};if(u.includes("x.ai"))return{cls:"grok",text:"X"};return{cls:"",text:name.slice(0,1).toUpperCase()};}
function badgeProto(p){return p.protocol==="anthropic-messages"?"Anthropic":p.protocol==="openai-responses"?"Responses":"Chat"}

function render(){
  $("#version").textContent="v"+state.version;
  const h=state.host,sup=h.supervisor;
  const route=state.route,active=state.active,ap=active?state.providers[active]:null;
  const restartPending=h.runningCurrentBundle===false||!!sup.pending;
  $("#status").innerHTML=
    '<div class="now"><div class="label">当前对话使用</div><div class="value">'+
    (route==="official"?'官方 Grok':route==="external"?esc(active)+' <span class="badge info">'+esc(ap?badgeProto(ap):"")+'</span>':'<span class="badge bad">配置有误</span>')+
    (restartPending?' <span class="badge warn">等待主程序重启</span>':'')+'</div>'+
    (route==="external"&&ap?'<div class="sub">'+esc(ap.summary)+'</div>':route==="error"?'<div class="sub">'+esc(state.routeError)+'</div>':'<div class="sub">选择下面任一来源后，下一条消息生效</div>')+'</div>'+
    '<div class="dots">'+
      '<span class="dot '+(h.exists?(h.patched?"ok":"warn"):"bad")+'">'+(h.exists?(h.patched?"补丁已就位":"未打补丁"):"未找到主程序")+'</span>'+
      '<span class="dot '+(h.process?(h.runningCurrentBundle===false?"warn":"ok"):"warn")+'">'+(h.process?(h.runningCurrentBundle===false?"重启待执行":"主程序运行中"):"主程序未运行")+'</span>'+
      '<span class="dot '+(sup.busy?"warn":"ok")+'">'+(sup.busy?"Bot 忙碌中":"空闲")+'</span>'+
    '</div>';
  const names=Object.keys(state.providers);
  $("#count").textContent=names.length?names.length+" 个自定义来源":"";
  let html='<div class="card'+(route==="official"?" active":"")+'"><div class="card-row"><div class="avatar grok">G</div><div class="card-main"><div class="title"><h3>官方 Grok</h3><span class="badge">原厂通道</span>'+(route==="official"?'<span class="badge ok">使用中</span>':"")+'</div><div class="endpoint">Grok Bot 原生推理，走你的 Grok 额度</div></div><div class="actions">'+(route==="official"?"":'<button class="btn primary" data-act="official">使用</button>')+'</div></div></div>';
  if(names.length===0)html+='<div class="empty">还没有自定义模型来源。点下方"添加模型来源"，或在右侧 ChatGPT 卡片登录。</div>';
  for(const n of names){const p=state.providers[n],isActive=active===n,av=avatarFor(n,p);
    html+='<div class="card'+(isActive?" active":"")+'"><div class="card-row"><div class="avatar '+av.cls+'">'+esc(av.text)+'</div><div class="card-main"><div class="title"><h3>'+esc(n)+'</h3><span class="badge">'+esc(badgeProto(p))+'</span>'+(isActive?'<span class="badge ok">使用中</span>':"")+(p.valid?"":'<span class="badge bad">配置无效</span>')+'</div>'+
    '<div class="endpoint">'+esc(p.valid?"POST "+p.summary.split(" ")[1]:p.summary)+'</div><div class="meta"><span>'+esc(p.model||"")+'</span><span>'+(p.authType==="codex"?"ChatGPT 登录":p.authType==="none"?"无需密钥":p.hasKey?"已保存密钥":"未填密钥")+'</span></div></div>'+
    '<div class="actions">'+(isActive?"":'<button class="btn primary" data-act="use" data-n="'+esc(n)+'">使用</button>')+'<button class="btn ghost" data-act="test" data-n="'+esc(n)+'">测试</button><button class="btn ghost" data-act="edit" data-n="'+esc(n)+'">编辑</button><button class="btn ghost danger" data-act="remove" data-n="'+esc(n)+'"'+(isActive?" disabled":"")+'>删除</button></div></div></div>';}
  $("#list").innerHTML=html;

  const c=state.codex,job=c.jobs["codex-login"],inst=c.jobs["codex-install"];let cx='<div class="card-row"><div class="avatar gpt">AI</div><div class="card-main"><div class="title"><h3>用 ChatGPT Plus / Pro 额度</h3>'+(c.installed?(c.loggedIn?'<span class="badge ok">已登录</span>':'<span class="badge">未登录</span>'):'<span class="badge warn">未安装 Codex CLI</span>')+'</div>';
  cx+='<div class="meta" style="margin-top:6px"><span>不需要 API key，登录在你自己的设备上完成。OpenAI 条款上属擦边行为，账号有被限风险。</span></div>';
  if(!c.installed){cx+=(inst&&inst.status==="failed"?'<div class="form-msg bad">'+esc(inst.error)+'</div>':"")+(inst&&inst.output?'<pre class="log">'+esc(inst.output)+'</pre>':"");}
  else if(job&&job.status==="running"){cx+='<ol class="steps"><li>在你自己的手机或电脑浏览器打开 '+(job.url?'<b>'+esc(job.url)+'</b>':"…")+'</li><li>输入验证码 <span class="code">'+esc(job.code||"获取中…")+'</span></li><li>登录完成后这里会自动更新</li></ol>';}
  else{cx+='<div class="grid2" style="margin-top:10px"><div class="field" style="margin:0"><label>保存为来源名</label><input id="codex-name" value="chatgpt"></div><div class="field" style="margin:0"><label>模型</label><input id="codex-model" value="'+esc(c.defaultModel||"gpt-5.4")+'"></div></div>'+(job&&job.status==="done"?'<div class="form-msg ok">登录成功，已保存来源。'+esc(job.error||"")+'</div>':job&&job.status==="failed"?'<div class="form-msg bad">'+esc(job.error||"登录失败")+'</div>':"");}
  cx+='</div><div class="actions">'+(!c.installed?'<button class="btn primary" data-act="codex-install"'+(inst&&inst.status==="running"?" disabled":"")+'>'+(inst&&inst.status==="running"?"安装中…":"安装 Codex CLI")+'</button>':job&&job.status==="running"?'<button class="btn" data-act="codex-cancel">取消</button>':'<button class="btn primary" data-act="codex-login">'+(c.loggedIn?"重新登录并保存":"登录 ChatGPT")+'</button>')+'</div></div>';
  $("#codex").innerHTML=cx;

  const u=state.usage,un=Object.keys(u);
  $("#usage").innerHTML=(un.length?'<table class="usage"><tr><th>来源</th><th>请求</th><th>失败</th><th>输入 token</th><th>输出 token</th></tr>'+un.map(n=>'<tr><td>'+esc(n)+'</td><td>'+u[n].requests+'</td><td>'+u[n].failed+'</td><td>'+u[n].promptTokens.toLocaleString()+'</td><td>'+u[n].completionTokens.toLocaleString()+'</td></tr>').join("")+'</table>':'<div style="color:var(--muted);font-size:13px">还没有外部请求。</div>')+
    (state.recent.length?'<pre class="log">'+esc(state.recent.map(e=>e.raw||[(e.ts||"").slice(11,19),e.provider||"-",e.model||"-",e.kind||"-","HTTP "+e.status,(e.ms||0)+"ms",e.usage?e.usage.promptTokens+"+"+e.usage.completionTokens:"",e.error?"ERROR "+e.error:""].filter(Boolean).join("  ")).join("\n"))+'</pre>':"");

  $("#host").innerHTML='<div class="meta" style="margin:0 0 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px"><span>主程序</span><span>'+esc(h.path)+(h.version?" · "+esc(h.version):"")+' · '+(h.patched?"已打补丁 "+esc(h.patchVersion):"未打补丁")+'</span><span>进程</span><span>'+(h.process?"pid "+h.process.pid+(h.process.startedAtMs?" · 启动于 "+new Date(h.process.startedAtMs).toLocaleString():""):"未运行")+'</span><span>supervisor</span><span>'+(sup.busy?"有 Bot 在忙":"空闲")+(sup.pending?" · 待处理命令 "+esc(sup.pending.id):"")+'</span><span>配置文件</span><span>'+esc(state.configPath)+'</span></div><div class="actions" style="justify-content:flex-start;flex-wrap:wrap"><button class="btn" data-act="restart">请求重启主程序</button><button class="btn danger" data-act="restore">卸载补丁并恢复原厂</button></div>';

  const running=Object.values(c.jobs).some(j=>j.status==="running")||restartPending;
  clearTimeout(timer);timer=setTimeout(refresh,running?2000:15000);
}
let firstRender=true;
async function refresh(){try{state=await api("/api/state");render();if(firstRender){firstRender=false;if(location.hash==="#add")openForm(null);}}catch(e){toast(e.message,"bad");}}
function apply(r){if(r.state){state=r.state;render();}}

async function act(action,name){
  try{
    if(action==="use"){const r=await api("/api/use",{name});apply(r);toast(r.lines[0]+(r.lines.some(l=>/restart requested/.test(l))?"；主程序将在空闲时重启一次":""),"ok");}
    else if(action==="official"){apply(await api("/api/official",{}));toast("已切回官方 Grok，下一条消息生效","ok");}
    else if(action==="test"){toast("正在向 "+name+" 发测试请求…");const r=await api("/api/test",{name});toast(r.probe.ok?name+" 正常，"+r.probe.ms+"ms，回复 "+JSON.stringify(r.probe.text):name+" 失败："+r.probe.error,r.probe.ok?"ok":"bad");refresh();}
    else if(action==="remove"){if(!await confirmDlg("删除来源 "+name,"只删除这条配置，不影响其它来源。"))return;apply(await api("/api/providers/delete",{name}));toast("已删除 "+name,"ok");}
    else if(action==="edit"){openForm(name);}
    else if(action==="restart"){const r=await api("/api/restart",{});apply(r);toast(r.lines.join(" "),"ok");}
    else if(action==="restore"){if(!await confirmDlg("卸载补丁","主程序恢复为原厂文件并重启一次；已保存的来源配置不会删除。"))return;const r=await api("/api/restore",{});apply(r);toast(r.lines.join(" "),"ok");}
    else if(action==="codex-install"){apply(await api("/api/codex/install",{}));}
    else if(action==="codex-login"){apply(await api("/api/codex/login",{name:($("#codex-name")||{}).value||"chatgpt",model:($("#codex-model")||{}).value||""}));}
    else if(action==="codex-cancel"){apply(await api("/api/codex/cancel",{}));}
  }catch(e){toast(e.message,"bad");}
}

/* form */
function setPreset(id){const f=$("#form"),p=PRESETS.find(x=>x.id===id);document.querySelectorAll(".preset").forEach(b=>b.classList.toggle("on",b.dataset.id===id));if(!p)return;f.protocol.value=p.protocol;if(p.url)f.baseUrl.value=p.url;if(p.model)f.model.value=p.model;if(!f.name.value&&id!=="custom")f.name.value=id;urlHint();}
function urlHint(){const f=$("#form");$("#url-hint").textContent="实际请求："+(f.baseUrl.value.trim()||"https://api.example.com/v1").replace(/\/+$/,"")+(f.endpointPath.value.trim()||DEFAULT_PATH[f.protocol.value]);}
function openForm(name){const f=$("#form");f.reset();editing=name||null;$("#dlg-title").textContent=name?"编辑 "+name:"添加模型来源";$("#form-msg").textContent="";$("#key-note").textContent=name?"（留空 = 不改）":"";
  if(name){const p=state.providers[name];f.name.value=name;f.protocol.value=p.protocol||"openai-chat";f.baseUrl.value=p.baseUrl||"";f.model.value=p.model||"";f.authType.value=p.authType&&p.authType!=="codex"?p.authType:"";f.endpointPath.value=p.endpointPath||"";f.reasoning.value=p.parameters?.reasoningEffort||"";f.maxTokens.value=p.parameters?.maxTokens||"";f.headers.value=p.headers?Object.entries(p.headers).map(([k,v])=>k+": "+v).join("\n"):"";document.querySelectorAll(".preset").forEach(b=>b.classList.remove("on"));}
  else setPreset("custom");
  f.name.readOnly=!!name;urlHint();$("#dlg-provider").showModal();}
async function save(useAfter){const f=$("#form");if(!f.reportValidity())return;const body={name:f.name.value.trim(),protocol:f.protocol.value,baseUrl:f.baseUrl.value.trim(),model:f.model.value.trim(),apiKey:f.apiKey.value,authType:f.authType.value,endpointPath:f.endpointPath.value.trim(),reasoning:f.reasoning.value.trim(),maxTokens:f.maxTokens.value,headers:f.headers.value.split("\n").map(s=>s.trim()).filter(Boolean)};
  const btns=[$("#btn-save-only"),$("#btn-save-use")];btns.forEach(b=>b.disabled=true);const msg=$("#form-msg");msg.className="form-msg";msg.textContent="正在保存并向它发一条测试请求…";
  try{const r=await api("/api/providers",body);apply(r);if(r.probe&&!r.probe.ok){msg.className="form-msg bad";msg.textContent="已保存，但测试请求失败："+r.probe.error;return;}
    $("#dlg-provider").close();toast(body.name+" 测试通过（"+r.probe.ms+"ms）","ok");if(useAfter)await act("use",body.name);}
  catch(e){msg.className="form-msg bad";msg.textContent=e.message;}finally{btns.forEach(b=>b.disabled=false);}}

/* wiring */
document.addEventListener("click",e=>{const t=e.target.closest("[data-act]");if(t){act(t.dataset.act,t.dataset.n);return;}if(e.target.closest("[data-close]")){e.target.closest("dialog").close();}});
$("#fab").addEventListener("click",()=>openForm(null));
$("#btn-refresh").addEventListener("click",refresh);
$("#btn-help").addEventListener("click",()=>$("#dlg-help").showModal());
$("#btn-save-only").addEventListener("click",()=>save(false));
$("#btn-save-use").addEventListener("click",()=>save(true));
$("#presets").innerHTML=PRESETS.map(p=>'<button type="button" class="preset" data-id="'+p.id+'">'+esc(p.label)+'</button>').join("");
$("#presets").addEventListener("click",e=>{const b=e.target.closest(".preset");if(b)setPreset(b.dataset.id);});
$("#form").addEventListener("input",urlHint);$("#form").addEventListener("change",urlHint);
$("#form").addEventListener("submit",e=>{e.preventDefault();save(true);});
refresh();
</script>
</body></html>`;
