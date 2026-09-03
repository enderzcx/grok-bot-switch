// grok-switch runtime. This file is injected verbatim into the Grok Bot cloud
// host bundle (host-main.cjs), so it must not use module.exports or top-level
// require(). Every top-level name is prefixed with grokSwitch/GROK_SWITCH to
// avoid colliding with names inside the bundle.
//
// Host globals used lazily: BasePromptExecutor, BasePromptBuilder, fetch, crypto.
// Protocol adapters come from __grokSwitchRequire (bundled build) or from
// ./protocols/index.cjs when running from the repository.

// The host process never sets GROK_SWITCH_DIR; the override exists for tests.
var GROK_SWITCH_DIR = (typeof process !== "undefined" && process.env != null && process.env.GROK_SWITCH_DIR) || "/workspace/grok-switch";
var GROK_SWITCH_CONFIG_PATH = GROK_SWITCH_DIR + "/config.json";
var GROK_SWITCH_LOG_PATH = GROK_SWITCH_DIR + "/requests.log";
var GROK_SWITCH_LOG_MAX_BYTES = 1024 * 1024;
var GROK_SWITCH_PROTOCOLS = ["openai-chat", "openai-responses", "anthropic-messages"];
// "codex" signs requests with the ChatGPT login stored by the Codex CLI
// (~/.codex/auth.json) instead of an API key.
var GROK_SWITCH_AUTH_TYPES = ["bearer", "x-api-key", "none", "codex"];
var GROK_SWITCH_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
var GROK_SWITCH_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Messages starting with this prefix are handled inside the host and never
// reach a model.
var GROK_SWITCH_COMMAND_PREFIX = /^\s*\/(?:gs|grok-switch)(?:\s+|$)/i;
var GROK_SWITCH_DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
var GROK_SWITCH_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
var GROK_SWITCH_MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;
var GROK_SWITCH_MAX_FAILURE_BODY_BYTES = 64 * 1024;
var GROK_SWITCH_DELIVERY_BREAKER_THRESHOLD = 2;
// Any tool: this many consecutive failed results, or identical calls in a
// row, ends the turn instead of billing another full-context request.
var GROK_SWITCH_LOOP_FAILURE_THRESHOLD = 3;
var GROK_SWITCH_LOOP_REPEAT_THRESHOLD = 3;
var GROK_SWITCH_DELIVERY_BREAKER_PREFIX = "grok_switch_delivery_breaker_";
// Idle timeout: abort when the upstream sends nothing for this long. Long
// generations keep streaming, so total duration is not capped.
var GROK_SWITCH_IDLE_TIMEOUT_MS = 180000;
var GROK_SWITCH_HOP_HEADERS = /^(host|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer)$/i;

var grokSwitchExecutorCtor;
var grokSwitchProtocolRegistry;

// ---------------------------------------------------------------------------
// Config

function grokSwitchFs() {
  return require("node:fs");
}

function grokSwitchReadConfigText() {
  try {
    return grokSwitchFs().readFileSync(GROK_SWITCH_CONFIG_PATH, "utf8");
  } catch (error) {
    if (error != null && error.code === "ENOENT") return null;
    throw error;
  }
}

function grokSwitchIsPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function grokSwitchIsAbsolutePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.charCodeAt(0) !== 47) return false;
  if (/[\s\\?#]/.test(path) || path.indexOf("://") !== -1) return false;
  var parts = path.split("/");
  for (var i = 0; i < parts.length; i += 1) {
    if (parts[i] === "..") return false;
  }
  return true;
}

function grokSwitchDefaultEndpointPath(protocol) {
  if (protocol === "openai-chat") return "/chat/completions";
  if (protocol === "openai-responses") return "/responses";
  return "/messages";
}

function grokSwitchDefaultAuthType(protocol) {
  return protocol === "anthropic-messages" ? "x-api-key" : "bearer";
}

// Validates one provider entry and returns a normalized copy. Throws Error
// with a human-readable message on any problem.
function grokSwitchNormalizeProvider(name, raw) {
  if (!grokSwitchIsPlainObject(raw)) throw new Error("provider " + name + " must be an object");
  var protocol = raw.protocol;
  if (GROK_SWITCH_PROTOCOLS.indexOf(protocol) === -1) {
    throw new Error("provider " + name + ": protocol must be one of " + GROK_SWITCH_PROTOCOLS.join(", "));
  }
  var url;
  try {
    url = new URL(String(raw.baseUrl));
  } catch (_error) {
    throw new Error("provider " + name + ": baseUrl is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("provider " + name + ": baseUrl must be http(s)");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("provider " + name + ": baseUrl must not contain credentials or a fragment");
  }
  if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
    throw new Error("provider " + name + ": model is required");
  }
  var authType = raw.authType == null ? grokSwitchDefaultAuthType(protocol) : raw.authType;
  if (GROK_SWITCH_AUTH_TYPES.indexOf(authType) === -1) {
    throw new Error("provider " + name + ": authType must be one of " + GROK_SWITCH_AUTH_TYPES.join(", "));
  }
  var apiKey = raw.apiKey == null ? "" : String(raw.apiKey);
  if (authType !== "none" && authType !== "codex" && apiKey.trim().length === 0) {
    throw new Error("provider " + name + ": apiKey is required for authType " + authType);
  }
  if (authType === "codex" && protocol !== "openai-responses") {
    throw new Error("provider " + name + ": authType codex requires protocol openai-responses");
  }
  var endpointPath = raw.endpointPath == null || raw.endpointPath === ""
    ? grokSwitchDefaultEndpointPath(protocol)
    : raw.endpointPath;
  if (!grokSwitchIsAbsolutePath(endpointPath)) {
    throw new Error("provider " + name + ": endpointPath must be an absolute path like /v1/chat/completions");
  }
  var headers = {};
  if (raw.headers != null) {
    if (!grokSwitchIsPlainObject(raw.headers)) throw new Error("provider " + name + ": headers must be an object");
    var headerNames = Object.keys(raw.headers);
    for (var i = 0; i < headerNames.length; i += 1) {
      var headerName = headerNames[i];
      var headerValue = raw.headers[headerName];
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(headerName) || GROK_SWITCH_HOP_HEADERS.test(headerName)) {
        throw new Error("provider " + name + ": header " + headerName + " is not allowed");
      }
      if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
        throw new Error("provider " + name + ": header " + headerName + " must be a single-line string");
      }
      headers[headerName] = headerValue;
    }
  }
  var parameters = {};
  if (raw.parameters != null) {
    if (!grokSwitchIsPlainObject(raw.parameters)) throw new Error("provider " + name + ": parameters must be an object");
    var paramNames = Object.keys(raw.parameters);
    for (var j = 0; j < paramNames.length; j += 1) {
      var key = paramNames[j];
      var value = raw.parameters[key];
      if (key === "maxTokens") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          throw new Error("provider " + name + ": parameters.maxTokens must be a positive integer");
        }
      } else if (key === "reasoningEffort" || key === "anthropicVersion") {
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("provider " + name + ": parameters." + key + " must be a string");
        }
      } else {
        throw new Error("provider " + name + ": unknown parameter " + key);
      }
      parameters[key] = value;
    }
  }
  if (protocol === "anthropic-messages" && parameters.maxTokens == null) {
    parameters.maxTokens = GROK_SWITCH_DEFAULT_ANTHROPIC_MAX_TOKENS;
  }
  return {
    name: name,
    protocol: protocol,
    baseUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    baseQuery: url.search,
    endpointPath: endpointPath,
    model: raw.model.trim(),
    authType: authType,
    apiKey: apiKey,
    headers: headers,
    parameters: parameters
  };
}

