// Injected into the 0.30 host bundle. Keep this file free of export assignments.
// Protocol adapters are loaded from src/provider_protocols via Node require in
// tests, or from the hash-fenced in-bundle registry after patching:
//   getAdapter(protocol) -> { buildRequest, createStreamDecoder, interpretHttpFailure }
// Host redaction keeps assistant providerOptions and drops unknown top-level
// fields, so opaque provider-state is dual-written onto the assistant message.

var PROVIDER_DIRECT_CONFIG_PATH = "/workspace/grok-home/config/external.json";
var PROVIDER_DIRECT_PROTOCOL_IDS = ["openai-chat", "openai-responses", "anthropic-messages"];
var PROVIDER_DIRECT_CONFIG_KEYS = {
  schemaVersion: true,
  enabled: true,
  mode: true,
  nativeFallback: true,
  fallbackPolicy: true,
  profileId: true,
  protocol: true,
  model: true,
  baseUrl: true,
  endpointPath: true,
  generation: true,
  profileDigest: true
};
var PROVIDER_DIRECT_CREDENTIAL_KEY = /^(api[_-]?key|authorization|auth|token|access[_-]?token|refresh[_-]?token|oauth|cookie|cookies|credential|credentials|key[_-]?file|secret|password|bearer|x[_-]?api[_-]?key)$/i;
var PROVIDER_DIRECT_PROFILE_ID = /^(?:[a-z]|[a-z][a-z0-9-]{0,61}[a-z0-9])$/;
var PROVIDER_DIRECT_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
var PROVIDER_DIRECT_DIGEST = /^[a-f0-9]{64}$/;
var PROVIDER_DIRECT_FORBIDDEN_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|host|content-length|connection|transfer-encoding|keep-alive|upgrade|te|trailer|x-api-key|api-key|x-auth-token)$/i;
// Host-to-hop bounds. Finite, not configurable, independent of hop upstream caps.
var PROVIDER_DIRECT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
var PROVIDER_DIRECT_MAX_SSE_EVENT_BYTES = 1 * 1024 * 1024;
var PROVIDER_DIRECT_MAX_FAILURE_BODY_BYTES = 8 * 1024;
var PROVIDER_DIRECT_REQUEST_TIMEOUT_MS = 120000;
var ProviderDirectPromptExecutorCtor;
var providerDirectProtocolRegistry;

function providerDirectIsErrorLike(value) {
  return value != null && typeof value === "object" && typeof value.message === "string";
}

function providerDirectAsError(value) {
  if (providerDirectIsErrorLike(value)) return value;
  return new Error(String(value));
}

function providerDirectAbortError(signal) {
  if (signal != null && providerDirectIsErrorLike(signal.reason)) return signal.reason;
  var error = new Error("Provider direct request aborted");
  error.name = "AbortError";
  return error;
}

function providerDirectTimeoutError() {
  var error = new Error("Provider direct request timed out");
  error.name = "TimeoutError";
  return error;
}

function providerDirectResponseTooLargeError() {
  return new Error("Provider direct response exceeded " + PROVIDER_DIRECT_MAX_RESPONSE_BYTES + " bytes");
}

function providerDirectSseEventTooLargeError() {
  return new Error("Provider direct SSE event exceeded " + PROVIDER_DIRECT_MAX_SSE_EVENT_BYTES + " bytes");
}

function providerDirectFailureBodyTooLargeError() {
  return new Error("Provider direct failure body exceeded " + PROVIDER_DIRECT_MAX_FAILURE_BODY_BYTES + " bytes");
}

