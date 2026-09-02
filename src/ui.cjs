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
      cliFs.writeFileSync(UI_STATE_PATH, JSON.stringify({ pid: process.pid, port: actualPort, url: panelUrl, startedAt: new Date().toISOString() }), { mode: 384 });
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
    return cliPrint(existing == null ? "panel is not running" : "panel running: " + existing.url + " (pid " + existing.pid + ")");
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
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grok Bot Switch</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1a1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--accent-text:#fff;--ok:#16a34a;--bad:#dc2626;--warn:#d97706;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e6e8eb;--muted:#9aa1ab;--line:#2a2f3a;--accent:#3b82f6}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans SC",sans-serif;background:var(--bg);color:var(--text)}
main{max-width:880px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1}
.kv{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;font-size:14px}.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-all}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--line)}
.pill.ok{background:rgba(22,163,74,.15);color:var(--ok)}.pill.bad{background:rgba(220,38,38,.15);color:var(--bad)}.pill.warn{background:rgba(217,119,6,.15);color:var(--warn)}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--text);padding:7px 14px;border-radius:8px;cursor:pointer}
button:hover{border-color:var(--accent)}button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}button.danger{color:var(--bad)}button:disabled{opacity:.5;cursor:default}
input,select{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}.field{margin-bottom:12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:600px){.grid2{grid-template-columns:1fr}}
.provider{display:flex;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}.provider:first-of-type{border-top:0}
.provider .name{font-weight:600}.provider .summary{font-size:13px;color:var(--muted);word-break:break-all}
pre{font-family:var(--mono);font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;margin:10px 0 0}
.msg{margin-top:10px;font-size:14px}.msg.ok{color:var(--ok)}.msg.bad{color:var(--bad)}
.code{font-family:var(--mono);font-size:26px;letter-spacing:2px;font-weight:700}
a{color:var(--accent)}small{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-top:1px solid var(--line)}th{color:var(--muted);font-weight:500;border-top:0}
</style>
</head>
<body><main>
<h1>Grok Bot Switch <small id="version"></small></h1>
<p class="sub">选择 Grok Bot 用哪个模型。切换下一条消息生效；也可以在聊天里发 <code>/gs use 名字</code>、<code>/gs official</code>。</p>

<section class="card" id="status-card">
<div class="row" style="margin-bottom:12px"><h2 class="grow" style="margin:0">状态</h2><button onclick="refresh()">刷新</button></div>
<dl class="kv" id="status"></dl>
<div class="row" style="margin-top:12px"><button id="btn-official" onclick="act('/api/official')">切回官方 Grok</button><button onclick="act('/api/restart')">请求重启主程序</button><button class="danger" onclick="confirm('去掉补丁并恢复原厂主程序？已保存的供应商不会删除。')&&act('/api/restore')">卸载补丁</button></div>
<div id="status-msg" class="msg"></div>
</section>

<section class="card">
<h2>供应商</h2>
<div id="providers"></div>
<div id="providers-msg" class="msg"></div>
</section>