// Parses the whole config file. Returns { active: provider|null, providers }.
function grokSwitchParseConfig(text) {
  if (text == null) return { active: null, providers: {} };
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new Error("config.json is not valid JSON");
  }
  if (!grokSwitchIsPlainObject(parsed)) throw new Error("config.json must be a JSON object");
  var providers = {};
  if (parsed.providers != null) {
    if (!grokSwitchIsPlainObject(parsed.providers)) throw new Error("config.json: providers must be an object");
    var names = Object.keys(parsed.providers);
    for (var i = 0; i < names.length; i += 1) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(names[i])) {
        throw new Error("config.json: provider name " + JSON.stringify(names[i]) + " is invalid");
      }
      providers[names[i]] = grokSwitchNormalizeProvider(names[i], parsed.providers[names[i]]);
    }
  }
  var active = null;
  if (parsed.active != null) {
    if (typeof parsed.active !== "string") throw new Error("config.json: active must be a provider name or null");
    if (!Object.prototype.hasOwnProperty.call(providers, parsed.active)) {
      throw new Error("config.json: active provider " + JSON.stringify(parsed.active) + " is not defined");
    }
    active = providers[parsed.active];
  }
  return { active: active, providers: providers };
}

// Decides where the next session goes. Never throws.
//   { kind: "official" } | { kind: "external", provider } | { kind: "error", message }
function grokSwitchResolveRoute() {
  try {
    var config = grokSwitchParseConfig(grokSwitchReadConfigText());
    if (config.active == null) return { kind: "official" };
    return { kind: "external", provider: config.active };
  } catch (error) {
    return { kind: "error", message: error != null && error.message ? error.message : String(error) };
  }
}

// Raw (unnormalized) config for editing. Missing file -> empty config.
function grokSwitchReadRawConfig() {
  var text = grokSwitchReadConfigText();
  var parsed = text == null ? {} : JSON.parse(text);
  if (!grokSwitchIsPlainObject(parsed)) throw new Error("config.json must be a JSON object");
  if (!grokSwitchIsPlainObject(parsed.providers)) parsed.providers = {};
  if (parsed.active === void 0) parsed.active = null;
  return parsed;
}

function grokSwitchWriteConfig(config) {
  var fs = grokSwitchFs();
  fs.mkdirSync(GROK_SWITCH_DIR, { recursive: true, mode: 448 });
  var tmp = GROK_SWITCH_CONFIG_PATH + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 384 });
  fs.renameSync(tmp, GROK_SWITCH_CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT login) credentials

function grokSwitchCodexAuthPath() {
  var home = process.env.CODEX_HOME && process.env.CODEX_HOME.trim().length > 0
    ? process.env.CODEX_HOME.trim()
    : (process.env.HOME || require("node:os").homedir()) + "/.codex";
  return home + "/auth.json";
}

function grokSwitchCodexCredentials() {
  var path = grokSwitchCodexAuthPath();
  var parsed;
  try {
    parsed = JSON.parse(grokSwitchFs().readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("Codex login not found at " + path + "; run `codex login` on the cloud machine first");
  }
  var tokens = grokSwitchIsPlainObject(parsed) && grokSwitchIsPlainObject(parsed.tokens) ? parsed.tokens : {};
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0 || typeof tokens.account_id !== "string" || tokens.account_id.length === 0) {
    throw new Error("Codex is not signed in with a ChatGPT account (" + path + "); run `codex login`");
  }
  return { path: path, document: parsed, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, accountId: tokens.account_id };
}

function grokSwitchJwtAudience(token) {
  try {
    var payload = JSON.parse(Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"));
    if (typeof payload.aud === "string") return payload.aud;
    if (Array.isArray(payload.aud)) return payload.aud.find(function (v) { return typeof v === "string"; }) || null;
  } catch (_error) {}
  return null;
}

async function grokSwitchCodexRefresh(current) {
  var clientId = grokSwitchJwtAudience(current.idToken);
  if (clientId == null || typeof current.refreshToken !== "string" || current.refreshToken.length === 0) {
    throw new Error("Codex login expired and cannot be refreshed; run `codex login` again");
  }
  var response = await fetch(GROK_SWITCH_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }).toString()
  });
  if (!response.ok) throw new Error("Codex login expired and refresh failed (HTTP " + response.status + "); run `codex login` again");
  var payload = await response.json();
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Codex refresh returned no access token; run `codex login` again");
  }
  var document = Object.assign({}, current.document);
  document.tokens = Object.assign({}, current.document.tokens, {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
    id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken
  });
  document.last_refresh = new Date().toISOString();
  var fs = grokSwitchFs();
  var tmp = current.path + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + "\n", { mode: 384 });
  fs.renameSync(tmp, current.path);
  return grokSwitchCodexCredentials();
}

// ---------------------------------------------------------------------------
// Chat commands: "/gs use <name>", "/gs official", "/gs status", "/gs list".
// Executed inside the host so the stock desktop app needs no changes.