function providerDirectLinkDeadline(userSignal) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    try {
      controller.abort(providerDirectTimeoutError());
    } catch (_error) {
      try {
        controller.abort();
      } catch (_abort) {}
    }
  }, PROVIDER_DIRECT_REQUEST_TIMEOUT_MS);
  function onUserAbort() {
    try {
      controller.abort(providerDirectAbortError(userSignal));
    } catch (_error) {
      try {
        controller.abort();
      } catch (_abort) {}
    }
  }
  if (userSignal != null) {
    if (userSignal.aborted) {
      onUserAbort();
    } else if (typeof userSignal.addEventListener === "function") {
      userSignal.addEventListener("abort", onUserAbort);
    }
  }
  return {
    signal: controller.signal,
    dispose: function () {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (userSignal != null && typeof userSignal.removeEventListener === "function") {
        userSignal.removeEventListener("abort", onUserAbort);
      }
    }
  };
}

function providerDirectCreateResponseBounds() {
  var total = 0;
  var pending = 0;
  var prev1 = 0;
  var prev2 = 0;
  var prev3 = 0;
  return {
    observe: function (bytes) {
      var length = bytes.length;
      if (length > PROVIDER_DIRECT_MAX_RESPONSE_BYTES || total > PROVIDER_DIRECT_MAX_RESPONSE_BYTES - length) {
        throw providerDirectResponseTooLargeError();
      }
      total += length;
      for (var i = 0; i < length; i += 1) {
        var b = bytes[i];
        pending += 1;
        var delimited = b === 10 && (prev1 === 10 || (prev1 === 13 && prev2 === 10 && prev3 === 13));
        prev3 = prev2;
        prev2 = prev1;
        prev1 = b;
        if (delimited) {
          pending = 0;
        } else if (pending > PROVIDER_DIRECT_MAX_SSE_EVENT_BYTES) {
          throw providerDirectSseEventTooLargeError();
        }
      }
    }
  };
}

async function providerDirectCancelResponse(response, reader) {
  try {
    if (reader != null && typeof reader.cancel === "function") {
      await reader.cancel();
      return;
    }
  } catch (_cancelReader) {}
  var body = response == null ? null : response.body;
  try {
    if (body != null && typeof body.cancel === "function") {
      await body.cancel();
      return;
    }
  } catch (_cancelBody) {}
  try {
    if (body != null && typeof body.destroy === "function") {
      body.destroy();
    }
  } catch (_destroy) {}
}

function providerDirectDeferred() {
  var resolveFn;
  var rejectFn;
  var settled = false;
  var promise = new Promise(function (resolve, reject) {
    resolveFn = resolve;
    rejectFn = reject;
  });
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

function providerDirectAsUint8Array(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Provider direct stream returned an invalid body chunk");
}

function providerDirectHeader(response, name) {
  if (response == null || response.headers == null) return null;
  var headers = response.headers;
  if (typeof headers.get === "function") {
    var value = headers.get(name);
    return value == null || value === "" ? null : String(value);
  }
  var direct = headers[name] || headers[name.toLowerCase()];
  return direct == null || direct === "" ? null : String(direct);
}

function providerDirectRequestKind(sessionOptions) {
  var options = sessionOptions || {};
  if (options.requestSource === "compaction") return "compaction";
  if (options.requestSource === "memory") return "memory";
  if (options.requestSource === "label") return "label";
  if (options.requestSource === "review") return "review";
  if (options.isSummarizationSession === true) return "summary";
  if (options.isComputerUseSubagent === true) return "computer";
  if (options.isBrowserUseSubagent === true) return "browser";
  if (options.modelId != null || options.lineage != null) return "subagent";
  return "main";
}

function providerDirectUsageFromFinish(event) {
  var usage = event == null ? null : event.usage;
  if (usage == null || typeof usage !== "object") return null;
  var promptTokens = Number(usage.promptTokens);
  var completionTokens = Number(usage.completionTokens);
  var totalTokens = usage.totalTokens == null ? promptTokens + completionTokens : Number(usage.totalTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) {
    return null;
  }
  return {
    promptTokens: promptTokens,
    completionTokens: completionTokens,
    totalTokens: totalTokens
  };
}

function providerDirectExtendedUsageFromFinish(event, usage) {
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
  if (usage == null) return null;
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cacheReadTokens: Number(usage.cacheReadTokens) || 0,
    cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
    maxTokens: Number(usage.maxTokens) || 0
  };
}

