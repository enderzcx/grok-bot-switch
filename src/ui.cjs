// grok-switch web panel. Listens on 127.0.0.1 inside the Grok Bot cloud
// machine; the user reaches it through Grok Bot's cloud desktop browser.
// Appended by build.mjs before cli.cjs; cli* helpers are in scope.

var uiHttp = require("node:http");
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

// Lists models the provider exposes (GET <baseUrl>/models, the OpenAI and
// Anthropic convention) so the form can offer them instead of requiring the
// exact id to be typed. Works from the form's current values; when editing a
// saved provider with the key left blank, the stored key is used.
async function uiFetchModels(body) {
  var config = cliReadRawConfig();
  var existing = body.name && config.providers[body.name] ? config.providers[body.name] : null;
  var raw = {
    protocol: body.protocol || (existing && existing.protocol) || "openai-chat",
    baseUrl: body.baseUrl || (existing && existing.baseUrl),
    model: "placeholder",
    apiKey: body.apiKey || (existing && existing.apiKey) || "",
    authType: body.authType || (existing && existing.authType) || void 0,
    headers: existing && existing.headers ? existing.headers : void 0
  };
  if (Array.isArray(body.headers) && body.headers.length > 0) {
    raw.headers = {};
    for (var i = 0; i < body.headers.length; i += 1) {
      var line = String(body.headers[i]);
      var colon = line.indexOf(":");
      if (colon > 0) raw.headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  var provider;
  try {
    provider = grokSwitchNormalizeProvider(body.name || "draft", raw);
  } catch (error) {
    throw new CliError(error.message);
  }
  if (provider.authType === "codex") return { models: [], note: "ChatGPT 登录方式不提供模型列表，请直接填写模型名" };
  var codex = null;
  var headers = grokSwitchBuildHeaders(provider, { accept: "application/json" }, codex);
  if (provider.protocol === "anthropic-messages") headers["anthropic-version"] = (provider.parameters && provider.parameters.anthropicVersion) || "2023-06-01";
  var url = provider.baseUrl + "/models" + provider.baseQuery;
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, 15000);
  var response;
  try {
    response = await fetch(url, { method: "GET", headers: headers, redirect: "error", signal: controller.signal });
  } catch (error) {
    throw new CliError("无法连接 " + url + (error && error.cause && error.cause.message ? "（" + error.cause.message + "）" : ""));
  } finally {
    clearTimeout(timer);
  }
  var text = await response.text();
  if (!response.ok) throw new CliError("GET " + url + " 返回 HTTP " + response.status + (text ? "：" + text.slice(0, 300) : ""));
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new CliError(url + " 返回的不是 JSON");
  }
  var list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
  var ids = [];
  for (var j = 0; j < list.length; j += 1) {
    var item = list[j];
    var id = typeof item === "string" ? item : item && (item.id || item.name || item.model);
    if (typeof id === "string" && id.length > 0 && ids.indexOf(id) === -1) ids.push(id);
  }
  ids.sort();
  return { models: ids, url: url };
}

async function uiHandleApi(method, pathname, body) {
  if (method === "GET" && pathname === "/api/state") return uiState();
  if (method === "POST" && pathname === "/api/models") return uiFetchModels(body);
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
  if (method === "POST" && pathname === "/api/providers/duplicate") {
    var source = cliRequireProviderName(body.name);
    var target = cliRequireProviderName(body.newName);
    var dupConfig = cliReadRawConfig();
    if (dupConfig.providers[source] == null) throw new CliError("no provider named " + source);
    if (dupConfig.providers[target] != null) throw new CliError("已有名为 " + target + " 的来源");
    dupConfig.providers[target] = JSON.parse(JSON.stringify(dupConfig.providers[source]));
    cliWriteConfig(dupConfig);
    return { saved: target, state: uiState() };
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

// The API is reachable only from the panel page itself. The server binds to
// 127.0.0.1; on top of that every API request must (a) carry a loopback Host
// header (defeats DNS rebinding), (b) carry no Origin or one equal to the
// panel's own origin (a page on another site cannot forge that), and (c) carry
// a custom header, which cross-site requests cannot add without a CORS
// preflight this server never approves. Processes on the same machine and
// user can read the config file anyway, so a secret token would add nothing.
function uiRequestAllowed(request) {
  var hostHeader = String(request.headers.host || "");
  var hostname;
  try {
    hostname = new URL("http://" + hostHeader).hostname;
  } catch (_error) {
    return false;
  }
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") return false;
  var origin = request.headers.origin;
  if (origin != null && origin !== "http://" + hostHeader) return false;
  return request.headers["x-gs-panel"] != null;
}

function uiCreateServer() {
  return uiHttp.createServer(function (request, response) {
    var url = new URL(request.url, "http://127.0.0.1");
    var send = function (status, payload, type) {
      var data = type ? payload : JSON.stringify(payload);
      response.writeHead(status, { "content-type": type || "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(data);
    };
    if (url.pathname === "/" && request.method === "GET") return send(200, UI_HTML, "text/html; charset=utf-8");
    if (url.pathname.indexOf("/api/") !== 0) return send(404, { error: "not found" });
    if (!uiRequestAllowed(request)) return send(403, { error: "requests must come from the panel page on this machine" });
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
  var server = uiCreateServer();
  return new Promise(function (resolve, reject) {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", function () {
      var actualPort = server.address().port;
      var panelUrl = "http://127.0.0.1:" + actualPort + "/";
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