function grokSwitchLastUserText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  var last = messages[messages.length - 1];
  if (!grokSwitchIsPlainObject(last) || last.role !== "user") return null;
  if (typeof last.content === "string") return last.content;
  if (!Array.isArray(last.content)) return null;
  var text = "";
  for (var i = 0; i < last.content.length; i += 1) {
    var part = last.content[i];
    if (grokSwitchIsPlainObject(part) && part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

function grokSwitchDescribeProvider(provider) {
  return provider.protocol + " · " + provider.baseUrl + provider.endpointPath + " · model `" + provider.model + "`";
}

function grokSwitchCommandReply(text) {
  var command = text.replace(GROK_SWITCH_COMMAND_PREFIX, "").trim();
  var parts = command.length === 0 ? [] : command.split(/\s+/);
  var action = (parts[0] || "help").toLowerCase();
  if (action === "official" || action === "off" || action === "grok") {
    var rawOfficial;
    try {
      rawOfficial = grokSwitchReadRawConfig();
    } catch (error) {
      return "grok-switch: config.json is not valid JSON (" + error.message + "); fix or delete " + GROK_SWITCH_CONFIG_PATH + " from the cloud terminal.";
    }
    rawOfficial.active = null;
    grokSwitchWriteConfig(rawOfficial);
    return "Switched back to **official Grok**. Saved providers are kept; `/gs use <name>` switches again.";
  }
  var config;
  try {
    config = grokSwitchParseConfig(grokSwitchReadConfigText());
  } catch (error) {
    return "grok-switch: config.json is broken (" + error.message + "). Run `/gs official` to reset the active provider, or fix the file from the cloud terminal.";
  }
  var names = Object.keys(config.providers);
  if (action === "use") {
    var name = parts[1];
    if (name == null) return "Usage: `/gs use <name>`. Saved providers: " + (names.length ? names.join(", ") : "none") + ".";
    if (!Object.prototype.hasOwnProperty.call(config.providers, name)) {
      return "No provider named `" + name + "`. Saved providers: " + (names.length ? names.join(", ") : "none") + ". Add one from the cloud terminal: `node /workspace/grok-switch/grok-switch.cjs add " + name + " --url ... --model ... --key ...`";
    }
    var raw = grokSwitchReadRawConfig();
    raw.active = name;
    grokSwitchWriteConfig(raw);
    return "Switched to **" + name + "** (" + grokSwitchDescribeProvider(config.providers[name]) + "). Your next message uses it.";
  }
  if (action === "status" || action === "list" || action === "ls") {
    var lines = [config.active == null ? "Active: **official Grok**" : "Active: **" + config.active.name + "** (" + grokSwitchDescribeProvider(config.active) + ")"];
    if (names.length === 0) {
      lines.push("No saved providers.");
    } else {
      lines.push("Saved providers:");
      for (var i = 0; i < names.length; i += 1) {
        var p = config.providers[names[i]];
        lines.push((config.active != null && config.active.name === names[i] ? "- **" : "- ") + names[i] + (config.active != null && config.active.name === names[i] ? "**" : "") + " — " + grokSwitchDescribeProvider(p));
      }
    }
    return lines.join("\n");
  }
  return [
    "grok-switch commands (handled locally, no model call):",
    "- `/gs use <name>` — route new turns to a saved provider",
    "- `/gs official` — back to official Grok",
    "- `/gs status` — show the active route and saved providers",
    "Adding a provider (with its API key) is done once from the cloud terminal: `node /workspace/grok-switch/grok-switch.cjs use <name> --url ... --model ... --key ...`"
  ].join("\n");
}

// A completed stream carrying a fixed reply, shaped like a model response.
function grokSwitchTextStream(text, invocationId) {
  var id = invocationId == null || invocationId === "" ? crypto.randomUUID() : invocationId;
  var usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  var pump = grokSwitchPump();
  pump.push({ type: "text-delta", textDelta: text });
  pump.push({ type: "finish", finishReason: "stop", usage: usage, extendedUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 } });
  pump.end();
  return {
    fullStream: pump.iterate(),
    usage: Promise.resolve(usage),
    extendedUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }),
    providerMetadata: Promise.resolve({ grokSwitch: { command: true } }),
    invocationId: Promise.resolve(id),
    response: Promise.resolve({ id: id, modelId: "grok-switch", timestamp: new Date(), messages: [{ id: id, role: "assistant", content: [{ type: "text", text: text }] }] })
  };
}

// Wraps any executor so a trailing "/gs ..." user message is answered locally.
function grokSwitchInterceptCommands(executor) {
  var originalStream = executor.stream;
  if (typeof originalStream !== "function") return executor;
  executor.stream = function (ctx, invocationId, tools, options) {
    var text = null;
    try {
      text = grokSwitchLastUserText(executor.getMessages());
    } catch (_error) {}
    if (text != null && GROK_SWITCH_COMMAND_PREFIX.test(text)) {
      var reply;
      try {
        reply = grokSwitchCommandReply(text);
      } catch (error) {
        reply = "grok-switch: command failed: " + (error && error.message ? error.message : String(error));
      }
      return grokSwitchTextStream(reply, invocationId);
    }
    return originalStream.call(executor, ctx, invocationId, tools, options);
  };
  return executor;
}

function grokSwitchIsMainSession(sessionOptions) {
  var kind = grokSwitchRequestKind(sessionOptions);
  return kind === "main" || kind === "turn";
}

// ---------------------------------------------------------------------------
// Request log (one JSON line per upstream request; rotated at 1 MiB)