function providerDirectCreatePump() {
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
        while (queue.length > 0) {
          yield queue.shift();
        }
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

async function providerDirectForEachBodyChunk(response, signal, onChunk) {
  var body = response == null ? null : response.body;
  if (body == null) {
    var whole;
    if (response != null && typeof response.arrayBuffer === "function") {
      whole = new Uint8Array(await response.arrayBuffer());
    } else if (response != null && typeof response.text === "function") {
      whole = new TextEncoder().encode(await response.text());
    } else {
      throw new Error("Provider direct response body is not readable");
    }
    try {
      await onChunk(whole);
    } catch (error) {
      await providerDirectCancelResponse(response, null);
      throw error;
    }
    return;
  }
  if (typeof body.getReader === "function") {
    var reader = body.getReader();
    try {
      for (;;) {
        if (signal != null && signal.aborted) {
          await providerDirectCancelResponse(response, reader);
          throw providerDirectAbortError(signal);
        }
        var read = await reader.read();
        if (read.done) break;
        if (read.value != null) {
          try {
            await onChunk(providerDirectAsUint8Array(read.value));
          } catch (error) {
            await providerDirectCancelResponse(response, reader);
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
  if (typeof body[Symbol.asyncIterator] === "function") {
    try {
      for await (var nodeChunk of body) {
        if (signal != null && signal.aborted) {
          await providerDirectCancelResponse(response, null);
          throw providerDirectAbortError(signal);
        }
        try {
          await onChunk(providerDirectAsUint8Array(nodeChunk));
        } catch (error) {
          await providerDirectCancelResponse(response, null);
          throw error;
        }
      }
    } catch (error) {
      if (signal != null && signal.aborted) throw providerDirectAbortError(signal);
      throw error;
    }
    return;
  }
  throw new Error("Provider direct response body is not readable");
}

async function providerDirectDrainFailureBody(response) {
  if (response == null) return;
  var limit = PROVIDER_DIRECT_MAX_FAILURE_BODY_BYTES;
  var collected = 0;
  var body = response.body;
  function note(length) {
    collected += length;
    if (collected > limit) {
      throw providerDirectFailureBodyTooLargeError();
    }
  }
  if (body != null && typeof body.getReader === "function") {
    var reader = body.getReader();
    try {
      for (;;) {
        var read = await reader.read();
        if (read.done) return;
        var chunk = providerDirectAsUint8Array(read.value);
        try {
          note(chunk.length);
        } catch (error) {
          await providerDirectCancelResponse(response, reader);
          throw error;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_release) {}
    }
    return;
  }
  if (body != null && typeof body[Symbol.asyncIterator] === "function") {
    for await (var nodeChunk of body) {
      var bytes = providerDirectAsUint8Array(nodeChunk);
      try {
        note(bytes.length);
      } catch (error) {
        await providerDirectCancelResponse(response, null);
        throw error;
      }
    }
    return;
  }
  if (typeof response.arrayBuffer === "function") {
    note((await response.arrayBuffer()).byteLength);
    return;
  }
  if (typeof response.text === "function") {
    note((await response.text()).length);
  }
}

function providerDirectReadConfigFile() {
  try {
    return require("node:fs").readFileSync(PROVIDER_DIRECT_CONFIG_PATH, "utf8");
  } catch (error) {
    if (error != null && error.code === "ENOENT") return null;
    throw error;
  }
}

function providerDirectAssertExact(parsed, key, expected) {
  if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
    throw new Error("enabled provider host config is invalid");
  }
  if (parsed[key] !== expected) {
    throw new Error("enabled provider host config is invalid");
  }
}

function providerDirectIsSafeAbsolutePath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.charCodeAt(0) !== 47 || (path.length > 1 && path.charCodeAt(1) === 47)) return false;
  for (var i = 0; i < path.length; i += 1) {
    var code = path.charCodeAt(i);
    if (code < 32 || code === 32 || code === 92 || code === 63 || code === 35 || code === 127) {
      return false;
    }
  }
  if (path.indexOf("://") !== -1) return false;
  var parts = path.split("/");
  for (var j = 0; j < parts.length; j += 1) {
    if (parts[j] === "..") return false;
  }
  return true;
}

function providerDirectLoopbackOrigin(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  var url;
  try {
    url = new URL(raw);
  } catch (_error) {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "" || url.search !== "") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  var host = String(url.hostname || "").toLowerCase();
  if (
    host !== "127.0.0.1"
    && host !== "localhost"
    && host !== "::1"
    && host !== "0:0:0:0:0:0:0:1"
  ) {
    return null;
  }
  return url.origin;
}

function providerDirectShallowCopy(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  var copy = {};
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i += 1) {
    copy[keys[i]] = value[keys[i]];
  }
  return copy;
}

function providerDirectReadOpaqueState(message) {
  if (message == null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.providerState != null) return message.providerState;
  if (
    message.providerOptions != null
    && typeof message.providerOptions === "object"
    && !Array.isArray(message.providerOptions)
    && message.providerOptions.grokHome != null
    && typeof message.providerOptions.grokHome === "object"
    && !Array.isArray(message.providerOptions.grokHome)
  ) {
    return message.providerOptions.grokHome.providerState == null
      ? null
      : message.providerOptions.grokHome.providerState;
  }
  return null;
}

function providerDirectHydrateMessage(message) {
  var state = providerDirectReadOpaqueState(message);
  if (state == null) return message;
  var copy = providerDirectShallowCopy(message);
  copy.providerState = state;
  return copy;
}

function providerDirectHydrateMessages(messages) {
  if (messages == null) return [];
  if (!Array.isArray(messages)) {
    throw new Error("Provider direct host messages must be an array");
  }
  var out = [];
  for (var i = 0; i < messages.length; i += 1) {
    out.push(providerDirectHydrateMessage(messages[i]));
  }
  return out;
}

function providerDirectAttachOpaqueState(message, state) {
  if (state == null) return message;
  message.providerState = state;
  var options = providerDirectShallowCopy(message.providerOptions) || {};
  var grokHome = providerDirectShallowCopy(options.grokHome) || {};
  grokHome.providerState = state;
  options.grokHome = grokHome;
  message.providerOptions = options;
  return message;
}

function providerDirectJoinUrl(baseUrl, path) {
  if (!providerDirectIsSafeAbsolutePath(path)) {
    throw new Error("Provider direct request path must be an absolute path");
  }
  return String(baseUrl).replace(/\/+$/, "") + path;
}

function providerDirectCopyHeaders(raw) {
  var headers = {};
  if (raw == null) return headers;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Provider direct request headers are invalid");
  }
  var keys = Object.keys(raw);
  for (var i = 0; i < keys.length; i += 1) {
    var name = keys[i];
    var value = raw[name];
    if (typeof name !== "string" || name.length === 0 || /[\r\n]/.test(name)) {
      throw new Error("Provider direct request header is not allowed");
    }
    if (PROVIDER_DIRECT_FORBIDDEN_HEADER.test(name)) {
      throw new Error("Provider direct request header is not allowed");
    }
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new Error("Provider direct request header is unrepresentable");
    }
    headers[name] = value;
  }
  return headers;
}

function parseProviderDirectConfig(raw) {
  if (raw == null) return null;
  var parsed = raw;
  if (typeof raw === "string") {
    var trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_error) {
      throw new Error("enabled provider host config is invalid");
    }
  }
  if (parsed == null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("enabled provider host config is invalid");
  }
  var extraKeys = Object.keys(parsed);
  for (var i = 0; i < extraKeys.length; i += 1) {
    var key = extraKeys[i];
    if (!PROVIDER_DIRECT_CONFIG_KEYS[key]) {
      if (PROVIDER_DIRECT_CREDENTIAL_KEY.test(key)) {
        throw new Error("enabled provider host config is invalid");
      }
      throw new Error("enabled provider host config is invalid");
    }
  }
  if (parsed.enabled !== true) return null;
  providerDirectAssertExact(parsed, "schemaVersion", 1);
  providerDirectAssertExact(parsed, "mode", "external-only");
  providerDirectAssertExact(parsed, "nativeFallback", false);
  providerDirectAssertExact(parsed, "fallbackPolicy", "never");
  if (typeof parsed.profileId !== "string" || !PROVIDER_DIRECT_PROFILE_ID.test(parsed.profileId)) {
    throw new Error("enabled provider host config is invalid");
  }
  if (PROVIDER_DIRECT_PROTOCOL_IDS.indexOf(parsed.protocol) === -1) {
    throw new Error("enabled provider host config is invalid");
  }
  if (typeof parsed.model !== "string" || !PROVIDER_DIRECT_MODEL.test(parsed.model)) {
    throw new Error("enabled provider host config is invalid");
  }
  var origin = providerDirectLoopbackOrigin(parsed.baseUrl);
  if (origin == null) {
    throw new Error("enabled provider host config is invalid");
  }
  if (!providerDirectIsSafeAbsolutePath(parsed.endpointPath)) {
    throw new Error("enabled provider host config is invalid");
  }
  if (typeof parsed.generation !== "number" || !Number.isInteger(parsed.generation) || parsed.generation < 1) {
    throw new Error("enabled provider host config is invalid");
  }
  if (typeof parsed.profileDigest !== "string" || !PROVIDER_DIRECT_DIGEST.test(parsed.profileDigest)) {
    throw new Error("enabled provider host config is invalid");
  }
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "external-only",
    nativeFallback: false,
    fallbackPolicy: "never",
    profileId: parsed.profileId,
    protocol: parsed.protocol,
    model: parsed.model,
    baseUrl: origin,
    endpointPath: parsed.endpointPath,
    generation: parsed.generation,
    profileDigest: parsed.profileDigest
  };
}