<section class="card">
<h2>添加或修改供应商</h2>
<form id="form" onsubmit="saveProvider(event)">
<div class="grid2">
<div class="field"><label>名字（给自己看的，英文数字）</label><input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="myapi"></div>
<div class="field"><label>协议</label><select name="protocol" onchange="protocolChanged()"><option value="openai-chat">OpenAI Chat Completions（大多数中转站、DeepSeek、xAI）</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages（Claude）</option></select></div>
</div>
<div class="field"><label>接口根地址</label><input name="baseUrl" required placeholder="https://api.example.com/v1"><small id="url-hint"></small></div>
<div class="grid2">
<div class="field"><label>模型</label><input name="model" required placeholder="gpt-5"></div>
<div class="field"><label>API key <small>（修改已有供应商时留空 = 不改）</small></label><input name="apiKey" type="password" autocomplete="off" placeholder="sk-..."></div>
</div>
<details><summary style="cursor:pointer;color:var(--muted);font-size:13px">高级选项</summary>
<div class="grid2" style="margin-top:10px">
<div class="field"><label>认证方式</label><select name="authType"><option value="">按协议默认</option><option value="bearer">Authorization: Bearer</option><option value="x-api-key">x-api-key</option><option value="none">无</option></select></div>
<div class="field"><label>自定义请求路径</label><input name="endpointPath" placeholder="/v1/chat/completions"></div>
<div class="field"><label>reasoning effort（OpenAI）</label><input name="reasoning" placeholder="medium"></div>
<div class="field"><label>max tokens</label><input name="maxTokens" type="number" min="1" placeholder="Anthropic 默认 8192"></div>
</div>
<div class="field"><label>额外请求头（每行一个，Name: value）</label><input name="headers" placeholder="X-Team: blue"></div>
</details>
<div class="row" style="margin-top:8px"><button class="primary" type="submit" id="btn-save">保存并测试</button><label class="row" style="margin:0"><input type="checkbox" name="useNow" style="width:auto" checked> 测试通过后立即切换到它</label></div>
</form>
<div id="form-msg" class="msg"></div>
</section>

<section class="card" id="codex-card">
<h2>用 ChatGPT 订阅（Codex 登录）</h2>
<p class="sub" style="margin-bottom:12px">不需要 API key，用你的 ChatGPT Plus/Pro 额度。登录在你自己的设备上完成，云端只保存登录凭据。<b>注意</b>：这是让 Codex 后端为非 Codex 程序提供服务，OpenAI 条款上属擦边，账号有被限的可能。</p>
<div id="codex"></div>
</section>