function grokSwitchAppendLog(entry) {
  try {
    var fs = grokSwitchFs();
    try {
      if (fs.statSync(GROK_SWITCH_LOG_PATH).size > GROK_SWITCH_LOG_MAX_BYTES) {
        fs.renameSync(GROK_SWITCH_LOG_PATH, GROK_SWITCH_LOG_PATH + ".1");
      }
    } catch (_stat) {}
    fs.appendFileSync(GROK_SWITCH_LOG_PATH, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch (_error) {}
}

// ---------------------------------------------------------------------------
// Adapters

function grokSwitchProtocols() {
  if (grokSwitchProtocolRegistry != null) return grokSwitchProtocolRegistry;
  if (typeof __grokSwitchRequire === "function") {
    grokSwitchProtocolRegistry = __grokSwitchRequire("./index.cjs");
  } else {
    grokSwitchProtocolRegistry = require("./protocols/index.cjs");
  }
  return grokSwitchProtocolRegistry;
}

// ---------------------------------------------------------------------------
// Small helpers shared by the streaming loop

function grokSwitchAsError(value) {
  if (value != null && typeof value === "object" && typeof value.message === "string") return value;
  return new Error(String(value));
}

function grokSwitchAbortError(signal) {
  if (signal != null && signal.reason != null && typeof signal.reason === "object" && typeof signal.reason.message === "string") {
    return signal.reason;
  }
  var error = new Error("grok-switch: request aborted");
  error.name = "AbortError";
  return error;
}

function grokSwitchLinkDeadline(userSignal) {
  var controller = new AbortController();
  var timer = null;
  function arm() {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(function () {
      var error = new Error("grok-switch: upstream sent nothing for " + GROK_SWITCH_IDLE_TIMEOUT_MS / 1000 + "s");
      error.name = "TimeoutError";
      controller.abort(error);
    }, GROK_SWITCH_IDLE_TIMEOUT_MS);
  }
  function onUserAbort() {
    controller.abort(grokSwitchAbortError(userSignal));
  }
  if (userSignal != null) {
    if (userSignal.aborted) onUserAbort();
    else if (typeof userSignal.addEventListener === "function") userSignal.addEventListener("abort", onUserAbort);
  }
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    dispose: function () {
      if (timer != null) clearTimeout(timer);
      timer = null;
      if (userSignal != null && typeof userSignal.removeEventListener === "function") {
        userSignal.removeEventListener("abort", onUserAbort);
      }
    }
  };
}

function grokSwitchResponseBounds() {
  var total = 0;
  var pending = 0;
  var prev1 = 0;
  var prev2 = 0;
  var prev3 = 0;
  return {
    observe: function (bytes) {
      total += bytes.length;
      if (total > GROK_SWITCH_MAX_RESPONSE_BYTES) {
        throw new Error("grok-switch: upstream response exceeded " + GROK_SWITCH_MAX_RESPONSE_BYTES + " bytes");
      }
      for (var i = 0; i < bytes.length; i += 1) {
        var b = bytes[i];
        pending += 1;
        var delimited = b === 10 && (prev1 === 10 || (prev1 === 13 && prev2 === 10 && prev3 === 13));
        prev3 = prev2;
        prev2 = prev1;
        prev1 = b;
        if (delimited) pending = 0;
        else if (pending > GROK_SWITCH_MAX_SSE_EVENT_BYTES) {
          throw new Error("grok-switch: a single SSE event exceeded " + GROK_SWITCH_MAX_SSE_EVENT_BYTES + " bytes");
        }
      }
    }
  };
}

function grokSwitchDeferred() {
  var resolveFn;
  var rejectFn;
  var settled = false;
  var promise = new Promise(function (resolve, reject) {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // Consumers may never read some of these promises; avoid unhandled rejections.
  promise.catch(function () {});
  return {
    promise: promise,
    resolve: function (value) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject: function (error) {
      if (settled) return;
      settled = true;
      rejectFn(error);
    }
  };
}

function grokSwitchPump() {
  var queue = [];
  var notify = null;
  var ended = false;
  var failed = null;
  function kick() {
    if (notify == null) return;
    var resume = notify;
    notify = null;
    resume();
  }
  return {
    push: function (event) {
      queue.push(event);
      kick();
    },
    end: function () {
      ended = true;
      kick();
    },
    fail: function (error) {
      failed = error;
      ended = true;
      kick();
    },
    iterate: async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        if (failed != null) throw failed;
        if (ended) return;
        await new Promise(function (resolve) {
          notify = resolve;
          if (queue.length > 0 || ended || failed != null) {
            notify = null;
            resolve();
          }
        });
      }
    }
  };
}

function grokSwitchAsUint8Array(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("grok-switch: upstream stream returned an invalid body chunk");
}

async function grokSwitchCancelBody(response, reader) {
  try {
    if (reader != null) {
      await reader.cancel();
      return;
    }
  } catch (_error) {}
  try {
    if (response != null && response.body != null && typeof response.body.cancel === "function") {
      await response.body.cancel();
    }
  } catch (_error) {}
}

async function grokSwitchForEachChunk(response, signal, onChunk) {
  var body = response.body;
  if (body == null) {
    await onChunk(new Uint8Array(await response.arrayBuffer()));
    return;
  }
  if (typeof body.getReader === "function") {
    var reader = body.getReader();
    try {
      for (;;) {
        if (signal.aborted) {
          await grokSwitchCancelBody(response, reader);
          throw grokSwitchAbortError(signal);
        }
        var read = await reader.read();
        if (read.done) break;
        if (read.value != null) {
          try {
            await onChunk(grokSwitchAsUint8Array(read.value));
          } catch (error) {
            await grokSwitchCancelBody(response, reader);
            throw error;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_release) {}
    }
    return;
  }
  for await (var chunk of body) {
    if (signal.aborted) throw grokSwitchAbortError(signal);
    await onChunk(grokSwitchAsUint8Array(chunk));
  }
}

async function grokSwitchReadFailureBody(response) {
  var chunks = [];
  var total = 0;
  try {
    await grokSwitchForEachChunk(response, { aborted: false }, function (bytes) {
      total += bytes.length;
      if (total > GROK_SWITCH_MAX_FAILURE_BODY_BYTES) throw new Error("failure body too large");
      chunks.push(bytes);
    });
  } catch (_error) {}
  var out = new Uint8Array(Math.min(total, GROK_SWITCH_MAX_FAILURE_BODY_BYTES));
  var offset = 0;
  for (var i = 0; i < chunks.length && offset < out.length; i += 1) {
    var slice = chunks[i].subarray(0, out.length - offset);
    out.set(slice, offset);
    offset += slice.length;
  }
  return new TextDecoder("utf-8").decode(out);
}

function grokSwitchHeader(response, name) {
  var headers = response == null ? null : response.headers;
  if (headers == null) return null;
  var value = typeof headers.get === "function" ? headers.get(name) : headers[name];
  return value == null || value === "" ? null : String(value);
}

function grokSwitchRequestKind(sessionOptions) {
  var options = sessionOptions || {};
  if (typeof options.requestSource === "string" && options.requestSource.length > 0) return options.requestSource;
  if (options.isSummarizationSession === true) return "summary";
  if (options.isComputerUseSubagent === true) return "computer";
  if (options.isBrowserUseSubagent === true) return "browser";
  if (options.modelId != null || options.lineage != null) return "subagent";
  return "main";
}

// Opaque provider state (reasoning signatures, response ids) is carried on the
// assistant message. The host keeps providerOptions across redaction, so we
// dual-write it there and hydrate it back before the next request.
function grokSwitchShallowCopy(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  var copy = {};
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i += 1) copy[keys[i]] = value[keys[i]];
  return copy;
}

function grokSwitchReadOpaqueState(message) {
  if (!grokSwitchIsPlainObject(message)) return null;
  if (message.providerState != null) return message.providerState;
  var options = message.providerOptions;
  if (grokSwitchIsPlainObject(options) && grokSwitchIsPlainObject(options.grokSwitch)) {
    return options.grokSwitch.providerState == null ? null : options.grokSwitch.providerState;
  }
  return null;
}

function grokSwitchHydrateMessages(messages) {
  if (messages == null) return [];
  if (!Array.isArray(messages)) throw new Error("grok-switch: host messages must be an array");
  var out = [];
  for (var i = 0; i < messages.length; i += 1) {
    var state = grokSwitchReadOpaqueState(messages[i]);
    if (state == null) {
      out.push(messages[i]);
    } else {
      var copy = grokSwitchShallowCopy(messages[i]);
      copy.providerState = state;
      out.push(copy);
    }
  }
  return out;
}

function grokSwitchMessageParts(message) {
  return message != null && Array.isArray(message.content) ? message.content : [];
}

function grokSwitchIsDeliveryToolName(name) {
  return typeof name === "string" && /^(?:send_?message|send_?to_?user)$/i.test(name);
}

function grokSwitchPartToolId(part) {
  if (part == null || typeof part !== "object") return null;
  if (typeof part.toolCallId === "string") return part.toolCallId;
  if (typeof part.tool_call_id === "string") return part.tool_call_id;
  return typeof part.id === "string" ? part.id : null;
}

function grokSwitchHasFailureValue(value, depth) {
  if (value == null || depth > 8) return false;
  if (typeof value === "string") return /invalid arguments|nothing was sent|not delivered/i.test(value);
  if (typeof value !== "object") return false;
  if (value.isError === true) return true;
  if (Object.prototype.hasOwnProperty.call(value, "error") && value.error != null && value.error !== "") return true;
  var names = Object.keys(value);
  for (var i = 0; i < names.length; i += 1) {
    if (grokSwitchHasFailureValue(value[names[i]], depth + 1)) return true;
  }
  return false;
}

function grokSwitchHasSuccessValue(value, depth) {
  if (value == null || depth > 8 || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "success") && value.success != null) return true;
  var names = Object.keys(value);
  for (var i = 0; i < names.length; i += 1) {
    if (grokSwitchHasSuccessValue(value[names[i]], depth + 1)) return true;
  }
  return false;
}

// The host nudges a stuck model with synthetic user messages ("[SAND_HIDDEN_PROMPT]
// ... deliver the result now"). Those belong to the same turn: a loop that
// keeps failing across nudges must still accumulate.
function grokSwitchIsHiddenPrompt(message) {
  var text = grokSwitchLastUserText([message]);
  return typeof text === "string" && /^\s*\[SAND_HIDDEN_PROMPT\]/.test(text);
}

function grokSwitchCurrentTurnStart(messages) {
  var start = 0;
  for (var i = 0; i < messages.length; i += 1) {
    if (messages[i] != null && messages[i].role === "user" && !grokSwitchIsHiddenPrompt(messages[i])) start = i + 1;
  }
  return start;
}

function grokSwitchCallSignature(part) {
  var name = part.toolName || part.tool_name || part.name || "";
  var args = "";
  try {
    args = JSON.stringify(part.args == null ? {} : part.args);
  } catch (_error) {
    args = String(part.args);
  }
  return name + " " + args;
}

// Scans the current turn (everything after the last user message) for signs
// that the external model is stuck in a tool loop. Every iteration of such a
// loop is a full-context request billed by the provider, and the host itself
// imposes no per-turn limit, so this is the only place it can be stopped.
function grokSwitchDeliveryHistory(messages) {
  var calls = new Map();
  var failed = 0;
  var breakerCompleted = false;
  var trailingFailures = 0;
  var trailingTool = null;
  var signatures = [];
  var start = grokSwitchCurrentTurnStart(messages);
  for (var i = start; i < messages.length; i += 1) {
    var message = messages[i];
    var parts = grokSwitchMessageParts(message);
    for (var j = 0; j < parts.length; j += 1) {
      var part = parts[j];
      var type = part == null ? null : part.type;
      var id = grokSwitchPartToolId(part);
      if (message.role === "assistant" && (type === "tool-call" || type === "tool_call") && id != null) {
        var toolName = part.toolName || part.tool_name || part.name;
        calls.set(id, { name: toolName, delivery: grokSwitchIsDeliveryToolName(toolName), breaker: id.indexOf(GROK_SWITCH_DELIVERY_BREAKER_PREFIX) === 0 });
        signatures.push(grokSwitchCallSignature(part));
      } else if (message.role === "tool" && (type === "tool-result" || type === "tool_result") && id != null && calls.has(id)) {
        var call = calls.get(id);
        var result = part.result != null ? part.result : part;
        if (call.breaker) {
          if (grokSwitchHasSuccessValue(result, 0)) breakerCompleted = true;
        } else if (grokSwitchHasFailureValue(result, 0)) {
          if (call.delivery) failed += 1;
          trailingFailures += 1;
          trailingTool = call.name;
        } else {
          trailingFailures = 0;
          trailingTool = null;
        }
      }
    }
  }
  var repeated = null;
  var n = signatures.length;
  if (n >= GROK_SWITCH_LOOP_REPEAT_THRESHOLD) {
    var last = signatures[n - 1];
    var same = true;
    for (var k = n - GROK_SWITCH_LOOP_REPEAT_THRESHOLD; k < n; k += 1) {
      if (signatures[k] !== last) same = false;
    }
    if (same) repeated = last.split(" ")[0];
  }
  return { failed: failed, breakerCompleted: breakerCompleted, trailingFailures: trailingFailures, trailingTool: trailingTool, repeated: repeated, rounds: n };
}

function grokSwitchZeroUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function grokSwitchZeroExtendedUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 };
}