function loadProviderDirectConfig() {
  var raw = providerDirectReadConfigFile();
  if (raw == null) return null;
  return parseProviderDirectConfig(raw);
}

function getProviderProtocolRegistry() {
  if (providerDirectProtocolRegistry != null) return providerDirectProtocolRegistry;
  if (typeof __grokProviderRequire === "function") {
    providerDirectProtocolRegistry = __grokProviderRequire("./index.cjs");
  } else {
    providerDirectProtocolRegistry = require("./provider_protocols/index.cjs");
  }
  return providerDirectProtocolRegistry;
}

function getProviderDirectPromptExecutorCtor() {
  if (ProviderDirectPromptExecutorCtor == null) {
    ProviderDirectPromptExecutorCtor = class ProviderDirectPromptExecutor extends BasePromptExecutor {
      constructor(config, initialMessages, sessionContext) {
        super(new BasePromptBuilder(initialMessages));
        this._providerDirectConfig = config;
        this._providerDirectSession = sessionContext || {};
      }
      stream(ctx, invocationId, tools, options) {
        return streamProviderDirect(this, ctx, invocationId, tools, options);
      }
    };
  }
  return ProviderDirectPromptExecutorCtor;
}

function createProviderDirectPromptSession(options) {
  var sessionContext = options || {};
  var config = sessionContext.config != null ? sessionContext.config : loadProviderDirectConfig();
  if (config == null) {
    throw new Error("Provider direct session requires an active host config");
  }
  var Executor = getProviderDirectPromptExecutorCtor();
  return {
    getModelId: function () {
      return config.model;
    },
    getExecutor: function (state) {
      return new Executor(config, state, sessionContext);
    }
  };
}