<section class="card">
<h2>用量与最近请求</h2>
<div id="usage"></div>
<pre id="recent" style="display:none"></pre>
</section>
</main>
<script>
const token=new URLSearchParams(location.search).get("t")||"";
let state=null,timer=null;
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function api(path,body){const r=await fetch(path,{method:body===undefined?"GET":"POST",headers:{"x-gs-token":token,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||r.statusText);return j;}
function pill(text,cls){return '<span class="pill '+cls+'">'+esc(text)+'</span>'}
function render(){
  $("#version").textContent="v"+state.version;
  const h=state.host,s=[];
  s.push(["主程序",h.exists?(h.patched?pill("已打补丁 "+h.patchVersion,"ok"):pill("未打补丁","warn")):pill("找不到（不在云端？）","bad")]);
  if(h.process)s.push(["进程","pid "+h.process.pid+" · "+(h.runningCurrentBundle===true?pill("运行最新代码","ok"):h.runningCurrentBundle===false?pill("等待重启","warn"):"启动时间未知")]);else s.push(["进程",pill("未运行","warn")]);
  s.push(["supervisor",(h.supervisor.busy?"有 Bot 在忙":"空闲")+(h.supervisor.pending?" · 有待处理的重启命令":"")]);
  s.push(["当前走",state.route==="official"?"<b>官方 Grok</b>":state.route==="external"?"<b>"+esc(state.active)+"</b> — "+esc(state.providers[state.active]?.summary||""):pill("配置有误："+state.routeError,"bad")]);
  $("#status").innerHTML=s.map(([k,v])=>"<dt>"+k+"</dt><dd>"+v+"</dd>").join("");
  $("#btn-official").disabled=state.route==="official";
  const names=Object.keys(state.providers);
  $("#providers").innerHTML=names.length?names.map(n=>{const p=state.providers[n],active=state.active===n;return '<div class="provider"><div class="grow"><div class="name">'+esc(n)+(active?' '+pill("使用中","ok"):"")+(p.valid?"":' '+pill("配置无效","bad"))+'</div><div class="summary">'+esc(p.summary)+(p.authType==="codex"?" · ChatGPT 登录":p.hasKey?" · 已有 key":"")+'</div></div>'+(active?"":'<button class="primary" onclick="useProvider(\''+n+'\')">使用</button>')+'<button onclick="testProvider(\''+n+'\')">测试</button><button onclick="editProvider(\''+n+'\')">编辑</button><button class="danger" onclick="removeProvider(\''+n+'\')"'+(active?" disabled":"")+'>删除</button></div>'}).join(""):'<p class="sub" style="margin:0">还没有供应商，在下面添加一个。</p>';
  const c=state.codex,job=c.jobs["codex-login"],inst=c.jobs["codex-install"];let html="";
  if(!c.installed){html+='<div class="row">'+pill("云端未安装 Codex CLI","warn")+'<button onclick="act(\'/api/codex/install\')"'+(inst&&inst.status==="running"?" disabled":"")+'>'+(inst&&inst.status==="running"?"安装中…":"安装 Codex CLI")+'</button></div>';if(inst&&inst.output)html+='<pre>'+esc(inst.output)+'</pre>';if(inst&&inst.status==="failed")html+='<div class="msg bad">'+esc(inst.error)+'</div>';}
  else{html+='<div class="row">'+(c.loggedIn?pill("已登录 ChatGPT（账号 "+c.account+"）","ok"):pill("未登录","warn"))+'</div>';
    html+='<div class="grid2" style="margin-top:12px"><div class="field"><label>保存为供应商名</label><input id="codex-name" value="chatgpt"></div><div class="field"><label>模型</label><input id="codex-model" value="'+esc(c.defaultModel||"gpt-5.4")+'"></div></div>';
    if(job&&job.status==="running"){html+='<div class="row"><b>1.</b> 在你自己的手机或电脑浏览器打开 '+(job.url?'<a href="'+esc(job.url)+'" target="_blank">'+esc(job.url)+'</a>':"…")+'</div><div class="row" style="margin-top:8px"><b>2.</b> 输入验证码：<span class="code">'+esc(job.code||"获取中…")+'</span></div><div class="row" style="margin-top:8px"><small>登录完成后这里会自动更新。</small><button onclick="act(\'/api/codex/cancel\')">取消</button></div>';}
    else{html+='<div class="row"><button class="primary" onclick="codexLogin()">'+(c.loggedIn?"重新登录 / 保存为供应商":"登录 ChatGPT")+'</button></div>';if(job&&job.status==="done")html+='<div class="msg ok">登录成功，已保存供应商。'+(job.error?" "+esc(job.error):"")+'</div>';if(job&&job.status==="failed")html+='<div class="msg bad">'+esc(job.error||"登录失败")+'</div>';}
  }
  $("#codex").innerHTML=html;
  const u=state.usage,un=Object.keys(u);
  $("#usage").innerHTML=un.length?'<table><tr><th>供应商</th><th>请求</th><th>失败</th><th>输入 token</th><th>输出 token</th><th>最近</th></tr>'+un.map(n=>'<tr><td>'+esc(n)+'</td><td>'+u[n].requests+'</td><td>'+u[n].failed+'</td><td>'+u[n].promptTokens.toLocaleString()+'</td><td>'+u[n].completionTokens.toLocaleString()+'</td><td>'+esc((u[n].lastUsedAt||"").replace("T"," ").slice(0,19))+'</td></tr>').join("")+'</table>':'<p class="sub" style="margin:0">还没有外部请求。</p>';
  const rec=$("#recent");if(state.recent.length){rec.style.display="block";rec.textContent=state.recent.map(e=>e.raw||[(e.ts||"").slice(11,19),e.provider,e.model,e.kind,"HTTP "+e.status,(e.ms||0)+"ms",e.usage?e.usage.promptTokens+"+"+e.usage.completionTokens:"",e.error?"ERROR "+e.error:""].filter(Boolean).join("  ")).join("\n");}else rec.style.display="none";
  const running=Object.values(c.jobs).some(j=>j.status==="running")||state.host.runningCurrentBundle===false;
  clearTimeout(timer);timer=setTimeout(refresh,running?2000:15000);
}
async function refresh(){try{state=await api("/api/state");render();}catch(e){$("#status-msg").className="msg bad";$("#status-msg").textContent=e.message;}}
function show(id,text,ok){const el=$(id);el.className="msg "+(ok?"ok":"bad");el.textContent=text;}
async function act(path,body){try{const r=await api(path,body||{});if(r.state){state=r.state;render();}if(r.lines)show("#status-msg",r.lines.join(" "),true);}catch(e){show("#status-msg",e.message,false);}}
async function useProvider(n){try{const r=await api("/api/use",{name:n});state=r.state;render();show("#providers-msg",r.lines.join(" "),true);}catch(e){show("#providers-msg",e.message,false);}}
async function testProvider(n){show("#providers-msg","正在向 "+n+" 发测试请求…",true);try{const r=await api("/api/test",{name:n});show("#providers-msg",r.probe.ok?"OK，"+r.probe.ms+"ms，回复 "+JSON.stringify(r.probe.text):"失败："+r.probe.error,r.probe.ok);await refresh();}catch(e){show("#providers-msg",e.message,false);}}
async function removeProvider(n){if(!confirm("删除供应商 "+n+"？"))return;try{const r=await api("/api/providers/delete",{name:n});state=r.state;render();show("#providers-msg",r.lines.join(" "),true);}catch(e){show("#providers-msg",e.message,false);}}
function editProvider(n){const p=state.providers[n],f=$("#form");f.name.value=n;f.protocol.value=p.protocol||"openai-chat";f.baseUrl.value=p.baseUrl||"";f.model.value=p.model||"";f.apiKey.value="";f.authType.value=p.authType||"";f.endpointPath.value=p.endpointPath||"";f.reasoning.value=p.parameters?.reasoningEffort||"";f.maxTokens.value=p.parameters?.maxTokens||"";f.headers.value=p.headers?Object.entries(p.headers).map(([k,v])=>k+": "+v).join("\n"):"";protocolChanged();f.scrollIntoView({behavior:"smooth"});}
function protocolChanged(){const f=$("#form"),d={"openai-chat":"/chat/completions","openai-responses":"/responses","anthropic-messages":"/messages"}[f.protocol.value];$("#url-hint").textContent="实际请求 = 根地址 + "+d+"，例如 https://api.example.com/v1 → https://api.example.com/v1"+d;}
async function saveProvider(ev){ev.preventDefault();const f=ev.target,btn=$("#btn-save");btn.disabled=true;show("#form-msg","保存中，并向它发一条测试请求…",true);
  const body={name:f.name.value.trim(),protocol:f.protocol.value,baseUrl:f.baseUrl.value.trim(),model:f.model.value.trim(),apiKey:f.apiKey.value,authType:f.authType.value,endpointPath:f.endpointPath.value.trim(),reasoning:f.reasoning.value.trim(),maxTokens:f.maxTokens.value,headers:f.headers.value.split("\n").map(s=>s.trim()).filter(Boolean)};
  try{const r=await api("/api/providers",body);state=r.state;render();if(r.probe&&!r.probe.ok){show("#form-msg","已保存，但测试请求失败："+r.probe.error+"。请检查地址、key、模型。",false);}else{show("#form-msg","已保存，测试通过（"+r.probe.ms+"ms，回复 "+JSON.stringify(r.probe.text)+"）。",true);if(f.useNow.checked)await useProvider(body.name);f.apiKey.value="";}}
  catch(e){show("#form-msg",e.message,false);}finally{btn.disabled=false;}}
async function codexLogin(){try{const r=await api("/api/codex/login",{name:$("#codex-name").value.trim()||"chatgpt",model:$("#codex-model").value.trim()});state=r.state;render();}catch(e){show("#status-msg",e.message,false);}}
protocolChanged();refresh();
</script>
</body></html>`;