function grokSwitchImmediateResponseStream(invocationId, modelId, content, events, metadata) {
  var usage = grokSwitchZeroUsage();
  var extended = grokSwitchZeroExtendedUsage();
  var pump = grokSwitchPump();
  for (var i = 0; i < events.length; i += 1) pump.push(events[i]);
  pump.end();
  var message = { id: invocationId, role: "assistant", content: content };
  return {
    fullStream: pump.iterate(),
    usage: Promise.resolve(usage),
    extendedUsage: Promise.resolve(extended),
    providerMetadata: Promise.resolve(metadata || {}),
    invocationId: Promise.resolve(invocationId),
    response: Promise.resolve({ id: invocationId, modelId: modelId, timestamp: new Date(), messages: [message] })
  };
}

function grokSwitchDeliveryBreakerStream(invocationId, modelId, reason) {
  var suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  var id = GROK_SWITCH_DELIVERY_BREAKER_PREFIX + suffix;
  var args = {
    type: "text",
    content: "⚠️ " + reason + " grok-switch 已停止本轮，避免继续消耗额度。请重新发一条消息；如果反复出现，换一个模型或发送 `/gs official` 切回官方 Grok。"
  };
  grokSwitchAppendLog({ ts: new Date().toISOString(), model: modelId, kind: "breaker", status: 0, ms: 0, error: reason });
  var call = { type: "tool-call", toolCallId: id, toolName: "send_message", args: args };
  return grokSwitchImmediateResponseStream(invocationId, modelId, [call], [
    { type: "tool-call-streaming-start", toolCallId: id, toolName: "send_message" },
    call,
    { type: "finish", finishReason: "tool-calls", usage: grokSwitchZeroUsage(), extendedUsage: grokSwitchZeroExtendedUsage() }
  ], { grokSwitch: { deliveryBreaker: true } });
}

function grokSwitchSilentCompletionStream(invocationId, modelId) {
  return grokSwitchImmediateResponseStream(invocationId, modelId, [], [
    { type: "finish", finishReason: "stop", usage: grokSwitchZeroUsage(), extendedUsage: grokSwitchZeroExtendedUsage() }
  ], { grokSwitch: { deliveryBreakerCompleted: true } });
}