function wrapHostInferenceWithProviderSwitcher(cursorInference, _options) {
  var directConfig = loadProviderDirectConfig();
  if (directConfig == null) {
    return cursorInference;
  }
  return {
    ...cursorInference,
    createSession: function (onRequestId, sessionOptions) {
      return createProviderDirectPromptSession({
        onRequestId: onRequestId,
        sessionOptions: sessionOptions,
        config: directConfig
      });
    },
    recordPostTurnLabeling: function (_args) {}
  };
}

function providerDirectMergeState(current, event) {
  if (event == null || event.type !== "provider-state") return current;
  var nextItems = event.state != null && Array.isArray(event.state.items) ? event.state.items : [];
  var protocol = typeof event.protocol === "string" ? event.protocol : (event.state != null ? event.state.protocol : null);
  if (typeof protocol !== "string" || protocol.length === 0) {
    throw new Error("Provider direct stream emitted invalid provider-state");
  }
  if (current == null) {
    return { protocol: protocol, items: nextItems.slice() };
  }
  if (current.protocol !== protocol) {
    throw new Error("Provider direct stream mixed provider-state protocols");
  }
  return { protocol: current.protocol, items: current.items.concat(nextItems) };
}

function streamProviderDirect(executor, ctx, invocationId, tools, options) {
  var usageSlot = providerDirectDeferred();
  var extendedSlot = providerDirectDeferred();
  var metadataSlot = providerDirectDeferred();
  var invocationSlot = providerDirectDeferred();
  var responseSlot = providerDirectDeferred();
  var pump = providerDirectCreatePump();
  var resolvedInvocationId = invocationId == null || invocationId === "" ? crypto.randomUUID() : invocationId;
  var signal = ctx == null ? void 0 : ctx.signal;

  void (async function () {
    var sawFinish = false;
    var finishEvent = null;
    var text = "";
    var reasoning = "";
    var toolCalls = [];
    var pendingToolCalls = new Map();
    var headerRequestId = null;
    var opaqueState = null;

    function onHostEvent(event) {
      if (event == null || typeof event !== "object") {
        throw new Error("Provider adapter emitted an invalid host event");
      }
      if (event.type === "provider-state") {
        opaqueState = providerDirectMergeState(opaqueState, event);
        return;
      }
      if (event.type === "finish") {
        if (sawFinish) throw new Error("Provider direct stream emitted multiple finish events");
        sawFinish = true;
        finishEvent = event;
      } else if (event.type === "text-delta" && typeof event.textDelta === "string") {
        text += event.textDelta;
      } else if (event.type === "reasoning" && typeof event.textDelta === "string") {
        reasoning += event.textDelta;
      } else if (event.type === "tool-call-streaming-start") {
        pendingToolCalls.set(event.toolCallId, event.toolName);
      } else if (event.type === "tool-call") {
        pendingToolCalls.delete(event.toolCallId);
        toolCalls.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args
        });
      } else if (event.type === "error") {
        throw providerDirectAsError(event.error);
      }
      pump.push(event);
    }

    function applyEvents(events, where) {
      if (events == null) return;
      if (!Array.isArray(events)) {
        throw new Error("Provider adapter " + where + " must return an array of host stream parts");
      }
      for (var i = 0; i < events.length; i += 1) {
        onHostEvent(events[i]);
      }
    }

    var deadline = providerDirectLinkDeadline(signal);
    var hopSignal = deadline.signal;
    try {
      if (hopSignal.aborted) throw providerDirectAbortError(hopSignal);
      var config = executor._providerDirectConfig;
      var adapter = getProviderProtocolRegistry().getAdapter(config.protocol);
      if (adapter == null || typeof adapter.buildRequest !== "function" || typeof adapter.createStreamDecoder !== "function") {
        throw new Error("Provider protocol adapter is incomplete");
      }
      var normalized = {
        model: config.model,
        messages: providerDirectHydrateMessages(executor.getMessages()),
        tools: tools,
        stream: true
      };
      if (options != null && options.maxTokens != null) {
        normalized.maxTokens = options.maxTokens;
      }
      var adapterRequest = adapter.buildRequest(normalized, { endpointPath: config.endpointPath });
      if (adapterRequest == null || adapterRequest.method !== "POST") {
        throw new Error("Provider adapter produced an unrepresentable request");
      }
      if (adapterRequest.path !== config.endpointPath) {
        throw new Error("Provider adapter path does not match the active host endpointPath");
      }
      var headers = providerDirectCopyHeaders(adapterRequest.headers);
      headers["x-grok-request-kind"] = providerDirectRequestKind(executor._providerDirectSession.sessionOptions);
      var url = providerDirectJoinUrl(config.baseUrl, adapterRequest.path);
      var response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(adapterRequest.body),
          signal: hopSignal
        });
      } catch (error) {
        if (hopSignal.aborted) throw providerDirectAbortError(hopSignal);
        throw error;
      }
      if (hopSignal.aborted) throw providerDirectAbortError(hopSignal);
      headerRequestId = providerDirectHeader(response, "x-request-id")
        || providerDirectHeader(response, "x-oneapi-request-id")
        || providerDirectHeader(response, "request-id");
      if (headerRequestId != null && typeof executor._providerDirectSession.onRequestId === "function") {
        executor._providerDirectSession.onRequestId(headerRequestId);
      }
      if (response == null || response.ok !== true || response.status < 200 || response.status > 299) {
        var status = response == null ? 0 : response.status;
        await providerDirectDrainFailureBody(response);
        throw new Error("Provider direct request failed with status " + status);
      }
      var decoder = adapter.createStreamDecoder({ requestId: headerRequestId || "" });
      if (decoder == null || typeof decoder.push !== "function" || typeof decoder.close !== "function") {
        throw new Error("Provider adapter createStreamDecoder must return { push, close }");
      }
      var bounds = providerDirectCreateResponseBounds();
      await providerDirectForEachBodyChunk(response, hopSignal, function (bytes) {
        bounds.observe(bytes);
        applyEvents(decoder.push(bytes), "push()");
      });
      applyEvents(decoder.close(), "close()");
      if (!sawFinish || finishEvent == null) {
        throw new Error("Provider direct stream ended without a terminal finish event");
      }
      if (pendingToolCalls.size > 0) {
        throw new Error("Provider direct stream ended with incomplete tool calls");
      }
      var usage = providerDirectUsageFromFinish(finishEvent);
      if (usage == null) {
        throw new Error("Provider direct stream finished without usage");
      }
      var extendedUsage = providerDirectExtendedUsageFromFinish(finishEvent, usage);
      var requestId = headerRequestId
        || finishEvent.requestId
        || (finishEvent.response != null ? finishEvent.response.id : null);
      var providerMetadata = finishEvent.providerMetadata != null && typeof finishEvent.providerMetadata === "object"
        ? providerDirectShallowCopy(finishEvent.providerMetadata)
        : {};
      if (requestId != null && requestId !== "") {
        providerMetadata.requestId = requestId;
        if (headerRequestId == null && typeof executor._providerDirectSession.onRequestId === "function") {
          executor._providerDirectSession.onRequestId(requestId);
        }
      }
      var content = [];
      if (reasoning.length > 0) content.push({ type: "reasoning", text: reasoning });
      if (text.length > 0) content.push({ type: "text", text: text });
      for (var t = 0; t < toolCalls.length; t += 1) {
        content.push({
          type: "tool-call",
          toolCallId: toolCalls[t].toolCallId,
          toolName: toolCalls[t].toolName,
          args: toolCalls[t].args
        });
      }
      var assistantMessage = {
        id: resolvedInvocationId,
        role: "assistant",
        content: content
      };
      if (opaqueState != null && opaqueState.items.length > 0) {
        providerDirectAttachOpaqueState(assistantMessage, opaqueState);
      }
      usageSlot.resolve(usage);
      extendedSlot.resolve(extendedUsage);
      metadataSlot.resolve(providerMetadata);
      invocationSlot.resolve(resolvedInvocationId);
      responseSlot.resolve({
        id: resolvedInvocationId,
        modelId: config.model,
        timestamp: new Date(),
        messages: [assistantMessage]
      });
      pump.end();
    } catch (error) {
      var err = providerDirectAsError(error);
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