// Diagnostics: when GROK_SWITCH_DIR/debug exists, append a compact view of the
// current turn's tool traffic (names, ids, truncated args/results) and the
// breaker decision to debug.log. Off by default; the file is the switch.
function grokSwitchDebugTurn(messages, history) {
  var fs = grokSwitchFs();
  try {
    fs.statSync(GROK_SWITCH_DIR + "/debug");
  } catch (_off) {
    return;
  }
  var clip = function (value) {
    var text;
    try {
      text = typeof value === "string" ? value : JSON.stringify(value);
    } catch (_error) {
      text = String(value);
    }
    return text == null ? null : text.length > 400 ? text.slice(0, 400) + "…(" + text.length + ")" : text;
  };
  var start = grokSwitchCurrentTurnStart(messages);
  var turn = [];
  for (var i = start; i < messages.length; i += 1) {
    var m = messages[i];
    var parts = grokSwitchMessageParts(m);
    for (var j = 0; j < parts.length; j += 1) {
      var p = parts[j];
      if (p == null) continue;
      if (p.type === "tool-call" || p.type === "tool_call") turn.push({ role: m.role, type: p.type, id: grokSwitchPartToolId(p), name: p.toolName || p.tool_name || p.name, args: clip(p.args) });
      else if (p.type === "tool-result" || p.type === "tool_result") turn.push({ role: m.role, type: p.type, id: grokSwitchPartToolId(p), name: p.toolName || p.tool_name, isError: p.isError, result: clip(p.result !== void 0 ? p.result : p.content), keys: Object.keys(p) });
      else turn.push({ role: m.role, type: p.type, text: clip(p.text) });
    }
    if (typeof m.content === "string") turn.push({ role: m.role, type: "string", text: clip(m.content) });
  }
  try {
    fs.appendFileSync(GROK_SWITCH_DIR + "/debug.log", JSON.stringify({ ts: new Date().toISOString(), messages: messages.length, turnStart: start, history: history, turn: turn }) + "\n", { mode: 384 });
  } catch (_error) {}
}

function grokSwitchDeliveryIntervention(messages, invocationId, modelId) {
  var history = grokSwitchDeliveryHistory(messages);
  grokSwitchDebugTurn(messages, history);
  if (history.breakerCompleted) return grokSwitchSilentCompletionStream(invocationId, modelId);
  if (history.failed >= GROK_SWITCH_DELIVERY_BREAKER_THRESHOLD) {
    return grokSwitchDeliveryBreakerStream(invocationId, modelId, "外部模型连续 " + history.failed + " 次用无效参数调用消息工具。");
  }
  if (history.trailingFailures >= GROK_SWITCH_LOOP_FAILURE_THRESHOLD) {
    return grokSwitchDeliveryBreakerStream(invocationId, modelId, "外部模型连续 " + history.trailingFailures + " 次调用工具 " + (history.trailingTool || "?") + " 都失败。");
  }
  if (history.repeated != null) {
    return grokSwitchDeliveryBreakerStream(invocationId, modelId, "外部模型连续 " + GROK_SWITCH_LOOP_REPEAT_THRESHOLD + " 次用完全相同的参数调用工具 " + history.repeated + "，判断为死循环。");
  }
  return null;
}

// Grok Bot's own system prompt says "you are Grok Bot" and nothing about the
// model, so an external model asked "what model are you" can only guess. A
// short system note after the host's system prompt lets it answer truthfully.
function grokSwitchIdentityNote(provider) {
  return {
    role: "system",
    content: "[grok-switch] 当前实际为你提供推理的模型是 " + provider.model + "（供应商配置名 " + provider.name + "，通过 grok-switch 接入，不是 Grok 官方模型）。当用户询问你是什么模型或底层模型时，如实说明这一点；其余行为仍遵循上文的 Grok Bot 指令。"
  };
}

function grokSwitchWithIdentityNote(messages, provider) {
  var out = messages.slice();
  var insertAt = 0;
  while (insertAt < out.length && out[insertAt] != null && out[insertAt].role === "system") insertAt += 1;
  out.splice(insertAt, 0, grokSwitchIdentityNote(provider));
  return out;
}

function grokSwitchAttachOpaqueState(message, state) {
  message.providerState = state;
  var options = grokSwitchShallowCopy(message.providerOptions) || {};
  options.grokSwitch = { providerState: state };
  message.providerOptions = options;
}

function grokSwitchMergeState(current, event) {
  var items = event.state != null && Array.isArray(event.state.items) ? event.state.items : [];
  var protocol = typeof event.protocol === "string" ? event.protocol : (event.state != null ? event.state.protocol : null);
  if (typeof protocol !== "string" || protocol.length === 0) {
    throw new Error("grok-switch: adapter emitted invalid provider-state");
  }
  if (current == null) return { protocol: protocol, items: items.slice() };
  if (current.protocol !== protocol) throw new Error("grok-switch: adapter mixed provider-state protocols");
  return { protocol: protocol, items: current.items.concat(items) };
}

function grokSwitchBuildHeaders(provider, adapterHeaders, codex) {
  var headers = {};
  var names = Object.keys(adapterHeaders || {});
  for (var i = 0; i < names.length; i += 1) headers[names[i]] = adapterHeaders[names[i]];
  var extra = Object.keys(provider.headers);
  for (var j = 0; j < extra.length; j += 1) headers[extra[j]] = provider.headers[extra[j]];
  if (provider.authType === "bearer") headers.authorization = "Bearer " + provider.apiKey;
  else if (provider.authType === "x-api-key") headers["x-api-key"] = provider.apiKey;
  else if (provider.authType === "codex") {
    headers.authorization = "Bearer " + codex.accessToken;
    headers["chatgpt-account-id"] = codex.accountId;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

// One upstream POST. For codex auth a 401 triggers a single token refresh.
async function grokSwitchPost(provider, url, adapterHeaders, body, signal) {
  var codex = provider.authType === "codex" ? grokSwitchCodexCredentials() : null;
  var send = function () {
    return fetch(url, {
      method: "POST",
      redirect: "error",
      headers: grokSwitchBuildHeaders(provider, adapterHeaders, codex),
      body: body,
      signal: signal
    });
  };
  var response = await send();
  if (codex != null && response.status === 401) {
    await grokSwitchReadFailureBody(response);
    codex = await grokSwitchCodexRefresh(codex);
    response = await send();
  }
  return response;
}

function grokSwitchUsageFromFinish(event) {
  var usage = event == null ? null : event.usage;
  if (usage == null || typeof usage !== "object") return null;
  var promptTokens = Number(usage.promptTokens);
  var completionTokens = Number(usage.completionTokens);
  var totalTokens = usage.totalTokens == null ? promptTokens + completionTokens : Number(usage.totalTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null;
  return { promptTokens: promptTokens, completionTokens: completionTokens, totalTokens: totalTokens };
}

function grokSwitchExtendedUsage(event, usage) {
  var extended = event == null ? null : event.extendedUsage;
  if (extended != null && typeof extended === "object") {
    return {
      inputTokens: Number(extended.inputTokens) || 0,
      outputTokens: Number(extended.outputTokens) || 0,
      cacheReadTokens: Number(extended.cacheReadTokens) || 0,
      cacheWriteTokens: Number(extended.cacheWriteTokens) || 0,
      maxTokens: Number(extended.maxTokens) || 0
    };
  }
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 0
  };
}

// ---------------------------------------------------------------------------
// The streaming request. Returns the same shape the host's own executors
// return from stream(): { fullStream, usage, extendedUsage, providerMetadata,
// invocationId, response }.

function grokSwitchStream(provider, input) {
  var messages = input.messages;
  var tools = input.tools;
  var options = input.options || {};
  var signal = input.signal;
  var invocationId = input.invocationId == null || input.invocationId === "" ? crypto.randomUUID() : input.invocationId;
  var requestKind = input.requestKind || "main";
  var onRequestId = typeof input.onRequestId === "function" ? input.onRequestId : null;

  var usageSlot = grokSwitchDeferred();
  var extendedSlot = grokSwitchDeferred();
  var metadataSlot = grokSwitchDeferred();
  var invocationSlot = grokSwitchDeferred();
  var responseSlot = grokSwitchDeferred();
  var pump = grokSwitchPump();

  void (async function () {
    var startedAt = Date.now();
    var status = 0;
    var headerRequestId = null;
    var finishEvent = null;
    var text = "";
    var reasoning = "";
    var toolCalls = [];
    var pendingToolCalls = new Map();
    var opaqueState = null;
    var logged = false;

    function log(error) {
      if (logged) return;
      logged = true;
      var entry = {
        ts: new Date(startedAt).toISOString(),
        provider: provider.name,
        protocol: provider.protocol,
        model: provider.model,
        kind: requestKind,
        status: status,
        ms: Date.now() - startedAt
      };
      if (headerRequestId) entry.requestId = headerRequestId;
      if (finishEvent != null && finishEvent.usage != null) entry.usage = finishEvent.usage;
      if (error != null) entry.error = String(error.message || error).slice(0, 500);
      grokSwitchAppendLog(entry);
    }

    function onHostEvent(event) {
      if (event == null || typeof event !== "object") throw new Error("grok-switch: adapter emitted an invalid event");
      if (event.type === "provider-state") {
        opaqueState = grokSwitchMergeState(opaqueState, event);
        return;
      }
      if (event.type === "finish") {
        if (finishEvent != null) throw new Error("grok-switch: adapter emitted multiple finish events");
        finishEvent = event;
      } else if (event.type === "text-delta" && typeof event.textDelta === "string") {
        text += event.textDelta;
      } else if (event.type === "reasoning" && typeof event.textDelta === "string") {
        reasoning += event.textDelta;
      } else if (event.type === "tool-call-streaming-start") {
        pendingToolCalls.set(event.toolCallId, event.toolName);
      } else if (event.type === "tool-call-delta") {
        // The host executes tools from the accumulated delta text, not from
        // the final `args`. Raw deltas would bypass argument normalization
        // (SendToUser field scoping), so they are withheld and replaced by
        // one delta carrying the final normalized JSON at completion.
        return;
      } else if (event.type === "tool-call") {
        pendingToolCalls.delete(event.toolCallId);
        toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        pump.push({ type: "tool-call-delta", toolCallId: event.toolCallId, toolName: event.toolName, argsTextDelta: JSON.stringify(event.args == null ? {} : event.args) });
      } else if (event.type === "error") {
        throw grokSwitchAsError(event.error);
      }
      pump.push(event);
    }

    function applyEvents(events) {
      if (events == null) return;
      if (!Array.isArray(events)) throw new Error("grok-switch: adapter must return an array of events");
      for (var i = 0; i < events.length; i += 1) onHostEvent(events[i]);
    }

    var deadline = grokSwitchLinkDeadline(signal);
    try {
      if (deadline.signal.aborted) throw grokSwitchAbortError(deadline.signal);
      var adapter = grokSwitchProtocols().getAdapter(provider.protocol);
      var normalized = {
        model: provider.model,
        messages: requestKind === "test" ? grokSwitchHydrateMessages(messages) : grokSwitchWithIdentityNote(grokSwitchHydrateMessages(messages), provider),
        tools: tools,
        stream: true
      };
      if (Object.keys(provider.parameters).length > 0) normalized.parameters = grokSwitchShallowCopy(provider.parameters);
      if (options.maxTokens != null) normalized.maxTokens = options.maxTokens;
      var adapterRequest = adapter.buildRequest(normalized, { endpointPath: provider.endpointPath });
      var url = provider.baseUrl + adapterRequest.path + provider.baseQuery;
      var response;
      try {
        response = await grokSwitchPost(provider, url, adapterRequest.headers, JSON.stringify(adapterRequest.body), deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) throw grokSwitchAbortError(deadline.signal);
        if (error != null && /^Codex/.test(String(error.message))) throw new Error("grok-switch: " + error.message);
        var cause = error != null && error.cause != null && error.cause.message ? " (" + error.cause.message + ")" : "";
        throw new Error("grok-switch: cannot reach " + url + cause);
      }
      deadline.touch();
      status = response.status;
      headerRequestId = grokSwitchHeader(response, "x-request-id") || grokSwitchHeader(response, "request-id");
      if (headerRequestId != null && onRequestId != null) onRequestId(headerRequestId);
      if (!response.ok) {
        var bodyText = await grokSwitchReadFailureBody(response);
        var message = "HTTP " + status;
        try {
          adapter.interpretHttpFailure(status, bodyText);
        } catch (interpreted) {
          if (interpreted != null && interpreted.message) message = "HTTP " + status + ": " + interpreted.message;
        }
        var httpError = new Error("grok-switch: " + provider.name + " (" + provider.model + ") " + message);
        // 4xx other than timeout/rate-limit will fail the same way on retry.
        httpError.grokSwitchFatal = status >= 400 && status < 500 && status !== 408 && status !== 429;
        throw httpError;
      }
      var decoder = adapter.createStreamDecoder({ requestId: headerRequestId || "" });
      var bounds = grokSwitchResponseBounds();
      await grokSwitchForEachChunk(response, deadline.signal, function (bytes) {
        deadline.touch();
        bounds.observe(bytes);
        applyEvents(decoder.push(bytes));
      });
      applyEvents(decoder.close());
      if (finishEvent == null) throw new Error("grok-switch: upstream stream ended without a finish event");
      if (pendingToolCalls.size > 0) throw new Error("grok-switch: upstream stream ended with incomplete tool calls");
      var usage = grokSwitchUsageFromFinish(finishEvent);
      if (usage == null) throw new Error("grok-switch: upstream stream finished without usage");
      var requestId = headerRequestId || finishEvent.requestId || (finishEvent.response != null ? finishEvent.response.id : null);
      var providerMetadata = grokSwitchIsPlainObject(finishEvent.providerMetadata) ? grokSwitchShallowCopy(finishEvent.providerMetadata) : {};
      if (requestId != null && requestId !== "") {
        providerMetadata.requestId = requestId;
        if (headerRequestId == null && onRequestId != null) onRequestId(requestId);
      }
      var content = [];
      if (reasoning.length > 0) content.push({ type: "reasoning", text: reasoning });
      if (text.length > 0) content.push({ type: "text", text: text });
      for (var t = 0; t < toolCalls.length; t += 1) {
        content.push({ type: "tool-call", toolCallId: toolCalls[t].toolCallId, toolName: toolCalls[t].toolName, args: toolCalls[t].args });
      }
      var assistantMessage = { id: invocationId, role: "assistant", content: content };
      if (opaqueState != null && opaqueState.items.length > 0) grokSwitchAttachOpaqueState(assistantMessage, opaqueState);
      log(null);
      usageSlot.resolve(usage);
      extendedSlot.resolve(grokSwitchExtendedUsage(finishEvent, usage));
      metadataSlot.resolve(providerMetadata);
      invocationSlot.resolve(invocationId);
      responseSlot.resolve({ id: invocationId, modelId: provider.model, timestamp: new Date(), messages: [assistantMessage] });
      pump.end();
    } catch (error) {
      var err = grokSwitchAsError(error);
      log(err);
      // The host retries any unknown error up to three times, re-billing the
      // provider each time. Failures that cannot succeed on retry (4xx,
      // request shapes the protocol cannot express) are surfaced as visible
      // text first: once the turn has produced output the host stops retrying
      // and shows the error immediately.
      var fatal = err.grokSwitchFatal === true
        || (err.name === "ProtocolError" && (err.code === "unsupported-shape" || err.code === "invalid-request"));
      if (fatal && text.length === 0 && toolCalls.length === 0) {
        pump.push({ type: "text-delta", textDelta: "⚠️ " + err.message });
      }
      pump.push({ type: "error", error: err });
      usageSlot.reject(err);
      extendedSlot.reject(err);
      metadataSlot.reject(err);
      invocationSlot.reject(err);
      responseSlot.reject(err);
      pump.fail(err);
    } finally {
      deadline.dispose();
    }
  })();

  return {
    fullStream: pump.iterate(),
    usage: usageSlot.promise,
    extendedUsage: extendedSlot.promise,
    providerMetadata: metadataSlot.promise,
    invocationId: invocationSlot.promise,
    response: responseSlot.promise
  };
}

// A stream that fails immediately with a clear message. Used when config.json
// is present but broken, so the user sees the reason in chat instead of the
// request silently going to the official backend.
function grokSwitchFailedStream(message) {
  var error = new Error("grok-switch: " + message);
  grokSwitchAppendLog({ ts: new Date().toISOString(), status: 0, ms: 0, error: error.message });
  var rejected = Promise.reject(error);
  rejected.catch(function () {});
  var pump = grokSwitchPump();
  pump.push({ type: "text-delta", textDelta: "⚠️ " + error.message });
  pump.push({ type: "error", error: error });
  pump.fail(error);
  return {
    fullStream: pump.iterate(),
    usage: rejected,
    extendedUsage: rejected,
    providerMetadata: rejected,
    invocationId: rejected,
    response: rejected
  };
}

// ---------------------------------------------------------------------------
// Host integration

function grokSwitchExecutorClass() {
  if (grokSwitchExecutorCtor == null) {
    grokSwitchExecutorCtor = class GrokSwitchPromptExecutor extends BasePromptExecutor {
      constructor(route, initialMessages, session) {
        super(new BasePromptBuilder(initialMessages));
        this._grokSwitchRoute = route;
        this._grokSwitchSession = session;
      }
      stream(ctx, invocationId, tools, options) {
        var route = this._grokSwitchRoute;
        if (route.kind === "error") return grokSwitchFailedStream(route.message);
        var messages = this.getMessages();
        var id = invocationId == null || invocationId === "" ? crypto.randomUUID() : invocationId;
        var intervention = grokSwitchDeliveryIntervention(messages, id, route.provider.model);
        if (intervention != null) return intervention;
        return grokSwitchStream(route.provider, {
          messages: messages,
          tools: tools,
          options: options,
          signal: ctx == null ? void 0 : ctx.signal,
          invocationId: invocationId,
          requestKind: grokSwitchRequestKind(this._grokSwitchSession.sessionOptions),
          onRequestId: this._grokSwitchSession.onRequestId
        });
      }
    };
  }
  return grokSwitchExecutorCtor;
}

function grokSwitchCreateSession(route, onRequestId, sessionOptions) {
  var Executor = grokSwitchExecutorClass();
  var session = { onRequestId: onRequestId, sessionOptions: sessionOptions };
  var modelId = route.kind === "external" ? route.provider.model : "grok-switch-misconfigured";
  return {
    getModelId: function () {
      return modelId;
    },
    getExecutor: function (state) {
      var executor = new Executor(route, state, session);
      return grokSwitchIsMainSession(sessionOptions) ? grokSwitchInterceptCommands(executor) : executor;
    }
  };
}

// Official sessions only get the command interceptor. The host's session may
// be a class instance with methods on its prototype (getModelId etc.), so it
// is modified in place rather than copied; the object is created fresh for
// every createSession call.
function grokSwitchWrapOfficialSession(session, sessionOptions) {
  if (session == null || typeof session.getExecutor !== "function" || !grokSwitchIsMainSession(sessionOptions)) return session;
  var originalGetExecutor = session.getExecutor;
  session.getExecutor = function (state) {
    return grokSwitchInterceptCommands(originalGetExecutor.call(session, state));
  };
  return session;
}

// Wraps the object returned by the host's createHostInference. The route is
// resolved on every createSession call, so editing config.json takes effect on
// the next conversation turn without restarting the host.
function grokSwitchWrapHostInference(inference) {
  var wrapped = {};
  var keys = Object.keys(inference);
  for (var i = 0; i < keys.length; i += 1) wrapped[keys[i]] = inference[keys[i]];
  wrapped.createSession = function (onRequestId, sessionOptions) {
    var route = grokSwitchResolveRoute();
    if (route.kind === "official") {
      return grokSwitchWrapOfficialSession(inference.createSession(onRequestId, sessionOptions), sessionOptions);
    }
    return grokSwitchCreateSession(route, onRequestId, sessionOptions);
  };
  // Labeling callbacks send conversation text to the official backend. Skip
  // them while an external provider is active.
  var labeling = ["recordPostTurnLabeling", "recordFollowupLabeling"];
  for (var j = 0; j < labeling.length; j += 1) {
    var name = labeling[j];
    if (typeof inference[name] === "function") {
      wrapped[name] = (function (method) {
        return function (args) {
          if (grokSwitchResolveRoute().kind === "official") return method.call(inference, args);
          return void 0;
        };
      })(inference[name]);
    }
  }
  return wrapped;
}
