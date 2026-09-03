#!/usr/bin/env node
// grok-switch 0.8.1 - https://github.com/enderzcx/grok-bot-switch
// Single-file build. Do not edit; regenerate with `node build.mjs`.
"use strict";
// GROK_SWITCH_PAYLOAD_BEGIN
var __grokSwitchFactories = Object.create(null);
var __grokSwitchModules = Object.create(null);
function __grokSwitchRegister(id, factory) {
  __grokSwitchFactories[id] = factory;
}
function __grokSwitchRequire(id) {
  if (__grokSwitchModules[id] == null) {
    var factory = __grokSwitchFactories[id];
    // Node built-ins (node:crypto) come from the host's own require.
    if (factory == null) return require(id);
    var module = { exports: {} };
    __grokSwitchModules[id] = module;
    factory(module, module.exports, __grokSwitchRequire);
  }
  return __grokSwitchModules[id].exports;
}
__grokSwitchRegister("./contract.cjs", function (module, exports, require) {
"use strict";

var PROTOCOL_IDS = Object.freeze(["openai-chat", "openai-responses", "anthropic-messages"]);

var DEFAULT_ENDPOINT_PATHS = Object.freeze({
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages"
});

var DEFAULT_AUTH_TYPES = Object.freeze({
  "openai-chat": "bearer",
  "openai-responses": "bearer",
  "anthropic-messages": "x-api-key"
});

var FORBIDDEN_REQUEST_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|host|content-length|connection|transfer-encoding|keep-alive|upgrade|te|trailer|x-api-key|api-key|x-auth-token)$/i;

function protocolError(message, extra) {
  extra = extra || {};
  var error = new Error(message);
  error.name = "ProtocolError";
  if (extra.protocol) {
    error.protocol = extra.protocol;
  }
  if (extra.code) {
    error.code = extra.code;
  }
  if (extra.status != null) {
    error.status = extra.status;
  }
  return error;
}

function assertProtocolId(protocolId) {
  if (typeof protocolId !== "string" || PROTOCOL_IDS.indexOf(protocolId) === -1) {
    throw protocolError("Unknown provider protocol", { code: "unknown-protocol" });
  }
  return protocolId;
}

function assertNormalizedRequest(request, protocolId) {
  if (request == null || typeof request !== "object" || Array.isArray(request)) {
    throw protocolError("Normalized request must be an object", { protocol: protocolId, code: "invalid-request" });
  }
  if (typeof request.model !== "string" || request.model.length === 0) {
    throw protocolError("Normalized request is missing model", { protocol: protocolId, code: "invalid-request" });
  }
  if (request.messages != null && !Array.isArray(request.messages)) {
    throw protocolError("Normalized messages must be an array", { protocol: protocolId, code: "invalid-request" });
  }
  if (request.tools != null && !Array.isArray(request.tools)) {
    throw protocolError("Normalized tools must be an array", { protocol: protocolId, code: "invalid-request" });
  }
  if (request.stream === false) {
    throw protocolError("Non-streaming requests are unrepresentable in this adapter", {
      protocol: protocolId,
      code: "unsupported-shape"
    });
  }
  if (request.parameters != null) {
    if (typeof request.parameters !== "object" || Array.isArray(request.parameters)) {
      throw protocolError("Normalized request parameters are unrepresentable", {
        protocol: protocolId,
        code: "unsupported-shape"
      });
    }
  }
}

function isSafeAbsolutePath(path) {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  if (path.charCodeAt(0) !== 47 || (path.length > 1 && path.charCodeAt(1) === 47)) {
    return false;
  }
  for (var i = 0; i < path.length; i += 1) {
    var code = path.charCodeAt(i);
    if (code < 32 || code === 32 || code === 92 || code === 63 || code === 35 || code === 127) {
      return false;
    }
  }
  if (path.indexOf("://") !== -1) {
    return false;
  }
  return true;
}

function resolveEndpointPath(defaultPath, options, protocolId) {
  if (options == null || options.endpointPath == null || options.endpointPath === "") {
    return defaultPath;
  }
  if (typeof options.endpointPath !== "string" || !isSafeAbsolutePath(options.endpointPath)) {
    throw protocolError("endpointPath must be an absolute path", { protocol: protocolId, code: "invalid-request" });
  }
  return options.endpointPath;
}

function providerStateEvent(protocolId, items) {
  return {
    type: "provider-state",
    protocol: protocolId,
    state: {
      protocol: protocolId,
      items: items
    }
  };
}

// Opaque reasoning state we previously recorded for this protocol. State that
// is absent, empty, or belongs to another protocol (the conversation moved
// between providers) yields null: the adapter then replays the message without
// reasoning items, which every provider accepts. Malformed state still throws.
function readMessageProviderState(message, protocolId) {
  if (message == null || message.providerState == null) {
    return null;
  }
  var state = message.providerState;
  if (typeof state !== "object" || Array.isArray(state)) {
    throw protocolError("providerState is unrepresentable", {
      protocol: protocolId,
      code: "unsupported-shape"
    });
  }
  if (state.protocol !== protocolId) {
    return null;
  }
  if (!Array.isArray(state.items)) {
    throw protocolError("providerState items must be an array", {
      protocol: protocolId,
      code: "unsupported-shape"
    });
  }
  if (state.items.length === 0) {
    return null;
  }
  return state;
}

function continuationState(message, payload, protocolId) {
  var state = readMessageProviderState(message, protocolId);
  var hasReasoning = payload != null && typeof payload.reasoning === "string" && payload.reasoning.length > 0;
  // State without visible reasoning means the host dropped the reasoning
  // text; replaying the state alone would desynchronise the transcript.
  if (state != null && !hasReasoning) {
    return null;
  }
  return state;
}

function assertBoundReasoning(visible, derived, protocolId) {
  var text = visible == null ? "" : String(visible);
  var bound = derived == null ? "" : String(derived);
  if (text !== bound) {
    throw protocolError("providerState does not match visible reasoning", {
      protocol: protocolId,
      code: "unsupported-shape"
    });
  }
}

function jsonHeaders(extra, protocolId) {
  var headers = {
    "content-type": "application/json",
    accept: "text/event-stream"
  };
  if (extra != null) {
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i += 1) {
      var name = keys[i];
      assertSafeHeaderName(name, protocolId);
      var value = extra[name];
      if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
        throw protocolError("Request header is unrepresentable", { protocol: protocolId, code: "invalid-request" });
      }
      headers[name] = value;
    }
  }
  var outNames = Object.keys(headers);
  for (var j = 0; j < outNames.length; j += 1) {
    assertSafeHeaderName(outNames[j], protocolId);
  }
  return headers;
}

function assertSafeHeaderName(name, protocolId) {
  if (typeof name !== "string" || name.length === 0 || /[\r\n]/.test(name) || FORBIDDEN_REQUEST_HEADER.test(name)) {
    throw protocolError("Request header is not allowed", { protocol: protocolId, code: "invalid-request" });
  }
}

function mapFinishReason(reason) {
  if (reason == null || reason === "") {
    return null;
  }
  if (reason === "tool_calls" || reason === "function_call" || reason === "tool_use" || reason === "tool-calls") {
    return "tool-calls";
  }
  if (reason === "content_filter" || reason === "refusal") {
    return "content-filter";
  }
  if (reason === "max_tokens" || reason === "length") {
    return "length";
  }
  if (reason === "stop" || reason === "end_turn" || reason === "stop_sequence") {
    return "stop";
  }
  return String(reason);
}

function numberOrZero(value) {
  var n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeUsage(usage) {
  if (usage == null || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  var prompt = firstDefined(
    usage.prompt_tokens,
    usage.promptTokens,
    usage.input_tokens,
    usage.inputTokens
  );
  var completion = firstDefined(
    usage.completion_tokens,
    usage.completionTokens,
    usage.output_tokens,
    usage.outputTokens
  );
  var total = firstDefined(usage.total_tokens, usage.totalTokens);
  if (prompt == null && completion == null && total == null) {
    return null;
  }
  var promptTokens = numberOrZero(prompt);
  var completionTokens = numberOrZero(completion);
  var totalTokens = total == null ? promptTokens + completionTokens : numberOrZero(total);
  var cacheRead = 0;
  if (usage.prompt_tokens_details != null && usage.prompt_tokens_details.cached_tokens != null) {
    cacheRead = numberOrZero(usage.prompt_tokens_details.cached_tokens);
  } else if (usage.input_tokens_details != null && usage.input_tokens_details.cached_tokens != null) {
    cacheRead = numberOrZero(usage.input_tokens_details.cached_tokens);
  } else if (usage.cache_read_tokens != null) {
    cacheRead = numberOrZero(usage.cache_read_tokens);
  } else if (usage.cacheReadTokens != null) {
    cacheRead = numberOrZero(usage.cacheReadTokens);
  } else if (usage.cache_read_input_tokens != null) {
    cacheRead = numberOrZero(usage.cache_read_input_tokens);
  }
  var cacheWrite = 0;
  if (usage.cache_write_tokens != null) {
    cacheWrite = numberOrZero(usage.cache_write_tokens);
  } else if (usage.cacheWriteTokens != null) {
    cacheWrite = numberOrZero(usage.cacheWriteTokens);
  } else if (usage.cache_creation_input_tokens != null) {
    cacheWrite = numberOrZero(usage.cache_creation_input_tokens);
  }
  return {
    promptTokens: promptTokens,
    completionTokens: completionTokens,
    totalTokens: totalTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite
  };
}

function firstDefined() {
  for (var i = 0; i < arguments.length; i += 1) {
    if (arguments[i] != null) {
      return arguments[i];
    }
  }
  return null;
}

function mergeUsage(base, extra) {
  var left = base == null ? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } : base;
  if (extra == null) {
    return left;
  }
  return {
    promptTokens: extra.promptTokens != null && extra.promptTokens !== 0 ? extra.promptTokens : left.promptTokens,
    completionTokens: extra.completionTokens != null ? extra.completionTokens : left.completionTokens,
    totalTokens: 0,
    cacheReadTokens: extra.cacheReadTokens ? extra.cacheReadTokens : left.cacheReadTokens,
    cacheWriteTokens: extra.cacheWriteTokens ? extra.cacheWriteTokens : left.cacheWriteTokens
  };
}

function finalizeUsage(usage) {
  if (usage == null) {
    return null;
  }
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens != null && usage.totalTokens !== 0
      ? usage.totalTokens
      : usage.promptTokens + usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0
  };
}

function finishEvent(fields) {
  var usage = finalizeUsage(fields.usage);
  var event = {
    type: "finish",
    finishReason: fields.finishReason == null || fields.finishReason === "" ? "stop" : fields.finishReason,
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens
    },
    extendedUsage: {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cacheReadTokens: usage.cacheReadTokens || 0,
      cacheWriteTokens: usage.cacheWriteTokens || 0,
      maxTokens: 0
    }
  };
  if (typeof fields.requestId === "string" && fields.requestId.length > 0) {
    event.requestId = fields.requestId;
  }
  var responseId = typeof fields.responseId === "string" ? fields.responseId : "";
  var modelId = typeof fields.modelId === "string" ? fields.modelId : "";
  if (responseId.length > 0 || modelId.length > 0) {
    event.response = { id: responseId, modelId: modelId };
  }
  return event;
}

function extractUpstreamErrorMessage(bodyText, fallback) {
  if (typeof bodyText !== "string") {
    return fallback;
  }
  var trimmed = bodyText.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  var parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_error) {
    return fallback;
  }
  if (typeof parsed === "string" && parsed.length > 0) {
    return parsed;
  }
  if (parsed == null || typeof parsed !== "object") {
    return fallback;
  }
  if (typeof parsed.message === "string" && parsed.message.length > 0) {
    return parsed.message;
  }
  var errorValue = parsed.error;
  if (typeof errorValue === "string" && errorValue.length > 0) {
    return errorValue;
  }
  if (errorValue != null && typeof errorValue === "object") {
    if (typeof errorValue.message === "string" && errorValue.message.length > 0) {
      return errorValue.message;
    }
  }
  return fallback;
}

function bodyToText(body) {
  if (body == null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder("utf-8").decode(body);
  }
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(body));
  }
  return "";
}

function maxTokensFrom(request) {
  if (request.maxTokens != null) {
    return request.maxTokens;
  }
  if (request.parameters != null && request.parameters.maxTokens != null) {
    return request.parameters.maxTokens;
  }
  return null;
}

function reasoningEffortFrom(request) {
  if (request.parameters == null) {
    return null;
  }
  var effort = request.parameters.reasoningEffort;
  if (effort == null || effort === "") {
    return null;
  }
  if (typeof effort !== "string") {
    return null;
  }
  return effort;
}

function assertKnownParameters(request, allowed, protocolId) {
  if (request.parameters == null) {
    return;
  }
  var keys = Object.keys(request.parameters);
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (key === "maxTokens") {
      continue;
    }
    if (allowed.indexOf(key) === -1) {
      throw protocolError("Request parameter " + key + " is unrepresentable", {
        protocol: protocolId,
        code: "unsupported-shape"
      });
    }
  }
}

function decodeJsonData(data, protocolId) {
  try {
    return JSON.parse(data);
  } catch (_error) {
    throw protocolError("SSE data is invalid JSON", { protocol: protocolId, code: "invalid-json" });
  }
}

module.exports = {
  PROTOCOL_IDS: PROTOCOL_IDS,
  DEFAULT_ENDPOINT_PATHS: DEFAULT_ENDPOINT_PATHS,
  DEFAULT_AUTH_TYPES: DEFAULT_AUTH_TYPES,
  protocolError: protocolError,
  assertProtocolId: assertProtocolId,
  assertNormalizedRequest: assertNormalizedRequest,
  resolveEndpointPath: resolveEndpointPath,
  providerStateEvent: providerStateEvent,
  readMessageProviderState: readMessageProviderState,
  continuationState: continuationState,
  assertBoundReasoning: assertBoundReasoning,
  jsonHeaders: jsonHeaders,
  mapFinishReason: mapFinishReason,
  normalizeUsage: normalizeUsage,
  mergeUsage: mergeUsage,
  finalizeUsage: finalizeUsage,
  finishEvent: finishEvent,
  extractUpstreamErrorMessage: extractUpstreamErrorMessage,
  bodyToText: bodyToText,
  maxTokensFrom: maxTokensFrom,
  reasoningEffortFrom: reasoningEffortFrom,
  assertKnownParameters: assertKnownParameters,
  decodeJsonData: decodeJsonData
};
});
__grokSwitchRegister("./sse.cjs", function (module, exports, require) {
"use strict";

var contract = require("./contract.cjs");

function asUtf8Bytes(chunk, protocolId) {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (typeof ArrayBuffer !== "undefined" && chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  throw contract.protocolError("SSE decoder requires UTF-8 bytes", {
    protocol: protocolId,
    code: "invalid-request"
  });
}

function splitSseLines(text, isEnd) {
  var lines = [];
  var start = 0;
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i);
    if (code === 10) {
      lines.push(text.slice(start, i));
      start = i + 1;
    } else if (code === 13) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
        lines.push(text.slice(start, i));
        i += 1;
        start = i + 1;
      } else if (i + 1 < text.length || isEnd) {
        lines.push(text.slice(start, i));
        start = i + 1;
      }
    }
  }
  var rest = text.slice(start);
  if (isEnd && rest.length > 0) {
    lines.push(rest);
    rest = "";
  }
  return { lines: lines, rest: rest };
}

function createSseDecoder(options) {
  options = options || {};
  var protocolId = options.protocol;
  var utf8 = new TextDecoder("utf-8", { fatal: true });
  var textBuffer = "";
  var pendingData = [];
  var pendingEvent = "";
  var pendingId = "";
  var ended = false;
  var strippedBom = false;

  function dispatch() {
    if (pendingData.length === 0) {
      pendingEvent = "";
      pendingId = "";
      return null;
    }
    var data = pendingData.join("\n");
    var eventName = pendingEvent;
    var id = pendingId;
    pendingData = [];
    pendingEvent = "";
    pendingId = "";
    if (data.trim().length === 0) {
      return null;
    }
    return {
      event: eventName.length > 0 ? eventName : "message",
      data: data,
      id: id
    };
  }

  function handleLine(line) {
    if (line.length === 0) {
      return dispatch();
    }
    if (line.charCodeAt(0) === 58) {
      return null;
    }
    var colon = line.indexOf(":");
    var field;
    var value;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 32) {
        value = value.slice(1);
      }
    }
    if (field === "data") {
      pendingData.push(value);
    } else if (field === "event") {
      pendingEvent = value;
    } else if (field === "id") {
      pendingId = value;
    }
    return null;
  }

  function consume(isEnd) {
    var events = [];
    var lines = splitSseLines(textBuffer, isEnd);
    textBuffer = lines.rest;
    for (var i = 0; i < lines.lines.length; i += 1) {
      var event = handleLine(lines.lines[i]);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  return {
    push: function (chunk) {
      if (ended) {
        throw contract.protocolError("SSE decoder is already finished", {
          protocol: protocolId,
          code: "invalid-request"
        });
      }
      var bytes = asUtf8Bytes(chunk, protocolId);
      var decoded;
      try {
        decoded = utf8.decode(bytes, { stream: true });
      } catch (_error) {
        throw contract.protocolError("SSE stream is truncated", {
          protocol: protocolId,
          code: "truncated"
        });
      }
      if (!strippedBom && decoded.length > 0) {
        if (decoded.charCodeAt(0) === 0xfeff) {
          decoded = decoded.slice(1);
        }
        strippedBom = true;
      }
      textBuffer += decoded;
      return consume(false);
    },
    close: function () {
      if (ended) {
        throw contract.protocolError("SSE decoder is already finished", {
          protocol: protocolId,
          code: "invalid-request"
        });
      }
      ended = true;
      try {
        textBuffer += utf8.decode();
      } catch (_error) {
        throw contract.protocolError("SSE stream is truncated", {
          protocol: protocolId,
          code: "truncated"
        });
      }
      var events = consume(true);
      if (pendingData.length > 0) {
        var last = dispatch();
        if (last) {
          events.push(last);
        }
      }
      return events;
    }
  };
}

module.exports = {
  createSseDecoder: createSseDecoder,
  asUtf8Bytes: asUtf8Bytes
};
});
__grokSwitchRegister("./tools.cjs", function (module, exports, require) {
"use strict";

var contract = require("./contract.cjs");
var nodeCrypto = require("node:crypto");

// Providers cap tool call ids (OpenAI Responses: 64 chars; Anthropic:
// [A-Za-z0-9_-]). Grok Bot's own ids are longer, so out-of-spec ids are
// replaced by a deterministic hash: the same original id always maps to the
// same short id, which keeps tool results paired with their calls.
var TOOL_CALL_ID_OK = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeToolCallId(id) {
  if (TOOL_CALL_ID_OK.test(id)) return id;
  return "call_" + nodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 32);
}

function unsupported(protocolId, detail) {
  return contract.protocolError(detail || "Shape is unrepresentable", {
    protocol: protocolId,
    code: "unsupported-shape"
  });
}

function jsonArgumentString(args, protocolId) {
  if (args == null) {
    return "{}";
  }
  if (typeof args === "string") {
    if (args.trim().length === 0) {
      return "{}";
    }
    try {
      JSON.parse(args);
      return args;
    } catch (_error) {
      return JSON.stringify(args);
    }
  }
  try {
    return JSON.stringify(args);
  } catch (_error) {
    throw unsupported(protocolId, "Tool call arguments are unrepresentable");
  }
}

function isEmptyOptionalValue(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function isSendMessageTool(name) {
  return typeof name === "string" && /^(?:send_?message|send_?to_?user)$/i.test(name);
}

// Mirrors the host's TYPE_SCOPED_SEND_MESSAGE_FIELDS: each of these fields is
// only meaningful for the listed message types.
var SEND_MESSAGE_TYPE_SCOPED_FIELDS = {
  content: ["text"],
  url: ["attachment"],
  alt: ["attachment"],
  widget: ["widget"],
  bcId: ["cursor-agent"],
  secret: ["secret-request"]
};

// Grok Bot's SendMessage schema has mutually-exclusive optional branches keyed
// by `type`. Some models fill every optional branch (an empty {} or even a
// fully formed widget/secret object) on a plain type:text message; the host
// rejects that with "Nothing was sent" and the model retries forever. The host
// documents that such fields would otherwise be "silently dropped", so
// dropping fields that do not belong to the declared type is equivalent and
// stops the loop. Empty optional values are removed as well.
function normalizeToolArguments(name, args) {
  if (!isSendMessageTool(name) || args == null || typeof args !== "object" || Array.isArray(args)) return args;
  var declaredType = typeof args.type === "string" ? args.type : null;
  var out = {};
  var names = Object.keys(args);
  for (var i = 0; i < names.length; i += 1) {
    var key = names[i];
    if (key !== "type" && isEmptyOptionalValue(args[key])) continue;
    var scope = SEND_MESSAGE_TYPE_SCOPED_FIELDS[key];
    if (scope != null && declaredType != null && scope.indexOf(declaredType) === -1) continue;
    out[key] = args[key];
  }
  return out;
}

function parseToolArgumentsObject(raw, protocolId, toolName) {
  var text = raw == null ? "" : String(raw);
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return normalizeToolArguments(toolName, JSON.parse(text));
  } catch (_error) {
    throw contract.protocolError("Tool call has invalid final JSON arguments", {
      protocol: protocolId,
      code: "invalid-json"
    });
  }
}

function toolParameters(parameters, protocolId) {
  if (parameters == null) {
    return { type: "object", properties: {} };
  }
  if (typeof parameters !== "object" || Array.isArray(parameters)) {
    throw unsupported(protocolId, "Tool parameters are unrepresentable");
  }
  if (parameters.jsonSchema != null && typeof parameters.jsonSchema === "object" && !Array.isArray(parameters.jsonSchema)) {
    return parameters.jsonSchema;
  }
  if (parameters.type != null || parameters.properties != null || parameters.$schema != null) {
    return parameters;
  }
  if (Object.keys(parameters).length === 0) {
    return { type: "object", properties: {} };
  }
  throw unsupported(protocolId, "Tool parameters are unrepresentable");
}

function convertFunctionTools(tools, protocolId) {
  if (tools == null) {
    return [];
  }
  if (!Array.isArray(tools)) {
    throw unsupported(protocolId, "Tools must be an array");
  }
  var out = [];
  for (var i = 0; i < tools.length; i += 1) {
    out.push(convertFunctionTool(tools[i], protocolId));
  }
  return out;
}

function convertFunctionTool(tool, protocolId) {
  if (tool == null || typeof tool !== "object" || Array.isArray(tool)) {
    throw unsupported(protocolId, "Tool is unrepresentable");
  }
  if (tool.type === "provider-defined" || tool.type === "provider_defined") {
    throw unsupported(protocolId, "Tool has an unrepresentable provider-defined shape");
  }
  if (tool.type != null && tool.type !== "function") {
    throw unsupported(protocolId, "Tool has an unrepresentable provider-defined shape");
  }
  var fn = tool.type === "function" && tool.function != null && typeof tool.function === "object"
    ? tool.function
    : tool;
  var name = fn.name || tool.name;
  if (typeof name !== "string" || name.length === 0) {
    throw contract.protocolError("Tool is missing a function name", {
      protocol: protocolId,
      code: "invalid-request"
    });
  }
  var description = fn.description || tool.description;
  var parameters = toolParameters(fn.parameters || tool.parameters || fn.inputSchema || tool.inputSchema, protocolId);
  var converted = { name: name, parameters: parameters };
  if (typeof description === "string") {
    converted.description = description;
  }
  return converted;
}

function bytesToBase64(bytes) {
  var table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var out = "";
  var i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    var n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + table[n & 63];
  }
  var remain = bytes.length - i;
  if (remain === 1) {
    var n1 = bytes[i] << 16;
    out += table[(n1 >> 18) & 63] + table[(n1 >> 12) & 63] + "==";
  } else if (remain === 2) {
    var n2 = bytes[i] << 16 | bytes[i + 1] << 8;
    out += table[(n2 >> 18) & 63] + table[(n2 >> 12) & 63] + table[(n2 >> 6) & 63] + "=";
  }
  return out;
}

function imageUrlFromPart(part, protocolId) {
  if (part.type === "image_url") {
    var imageUrl = part.image_url;
    var url = typeof imageUrl === "string" ? imageUrl : imageUrl != null ? imageUrl.url : null;
    if (typeof url !== "string" || url.length === 0) {
      throw unsupported(protocolId, "Image content is unrepresentable");
    }
    return url;
  }
  var image = part.image;
  var mime = typeof part.mimeType === "string" && part.mimeType.length > 0 ? part.mimeType : "image/png";
  if (typeof image === "string") {
    if (image.length === 0) {
      throw unsupported(protocolId, "Image content is unrepresentable");
    }
    // The host emits bare base64 when the attachment had no mime type.
    if (!/^(data:|https?:\/\/)/i.test(image)) {
      return "data:" + mime + ";base64," + image;
    }
    return image;
  }
  if (typeof URL !== "undefined" && image instanceof URL) {
    return String(image);
  }
  if (image instanceof Uint8Array) {
    return "data:" + mime + ";base64," + bytesToBase64(image);
  }
  if (typeof ArrayBuffer !== "undefined" && image instanceof ArrayBuffer) {
    return "data:" + mime + ";base64," + bytesToBase64(new Uint8Array(image));
  }
  throw unsupported(protocolId, "Image content is unrepresentable");
}

function extractSystemText(message, protocolId) {
  if (typeof message.content === "string") {
    return message.content;
  }
  throw unsupported(protocolId, "System content is unrepresentable");
}

// History compatibility policy: conversation history produced by another
// provider (usually official Grok) may contain parts no external protocol can
// carry. Those are degraded to a short text placeholder or dropped so the turn
// can proceed; genuinely malformed parts still throw.
function filePlaceholder(part) {
  var name = typeof part.filename === "string" && part.filename.length > 0 ? part.filename : "file";
  var mime = typeof part.mimeType === "string" && part.mimeType.length > 0 ? " (" + part.mimeType + ")" : "";
  return "[Attached file omitted: " + name + mime + "]";
}

function extractUserParts(message, protocolId) {
  if (typeof message.content === "string") {
    return [{ kind: "text", text: message.content }];
  }
  if (!Array.isArray(message.content)) {
    throw unsupported(protocolId, "User content is unrepresentable");
  }
  var parts = [];
  for (var i = 0; i < message.content.length; i += 1) {
    var part = message.content[i];
    if (part == null || typeof part !== "object") {
      throw unsupported(protocolId, "User content is unrepresentable");
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw unsupported(protocolId, "User content is unrepresentable");
      }
      parts.push({ kind: "text", text: part.text });
    } else if (part.type === "image" || part.type === "image_url") {
      parts.push({ kind: "image", url: imageUrlFromPart(part, protocolId) });
    } else if (part.type === "file") {
      parts.push({ kind: "text", text: filePlaceholder(part) });
    } else {
      throw unsupported(protocolId, "User content is unrepresentable");
    }
  }
  return parts;
}

function hostToolCall(part, protocolId) {
  var id = part.toolCallId || part.tool_call_id || part.id;
  var name = part.toolName || part.tool_name;
  if ((name == null || name === "") && part.function != null && typeof part.function.name === "string") {
    name = part.function.name;
  }
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
    throw contract.protocolError("Tool call is missing id or name", {
      protocol: protocolId,
      code: "incomplete-tool-call"
    });
  }
  var args = part.args;
  if (part.providerOptions != null && part.providerOptions.cursor != null && typeof part.providerOptions.cursor.rawToolCallArgs === "string") {
    args = part.providerOptions.cursor.rawToolCallArgs;
  }
  return { id: normalizeToolCallId(id), name: name, arguments: jsonArgumentString(args, protocolId) };
}

function openAiShapedToolCall(toolCall, protocolId) {
  if (toolCall == null || typeof toolCall !== "object") {
    throw unsupported(protocolId, "Tool call is unrepresentable");
  }
  var fn = toolCall.function;
  var id = toolCall.id;
  var name = fn != null ? fn.name : null;
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
    throw contract.protocolError("Tool call is missing id or name", {
      protocol: protocolId,
      code: "incomplete-tool-call"
    });
  }
  return { id: normalizeToolCallId(id), name: name, arguments: jsonArgumentString(fn.arguments, protocolId) };
}

function extractAssistantPayload(message, protocolId) {
  var toolCalls = [];
  var texts = [];
  var reasonings = [];
  if (Array.isArray(message.tool_calls)) {
    for (var i = 0; i < message.tool_calls.length; i += 1) {
      toolCalls.push(openAiShapedToolCall(message.tool_calls[i], protocolId));
    }
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    reasonings.push(message.reasoning_content);
  }
  if (typeof message.content === "string") {
    texts.push(message.content);
  } else if (message.content == null) {
    // OpenAI-shaped assistant with tool_calls and null content.
  } else if (Array.isArray(message.content)) {
    for (var j = 0; j < message.content.length; j += 1) {
      var part = message.content[j];
      if (part == null || typeof part !== "object") {
        throw unsupported(protocolId, "Assistant content is unrepresentable");
      }
      if (part.type === "text") {
        if (typeof part.text !== "string") {
          throw unsupported(protocolId, "Assistant content is unrepresentable");
        }
        texts.push(part.text);
      } else if (part.type === "reasoning") {
        if (typeof part.text !== "string") {
          throw unsupported(protocolId, "Assistant content is unrepresentable");
        }
        reasonings.push(part.text);
      } else if (part.type === "tool-call" || part.type === "tool_call") {
        toolCalls.push(hostToolCall(part, protocolId));
      } else if (part.type === "redacted-reasoning" || part.type === "file") {
        // Opaque reasoning from another provider cannot be replayed anywhere;
        // assistant file outputs have no equivalent in these protocols.
        continue;
      } else {
        throw unsupported(protocolId, "Assistant content is unrepresentable");
      }
    }
  } else {
    throw unsupported(protocolId, "Assistant content is unrepresentable");
  }
  return {
    text: texts.join(""),
    reasoning: reasonings.join(""),
    toolCalls: toolCalls,
    isEmpty: texts.join("").length === 0 && reasonings.join("").length === 0 && toolCalls.length === 0
  };
}

// Splits a tool result's rich content (host `content` or `experimental_content`)
// into text and image data URLs. Any other item type is unrepresentable.
function toolResultRichParts(part, protocolId) {
  var extras = Array.isArray(part.experimental_content) ? part.experimental_content : part.content;
  var texts = [];
  var images = [];
  if (!Array.isArray(extras)) {
    return { texts: texts, images: images };
  }
  for (var i = 0; i < extras.length; i += 1) {
    var item = extras[i];
    if (item == null || typeof item !== "object") {
      throw unsupported(protocolId, "Tool result content is unrepresentable");
    }
    if (item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    } else if (item.type === "image" && typeof item.data === "string" && item.data.length > 0) {
      var mime = typeof item.mimeType === "string" && item.mimeType.length > 0 ? item.mimeType : "image/png";
      images.push(item.data.indexOf("data:") === 0 ? item.data : "data:" + mime + ";base64," + item.data);
    } else if (item.type === "image" || item.type === "image_url") {
      images.push(imageUrlFromPart(item, protocolId));
    } else {
      throw unsupported(protocolId, "Tool result content is unrepresentable");
    }
  }
  return { texts: texts, images: images };
}

function toolResultContent(part, rich, protocolId) {
  if (typeof part.result === "string") {
    return part.result;
  }
  if (part.result !== undefined) {
    try {
      return JSON.stringify(part.result);
    } catch (_error) {
      throw unsupported(protocolId, "Tool result content is unrepresentable");
    }
  }
  if (typeof part.content === "string") {
    return part.content;
  }
  return rich.texts.join("");
}

// Returns [{ id, name, content, images }] where images are data/HTTP URLs of
// image outputs the tool produced (screenshots etc.).
function extractToolResults(message, protocolId) {
  if (typeof message.tool_call_id === "string" && message.tool_call_id.length > 0 && (typeof message.content === "string" || message.content == null)) {
    return [{ id: normalizeToolCallId(message.tool_call_id), name: message.name, content: message.content == null ? "" : message.content, images: [] }];
  }
  if (!Array.isArray(message.content)) {
    throw unsupported(protocolId, "Tool content is unrepresentable");
  }
  var out = [];
  for (var i = 0; i < message.content.length; i += 1) {
    var part = message.content[i];
    if (part == null || typeof part !== "object" || (part.type !== "tool-result" && part.type !== "tool_result")) {
      throw unsupported(protocolId, "Tool content is unrepresentable");
    }
    var id = typeof part.toolCallId === "string" ? part.toolCallId : part.tool_call_id;
    if (typeof id !== "string" || id.length === 0) {
      throw contract.protocolError("Tool result is missing tool_call_id", {
        protocol: protocolId,
        code: "incomplete-tool-call"
      });
    }
    var rich = toolResultRichParts(part, protocolId);
    out.push({
      id: normalizeToolCallId(id),
      name: typeof part.toolName === "string" ? part.toolName : part.tool_name,
      content: toolResultContent(part, rich, protocolId),
      images: rich.images
    });
  }
  return out;
}

// For protocols whose tool-result slot is text-only, image outputs are carried
// by a user message that immediately follows the tool results.
function toolImagesUserParts(results) {
  var parts = [];
  for (var i = 0; i < results.length; i += 1) {
    if (results[i].images.length === 0) continue;
    var label = results[i].name ? results[i].name : results[i].id;
    parts.push({ kind: "text", text: "[Image output of tool " + label + "]" });
    for (var j = 0; j < results[i].images.length; j += 1) {
      parts.push({ kind: "image", url: results[i].images[j] });
    }
  }
  return parts;
}

module.exports = {
  convertFunctionTools: convertFunctionTools,
  jsonArgumentString: jsonArgumentString,
  parseToolArgumentsObject: parseToolArgumentsObject,
  normalizeToolArguments: normalizeToolArguments,
  extractSystemText: extractSystemText,
  extractUserParts: extractUserParts,
  extractAssistantPayload: extractAssistantPayload,
  extractToolResults: extractToolResults,
  toolImagesUserParts: toolImagesUserParts,
  unsupported: unsupported
};
});
__grokSwitchRegister("./openai-chat.cjs", function (module, exports, require) {
"use strict";

var contract = require("./contract.cjs");
var sse = require("./sse.cjs");
var tools = require("./tools.cjs");

var PROTOCOL_ID = "openai-chat";

function toOpenAiMessages(messages) {
  if (messages == null) {
    return [];
  }
  if (!Array.isArray(messages)) {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat messages must be an array");
  }
  var out = [];
  for (var i = 0; i < messages.length; i += 1) {
    var message = messages[i];
    if (message == null || typeof message !== "object" || Array.isArray(message)) {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat message is unrepresentable");
    }
    var role = message.role;
    if (role === "system") {
      out.push({ role: "system", content: tools.extractSystemText(message, PROTOCOL_ID) });
    } else if (role === "user") {
      out.push({ role: "user", content: userContentFromParts(tools.extractUserParts(message, PROTOCOL_ID)) });
    } else if (role === "assistant") {
      var assistant = assistantMessage(message);
      if (assistant != null) {
        out.push(assistant);
      }
    } else if (role === "tool") {
      var toolMessages = tools.extractToolResults(message, PROTOCOL_ID);
      for (var j = 0; j < toolMessages.length; j += 1) {
        out.push({
          role: "tool",
          tool_call_id: toolMessages[j].id,
          content: toolMessages[j].content
        });
      }
      var imageParts = tools.toolImagesUserParts(toolMessages);
      if (imageParts.length > 0) {
        out.push({ role: "user", content: userContentFromParts(imageParts) });
      }
    } else {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat message role is unrepresentable");
    }
  }
  return out;
}

function userContentFromParts(parts) {
  if (parts.length === 0) {
    return "";
  }
  var allText = true;
  var mapped = [];
  for (var i = 0; i < parts.length; i += 1) {
    if (parts[i].kind === "text") {
      mapped.push({ type: "text", text: parts[i].text });
    } else {
      allText = false;
      mapped.push({ type: "image_url", image_url: { url: parts[i].url } });
    }
  }
  if (allText && mapped.length === 1) {
    return mapped[0].text;
  }
  return mapped;
}

function assistantMessage(message) {
  var payload = tools.extractAssistantPayload(message, PROTOCOL_ID);
  // Chat Completions is stateless: prior reasoning is never replayed. OpenAI
  // rejects unknown message fields and DeepSeek returns 400 when
  // reasoning_content is echoed back, so only text and tool calls go out.
  if (payload.text.length === 0 && payload.toolCalls.length === 0) {
    return null;
  }
  var result = {
    role: "assistant",
    content: payload.text.length === 0 ? null : payload.text
  };
  if (payload.toolCalls.length > 0) {
    result.tool_calls = [];
    for (var i = 0; i < payload.toolCalls.length; i += 1) {
      var call = payload.toolCalls[i];
      result.tool_calls.push({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments }
      });
    }
  }
  return result;
}

function toOpenAiTools(rawTools) {
  var fns = tools.convertFunctionTools(rawTools, PROTOCOL_ID);
  var out = [];
  for (var i = 0; i < fns.length; i += 1) {
    var item = {
      type: "function",
      function: {
        name: fns[i].name,
        parameters: fns[i].parameters
      }
    };
    if (typeof fns[i].description === "string") {
      item.function.description = fns[i].description;
    }
    out.push(item);
  }
  return out;
}

function buildRequest(request, options) {
  contract.assertNormalizedRequest(request, PROTOCOL_ID);
  contract.assertKnownParameters(request, ["reasoningEffort"], PROTOCOL_ID);
  var body = {
    model: request.model,
    messages: toOpenAiMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true }
  };
  var openaiTools = toOpenAiTools(request.tools);
  if (openaiTools.length > 0) {
    body.tools = openaiTools;
  }
  var maxTokens = contract.maxTokensFrom(request);
  if (maxTokens != null) {
    body.max_tokens = maxTokens;
  }
  var effort = contract.reasoningEffortFrom(request);
  if (effort != null) {
    body.reasoning_effort = effort;
  }
  return {
    method: "POST",
    path: contract.resolveEndpointPath("/chat/completions", options, PROTOCOL_ID),
    headers: contract.jsonHeaders(null, PROTOCOL_ID),
    body: body
  };
}

function createToolCallAccumulator() {
  var slots = new Map();
  var finishReason = null;
  var usage = null;
  var responseId = "";
  var modelId = "";
  var callsFinalized = false;
  var finishEmitted = false;

  function slot(index) {
    var current = slots.get(index);
    if (current == null) {
      current = {
        index: index,
        id: "",
        name: "",
        arguments: "",
        pendingDeltas: "",
        started: false
      };
      slots.set(index, current);
    }
    return current;
  }

  function maybeStart(current, events) {
    if (current.started || current.id.length === 0 || current.name.length === 0) {
      return;
    }
    current.started = true;
    events.push({
      type: "tool-call-streaming-start",
      toolCallId: current.id,
      toolName: current.name
    });
    if (current.pendingDeltas.length > 0) {
      events.push({
        type: "tool-call-delta",
        toolCallId: current.id,
        toolName: current.name,
        argsTextDelta: current.pendingDeltas
      });
      current.pendingDeltas = "";
    }
  }

  return {
    ingest: function (toolCalls) {
      if (toolCalls == null) {
        return [];
      }
      if (!Array.isArray(toolCalls)) {
        throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat tool_calls must be an array");
      }
      var events = [];
      for (var i = 0; i < toolCalls.length; i += 1) {
        var toolCall = toolCalls[i];
        if (toolCall == null || typeof toolCall !== "object") {
          throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat tool call fragment is unrepresentable");
        }
        var index = Number(toolCall.index);
        if (!Number.isInteger(index) || index < 0) {
          index = 0;
        }
        var current = slot(index);
        if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
          current.id = toolCall.id;
        }
        var fn = toolCall.function;
        if (fn != null && typeof fn === "object") {
          if (typeof fn.name === "string" && fn.name.length > 0) {
            current.name = fn.name;
          }
          if (typeof fn.arguments === "string") {
            current.arguments += fn.arguments;
            if (fn.arguments.length > 0) {
              if (current.started) {
                events.push({
                  type: "tool-call-delta",
                  toolCallId: current.id,
                  toolName: current.name,
                  argsTextDelta: fn.arguments
                });
              } else {
                current.pendingDeltas += fn.arguments;
              }
            }
          } else if (fn.arguments != null) {
            throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat tool call arguments are unrepresentable");
          }
        }
        maybeStart(current, events);
      }
      return events;
    },
    complete: function () {
      if (callsFinalized) {
        return [];
      }
      var ordered = Array.from(slots.values()).sort(function (a, b) {
        return a.index - b.index;
      });
      var events = [];
      for (var i = 0; i < ordered.length; i += 1) {
        var current = ordered[i];
        if (current.id.length === 0 || current.name.length === 0) {
          throw contract.protocolError("OpenAI Chat tool call is missing id or name", {
            protocol: PROTOCOL_ID,
            code: "incomplete-tool-call"
          });
        }
        if (!current.started) {
          current.started = true;
          events.push({
            type: "tool-call-streaming-start",
            toolCallId: current.id,
            toolName: current.name
          });
          if (current.pendingDeltas.length > 0) {
            events.push({
              type: "tool-call-delta",
              toolCallId: current.id,
              toolName: current.name,
              argsTextDelta: current.pendingDeltas
            });
            current.pendingDeltas = "";
          }
        }
        events.push({
          type: "tool-call",
          toolCallId: current.id,
          toolName: current.name,
          args: tools.parseToolArgumentsObject(current.arguments, PROTOCOL_ID, current.name)
        });
      }
      callsFinalized = true;
      return events;
    },
    observeChunk: function (chunk) {
      if (chunk == null || typeof chunk !== "object") {
        return;
      }
      if (typeof chunk.id === "string" && chunk.id.length > 0) {
        responseId = chunk.id;
      }
      if (typeof chunk.model === "string" && chunk.model.length > 0) {
        modelId = chunk.model;
      }
      var nextUsage = contract.normalizeUsage(chunk.usage);
      if (nextUsage != null) {
        usage = nextUsage;
      }
    },
    setFinishReason: function (reason) {
      var mapped = contract.mapFinishReason(reason);
      if (mapped != null) {
        finishReason = mapped;
      }
    },
    getFinishReason: function () {
      return finishReason;
    },
    getUsage: function () {
      return usage;
    },
    getResponseMeta: function () {
      return { id: responseId, modelId: modelId };
    },
    hasFinishEmitted: function () {
      return finishEmitted;
    },
    markFinishEmitted: function () {
      finishEmitted = true;
    }
  };
}

function primaryChoice(chunk) {
  var choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  for (var i = 0; i < choices.length; i += 1) {
    var choice = choices[i];
    if (choice != null && (choice.index === 0 || choice.index == null)) {
      return choice;
    }
  }
  return choices[0];
}

function deltaText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  if (Array.isArray(content)) {
    var texts = [];
    for (var i = 0; i < content.length; i += 1) {
      var part = content[i];
      if (part == null || typeof part !== "object") {
        throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat content delta is unrepresentable");
      }
      if (part.type != null && part.type !== "text") {
        throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat content delta is unrepresentable");
      }
      if (typeof part.text !== "string") {
        throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat content delta is unrepresentable");
      }
      texts.push(part.text);
    }
    return texts.join("");
  }
  throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat content delta is unrepresentable");
}

function deltaReasoning(delta) {
  if (typeof delta.reasoning_content === "string") {
    return delta.reasoning_content;
  }
  if (typeof delta.reasoning === "string") {
    return delta.reasoning;
  }
  if (delta.reasoning != null && typeof delta.reasoning === "object" && typeof delta.reasoning.content === "string") {
    return delta.reasoning.content;
  }
  return "";
}

function streamErrorMessage(errorValue) {
  if (typeof errorValue === "string" && errorValue.length > 0) {
    return errorValue;
  }
  if (errorValue != null && typeof errorValue === "object" && typeof errorValue.message === "string" && errorValue.message.length > 0) {
    return errorValue.message;
  }
  return "OpenAI Chat stream error";
}

function takeFinishEvents(accumulator, force, requestId) {
  var usage = accumulator.getUsage();
  var reason = accumulator.getFinishReason();
  if (!force && (reason == null || usage == null)) {
    return [];
  }
  if (accumulator.hasFinishEmitted()) {
    return [];
  }
  if (force && usage == null) {
    throw contract.protocolError("OpenAI Chat stream finished without usage", {
      protocol: PROTOCOL_ID,
      code: "missing-usage"
    });
  }
  var events = [];
  if (reason != null || force) {
    var completed = accumulator.complete();
    for (var i = 0; i < completed.length; i += 1) {
      events.push(completed[i]);
    }
  }
  var meta = accumulator.getResponseMeta();
  events.push(contract.finishEvent({
    finishReason: reason,
    usage: usage,
    requestId: requestId || meta.id,
    responseId: meta.id,
    modelId: meta.modelId
  }));
  accumulator.markFinishEmitted();
  return events;
}

function chunkToEvents(payload, accumulator, requestId) {
  if (payload.error != null) {
    throw contract.protocolError(streamErrorMessage(payload.error), {
      protocol: PROTOCOL_ID,
      code: "stream-error"
    });
  }
  accumulator.observeChunk(payload);
  var events = [];
  var choice = primaryChoice(payload);
  var delta = choice != null ? choice.delta : null;
  if (delta != null && typeof delta === "object") {
    var reasoning = deltaReasoning(delta);
    if (reasoning.length > 0) {
      events.push({ type: "reasoning", textDelta: reasoning });
    }
    var text = deltaText(delta.content);
    if (text.length > 0) {
      events.push({ type: "text-delta", textDelta: text });
    }
    if (delta.tool_calls != null) {
      var toolEvents = accumulator.ingest(delta.tool_calls);
      for (var i = 0; i < toolEvents.length; i += 1) {
        events.push(toolEvents[i]);
      }
    }
  }
  if (choice != null && choice.finish_reason != null && choice.finish_reason !== "") {
    accumulator.setFinishReason(choice.finish_reason);
    var completed = accumulator.complete();
    for (var j = 0; j < completed.length; j += 1) {
      events.push(completed[j]);
    }
  }
  var finishEvents = takeFinishEvents(accumulator, false, requestId);
  for (var k = 0; k < finishEvents.length; k += 1) {
    events.push(finishEvents[k]);
  }
  return events;
}

function createStreamDecoder(options) {
  options = options || {};
  var decoder = sse.createSseDecoder({ protocol: PROTOCOL_ID });
  var accumulator = createToolCallAccumulator();
  var closed = false;
  var seenDone = false;
  var requestId = typeof options.requestId === "string" ? options.requestId : "";

  function ingestSse(rawEvents) {
    var events = [];
    for (var i = 0; i < rawEvents.length; i += 1) {
      if (seenDone) {
        break;
      }
      var raw = rawEvents[i];
      var trimmed = raw.data.trim();
      if (trimmed === "[DONE]") {
        seenDone = true;
        var doneEvents = takeFinishEvents(accumulator, true, requestId);
        for (var j = 0; j < doneEvents.length; j += 1) {
          events.push(doneEvents[j]);
        }
        continue;
      }
      var payload = contract.decodeJsonData(raw.data, PROTOCOL_ID);
      if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
        throw contract.protocolError("SSE data is invalid JSON", {
          protocol: PROTOCOL_ID,
          code: "invalid-json"
        });
      }
      var mapped = chunkToEvents(payload, accumulator, requestId);
      for (var k = 0; k < mapped.length; k += 1) {
        events.push(mapped[k]);
      }
    }
    return events;
  }

  return {
    push: function (chunk) {
      return ingestSse(decoder.push(chunk));
    },
    close: function () {
      if (closed) {
        throw contract.protocolError("SSE decoder is already finished", {
          protocol: PROTOCOL_ID,
          code: "invalid-request"
        });
      }
      closed = true;
      var events = ingestSse(decoder.close());
      if (!seenDone) {
        throw contract.protocolError("OpenAI Chat SSE stream is missing [DONE]", {
          protocol: PROTOCOL_ID,
          code: "missing-terminator"
        });
      }
      return events;
    }
  };
}

function interpretHttpFailure(status, body) {
  var code = Number(status);
  if (!Number.isFinite(code) || (code >= 200 && code <= 299)) {
    throw contract.protocolError("Upstream HTTP status is not a failure", {
      protocol: PROTOCOL_ID,
      code: "invalid-request",
      status: code
    });
  }
  var fallback = "Upstream request failed with status " + code;
  throw contract.protocolError(
    contract.extractUpstreamErrorMessage(contract.bodyToText(body), fallback),
    { protocol: PROTOCOL_ID, code: "http-error", status: code }
  );
}

module.exports = {
  id: PROTOCOL_ID,
  defaultEndpointPath: "/chat/completions",
  defaultAuthType: "bearer",
  buildRequest: buildRequest,
  createStreamDecoder: createStreamDecoder,
  interpretHttpFailure: interpretHttpFailure
};
});
__grokSwitchRegister("./openai-responses.cjs", function (module, exports, require) {
"use strict";

var contract = require("./contract.cjs");
var sse = require("./sse.cjs");
var tools = require("./tools.cjs");

var PROTOCOL_ID = "openai-responses";
var REASONING_MODEL = /^(gpt-5|o1|o3|o4|codex)/i;

var HOSTED_ITEM_TYPES = {
  web_search_call: true,
  file_search_call: true,
  computer_call: true,
  code_interpreter_call: true,
  image_generation_call: true,
  mcp_call: true,
  custom_tool_call: true,
  local_shell_call: true
};

function validateSummaryEntries(summary) {
  if (!Array.isArray(summary)) {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses reasoning summary is unrepresentable");
  }
  var captured = [];
  for (var i = 0; i < summary.length; i += 1) {
    var part = summary[i];
    if (part == null || typeof part !== "object" || Array.isArray(part) || part.type !== "summary_text" || typeof part.text !== "string") {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses reasoning summary is unrepresentable");
    }
    captured.push({ type: "summary_text", text: part.text });
  }
  return captured;
}

function validateResponsesReasoningItem(item) {
  if (item == null || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning") {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses reasoning item is unrepresentable");
  }
  if (typeof item.id !== "string" || item.id.length === 0) {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses reasoning item is missing id");
  }
  if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses reasoning item is missing encrypted_content");
  }
  var captured = {
    type: "reasoning",
    id: item.id,
    encrypted_content: item.encrypted_content
  };
  if (item.summary != null) {
    captured.summary = validateSummaryEntries(item.summary);
  }
  return captured;
}

function derivedResponsesReasoningText(items) {
  var text = "";
  for (var i = 0; i < items.length; i += 1) {
    var summary = items[i].summary;
    if (!Array.isArray(summary) || summary.length === 0) {
      continue;
    }
    for (var j = 0; j < summary.length; j += 1) {
      text += summary[j].text;
    }
  }
  return text;
}

function userMessage(parts) {
  var content = [];
  for (var i = 0; i < parts.length; i += 1) {
    if (parts[i].kind === "text") {
      content.push({ type: "input_text", text: parts[i].text });
    } else {
      content.push({ type: "input_image", image_url: parts[i].url });
    }
  }
  return { type: "message", role: "user", content: content };
}

function assistantTextMessage(text) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: text }]
  };
}

function toResponsesInput(messages) {
  if (messages == null) {
    return { instructions: null, input: [] };
  }
  if (!Array.isArray(messages)) {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses messages must be an array");
  }
  var systems = [];
  var input = [];
  for (var i = 0; i < messages.length; i += 1) {
    var message = messages[i];
    if (message == null || typeof message !== "object" || Array.isArray(message)) {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses message is unrepresentable");
    }
    var role = message.role;
    if (role === "system") {
      systems.push(tools.extractSystemText(message, PROTOCOL_ID));
    } else if (role === "user") {
      input.push(userMessage(tools.extractUserParts(message, PROTOCOL_ID)));
    } else if (role === "assistant") {
      var payload = tools.extractAssistantPayload(message, PROTOCOL_ID);
      var providerState = contract.continuationState(message, payload, PROTOCOL_ID);
      if (providerState != null) {
        var reasoningItems = [];
        for (var s = 0; s < providerState.items.length; s += 1) {
          reasoningItems.push(validateResponsesReasoningItem(providerState.items[s]));
        }
        contract.assertBoundReasoning(payload.reasoning, derivedResponsesReasoningText(reasoningItems), PROTOCOL_ID);
        for (var r = 0; r < reasoningItems.length; r += 1) {
          input.push(reasoningItems[r]);
        }
      }
      if (payload.text.length > 0) {
        input.push(assistantTextMessage(payload.text));
      }
      for (var t = 0; t < payload.toolCalls.length; t += 1) {
        input.push({
          type: "function_call",
          call_id: payload.toolCalls[t].id,
          name: payload.toolCalls[t].name,
          arguments: payload.toolCalls[t].arguments
        });
      }
    } else if (role === "tool") {
      var results = tools.extractToolResults(message, PROTOCOL_ID);
      for (var r = 0; r < results.length; r += 1) {
        input.push({
          type: "function_call_output",
          call_id: results[r].id,
          output: results[r].content
        });
      }
      var imageParts = tools.toolImagesUserParts(results);
      if (imageParts.length > 0) {
        input.push(userMessage(imageParts));
      }
    } else {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses message role is unrepresentable");
    }
  }
  return {
    instructions: systems.length > 0 ? systems.join("\n\n") : null,
    input: input
  };
}

function toResponsesTools(rawTools) {
  var fns = tools.convertFunctionTools(rawTools, PROTOCOL_ID);
  var out = [];
  for (var i = 0; i < fns.length; i += 1) {
    var item = {
      type: "function",
      name: fns[i].name,
      parameters: fns[i].parameters
    };
    if (typeof fns[i].description === "string") {
      item.description = fns[i].description;
    }
    out.push(item);
  }
  return out;
}

function buildRequest(request, options) {
  contract.assertNormalizedRequest(request, PROTOCOL_ID);
  contract.assertKnownParameters(request, ["reasoningEffort"], PROTOCOL_ID);
  var mapped = toResponsesInput(request.messages);
  var body = {
    model: request.model,
    input: mapped.input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"]
  };
  if (mapped.instructions != null) {
    body.instructions = mapped.instructions;
  }
  var responsesTools = toResponsesTools(request.tools);
  if (responsesTools.length > 0) {
    body.tools = responsesTools;
  }
  var maxTokens = contract.maxTokensFrom(request);
  if (maxTokens != null) {
    body.max_output_tokens = maxTokens;
  }
  // Ask for reasoning summaries so thinking streams as it happens. The Grok
  // Bot host treats a stream with no delta for 150s as stalled and retries
  // (billing again); a reasoning model that only emits text at the end would
  // trip that. Only reasoning-capable model families accept `reasoning`.
  var effort = contract.reasoningEffortFrom(request);
  if (effort != null) {
    body.reasoning = { effort: effort, summary: "auto" };
  } else if (REASONING_MODEL.test(request.model)) {
    body.reasoning = { summary: "auto" };
  }
  return {
    method: "POST",
    path: contract.resolveEndpointPath("/responses", options, PROTOCOL_ID),
    headers: contract.jsonHeaders(null, PROTOCOL_ID),
    body: body
  };
}

function createItemSlot(index) {
  return {
    index: index,
    kind: "",
    id: "",
    callId: "",
    name: "",
    arguments: "",
    pendingDeltas: "",
    started: false,
    finalized: false,
    reasoningEmitted: false
  };
}

function createResponsesState(requestId) {
  var items = new Map();
  var finishReason = "stop";
  var usage = null;
  var responseId = "";
  var modelId = "";
  var completed = false;
  var failed = false;
  var finishEmitted = false;

  function slot(index) {
    var key = Number(index);
    if (!Number.isInteger(key) || key < 0) {
      key = 0;
    }
    var current = items.get(key);
    if (current == null) {
      current = createItemSlot(key);
      items.set(key, current);
    }
    return current;
  }

  function maybeStart(current, events) {
    if (current.kind !== "function_call") {
      return;
    }
    if (current.started || current.callId.length === 0 || current.name.length === 0) {
      return;
    }
    current.started = true;
    events.push({
      type: "tool-call-streaming-start",
      toolCallId: current.callId,
      toolName: current.name
    });
    if (current.pendingDeltas.length > 0) {
      events.push({
        type: "tool-call-delta",
        toolCallId: current.callId,
        toolName: current.name,
        argsTextDelta: current.pendingDeltas
      });
      current.pendingDeltas = "";
    }
  }

  function finalizeCall(current, events, argumentsOverride) {
    if (current.kind !== "function_call" || current.finalized) {
      return;
    }
    if (typeof argumentsOverride === "string") {
      current.arguments = argumentsOverride;
    }
    if (current.callId.length === 0 || current.name.length === 0) {
      throw contract.protocolError("OpenAI Responses function call is missing call_id or name", {
        protocol: PROTOCOL_ID,
        code: "incomplete-tool-call"
      });
    }
    maybeStart(current, events);
    events.push({
      type: "tool-call",
      toolCallId: current.callId,
      toolName: current.name,
      args: tools.parseToolArgumentsObject(current.arguments, PROTOCOL_ID, current.name)
    });
    current.finalized = true;
  }

  function observeResponse(response) {
    if (response == null || typeof response !== "object") {
      return;
    }
    if (typeof response.id === "string" && response.id.length > 0) {
      responseId = response.id;
    }
    if (typeof response.model === "string" && response.model.length > 0) {
      modelId = response.model;
    }
    var nextUsage = contract.normalizeUsage(response.usage);
    if (nextUsage != null) {
      usage = nextUsage;
    }
    if (response.status === "failed") {
      failed = true;
    }
    if (Array.isArray(response.output)) {
      for (var i = 0; i < response.output.length; i += 1) {
        var item = response.output[i];
        if (item != null && item.type === "function_call") {
          finishReason = "tool-calls";
        }
      }
    }
  }

  function takeFinish(force) {
    if (finishEmitted) {
      return [];
    }
    if (!force && !completed) {
      return [];
    }
    if (usage == null) {
      throw contract.protocolError("OpenAI Responses stream finished without usage", {
        protocol: PROTOCOL_ID,
        code: "missing-usage"
      });
    }
    var events = [];
    var ordered = Array.from(items.values()).sort(function (a, b) {
      return a.index - b.index;
    });
    for (var i = 0; i < ordered.length; i += 1) {
      if (ordered[i].kind === "function_call" && !ordered[i].finalized) {
        finalizeCall(ordered[i], events);
      }
    }
    events.push(contract.finishEvent({
      finishReason: finishReason,
      usage: usage,
      requestId: requestId || responseId,
      responseId: responseId,
      modelId: modelId
    }));
    finishEmitted = true;
    return events;
  }

  return {
    slot: slot,
    maybeStart: maybeStart,
    finalizeCall: finalizeCall,
    observeResponse: observeResponse,
    setFinishReason: function (reason) {
      var mapped = contract.mapFinishReason(reason);
      if (mapped != null) {
        finishReason = mapped;
      }
    },
    markCompleted: function () {
      completed = true;
    },
    markFailed: function () {
      failed = true;
    },
    isCompleted: function () {
      return completed;
    },
    isFailed: function () {
      return failed;
    },
    takeFinish: takeFinish
  };
}

// The JSON `type` is authoritative; relays are inconsistent about the SSE
// `event:` line, so a mismatch is not an error.
function eventType(raw, payload) {
  if (payload != null && typeof payload.type === "string" && payload.type.length > 0) {
    return payload.type;
  }
  return raw.event;
}

function applyFunctionItem(current, item, events, state) {
  current.kind = "function_call";
  if (typeof item.id === "string" && item.id.length > 0) {
    current.id = item.id;
  }
  if (typeof item.call_id === "string" && item.call_id.length > 0) {
    current.callId = item.call_id;
  }
  if (typeof item.name === "string" && item.name.length > 0) {
    current.name = item.name;
  }
  if (typeof item.arguments === "string" && item.arguments.length > 0 && current.arguments.length === 0) {
    current.arguments = item.arguments;
  }
  state.setFinishReason("tool-calls");
  state.maybeStart(current, events);
}

function handleOutputItem(state, item, outputIndex, events, finalize) {
  if (item == null || typeof item !== "object") {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses output item is unrepresentable");
  }
  if (HOSTED_ITEM_TYPES[item.type] === true) {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses hosted tool is unrepresentable");
  }
  var current = state.slot(outputIndex);
  if (item.type === "function_call") {
    applyFunctionItem(current, item, events, state);
    if (finalize) {
      state.finalizeCall(current, events, item.arguments);
    }
    return;
  }
  if (item.type === "message" || item.type === "output_text") {
    current.kind = current.kind || "message";
    return;
  }
  if (item.type === "reasoning") {
    current.kind = "reasoning";
    if (!finalize) {
      return;
    }
    var summaryText = reasoningSummaryText(item);
    if (summaryText.length > 0 && !current.reasoningEmitted) {
      events.push({ type: "reasoning", textDelta: summaryText });
      current.reasoningEmitted = true;
    }
    // Relays often strip encrypted_content. Without it the reasoning simply
    // is not replayed on the next turn; that is not a failure.
    if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
      events.push(contract.providerStateEvent(PROTOCOL_ID, [validateResponsesReasoningItem(item)]));
    }
    return;
  }
  throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses output item is unrepresentable");
}

function reasoningSummaryText(item) {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (!Array.isArray(item.summary)) {
    return "";
  }
  var texts = [];
  for (var i = 0; i < item.summary.length; i += 1) {
    var part = item.summary[i];
    if (part != null && typeof part === "object" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join("");
}

function errorMessageFrom(payload, fallback) {
  if (payload.response != null) {
    var fromResponse = contract.extractUpstreamErrorMessage(
      JSON.stringify({ error: payload.response.error || payload.response }),
      fallback
    );
    if (fromResponse !== fallback) {
      return fromResponse;
    }
  }
  return contract.extractUpstreamErrorMessage(JSON.stringify(payload), fallback);
}

function handlePayload(raw, payload, state) {
  var type = eventType(raw, payload);
  var events = [];
  if (type === "ping" || type === "response.created" || type === "response.in_progress" || type === "response.queued") {
    if (payload.response != null) {
      state.observeResponse(payload.response);
    }
    return events;
  }
  if (type === "response.failed" || type === "response.cancelled" || type === "response.canceled") {
    state.markFailed();
    if (payload.response != null) {
      state.observeResponse(payload.response);
    }
    throw contract.protocolError(
      errorMessageFrom(payload, "OpenAI Responses stream " + (type === "response.failed" ? "failed" : "cancelled")),
      { protocol: PROTOCOL_ID, code: "stream-error" }
    );
  }
  if (type === "error" || type === "response.error") {
    throw contract.protocolError(
      errorMessageFrom(payload, "OpenAI Responses stream error"),
      { protocol: PROTOCOL_ID, code: "stream-error" }
    );
  }
  if (type === "response.output_item.added") {
    handleOutputItem(state, payload.item, payload.output_index, events, false);
    return events;
  }
  if (type === "response.output_item.done") {
    handleOutputItem(state, payload.item, payload.output_index, events, true);
    return events;
  }
  if (type === "response.content_part.added" || type === "response.content_part.done") {
    return events;
  }
  if (type === "response.output_text.delta") {
    if (typeof payload.delta !== "string") {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses text delta is unrepresentable");
    }
    if (payload.delta.length > 0) {
      events.push({ type: "text-delta", textDelta: payload.delta });
    }
    return events;
  }
  if (type === "response.output_text.done") {
    return events;
  }
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    if (typeof payload.delta !== "string") {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses reasoning delta is unrepresentable");
    }
    if (payload.delta.length > 0) {
      var reasoningSlot = state.slot(payload.output_index == null ? 0 : payload.output_index);
      reasoningSlot.kind = "reasoning";
      reasoningSlot.reasoningEmitted = true;
      events.push({ type: "reasoning", textDelta: payload.delta });
    }
    return events;
  }
  if (type === "response.function_call_arguments.delta") {
    var deltaSlot = state.slot(payload.output_index);
    deltaSlot.kind = "function_call";
    if (typeof payload.delta !== "string") {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses function call arguments are unrepresentable");
    }
    deltaSlot.arguments += payload.delta;
    if (payload.delta.length > 0) {
      if (deltaSlot.started) {
        events.push({
          type: "tool-call-delta",
          toolCallId: deltaSlot.callId,
          toolName: deltaSlot.name,
          argsTextDelta: payload.delta
        });
      } else {
        deltaSlot.pendingDeltas += payload.delta;
        state.maybeStart(deltaSlot, events);
      }
    }
    state.setFinishReason("tool-calls");
    return events;
  }
  if (type === "response.function_call_arguments.done") {
    var doneSlot = state.slot(payload.output_index);
    doneSlot.kind = "function_call";
    if (typeof payload.call_id === "string" && payload.call_id.length > 0) {
      doneSlot.callId = payload.call_id;
    }
    if (typeof payload.name === "string" && payload.name.length > 0) {
      doneSlot.name = payload.name;
    }
    state.finalizeCall(doneSlot, events, payload.arguments);
    return events;
  }
  if (type === "response.refusal.delta" || type === "response.refusal.done") {
    throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses refusal is unrepresentable");
  }
  if (type === "response.completed" || type === "response.done") {
    if (payload.response != null) {
      state.observeResponse(payload.response);
    }
    if (payload.usage != null) {
      state.observeResponse({ usage: payload.usage });
    }
    state.markCompleted();
    var finish = state.takeFinish(true);
    for (var i = 0; i < finish.length; i += 1) {
      events.push(finish[i]);
    }
    return events;
  }
  if (type === "response.incomplete") {
    throw contract.protocolError("OpenAI Responses stream is incomplete", {
      protocol: PROTOCOL_ID,
      code: "missing-terminator"
    });
  }
  // Informational events (reasoning_summary_part.*, *.done markers,
  // annotations, hosted-tool progress, future additions) carry nothing the
  // host needs; the content they describe arrives through the deltas and
  // output items handled above.
  if (typeof type === "string" && type.indexOf("response.") === 0) {
    return events;
  }
  throw tools.unsupported(PROTOCOL_ID, "OpenAI Responses event is unrepresentable");
}

function createStreamDecoder(options) {
  options = options || {};
  var decoder = sse.createSseDecoder({ protocol: PROTOCOL_ID });
  var requestId = typeof options.requestId === "string" ? options.requestId : "";
  var state = createResponsesState(requestId);
  var closed = false;

  function ingest(rawEvents) {
    var events = [];
    for (var i = 0; i < rawEvents.length; i += 1) {
      if (state.isCompleted() || state.isFailed()) {
        break;
      }
      var raw = rawEvents[i];
      var payload = contract.decodeJsonData(raw.data, PROTOCOL_ID);
      if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
        throw contract.protocolError("SSE data is invalid JSON", {
          protocol: PROTOCOL_ID,
          code: "invalid-json"
        });
      }
      if (payload.error != null && raw.event === "message" && payload.type == null) {
        throw contract.protocolError(
          contract.extractUpstreamErrorMessage(JSON.stringify(payload), "OpenAI Responses stream error"),
          { protocol: PROTOCOL_ID, code: "stream-error" }
        );
      }
      var mapped = handlePayload(raw, payload, state);
      for (var j = 0; j < mapped.length; j += 1) {
        events.push(mapped[j]);
      }
    }
    return events;
  }

  return {
    push: function (chunk) {
      return ingest(decoder.push(chunk));
    },
    close: function () {
      if (closed) {
        throw contract.protocolError("SSE decoder is already finished", {
          protocol: PROTOCOL_ID,
          code: "invalid-request"
        });
      }
      closed = true;
      var events = ingest(decoder.close());
      if (!state.isCompleted()) {
        throw contract.protocolError("OpenAI Responses stream is missing response.completed", {
          protocol: PROTOCOL_ID,
          code: "missing-terminator"
        });
      }
      return events;
    }
  };
}

function interpretHttpFailure(status, body) {
  var code = Number(status);
  if (!Number.isFinite(code) || (code >= 200 && code <= 299)) {
    throw contract.protocolError("Upstream HTTP status is not a failure", {
      protocol: PROTOCOL_ID,
      code: "invalid-request",
      status: code
    });
  }
  var fallback = "Upstream request failed with status " + code;
  throw contract.protocolError(
    contract.extractUpstreamErrorMessage(contract.bodyToText(body), fallback),
    { protocol: PROTOCOL_ID, code: "http-error", status: code }
  );
}

module.exports = {
  id: PROTOCOL_ID,
  defaultEndpointPath: "/responses",
  defaultAuthType: "bearer",
  buildRequest: buildRequest,
  createStreamDecoder: createStreamDecoder,
  interpretHttpFailure: interpretHttpFailure
};
});
__grokSwitchRegister("./anthropic-messages.cjs", function (module, exports, require) {
"use strict";

var contract = require("./contract.cjs");
var sse = require("./sse.cjs");
var tools = require("./tools.cjs");

var PROTOCOL_ID = "anthropic-messages";
var DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

function imagePart(url) {
  if (url.indexOf("data:") === 0) {
    var match = /^data:([^;,]+);base64,(.+)$/.exec(url);
    if (match == null) {
      throw tools.unsupported(PROTOCOL_ID, "Anthropic image content is unrepresentable");
    }
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] }
    };
  }
  return {
    type: "image",
    source: { type: "url", url: url }
  };
}

function userContentFromParts(parts) {
  var content = [];
  for (var i = 0; i < parts.length; i += 1) {
    if (parts[i].kind === "text") {
      content.push({ type: "text", text: parts[i].text });
    } else {
      content.push(imagePart(parts[i].url));
    }
  }
  if (content.length === 1 && content[0].type === "text") {
    return content[0].text;
  }
  return content;
}

function asContentArray(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.slice();
}

function appendUser(messages, content) {
  var parts = asContentArray(content);
  if (messages.length > 0 && messages[messages.length - 1].role === "user") {
    var last = messages[messages.length - 1];
    last.content = asContentArray(last.content);
    for (var i = 0; i < parts.length; i += 1) {
      last.content.push(parts[i]);
    }
    return;
  }
  if (parts.length === 1 && parts[0].type === "text") {
    messages.push({ role: "user", content: parts[0].text });
    return;
  }
  messages.push({ role: "user", content: parts });
}

function validateAnthropicThinkingItem(item) {
  if (item == null || typeof item !== "object" || Array.isArray(item) || item.type !== "thinking") {
    throw tools.unsupported(PROTOCOL_ID, "Anthropic thinking item is unrepresentable");
  }
  if (typeof item.thinking !== "string") {
    throw tools.unsupported(PROTOCOL_ID, "Anthropic thinking item is unrepresentable");
  }
  if (typeof item.signature !== "string" || item.signature.length === 0) {
    throw tools.unsupported(PROTOCOL_ID, "Anthropic thinking continuation requires a signature");
  }
  return {
    type: "thinking",
    thinking: item.thinking,
    signature: item.signature
  };
}

function derivedAnthropicThinkingText(items) {
  var text = "";
  for (var i = 0; i < items.length; i += 1) {
    text += items[i].thinking;
  }
  return text;
}

function assistantContent(message) {
  var payload = tools.extractAssistantPayload(message, PROTOCOL_ID);
  if (payload.isEmpty) {
    return null;
  }
  var providerState = contract.continuationState(message, payload, PROTOCOL_ID);
  var content = [];
  if (providerState != null) {
    var thinkingItems = [];
    for (var i = 0; i < providerState.items.length; i += 1) {
      thinkingItems.push(validateAnthropicThinkingItem(providerState.items[i]));
    }
    contract.assertBoundReasoning(payload.reasoning, derivedAnthropicThinkingText(thinkingItems), PROTOCOL_ID);
    for (var t = 0; t < thinkingItems.length; t += 1) {
      content.push(thinkingItems[t]);
    }
  }
  if (payload.text.length > 0) {
    content.push({ type: "text", text: payload.text });
  }
  for (var t = 0; t < payload.toolCalls.length; t += 1) {
    content.push({
      type: "tool_use",
      id: payload.toolCalls[t].id,
      name: payload.toolCalls[t].name,
      input: tools.parseToolArgumentsObject(payload.toolCalls[t].arguments, PROTOCOL_ID, payload.toolCalls[t].name)
    });
  }
  return content;
}

// Anthropic tool_result content accepts text and image blocks directly.
function toolResultBlocks(result) {
  if (result.images.length === 0) {
    return result.content;
  }
  var blocks = [];
  if (result.content.length > 0) {
    blocks.push({ type: "text", text: result.content });
  }
  for (var i = 0; i < result.images.length; i += 1) {
    blocks.push(imagePart(result.images[i]));
  }
  return blocks;
}

function toAnthropicMessages(messages) {
  if (messages == null) {
    return { system: null, messages: [] };
  }
  if (!Array.isArray(messages)) {
    throw tools.unsupported(PROTOCOL_ID, "Anthropic messages must be an array");
  }
  var systems = [];
  var out = [];
  for (var i = 0; i < messages.length; i += 1) {
    var message = messages[i];
    if (message == null || typeof message !== "object" || Array.isArray(message)) {
      throw tools.unsupported(PROTOCOL_ID, "Anthropic message is unrepresentable");
    }
    var role = message.role;
    if (role === "system") {
      systems.push(tools.extractSystemText(message, PROTOCOL_ID));
    } else if (role === "user") {
      appendUser(out, userContentFromParts(tools.extractUserParts(message, PROTOCOL_ID)));
    } else if (role === "assistant") {
      var content = assistantContent(message);
      if (content != null) {
        out.push({ role: "assistant", content: content });
      }
    } else if (role === "tool") {
      var results = tools.extractToolResults(message, PROTOCOL_ID);
      var toolParts = [];
      for (var r = 0; r < results.length; r += 1) {
        toolParts.push({
          type: "tool_result",
          tool_use_id: results[r].id,
          content: toolResultBlocks(results[r])
        });
      }
      appendUser(out, toolParts);
    } else {
      throw tools.unsupported(PROTOCOL_ID, "Anthropic message role is unrepresentable");
    }
  }
  return {
    system: systems.length > 0 ? systems.join("\n\n") : null,
    messages: out
  };
}

function toAnthropicTools(rawTools) {
  var fns = tools.convertFunctionTools(rawTools, PROTOCOL_ID);
  var out = [];
  for (var i = 0; i < fns.length; i += 1) {
    var item = {
      name: fns[i].name,
      input_schema: fns[i].parameters
    };
    if (typeof fns[i].description === "string") {
      item.description = fns[i].description;
    }
    out.push(item);
  }
  return out;
}

function anthropicVersionFrom(request) {
  if (request.parameters != null && request.parameters.anthropicVersion != null) {
    var version = request.parameters.anthropicVersion;
    if (typeof version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(version)) {
      throw tools.unsupported(PROTOCOL_ID, "anthropic-version is unrepresentable");
    }
    return version;
  }
  return DEFAULT_ANTHROPIC_VERSION;
}

function buildRequest(request, options) {
  contract.assertNormalizedRequest(request, PROTOCOL_ID);
  contract.assertKnownParameters(request, ["anthropicVersion"], PROTOCOL_ID);
  if (contract.reasoningEffortFrom(request) != null) {
    throw tools.unsupported(PROTOCOL_ID, "reasoningEffort is unrepresentable for Anthropic Messages");
  }
  var maxTokens = contract.maxTokensFrom(request);
  if (maxTokens == null) {
    throw contract.protocolError("Anthropic Messages request requires maxTokens", {
      protocol: PROTOCOL_ID,
      code: "invalid-request"
    });
  }
  var mapped = toAnthropicMessages(request.messages);
  var body = {
    model: request.model,
    messages: mapped.messages,
    max_tokens: maxTokens,
    stream: true
  };
  if (mapped.system != null) {
    body.system = mapped.system;
  }
  var anthropicTools = toAnthropicTools(request.tools);
  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;
  }
  return {
    method: "POST",
    path: contract.resolveEndpointPath("/messages", options, PROTOCOL_ID),
    headers: contract.jsonHeaders({ "anthropic-version": anthropicVersionFrom(request) }, PROTOCOL_ID),
    body: body
  };
}

function createBlock(index) {
  return {
    index: index,
    kind: "",
    id: "",
    name: "",
    arguments: "",
    pendingDeltas: "",
    thinking: "",
    signature: "",
    started: false,
    finalized: false
  };
}

function createAnthropicState(requestId) {
  var blocks = new Map();
  var finishReason = "stop";
  var usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  var sawInputUsage = false;
  var sawOutputUsage = false;
  var responseId = "";
  var modelId = "";
  var stopped = false;
  var finishEmitted = false;

  function slot(index) {
    var key = Number(index);
    if (!Number.isInteger(key) || key < 0) {
      key = 0;
    }
    var current = blocks.get(key);
    if (current == null) {
      current = createBlock(key);
      blocks.set(key, current);
    }
    return current;
  }

  function maybeStart(current, events) {
    if (current.kind !== "tool" || current.started || current.id.length === 0 || current.name.length === 0) {
      return;
    }
    current.started = true;
    events.push({
      type: "tool-call-streaming-start",
      toolCallId: current.id,
      toolName: current.name
    });
    if (current.pendingDeltas.length > 0) {
      events.push({
        type: "tool-call-delta",
        toolCallId: current.id,
        toolName: current.name,
        argsTextDelta: current.pendingDeltas
      });
      current.pendingDeltas = "";
    }
  }

  function finalizeTool(current, events) {
    if (current.kind !== "tool" || current.finalized) {
      return;
    }
    if (current.id.length === 0 || current.name.length === 0) {
      throw contract.protocolError("Anthropic tool_use is missing id or name", {
        protocol: PROTOCOL_ID,
        code: "incomplete-tool-call"
      });
    }
    maybeStart(current, events);
    events.push({
      type: "tool-call",
      toolCallId: current.id,
      toolName: current.name,
      args: tools.parseToolArgumentsObject(current.arguments, PROTOCOL_ID, current.name)
    });
    current.finalized = true;
  }

  function observeUsage(rawUsage, isDelta) {
    var next = contract.normalizeUsage(rawUsage);
    if (next == null) {
      return;
    }
    if (!isDelta) {
      usage.promptTokens = next.promptTokens;
      usage.cacheReadTokens = next.cacheReadTokens || usage.cacheReadTokens;
      usage.cacheWriteTokens = next.cacheWriteTokens || usage.cacheWriteTokens;
      if (rawUsage.input_tokens != null || rawUsage.prompt_tokens != null) {
        sawInputUsage = true;
      }
      if (rawUsage.output_tokens != null || rawUsage.completion_tokens != null) {
        usage.completionTokens = next.completionTokens;
        sawOutputUsage = true;
      }
    } else {
      if (rawUsage.output_tokens != null || rawUsage.completion_tokens != null) {
        usage.completionTokens = next.completionTokens;
        sawOutputUsage = true;
      }
      if (next.cacheReadTokens) {
        usage.cacheReadTokens = next.cacheReadTokens;
      }
      if (next.cacheWriteTokens) {
        usage.cacheWriteTokens = next.cacheWriteTokens;
      }
    }
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }

  return {
    slot: slot,
    maybeStart: maybeStart,
    finalizeTool: finalizeTool,
    observeUsage: observeUsage,
    setMeta: function (message) {
      if (message == null || typeof message !== "object") {
        return;
      }
      if (typeof message.id === "string" && message.id.length > 0) {
        responseId = message.id;
      }
      if (typeof message.model === "string" && message.model.length > 0) {
        modelId = message.model;
      }
      if (message.usage != null) {
        observeUsage(message.usage, false);
      }
    },
    setFinishReason: function (reason) {
      var mapped = contract.mapFinishReason(reason);
      if (mapped != null) {
        finishReason = mapped;
      }
    },
    markStopped: function () {
      stopped = true;
    },
    isStopped: function () {
      return stopped;
    },
    takeFinish: function () {
      if (finishEmitted) {
        return [];
      }
      if (!sawInputUsage || !sawOutputUsage) {
        throw contract.protocolError("Anthropic Messages stream finished without usage", {
          protocol: PROTOCOL_ID,
          code: "missing-usage"
        });
      }
      var events = [];
      var ordered = Array.from(blocks.values()).sort(function (a, b) {
        return a.index - b.index;
      });
      for (var i = 0; i < ordered.length; i += 1) {
        if (ordered[i].kind === "tool" && !ordered[i].finalized) {
          finalizeTool(ordered[i], events);
        }
      }
      events.push(contract.finishEvent({
        finishReason: finishReason,
        usage: usage,
        requestId: requestId || responseId,
        responseId: responseId,
        modelId: modelId
      }));
      finishEmitted = true;
      return events;
    }
  };
}

function eventType(raw, payload) {
  if (payload != null && typeof payload.type === "string" && payload.type.length > 0) {
    if (raw.event !== "message" && raw.event !== payload.type) {
      throw contract.protocolError("Anthropic SSE event type mismatch", {
        protocol: PROTOCOL_ID,
        code: "invalid-json"
      });
    }
    return payload.type;
  }
  return raw.event;
}

function startBlock(state, payload, events) {
  var current = state.slot(payload.index);
  var block = payload.content_block;
  if (block == null || typeof block !== "object") {
    throw tools.unsupported(PROTOCOL_ID, "Anthropic content block is unrepresentable");
  }
  if (block.type === "text") {
    current.kind = "text";
    if (typeof block.text === "string" && block.text.length > 0) {
      events.push({ type: "text-delta", textDelta: block.text });
    }
    return;
  }
  if (block.type === "thinking") {
    current.kind = "reasoning";
    if (typeof block.thinking === "string" && block.thinking.length > 0) {
      current.thinking += block.thinking;
      events.push({ type: "reasoning", textDelta: block.thinking });
    }
    if (typeof block.signature === "string" && block.signature.length > 0) {
      current.signature += block.signature;
    }
    return;
  }
  if (block.type === "tool_use") {
    current.kind = "tool";
    if (typeof block.id === "string") {
      current.id = block.id;
    }
    if (typeof block.name === "string") {
      current.name = block.name;
    }
    if (block.input != null && typeof block.input === "object" && !Array.isArray(block.input) && Object.keys(block.input).length > 0) {
      current.arguments = tools.jsonArgumentString(block.input, PROTOCOL_ID);
    }
    state.setFinishReason("tool_use");
    state.maybeStart(current, events);
    return;
  }
  if (block.type === "redacted_thinking") {
    // Safety-redacted reasoning carries nothing displayable or replayable.
    current.kind = "redacted";
    return;
  }
  throw tools.unsupported(PROTOCOL_ID, "Anthropic content block is unrepresentable");
}

function deltaBlock(state, payload, events) {
  var current = state.slot(payload.index);
  var delta = payload.delta;
  if (delta == null || typeof delta !== "object") {
    throw tools.unsupported(PROTOCOL_ID, "Anthropic content delta is unrepresentable");
  }
  if (delta.type === "text_delta") {
    if (typeof delta.text !== "string") {
      throw tools.unsupported(PROTOCOL_ID, "Anthropic text delta is unrepresentable");
    }
    if (delta.text.length > 0) {
      events.push({ type: "text-delta", textDelta: delta.text });
    }
    return;
  }
  if (delta.type === "thinking_delta") {
    if (typeof delta.thinking !== "string") {
      throw tools.unsupported(PROTOCOL_ID, "Anthropic thinking delta is unrepresentable");
    }
    current.kind = "reasoning";
    current.thinking += delta.thinking;
    if (delta.thinking.length > 0) {
      events.push({ type: "reasoning", textDelta: delta.thinking });
    }
    return;
  }
  if (delta.type === "signature_delta") {
    if (typeof delta.signature !== "string") {
      throw tools.unsupported(PROTOCOL_ID, "Anthropic thinking signature is unrepresentable");
    }
    current.kind = "reasoning";
    current.signature += delta.signature;
    return;
  }
  if (delta.type === "input_json_delta") {
    if (typeof delta.partial_json !== "string") {
      throw tools.unsupported(PROTOCOL_ID, "Anthropic tool_use delta is unrepresentable");
    }
    current.kind = "tool";
    current.arguments += delta.partial_json;
    if (delta.partial_json.length > 0) {
      if (current.started) {
        events.push({
          type: "tool-call-delta",
          toolCallId: current.id,
          toolName: current.name,
          argsTextDelta: delta.partial_json
        });
      } else {
        current.pendingDeltas += delta.partial_json;
        state.maybeStart(current, events);
      }
    }
    state.setFinishReason("tool_use");
    return;
  }
  throw tools.unsupported(PROTOCOL_ID, "Anthropic content delta is unrepresentable");
}

function handlePayload(raw, payload, state) {
  var type = eventType(raw, payload);
  var events = [];
  if (type === "ping") {
    return events;
  }
  if (type === "error") {
    throw contract.protocolError(
      contract.extractUpstreamErrorMessage(JSON.stringify(payload), "Anthropic Messages stream error"),
      { protocol: PROTOCOL_ID, code: "stream-error" }
    );
  }
  if (type === "message_start") {
    state.setMeta(payload.message);
    return events;
  }
  if (type === "content_block_start") {
    startBlock(state, payload, events);
    return events;
  }
  if (type === "content_block_delta") {
    deltaBlock(state, payload, events);
    return events;
  }
  if (type === "content_block_stop") {
    var current = state.slot(payload.index);
    if (current.kind === "tool") {
      state.finalizeTool(current, events);
    } else if (current.kind === "reasoning") {
      // Relays may strip the signature; then the thinking is shown but not
      // replayed on the next turn (Anthropic rejects unsigned replays).
      if (typeof current.signature === "string" && current.signature.length > 0) {
        events.push(contract.providerStateEvent(PROTOCOL_ID, [{
          type: "thinking",
          thinking: current.thinking,
          signature: current.signature
        }]));
      }
    }
    return events;
  }
  if (type === "message_delta") {
    if (payload.delta != null && payload.delta.stop_reason != null) {
      state.setFinishReason(payload.delta.stop_reason);
    }
    if (payload.usage != null) {
      state.observeUsage(payload.usage, true);
    }
    return events;
  }
  if (type === "message_stop") {
    state.markStopped();
    var finish = state.takeFinish();
    for (var i = 0; i < finish.length; i += 1) {
      events.push(finish[i]);
    }
    return events;
  }
  // Unknown informational events are ignored; content only arrives through
  // the block events handled above.
  return events;
}

function createStreamDecoder(options) {
  options = options || {};
  var decoder = sse.createSseDecoder({ protocol: PROTOCOL_ID });
  var requestId = typeof options.requestId === "string" ? options.requestId : "";
  var state = createAnthropicState(requestId);
  var closed = false;

  function ingest(rawEvents) {
    var events = [];
    for (var i = 0; i < rawEvents.length; i += 1) {
      if (state.isStopped()) {
        break;
      }
      var raw = rawEvents[i];
      var payload = contract.decodeJsonData(raw.data, PROTOCOL_ID);
      if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
        throw contract.protocolError("SSE data is invalid JSON", {
          protocol: PROTOCOL_ID,
          code: "invalid-json"
        });
      }
      var mapped = handlePayload(raw, payload, state);
      for (var j = 0; j < mapped.length; j += 1) {
        events.push(mapped[j]);
      }
    }
    return events;
  }

  return {
    push: function (chunk) {
      return ingest(decoder.push(chunk));
    },
    close: function () {
      if (closed) {
        throw contract.protocolError("SSE decoder is already finished", {
          protocol: PROTOCOL_ID,
          code: "invalid-request"
        });
      }
      closed = true;
      var events = ingest(decoder.close());
      if (!state.isStopped()) {
        throw contract.protocolError("Anthropic Messages stream is missing message_stop", {
          protocol: PROTOCOL_ID,
          code: "missing-terminator"
        });
      }
      return events;
    }
  };
}

function interpretHttpFailure(status, body) {
  var code = Number(status);
  if (!Number.isFinite(code) || (code >= 200 && code <= 299)) {
    throw contract.protocolError("Upstream HTTP status is not a failure", {
      protocol: PROTOCOL_ID,
      code: "invalid-request",
      status: code
    });
  }
  var fallback = "Upstream request failed with status " + code;
  throw contract.protocolError(
    contract.extractUpstreamErrorMessage(contract.bodyToText(body), fallback),
    { protocol: PROTOCOL_ID, code: "http-error", status: code }
  );
}

module.exports = {
  id: PROTOCOL_ID,
  defaultEndpointPath: "/messages",
  defaultAuthType: "x-api-key",
  buildRequest: buildRequest,
  createStreamDecoder: createStreamDecoder,
  interpretHttpFailure: interpretHttpFailure
};
});
__grokSwitchRegister("./index.cjs", function (module, exports, require) {
"use strict";

var contract = require("./contract.cjs");
var openaiChat = require("./openai-chat.cjs");
var openaiResponses = require("./openai-responses.cjs");
var anthropicMessages = require("./anthropic-messages.cjs");

var REGISTRY = Object.freeze({
  "openai-chat": openaiChat,
  "openai-responses": openaiResponses,
  "anthropic-messages": anthropicMessages
});

function getAdapter(protocolId) {
  if (typeof protocolId !== "string" || !Object.prototype.hasOwnProperty.call(REGISTRY, protocolId)) {
    throw contract.protocolError("Unknown provider protocol", { code: "unknown-protocol" });
  }
  return REGISTRY[protocolId];
}

function createAdapter(protocolId) {
  return getAdapter(protocolId);
}

module.exports = {
  PROTOCOL_IDS: contract.PROTOCOL_IDS,
  DEFAULT_ENDPOINT_PATHS: contract.DEFAULT_ENDPOINT_PATHS,
  DEFAULT_AUTH_TYPES: contract.DEFAULT_AUTH_TYPES,
  protocolError: contract.protocolError,
  getAdapter: getAdapter,
  createAdapter: createAdapter
};
});
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
        messages: grokSwitchHydrateMessages(messages),
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
function createHostInference(options) {
  return grokSwitchWrapHostInference(__grokSwitchOriginalCreateHostInference(options));
}
// GROK_SWITCH_PAYLOAD_END
// grok-switch web panel. Listens on 127.0.0.1 inside the Grok Bot cloud
// machine; the user reaches it through Grok Bot's cloud desktop browser.
// Appended by build.mjs before cli.cjs; cli* helpers are in scope.

var uiHttp = require("node:http");
var uiCrypto = require("node:crypto");
var uiChild = require("node:child_process");

var UI_DEFAULT_PORT = 18990;
var UI_STATE_PATH = GROK_SWITCH_DIR + "/ui.json";
var UI_TOKEN_PATH = GROK_SWITCH_DIR + "/panel-token";
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

// The token is created once per installation and kept in the config dir, so
// the panel URL a user has open (or bookmarked in the cloud browser) survives
// panel restarts and upgrades. `ui --new-token` rotates it.
function uiToken(rotate) {
  var path = UI_TOKEN_PATH;
  if (!rotate) {
    try {
      var existing = cliFs.readFileSync(path, "utf8").trim();
      if (/^[a-f0-9]{32}$/.test(existing)) return existing;
    } catch (_error) {}
  }
  var token = uiCrypto.randomBytes(16).toString("hex");
  cliFs.mkdirSync(CLI_CONFIG_DIR, { recursive: true, mode: 448 });
  cliFs.writeFileSync(path, token + "\n", { mode: 384 });
  return token;
}

function uiServe(port, rotateToken) {
  var token = uiToken(rotateToken === true);
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
    var child = uiChild.spawn(process.execPath, [__filename, "ui", "--port", String(port)].concat(args.flags["new-token"] ? ["--new-token"] : []), { detached: true, stdio: ["ignore", log, log], env: process.env });
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
  var served = await uiServe(port, args.flags["new-token"] === true);
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

var UI_HTML = "<!doctype html>\n<html lang=\"zh-CN\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <title>Grok Bot Switch</title>\n    <script type=\"module\" crossorigin>var gp=n=>{throw TypeError(n)};var vp=(n,r,s)=>r.has(n)||gp(\"Cannot \"+s);var ft=(n,r,s)=>(vp(n,r,\"read from private field\"),s?s.call(n):r.get(n)),yp=(n,r,s)=>r.has(n)?gp(\"Cannot add the same private member more than once\"):r instanceof WeakSet?r.add(n):r.set(n,s),nu=(n,r,s,i)=>(vp(n,r,\"write to private field\"),i?i.call(n,s):r.set(n,s),s);function Zy(n,r){for(var s=0;s<r.length;s++){const i=r[s];if(typeof i!=\"string\"&&!Array.isArray(i)){for(const a in i)if(a!==\"default\"&&!(a in n)){const u=Object.getOwnPropertyDescriptor(i,a);u&&Object.defineProperty(n,a,u.get?u:{enumerable:!0,get:()=>i[a]})}}}return Object.freeze(Object.defineProperty(n,Symbol.toStringTag,{value:\"Module\"}))}(function(){const r=document.createElement(\"link\").relList;if(r&&r.supports&&r.supports(\"modulepreload\"))return;for(const a of document.querySelectorAll('link[rel=\"modulepreload\"]'))i(a);new MutationObserver(a=>{for(const u of a)if(u.type===\"childList\")for(const d of u.addedNodes)d.tagName===\"LINK\"&&d.rel===\"modulepreload\"&&i(d)}).observe(document,{childList:!0,subtree:!0});function s(a){const u={};return a.integrity&&(u.integrity=a.integrity),a.referrerPolicy&&(u.referrerPolicy=a.referrerPolicy),a.crossOrigin===\"use-credentials\"?u.credentials=\"include\":a.crossOrigin===\"anonymous\"?u.credentials=\"omit\":u.credentials=\"same-origin\",u}function i(a){if(a.ep)return;a.ep=!0;const u=s(a);fetch(a.href,u)}})();function qy(n){return n&&n.__esModule&&Object.prototype.hasOwnProperty.call(n,\"default\")?n.default:n}var ru={exports:{}},Zo={},ou={exports:{}},ke={};var xp;function Jy(){if(xp)return ke;xp=1;var n=Symbol.for(\"react.element\"),r=Symbol.for(\"react.portal\"),s=Symbol.for(\"react.fragment\"),i=Symbol.for(\"react.strict_mode\"),a=Symbol.for(\"react.profiler\"),u=Symbol.for(\"react.provider\"),d=Symbol.for(\"react.context\"),f=Symbol.for(\"react.forward_ref\"),h=Symbol.for(\"react.suspense\"),m=Symbol.for(\"react.memo\"),w=Symbol.for(\"react.lazy\"),v=Symbol.iterator;function S(N){return N===null||typeof N!=\"object\"?null:(N=v&&N[v]||N[\"@@iterator\"],typeof N==\"function\"?N:null)}var C={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},k=Object.assign,E={};function b(N,D,oe){this.props=N,this.context=D,this.refs=E,this.updater=oe||C}b.prototype.isReactComponent={},b.prototype.setState=function(N,D){if(typeof N!=\"object\"&&typeof N!=\"function\"&&N!=null)throw Error(\"setState(...): takes an object of state variables to update or a function which returns an object of state variables.\");this.updater.enqueueSetState(this,N,D,\"setState\")},b.prototype.forceUpdate=function(N){this.updater.enqueueForceUpdate(this,N,\"forceUpdate\")};function _(){}_.prototype=b.prototype;function L(N,D,oe){this.props=N,this.context=D,this.refs=E,this.updater=oe||C}var T=L.prototype=new _;T.constructor=L,k(T,b.prototype),T.isPureReactComponent=!0;var O=Array.isArray,B=Object.prototype.hasOwnProperty,V={current:null},H={key:!0,ref:!0,__self:!0,__source:!0};function $(N,D,oe){var pe,se={},ge=null,Se=null;if(D!=null)for(pe in D.ref!==void 0&&(Se=D.ref),D.key!==void 0&&(ge=\"\"+D.key),D)B.call(D,pe)&&!H.hasOwnProperty(pe)&&(se[pe]=D[pe]);var re=arguments.length-2;if(re===1)se.children=oe;else if(1<re){for(var le=Array(re),Pe=0;Pe<re;Pe++)le[Pe]=arguments[Pe+2];se.children=le}if(N&&N.defaultProps)for(pe in re=N.defaultProps,re)se[pe]===void 0&&(se[pe]=re[pe]);return{$$typeof:n,type:N,key:ge,ref:Se,props:se,_owner:V.current}}function W(N,D){return{$$typeof:n,type:N.type,key:D,ref:N.ref,props:N.props,_owner:N._owner}}function X(N){return typeof N==\"object\"&&N!==null&&N.$$typeof===n}function Q(N){var D={\"=\":\"=0\",\":\":\"=2\"};return\"$\"+N.replace(/[=:]/g,function(oe){return D[oe]})}var q=/\\/+/g;function Z(N,D){return typeof N==\"object\"&&N!==null&&N.key!=null?Q(\"\"+N.key):D.toString(36)}function ne(N,D,oe,pe,se){var ge=typeof N;(ge===\"undefined\"||ge===\"boolean\")&&(N=null);var Se=!1;if(N===null)Se=!0;else switch(ge){case\"string\":case\"number\":Se=!0;break;case\"object\":switch(N.$$typeof){case n:case r:Se=!0}}if(Se)return Se=N,se=se(Se),N=pe===\"\"?\".\"+Z(Se,0):pe,O(se)?(oe=\"\",N!=null&&(oe=N.replace(q,\"$&/\")+\"/\"),ne(se,D,oe,\"\",function(Pe){return Pe})):se!=null&&(X(se)&&(se=W(se,oe+(!se.key||Se&&Se.key===se.key?\"\":(\"\"+se.key).replace(q,\"$&/\")+\"/\")+N)),D.push(se)),1;if(Se=0,pe=pe===\"\"?\".\":pe+\":\",O(N))for(var re=0;re<N.length;re++){ge=N[re];var le=pe+Z(ge,re);Se+=ne(ge,D,oe,le,se)}else if(le=S(N),typeof le==\"function\")for(N=le.call(N),re=0;!(ge=N.next()).done;)ge=ge.value,le=pe+Z(ge,re++),Se+=ne(ge,D,oe,le,se);else if(ge===\"object\")throw D=String(N),Error(\"Objects are not valid as a React child (found: \"+(D===\"[object Object]\"?\"object with keys {\"+Object.keys(N).join(\", \")+\"}\":D)+\"). If you meant to render a collection of children, use an array instead.\");return Se}function fe(N,D,oe){if(N==null)return N;var pe=[],se=0;return ne(N,pe,\"\",\"\",function(ge){return D.call(oe,ge,se++)}),pe}function J(N){if(N._status===-1){var D=N._result;D=D(),D.then(function(oe){(N._status===0||N._status===-1)&&(N._status=1,N._result=oe)},function(oe){(N._status===0||N._status===-1)&&(N._status=2,N._result=oe)}),N._status===-1&&(N._status=0,N._result=D)}if(N._status===1)return N._result.default;throw N._result}var ee={current:null},I={transition:null},U={ReactCurrentDispatcher:ee,ReactCurrentBatchConfig:I,ReactCurrentOwner:V};function M(){throw Error(\"act(...) is not supported in production builds of React.\")}return ke.Children={map:fe,forEach:function(N,D,oe){fe(N,function(){D.apply(this,arguments)},oe)},count:function(N){var D=0;return fe(N,function(){D++}),D},toArray:function(N){return fe(N,function(D){return D})||[]},only:function(N){if(!X(N))throw Error(\"React.Children.only expected to receive a single React element child.\");return N}},ke.Component=b,ke.Fragment=s,ke.Profiler=a,ke.PureComponent=L,ke.StrictMode=i,ke.Suspense=h,ke.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=U,ke.act=M,ke.cloneElement=function(N,D,oe){if(N==null)throw Error(\"React.cloneElement(...): The argument must be a React element, but you passed \"+N+\".\");var pe=k({},N.props),se=N.key,ge=N.ref,Se=N._owner;if(D!=null){if(D.ref!==void 0&&(ge=D.ref,Se=V.current),D.key!==void 0&&(se=\"\"+D.key),N.type&&N.type.defaultProps)var re=N.type.defaultProps;for(le in D)B.call(D,le)&&!H.hasOwnProperty(le)&&(pe[le]=D[le]===void 0&&re!==void 0?re[le]:D[le])}var le=arguments.length-2;if(le===1)pe.children=oe;else if(1<le){re=Array(le);for(var Pe=0;Pe<le;Pe++)re[Pe]=arguments[Pe+2];pe.children=re}return{$$typeof:n,type:N.type,key:se,ref:ge,props:pe,_owner:Se}},ke.createContext=function(N){return N={$$typeof:d,_currentValue:N,_currentValue2:N,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},N.Provider={$$typeof:u,_context:N},N.Consumer=N},ke.createElement=$,ke.createFactory=function(N){var D=$.bind(null,N);return D.type=N,D},ke.createRef=function(){return{current:null}},ke.forwardRef=function(N){return{$$typeof:f,render:N}},ke.isValidElement=X,ke.lazy=function(N){return{$$typeof:w,_payload:{_status:-1,_result:N},_init:J}},ke.memo=function(N,D){return{$$typeof:m,type:N,compare:D===void 0?null:D}},ke.startTransition=function(N){var D=I.transition;I.transition={};try{N()}finally{I.transition=D}},ke.unstable_act=M,ke.useCallback=function(N,D){return ee.current.useCallback(N,D)},ke.useContext=function(N){return ee.current.useContext(N)},ke.useDebugValue=function(){},ke.useDeferredValue=function(N){return ee.current.useDeferredValue(N)},ke.useEffect=function(N,D){return ee.current.useEffect(N,D)},ke.useId=function(){return ee.current.useId()},ke.useImperativeHandle=function(N,D,oe){return ee.current.useImperativeHandle(N,D,oe)},ke.useInsertionEffect=function(N,D){return ee.current.useInsertionEffect(N,D)},ke.useLayoutEffect=function(N,D){return ee.current.useLayoutEffect(N,D)},ke.useMemo=function(N,D){return ee.current.useMemo(N,D)},ke.useReducer=function(N,D,oe){return ee.current.useReducer(N,D,oe)},ke.useRef=function(N){return ee.current.useRef(N)},ke.useState=function(N){return ee.current.useState(N)},ke.useSyncExternalStore=function(N,D,oe){return ee.current.useSyncExternalStore(N,D,oe)},ke.useTransition=function(){return ee.current.useTransition()},ke.version=\"18.3.1\",ke}var wp;function Qi(){return wp||(wp=1,ou.exports=Jy()),ou.exports}var Sp;function ex(){if(Sp)return Zo;Sp=1;var n=Qi(),r=Symbol.for(\"react.element\"),s=Symbol.for(\"react.fragment\"),i=Object.prototype.hasOwnProperty,a=n.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner,u={key:!0,ref:!0,__self:!0,__source:!0};function d(f,h,m){var w,v={},S=null,C=null;m!==void 0&&(S=\"\"+m),h.key!==void 0&&(S=\"\"+h.key),h.ref!==void 0&&(C=h.ref);for(w in h)i.call(h,w)&&!u.hasOwnProperty(w)&&(v[w]=h[w]);if(f&&f.defaultProps)for(w in h=f.defaultProps,h)v[w]===void 0&&(v[w]=h[w]);return{$$typeof:r,type:f,key:S,ref:C,props:v,_owner:a.current}}return Zo.Fragment=s,Zo.jsx=d,Zo.jsxs=d,Zo}var Cp;function tx(){return Cp||(Cp=1,ru.exports=ex()),ru.exports}var g=tx(),x=Qi();const jh=qy(x),us=Zy({__proto__:null,default:jh},[x]);var Ci={},su={exports:{}},kt={},iu={exports:{}},lu={};var kp;function nx(){return kp||(kp=1,(function(n){function r(I,U){var M=I.length;I.push(U);e:for(;0<M;){var N=M-1>>>1,D=I[N];if(0<a(D,U))I[N]=U,I[M]=D,M=N;else break e}}function s(I){return I.length===0?null:I[0]}function i(I){if(I.length===0)return null;var U=I[0],M=I.pop();if(M!==U){I[0]=M;e:for(var N=0,D=I.length,oe=D>>>1;N<oe;){var pe=2*(N+1)-1,se=I[pe],ge=pe+1,Se=I[ge];if(0>a(se,M))ge<D&&0>a(Se,se)?(I[N]=Se,I[ge]=M,N=ge):(I[N]=se,I[pe]=M,N=pe);else if(ge<D&&0>a(Se,M))I[N]=Se,I[ge]=M,N=ge;else break e}}return U}function a(I,U){var M=I.sortIndex-U.sortIndex;return M!==0?M:I.id-U.id}if(typeof performance==\"object\"&&typeof performance.now==\"function\"){var u=performance;n.unstable_now=function(){return u.now()}}else{var d=Date,f=d.now();n.unstable_now=function(){return d.now()-f}}var h=[],m=[],w=1,v=null,S=3,C=!1,k=!1,E=!1,b=typeof setTimeout==\"function\"?setTimeout:null,_=typeof clearTimeout==\"function\"?clearTimeout:null,L=typeof setImmediate<\"u\"?setImmediate:null;typeof navigator<\"u\"&&navigator.scheduling!==void 0&&navigator.scheduling.isInputPending!==void 0&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function T(I){for(var U=s(m);U!==null;){if(U.callback===null)i(m);else if(U.startTime<=I)i(m),U.sortIndex=U.expirationTime,r(h,U);else break;U=s(m)}}function O(I){if(E=!1,T(I),!k)if(s(h)!==null)k=!0,J(B);else{var U=s(m);U!==null&&ee(O,U.startTime-I)}}function B(I,U){k=!1,E&&(E=!1,_($),$=-1),C=!0;var M=S;try{for(T(U),v=s(h);v!==null&&(!(v.expirationTime>U)||I&&!Q());){var N=v.callback;if(typeof N==\"function\"){v.callback=null,S=v.priorityLevel;var D=N(v.expirationTime<=U);U=n.unstable_now(),typeof D==\"function\"?v.callback=D:v===s(h)&&i(h),T(U)}else i(h);v=s(h)}if(v!==null)var oe=!0;else{var pe=s(m);pe!==null&&ee(O,pe.startTime-U),oe=!1}return oe}finally{v=null,S=M,C=!1}}var V=!1,H=null,$=-1,W=5,X=-1;function Q(){return!(n.unstable_now()-X<W)}function q(){if(H!==null){var I=n.unstable_now();X=I;var U=!0;try{U=H(!0,I)}finally{U?Z():(V=!1,H=null)}}else V=!1}var Z;if(typeof L==\"function\")Z=function(){L(q)};else if(typeof MessageChannel<\"u\"){var ne=new MessageChannel,fe=ne.port2;ne.port1.onmessage=q,Z=function(){fe.postMessage(null)}}else Z=function(){b(q,0)};function J(I){H=I,V||(V=!0,Z())}function ee(I,U){$=b(function(){I(n.unstable_now())},U)}n.unstable_IdlePriority=5,n.unstable_ImmediatePriority=1,n.unstable_LowPriority=4,n.unstable_NormalPriority=3,n.unstable_Profiling=null,n.unstable_UserBlockingPriority=2,n.unstable_cancelCallback=function(I){I.callback=null},n.unstable_continueExecution=function(){k||C||(k=!0,J(B))},n.unstable_forceFrameRate=function(I){0>I||125<I?console.error(\"forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported\"):W=0<I?Math.floor(1e3/I):5},n.unstable_getCurrentPriorityLevel=function(){return S},n.unstable_getFirstCallbackNode=function(){return s(h)},n.unstable_next=function(I){switch(S){case 1:case 2:case 3:var U=3;break;default:U=S}var M=S;S=U;try{return I()}finally{S=M}},n.unstable_pauseExecution=function(){},n.unstable_requestPaint=function(){},n.unstable_runWithPriority=function(I,U){switch(I){case 1:case 2:case 3:case 4:case 5:break;default:I=3}var M=S;S=I;try{return U()}finally{S=M}},n.unstable_scheduleCallback=function(I,U,M){var N=n.unstable_now();switch(typeof M==\"object\"&&M!==null?(M=M.delay,M=typeof M==\"number\"&&0<M?N+M:N):M=N,I){case 1:var D=-1;break;case 2:D=250;break;case 5:D=1073741823;break;case 4:D=1e4;break;default:D=5e3}return D=M+D,I={id:w++,callback:U,priorityLevel:I,startTime:M,expirationTime:D,sortIndex:-1},M>N?(I.sortIndex=M,r(m,I),s(h)===null&&I===s(m)&&(E?(_($),$=-1):E=!0,ee(O,M-N))):(I.sortIndex=D,r(h,I),k||C||(k=!0,J(B))),I},n.unstable_shouldYield=Q,n.unstable_wrapCallback=function(I){var U=S;return function(){var M=S;S=U;try{return I.apply(this,arguments)}finally{S=M}}}})(lu)),lu}var bp;function rx(){return bp||(bp=1,iu.exports=nx()),iu.exports}var Ep;function ox(){if(Ep)return kt;Ep=1;var n=Qi(),r=rx();function s(e){for(var t=\"https://reactjs.org/docs/error-decoder.html?invariant=\"+e,o=1;o<arguments.length;o++)t+=\"&args[]=\"+encodeURIComponent(arguments[o]);return\"Minified React error #\"+e+\"; visit \"+t+\" for the full message or use the non-minified dev environment for full errors and additional helpful warnings.\"}var i=new Set,a={};function u(e,t){d(e,t),d(e+\"Capture\",t)}function d(e,t){for(a[e]=t,e=0;e<t.length;e++)i.add(t[e])}var f=!(typeof window>\"u\"||typeof window.document>\"u\"||typeof window.document.createElement>\"u\"),h=Object.prototype.hasOwnProperty,m=/^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$/,w={},v={};function S(e){return h.call(v,e)?!0:h.call(w,e)?!1:m.test(e)?v[e]=!0:(w[e]=!0,!1)}function C(e,t,o,l){if(o!==null&&o.type===0)return!1;switch(typeof t){case\"function\":case\"symbol\":return!0;case\"boolean\":return l?!1:o!==null?!o.acceptsBooleans:(e=e.toLowerCase().slice(0,5),e!==\"data-\"&&e!==\"aria-\");default:return!1}}function k(e,t,o,l){if(t===null||typeof t>\"u\"||C(e,t,o,l))return!0;if(l)return!1;if(o!==null)switch(o.type){case 3:return!t;case 4:return t===!1;case 5:return isNaN(t);case 6:return isNaN(t)||1>t}return!1}function E(e,t,o,l,c,p,y){this.acceptsBooleans=t===2||t===3||t===4,this.attributeName=l,this.attributeNamespace=c,this.mustUseProperty=o,this.propertyName=e,this.type=t,this.sanitizeURL=p,this.removeEmptyString=y}var b={};\"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style\".split(\" \").forEach(function(e){b[e]=new E(e,0,!1,e,null,!1,!1)}),[[\"acceptCharset\",\"accept-charset\"],[\"className\",\"class\"],[\"htmlFor\",\"for\"],[\"httpEquiv\",\"http-equiv\"]].forEach(function(e){var t=e[0];b[t]=new E(t,1,!1,e[1],null,!1,!1)}),[\"contentEditable\",\"draggable\",\"spellCheck\",\"value\"].forEach(function(e){b[e]=new E(e,2,!1,e.toLowerCase(),null,!1,!1)}),[\"autoReverse\",\"externalResourcesRequired\",\"focusable\",\"preserveAlpha\"].forEach(function(e){b[e]=new E(e,2,!1,e,null,!1,!1)}),\"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope\".split(\" \").forEach(function(e){b[e]=new E(e,3,!1,e.toLowerCase(),null,!1,!1)}),[\"checked\",\"multiple\",\"muted\",\"selected\"].forEach(function(e){b[e]=new E(e,3,!0,e,null,!1,!1)}),[\"capture\",\"download\"].forEach(function(e){b[e]=new E(e,4,!1,e,null,!1,!1)}),[\"cols\",\"rows\",\"size\",\"span\"].forEach(function(e){b[e]=new E(e,6,!1,e,null,!1,!1)}),[\"rowSpan\",\"start\"].forEach(function(e){b[e]=new E(e,5,!1,e.toLowerCase(),null,!1,!1)});var _=/[\\-:]([a-z])/g;function L(e){return e[1].toUpperCase()}\"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height\".split(\" \").forEach(function(e){var t=e.replace(_,L);b[t]=new E(t,1,!1,e,null,!1,!1)}),\"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type\".split(\" \").forEach(function(e){var t=e.replace(_,L);b[t]=new E(t,1,!1,e,\"http://www.w3.org/1999/xlink\",!1,!1)}),[\"xml:base\",\"xml:lang\",\"xml:space\"].forEach(function(e){var t=e.replace(_,L);b[t]=new E(t,1,!1,e,\"http://www.w3.org/XML/1998/namespace\",!1,!1)}),[\"tabIndex\",\"crossOrigin\"].forEach(function(e){b[e]=new E(e,1,!1,e.toLowerCase(),null,!1,!1)}),b.xlinkHref=new E(\"xlinkHref\",1,!1,\"xlink:href\",\"http://www.w3.org/1999/xlink\",!0,!1),[\"src\",\"href\",\"action\",\"formAction\"].forEach(function(e){b[e]=new E(e,1,!1,e.toLowerCase(),null,!0,!0)});function T(e,t,o,l){var c=b.hasOwnProperty(t)?b[t]:null;(c!==null?c.type!==0:l||!(2<t.length)||t[0]!==\"o\"&&t[0]!==\"O\"||t[1]!==\"n\"&&t[1]!==\"N\")&&(k(t,o,c,l)&&(o=null),l||c===null?S(t)&&(o===null?e.removeAttribute(t):e.setAttribute(t,\"\"+o)):c.mustUseProperty?e[c.propertyName]=o===null?c.type===3?!1:\"\":o:(t=c.attributeName,l=c.attributeNamespace,o===null?e.removeAttribute(t):(c=c.type,o=c===3||c===4&&o===!0?\"\":\"\"+o,l?e.setAttributeNS(l,t,o):e.setAttribute(t,o))))}var O=n.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,B=Symbol.for(\"react.element\"),V=Symbol.for(\"react.portal\"),H=Symbol.for(\"react.fragment\"),$=Symbol.for(\"react.strict_mode\"),W=Symbol.for(\"react.profiler\"),X=Symbol.for(\"react.provider\"),Q=Symbol.for(\"react.context\"),q=Symbol.for(\"react.forward_ref\"),Z=Symbol.for(\"react.suspense\"),ne=Symbol.for(\"react.suspense_list\"),fe=Symbol.for(\"react.memo\"),J=Symbol.for(\"react.lazy\"),ee=Symbol.for(\"react.offscreen\"),I=Symbol.iterator;function U(e){return e===null||typeof e!=\"object\"?null:(e=I&&e[I]||e[\"@@iterator\"],typeof e==\"function\"?e:null)}var M=Object.assign,N;function D(e){if(N===void 0)try{throw Error()}catch(o){var t=o.stack.trim().match(/\\n( *(at )?)/);N=t&&t[1]||\"\"}return`\n`+N+e}var oe=!1;function pe(e,t){if(!e||oe)return\"\";oe=!0;var o=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(t)if(t=function(){throw Error()},Object.defineProperty(t.prototype,\"props\",{set:function(){throw Error()}}),typeof Reflect==\"object\"&&Reflect.construct){try{Reflect.construct(t,[])}catch(F){var l=F}Reflect.construct(e,[],t)}else{try{t.call()}catch(F){l=F}e.call(t.prototype)}else{try{throw Error()}catch(F){l=F}e()}}catch(F){if(F&&l&&typeof F.stack==\"string\"){for(var c=F.stack.split(`\n`),p=l.stack.split(`\n`),y=c.length-1,P=p.length-1;1<=y&&0<=P&&c[y]!==p[P];)P--;for(;1<=y&&0<=P;y--,P--)if(c[y]!==p[P]){if(y!==1||P!==1)do if(y--,P--,0>P||c[y]!==p[P]){var R=`\n`+c[y].replace(\" at new \",\" at \");return e.displayName&&R.includes(\"<anonymous>\")&&(R=R.replace(\"<anonymous>\",e.displayName)),R}while(1<=y&&0<=P);break}}}finally{oe=!1,Error.prepareStackTrace=o}return(e=e?e.displayName||e.name:\"\")?D(e):\"\"}function se(e){switch(e.tag){case 5:return D(e.type);case 16:return D(\"Lazy\");case 13:return D(\"Suspense\");case 19:return D(\"SuspenseList\");case 0:case 2:case 15:return e=pe(e.type,!1),e;case 11:return e=pe(e.type.render,!1),e;case 1:return e=pe(e.type,!0),e;default:return\"\"}}function ge(e){if(e==null)return null;if(typeof e==\"function\")return e.displayName||e.name||null;if(typeof e==\"string\")return e;switch(e){case H:return\"Fragment\";case V:return\"Portal\";case W:return\"Profiler\";case $:return\"StrictMode\";case Z:return\"Suspense\";case ne:return\"SuspenseList\"}if(typeof e==\"object\")switch(e.$$typeof){case Q:return(e.displayName||\"Context\")+\".Consumer\";case X:return(e._context.displayName||\"Context\")+\".Provider\";case q:var t=e.render;return e=e.displayName,e||(e=t.displayName||t.name||\"\",e=e!==\"\"?\"ForwardRef(\"+e+\")\":\"ForwardRef\"),e;case fe:return t=e.displayName||null,t!==null?t:ge(e.type)||\"Memo\";case J:t=e._payload,e=e._init;try{return ge(e(t))}catch{}}return null}function Se(e){var t=e.type;switch(e.tag){case 24:return\"Cache\";case 9:return(t.displayName||\"Context\")+\".Consumer\";case 10:return(t._context.displayName||\"Context\")+\".Provider\";case 18:return\"DehydratedFragment\";case 11:return e=t.render,e=e.displayName||e.name||\"\",t.displayName||(e!==\"\"?\"ForwardRef(\"+e+\")\":\"ForwardRef\");case 7:return\"Fragment\";case 5:return t;case 4:return\"Portal\";case 3:return\"Root\";case 6:return\"Text\";case 16:return ge(t);case 8:return t===$?\"StrictMode\":\"Mode\";case 22:return\"Offscreen\";case 12:return\"Profiler\";case 21:return\"Scope\";case 13:return\"Suspense\";case 19:return\"SuspenseList\";case 25:return\"TracingMarker\";case 1:case 0:case 17:case 2:case 14:case 15:if(typeof t==\"function\")return t.displayName||t.name||null;if(typeof t==\"string\")return t}return null}function re(e){switch(typeof e){case\"boolean\":case\"number\":case\"string\":case\"undefined\":return e;case\"object\":return e;default:return\"\"}}function le(e){var t=e.type;return(e=e.nodeName)&&e.toLowerCase()===\"input\"&&(t===\"checkbox\"||t===\"radio\")}function Pe(e){var t=le(e)?\"checked\":\"value\",o=Object.getOwnPropertyDescriptor(e.constructor.prototype,t),l=\"\"+e[t];if(!e.hasOwnProperty(t)&&typeof o<\"u\"&&typeof o.get==\"function\"&&typeof o.set==\"function\"){var c=o.get,p=o.set;return Object.defineProperty(e,t,{configurable:!0,get:function(){return c.call(this)},set:function(y){l=\"\"+y,p.call(this,y)}}),Object.defineProperty(e,t,{enumerable:o.enumerable}),{getValue:function(){return l},setValue:function(y){l=\"\"+y},stopTracking:function(){e._valueTracker=null,delete e[t]}}}}function be(e){e._valueTracker||(e._valueTracker=Pe(e))}function Re(e){if(!e)return!1;var t=e._valueTracker;if(!t)return!0;var o=t.getValue(),l=\"\";return e&&(l=le(e)?e.checked?\"true\":\"false\":e.value),e=l,e!==o?(t.setValue(e),!0):!1}function _e(e){if(e=e||(typeof document<\"u\"?document:void 0),typeof e>\"u\")return null;try{return e.activeElement||e.body}catch{return e.body}}function Je(e,t){var o=t.checked;return M({},t,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:o??e._wrapperState.initialChecked})}function pt(e,t){var o=t.defaultValue==null?\"\":t.defaultValue,l=t.checked!=null?t.checked:t.defaultChecked;o=re(t.value!=null?t.value:o),e._wrapperState={initialChecked:l,initialValue:o,controlled:t.type===\"checkbox\"||t.type===\"radio\"?t.checked!=null:t.value!=null}}function Pr(e,t){t=t.checked,t!=null&&T(e,\"checked\",t,!1)}function er(e,t){Pr(e,t);var o=re(t.value),l=t.type;if(o!=null)l===\"number\"?(o===0&&e.value===\"\"||e.value!=o)&&(e.value=\"\"+o):e.value!==\"\"+o&&(e.value=\"\"+o);else if(l===\"submit\"||l===\"reset\"){e.removeAttribute(\"value\");return}t.hasOwnProperty(\"value\")?dl(e,t.type,o):t.hasOwnProperty(\"defaultValue\")&&dl(e,t.type,re(t.defaultValue)),t.checked==null&&t.defaultChecked!=null&&(e.defaultChecked=!!t.defaultChecked)}function Nr(e,t,o){if(t.hasOwnProperty(\"value\")||t.hasOwnProperty(\"defaultValue\")){var l=t.type;if(!(l!==\"submit\"&&l!==\"reset\"||t.value!==void 0&&t.value!==null))return;t=\"\"+e._wrapperState.initialValue,o||t===e.value||(e.value=t),e.defaultValue=t}o=e.name,o!==\"\"&&(e.name=\"\"),e.defaultChecked=!!e._wrapperState.initialChecked,o!==\"\"&&(e.name=o)}function dl(e,t,o){(t!==\"number\"||_e(e.ownerDocument)!==e)&&(o==null?e.defaultValue=\"\"+e._wrapperState.initialValue:e.defaultValue!==\"\"+o&&(e.defaultValue=\"\"+o))}var fo=Array.isArray;function Rr(e,t,o,l){if(e=e.options,t){t={};for(var c=0;c<o.length;c++)t[\"$\"+o[c]]=!0;for(o=0;o<e.length;o++)c=t.hasOwnProperty(\"$\"+e[o].value),e[o].selected!==c&&(e[o].selected=c),c&&l&&(e[o].defaultSelected=!0)}else{for(o=\"\"+re(o),t=null,c=0;c<e.length;c++){if(e[c].value===o){e[c].selected=!0,l&&(e[c].defaultSelected=!0);return}t!==null||e[c].disabled||(t=e[c])}t!==null&&(t.selected=!0)}}function fl(e,t){if(t.dangerouslySetInnerHTML!=null)throw Error(s(91));return M({},t,{value:void 0,defaultValue:void 0,children:\"\"+e._wrapperState.initialValue})}function Ec(e,t){var o=t.value;if(o==null){if(o=t.children,t=t.defaultValue,o!=null){if(t!=null)throw Error(s(92));if(fo(o)){if(1<o.length)throw Error(s(93));o=o[0]}t=o}t==null&&(t=\"\"),o=t}e._wrapperState={initialValue:re(o)}}function Pc(e,t){var o=re(t.value),l=re(t.defaultValue);o!=null&&(o=\"\"+o,o!==e.value&&(e.value=o),t.defaultValue==null&&e.defaultValue!==o&&(e.defaultValue=o)),l!=null&&(e.defaultValue=\"\"+l)}function Nc(e){var t=e.textContent;t===e._wrapperState.initialValue&&t!==\"\"&&t!==null&&(e.value=t)}function Rc(e){switch(e){case\"svg\":return\"http://www.w3.org/2000/svg\";case\"math\":return\"http://www.w3.org/1998/Math/MathML\";default:return\"http://www.w3.org/1999/xhtml\"}}function pl(e,t){return e==null||e===\"http://www.w3.org/1999/xhtml\"?Rc(t):e===\"http://www.w3.org/2000/svg\"&&t===\"foreignObject\"?\"http://www.w3.org/1999/xhtml\":e}var hs,Oc=(function(e){return typeof MSApp<\"u\"&&MSApp.execUnsafeLocalFunction?function(t,o,l,c){MSApp.execUnsafeLocalFunction(function(){return e(t,o,l,c)})}:e})(function(e,t){if(e.namespaceURI!==\"http://www.w3.org/2000/svg\"||\"innerHTML\"in e)e.innerHTML=t;else{for(hs=hs||document.createElement(\"div\"),hs.innerHTML=\"<svg>\"+t.valueOf().toString()+\"</svg>\",t=hs.firstChild;e.firstChild;)e.removeChild(e.firstChild);for(;t.firstChild;)e.appendChild(t.firstChild)}});function po(e,t){if(t){var o=e.firstChild;if(o&&o===e.lastChild&&o.nodeType===3){o.nodeValue=t;return}}e.textContent=t}var ho={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},tv=[\"Webkit\",\"ms\",\"Moz\",\"O\"];Object.keys(ho).forEach(function(e){tv.forEach(function(t){t=t+e.charAt(0).toUpperCase()+e.substring(1),ho[t]=ho[e]})});function jc(e,t,o){return t==null||typeof t==\"boolean\"||t===\"\"?\"\":o||typeof t!=\"number\"||t===0||ho.hasOwnProperty(e)&&ho[e]?(\"\"+t).trim():t+\"px\"}function _c(e,t){e=e.style;for(var o in t)if(t.hasOwnProperty(o)){var l=o.indexOf(\"--\")===0,c=jc(o,t[o],l);o===\"float\"&&(o=\"cssFloat\"),l?e.setProperty(o,c):e[o]=c}}var nv=M({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});function hl(e,t){if(t){if(nv[e]&&(t.children!=null||t.dangerouslySetInnerHTML!=null))throw Error(s(137,e));if(t.dangerouslySetInnerHTML!=null){if(t.children!=null)throw Error(s(60));if(typeof t.dangerouslySetInnerHTML!=\"object\"||!(\"__html\"in t.dangerouslySetInnerHTML))throw Error(s(61))}if(t.style!=null&&typeof t.style!=\"object\")throw Error(s(62))}}function ml(e,t){if(e.indexOf(\"-\")===-1)return typeof t.is==\"string\";switch(e){case\"annotation-xml\":case\"color-profile\":case\"font-face\":case\"font-face-src\":case\"font-face-uri\":case\"font-face-format\":case\"font-face-name\":case\"missing-glyph\":return!1;default:return!0}}var gl=null;function vl(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}var yl=null,Or=null,jr=null;function Tc(e){if(e=Do(e)){if(typeof yl!=\"function\")throw Error(s(280));var t=e.stateNode;t&&(t=Ms(t),yl(e.stateNode,e.type,t))}}function Lc(e){Or?jr?jr.push(e):jr=[e]:Or=e}function Ic(){if(Or){var e=Or,t=jr;if(jr=Or=null,Tc(e),t)for(e=0;e<t.length;e++)Tc(t[e])}}function Ac(e,t){return e(t)}function Dc(){}var xl=!1;function Mc(e,t,o){if(xl)return e(t,o);xl=!0;try{return Ac(e,t,o)}finally{xl=!1,(Or!==null||jr!==null)&&(Dc(),Ic())}}function mo(e,t){var o=e.stateNode;if(o===null)return null;var l=Ms(o);if(l===null)return null;o=l[t];e:switch(t){case\"onClick\":case\"onClickCapture\":case\"onDoubleClick\":case\"onDoubleClickCapture\":case\"onMouseDown\":case\"onMouseDownCapture\":case\"onMouseMove\":case\"onMouseMoveCapture\":case\"onMouseUp\":case\"onMouseUpCapture\":case\"onMouseEnter\":(l=!l.disabled)||(e=e.type,l=!(e===\"button\"||e===\"input\"||e===\"select\"||e===\"textarea\")),e=!l;break e;default:e=!1}if(e)return null;if(o&&typeof o!=\"function\")throw Error(s(231,t,typeof o));return o}var wl=!1;if(f)try{var go={};Object.defineProperty(go,\"passive\",{get:function(){wl=!0}}),window.addEventListener(\"test\",go,go),window.removeEventListener(\"test\",go,go)}catch{wl=!1}function rv(e,t,o,l,c,p,y,P,R){var F=Array.prototype.slice.call(arguments,3);try{t.apply(o,F)}catch(G){this.onError(G)}}var vo=!1,ms=null,gs=!1,Sl=null,ov={onError:function(e){vo=!0,ms=e}};function sv(e,t,o,l,c,p,y,P,R){vo=!1,ms=null,rv.apply(ov,arguments)}function iv(e,t,o,l,c,p,y,P,R){if(sv.apply(this,arguments),vo){if(vo){var F=ms;vo=!1,ms=null}else throw Error(s(198));gs||(gs=!0,Sl=F)}}function tr(e){var t=e,o=e;if(e.alternate)for(;t.return;)t=t.return;else{e=t;do t=e,(t.flags&4098)!==0&&(o=t.return),e=t.return;while(e)}return t.tag===3?o:null}function zc(e){if(e.tag===13){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function Fc(e){if(tr(e)!==e)throw Error(s(188))}function lv(e){var t=e.alternate;if(!t){if(t=tr(e),t===null)throw Error(s(188));return t!==e?null:e}for(var o=e,l=t;;){var c=o.return;if(c===null)break;var p=c.alternate;if(p===null){if(l=c.return,l!==null){o=l;continue}break}if(c.child===p.child){for(p=c.child;p;){if(p===o)return Fc(c),e;if(p===l)return Fc(c),t;p=p.sibling}throw Error(s(188))}if(o.return!==l.return)o=c,l=p;else{for(var y=!1,P=c.child;P;){if(P===o){y=!0,o=c,l=p;break}if(P===l){y=!0,l=c,o=p;break}P=P.sibling}if(!y){for(P=p.child;P;){if(P===o){y=!0,o=p,l=c;break}if(P===l){y=!0,l=p,o=c;break}P=P.sibling}if(!y)throw Error(s(189))}}if(o.alternate!==l)throw Error(s(190))}if(o.tag!==3)throw Error(s(188));return o.stateNode.current===o?e:t}function $c(e){return e=lv(e),e!==null?Vc(e):null}function Vc(e){if(e.tag===5||e.tag===6)return e;for(e=e.child;e!==null;){var t=Vc(e);if(t!==null)return t;e=e.sibling}return null}var Bc=r.unstable_scheduleCallback,Uc=r.unstable_cancelCallback,av=r.unstable_shouldYield,uv=r.unstable_requestPaint,We=r.unstable_now,cv=r.unstable_getCurrentPriorityLevel,Cl=r.unstable_ImmediatePriority,Hc=r.unstable_UserBlockingPriority,vs=r.unstable_NormalPriority,dv=r.unstable_LowPriority,Wc=r.unstable_IdlePriority,ys=null,Xt=null;function fv(e){if(Xt&&typeof Xt.onCommitFiberRoot==\"function\")try{Xt.onCommitFiberRoot(ys,e,void 0,(e.current.flags&128)===128)}catch{}}var Ft=Math.clz32?Math.clz32:mv,pv=Math.log,hv=Math.LN2;function mv(e){return e>>>=0,e===0?32:31-(pv(e)/hv|0)|0}var xs=64,ws=4194304;function yo(e){switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return e&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;default:return e}}function Ss(e,t){var o=e.pendingLanes;if(o===0)return 0;var l=0,c=e.suspendedLanes,p=e.pingedLanes,y=o&268435455;if(y!==0){var P=y&~c;P!==0?l=yo(P):(p&=y,p!==0&&(l=yo(p)))}else y=o&~c,y!==0?l=yo(y):p!==0&&(l=yo(p));if(l===0)return 0;if(t!==0&&t!==l&&(t&c)===0&&(c=l&-l,p=t&-t,c>=p||c===16&&(p&4194240)!==0))return t;if((l&4)!==0&&(l|=o&16),t=e.entangledLanes,t!==0)for(e=e.entanglements,t&=l;0<t;)o=31-Ft(t),c=1<<o,l|=e[o],t&=~c;return l}function gv(e,t){switch(e){case 1:case 2:case 4:return t+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return t+5e3;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function vv(e,t){for(var o=e.suspendedLanes,l=e.pingedLanes,c=e.expirationTimes,p=e.pendingLanes;0<p;){var y=31-Ft(p),P=1<<y,R=c[y];R===-1?((P&o)===0||(P&l)!==0)&&(c[y]=gv(P,t)):R<=t&&(e.expiredLanes|=P),p&=~P}}function kl(e){return e=e.pendingLanes&-1073741825,e!==0?e:e&1073741824?1073741824:0}function Kc(){var e=xs;return xs<<=1,(xs&4194240)===0&&(xs=64),e}function bl(e){for(var t=[],o=0;31>o;o++)t.push(e);return t}function xo(e,t,o){e.pendingLanes|=t,t!==536870912&&(e.suspendedLanes=0,e.pingedLanes=0),e=e.eventTimes,t=31-Ft(t),e[t]=o}function yv(e,t){var o=e.pendingLanes&~t;e.pendingLanes=t,e.suspendedLanes=0,e.pingedLanes=0,e.expiredLanes&=t,e.mutableReadLanes&=t,e.entangledLanes&=t,t=e.entanglements;var l=e.eventTimes;for(e=e.expirationTimes;0<o;){var c=31-Ft(o),p=1<<c;t[c]=0,l[c]=-1,e[c]=-1,o&=~p}}function El(e,t){var o=e.entangledLanes|=t;for(e=e.entanglements;o;){var l=31-Ft(o),c=1<<l;c&t|e[l]&t&&(e[l]|=t),o&=~c}}var Te=0;function Gc(e){return e&=-e,1<e?4<e?(e&268435455)!==0?16:536870912:4:1}var Qc,Pl,Yc,Xc,Zc,Nl=!1,Cs=[],Nn=null,Rn=null,On=null,wo=new Map,So=new Map,jn=[],xv=\"mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit\".split(\" \");function qc(e,t){switch(e){case\"focusin\":case\"focusout\":Nn=null;break;case\"dragenter\":case\"dragleave\":Rn=null;break;case\"mouseover\":case\"mouseout\":On=null;break;case\"pointerover\":case\"pointerout\":wo.delete(t.pointerId);break;case\"gotpointercapture\":case\"lostpointercapture\":So.delete(t.pointerId)}}function Co(e,t,o,l,c,p){return e===null||e.nativeEvent!==p?(e={blockedOn:t,domEventName:o,eventSystemFlags:l,nativeEvent:p,targetContainers:[c]},t!==null&&(t=Do(t),t!==null&&Pl(t)),e):(e.eventSystemFlags|=l,t=e.targetContainers,c!==null&&t.indexOf(c)===-1&&t.push(c),e)}function wv(e,t,o,l,c){switch(t){case\"focusin\":return Nn=Co(Nn,e,t,o,l,c),!0;case\"dragenter\":return Rn=Co(Rn,e,t,o,l,c),!0;case\"mouseover\":return On=Co(On,e,t,o,l,c),!0;case\"pointerover\":var p=c.pointerId;return wo.set(p,Co(wo.get(p)||null,e,t,o,l,c)),!0;case\"gotpointercapture\":return p=c.pointerId,So.set(p,Co(So.get(p)||null,e,t,o,l,c)),!0}return!1}function Jc(e){var t=nr(e.target);if(t!==null){var o=tr(t);if(o!==null){if(t=o.tag,t===13){if(t=zc(o),t!==null){e.blockedOn=t,Zc(e.priority,function(){Yc(o)});return}}else if(t===3&&o.stateNode.current.memoizedState.isDehydrated){e.blockedOn=o.tag===3?o.stateNode.containerInfo:null;return}}}e.blockedOn=null}function ks(e){if(e.blockedOn!==null)return!1;for(var t=e.targetContainers;0<t.length;){var o=Ol(e.domEventName,e.eventSystemFlags,t[0],e.nativeEvent);if(o===null){o=e.nativeEvent;var l=new o.constructor(o.type,o);gl=l,o.target.dispatchEvent(l),gl=null}else return t=Do(o),t!==null&&Pl(t),e.blockedOn=o,!1;t.shift()}return!0}function ed(e,t,o){ks(e)&&o.delete(t)}function Sv(){Nl=!1,Nn!==null&&ks(Nn)&&(Nn=null),Rn!==null&&ks(Rn)&&(Rn=null),On!==null&&ks(On)&&(On=null),wo.forEach(ed),So.forEach(ed)}function ko(e,t){e.blockedOn===t&&(e.blockedOn=null,Nl||(Nl=!0,r.unstable_scheduleCallback(r.unstable_NormalPriority,Sv)))}function bo(e){function t(c){return ko(c,e)}if(0<Cs.length){ko(Cs[0],e);for(var o=1;o<Cs.length;o++){var l=Cs[o];l.blockedOn===e&&(l.blockedOn=null)}}for(Nn!==null&&ko(Nn,e),Rn!==null&&ko(Rn,e),On!==null&&ko(On,e),wo.forEach(t),So.forEach(t),o=0;o<jn.length;o++)l=jn[o],l.blockedOn===e&&(l.blockedOn=null);for(;0<jn.length&&(o=jn[0],o.blockedOn===null);)Jc(o),o.blockedOn===null&&jn.shift()}var _r=O.ReactCurrentBatchConfig,bs=!0;function Cv(e,t,o,l){var c=Te,p=_r.transition;_r.transition=null;try{Te=1,Rl(e,t,o,l)}finally{Te=c,_r.transition=p}}function kv(e,t,o,l){var c=Te,p=_r.transition;_r.transition=null;try{Te=4,Rl(e,t,o,l)}finally{Te=c,_r.transition=p}}function Rl(e,t,o,l){if(bs){var c=Ol(e,t,o,l);if(c===null)Kl(e,t,l,Es,o),qc(e,l);else if(wv(c,e,t,o,l))l.stopPropagation();else if(qc(e,l),t&4&&-1<xv.indexOf(e)){for(;c!==null;){var p=Do(c);if(p!==null&&Qc(p),p=Ol(e,t,o,l),p===null&&Kl(e,t,l,Es,o),p===c)break;c=p}c!==null&&l.stopPropagation()}else Kl(e,t,l,null,o)}}var Es=null;function Ol(e,t,o,l){if(Es=null,e=vl(l),e=nr(e),e!==null)if(t=tr(e),t===null)e=null;else if(o=t.tag,o===13){if(e=zc(t),e!==null)return e;e=null}else if(o===3){if(t.stateNode.current.memoizedState.isDehydrated)return t.tag===3?t.stateNode.containerInfo:null;e=null}else t!==e&&(e=null);return Es=e,null}function td(e){switch(e){case\"cancel\":case\"click\":case\"close\":case\"contextmenu\":case\"copy\":case\"cut\":case\"auxclick\":case\"dblclick\":case\"dragend\":case\"dragstart\":case\"drop\":case\"focusin\":case\"focusout\":case\"input\":case\"invalid\":case\"keydown\":case\"keypress\":case\"keyup\":case\"mousedown\":case\"mouseup\":case\"paste\":case\"pause\":case\"play\":case\"pointercancel\":case\"pointerdown\":case\"pointerup\":case\"ratechange\":case\"reset\":case\"resize\":case\"seeked\":case\"submit\":case\"touchcancel\":case\"touchend\":case\"touchstart\":case\"volumechange\":case\"change\":case\"selectionchange\":case\"textInput\":case\"compositionstart\":case\"compositionend\":case\"compositionupdate\":case\"beforeblur\":case\"afterblur\":case\"beforeinput\":case\"blur\":case\"fullscreenchange\":case\"focus\":case\"hashchange\":case\"popstate\":case\"select\":case\"selectstart\":return 1;case\"drag\":case\"dragenter\":case\"dragexit\":case\"dragleave\":case\"dragover\":case\"mousemove\":case\"mouseout\":case\"mouseover\":case\"pointermove\":case\"pointerout\":case\"pointerover\":case\"scroll\":case\"toggle\":case\"touchmove\":case\"wheel\":case\"mouseenter\":case\"mouseleave\":case\"pointerenter\":case\"pointerleave\":return 4;case\"message\":switch(cv()){case Cl:return 1;case Hc:return 4;case vs:case dv:return 16;case Wc:return 536870912;default:return 16}default:return 16}}var _n=null,jl=null,Ps=null;function nd(){if(Ps)return Ps;var e,t=jl,o=t.length,l,c=\"value\"in _n?_n.value:_n.textContent,p=c.length;for(e=0;e<o&&t[e]===c[e];e++);var y=o-e;for(l=1;l<=y&&t[o-l]===c[p-l];l++);return Ps=c.slice(e,1<l?1-l:void 0)}function Ns(e){var t=e.keyCode;return\"charCode\"in e?(e=e.charCode,e===0&&t===13&&(e=13)):e=t,e===10&&(e=13),32<=e||e===13?e:0}function Rs(){return!0}function rd(){return!1}function Et(e){function t(o,l,c,p,y){this._reactName=o,this._targetInst=c,this.type=l,this.nativeEvent=p,this.target=y,this.currentTarget=null;for(var P in e)e.hasOwnProperty(P)&&(o=e[P],this[P]=o?o(p):p[P]);return this.isDefaultPrevented=(p.defaultPrevented!=null?p.defaultPrevented:p.returnValue===!1)?Rs:rd,this.isPropagationStopped=rd,this}return M(t.prototype,{preventDefault:function(){this.defaultPrevented=!0;var o=this.nativeEvent;o&&(o.preventDefault?o.preventDefault():typeof o.returnValue!=\"unknown\"&&(o.returnValue=!1),this.isDefaultPrevented=Rs)},stopPropagation:function(){var o=this.nativeEvent;o&&(o.stopPropagation?o.stopPropagation():typeof o.cancelBubble!=\"unknown\"&&(o.cancelBubble=!0),this.isPropagationStopped=Rs)},persist:function(){},isPersistent:Rs}),t}var Tr={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},_l=Et(Tr),Eo=M({},Tr,{view:0,detail:0}),bv=Et(Eo),Tl,Ll,Po,Os=M({},Eo,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:Al,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){return\"movementX\"in e?e.movementX:(e!==Po&&(Po&&e.type===\"mousemove\"?(Tl=e.screenX-Po.screenX,Ll=e.screenY-Po.screenY):Ll=Tl=0,Po=e),Tl)},movementY:function(e){return\"movementY\"in e?e.movementY:Ll}}),od=Et(Os),Ev=M({},Os,{dataTransfer:0}),Pv=Et(Ev),Nv=M({},Eo,{relatedTarget:0}),Il=Et(Nv),Rv=M({},Tr,{animationName:0,elapsedTime:0,pseudoElement:0}),Ov=Et(Rv),jv=M({},Tr,{clipboardData:function(e){return\"clipboardData\"in e?e.clipboardData:window.clipboardData}}),_v=Et(jv),Tv=M({},Tr,{data:0}),sd=Et(Tv),Lv={Esc:\"Escape\",Spacebar:\" \",Left:\"ArrowLeft\",Up:\"ArrowUp\",Right:\"ArrowRight\",Down:\"ArrowDown\",Del:\"Delete\",Win:\"OS\",Menu:\"ContextMenu\",Apps:\"ContextMenu\",Scroll:\"ScrollLock\",MozPrintableKey:\"Unidentified\"},Iv={8:\"Backspace\",9:\"Tab\",12:\"Clear\",13:\"Enter\",16:\"Shift\",17:\"Control\",18:\"Alt\",19:\"Pause\",20:\"CapsLock\",27:\"Escape\",32:\" \",33:\"PageUp\",34:\"PageDown\",35:\"End\",36:\"Home\",37:\"ArrowLeft\",38:\"ArrowUp\",39:\"ArrowRight\",40:\"ArrowDown\",45:\"Insert\",46:\"Delete\",112:\"F1\",113:\"F2\",114:\"F3\",115:\"F4\",116:\"F5\",117:\"F6\",118:\"F7\",119:\"F8\",120:\"F9\",121:\"F10\",122:\"F11\",123:\"F12\",144:\"NumLock\",145:\"ScrollLock\",224:\"Meta\"},Av={Alt:\"altKey\",Control:\"ctrlKey\",Meta:\"metaKey\",Shift:\"shiftKey\"};function Dv(e){var t=this.nativeEvent;return t.getModifierState?t.getModifierState(e):(e=Av[e])?!!t[e]:!1}function Al(){return Dv}var Mv=M({},Eo,{key:function(e){if(e.key){var t=Lv[e.key]||e.key;if(t!==\"Unidentified\")return t}return e.type===\"keypress\"?(e=Ns(e),e===13?\"Enter\":String.fromCharCode(e)):e.type===\"keydown\"||e.type===\"keyup\"?Iv[e.keyCode]||\"Unidentified\":\"\"},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:Al,charCode:function(e){return e.type===\"keypress\"?Ns(e):0},keyCode:function(e){return e.type===\"keydown\"||e.type===\"keyup\"?e.keyCode:0},which:function(e){return e.type===\"keypress\"?Ns(e):e.type===\"keydown\"||e.type===\"keyup\"?e.keyCode:0}}),zv=Et(Mv),Fv=M({},Os,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),id=Et(Fv),$v=M({},Eo,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:Al}),Vv=Et($v),Bv=M({},Tr,{propertyName:0,elapsedTime:0,pseudoElement:0}),Uv=Et(Bv),Hv=M({},Os,{deltaX:function(e){return\"deltaX\"in e?e.deltaX:\"wheelDeltaX\"in e?-e.wheelDeltaX:0},deltaY:function(e){return\"deltaY\"in e?e.deltaY:\"wheelDeltaY\"in e?-e.wheelDeltaY:\"wheelDelta\"in e?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),Wv=Et(Hv),Kv=[9,13,27,32],Dl=f&&\"CompositionEvent\"in window,No=null;f&&\"documentMode\"in document&&(No=document.documentMode);var Gv=f&&\"TextEvent\"in window&&!No,ld=f&&(!Dl||No&&8<No&&11>=No),ad=\" \",ud=!1;function cd(e,t){switch(e){case\"keyup\":return Kv.indexOf(t.keyCode)!==-1;case\"keydown\":return t.keyCode!==229;case\"keypress\":case\"mousedown\":case\"focusout\":return!0;default:return!1}}function dd(e){return e=e.detail,typeof e==\"object\"&&\"data\"in e?e.data:null}var Lr=!1;function Qv(e,t){switch(e){case\"compositionend\":return dd(t);case\"keypress\":return t.which!==32?null:(ud=!0,ad);case\"textInput\":return e=t.data,e===ad&&ud?null:e;default:return null}}function Yv(e,t){if(Lr)return e===\"compositionend\"||!Dl&&cd(e,t)?(e=nd(),Ps=jl=_n=null,Lr=!1,e):null;switch(e){case\"paste\":return null;case\"keypress\":if(!(t.ctrlKey||t.altKey||t.metaKey)||t.ctrlKey&&t.altKey){if(t.char&&1<t.char.length)return t.char;if(t.which)return String.fromCharCode(t.which)}return null;case\"compositionend\":return ld&&t.locale!==\"ko\"?null:t.data;default:return null}}var Xv={color:!0,date:!0,datetime:!0,\"datetime-local\":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function fd(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t===\"input\"?!!Xv[e.type]:t===\"textarea\"}function pd(e,t,o,l){Lc(l),t=Is(t,\"onChange\"),0<t.length&&(o=new _l(\"onChange\",\"change\",null,o,l),e.push({event:o,listeners:t}))}var Ro=null,Oo=null;function Zv(e){_d(e,0)}function js(e){var t=zr(e);if(Re(t))return e}function qv(e,t){if(e===\"change\")return t}var hd=!1;if(f){var Ml;if(f){var zl=\"oninput\"in document;if(!zl){var md=document.createElement(\"div\");md.setAttribute(\"oninput\",\"return;\"),zl=typeof md.oninput==\"function\"}Ml=zl}else Ml=!1;hd=Ml&&(!document.documentMode||9<document.documentMode)}function gd(){Ro&&(Ro.detachEvent(\"onpropertychange\",vd),Oo=Ro=null)}function vd(e){if(e.propertyName===\"value\"&&js(Oo)){var t=[];pd(t,Oo,e,vl(e)),Mc(Zv,t)}}function Jv(e,t,o){e===\"focusin\"?(gd(),Ro=t,Oo=o,Ro.attachEvent(\"onpropertychange\",vd)):e===\"focusout\"&&gd()}function ey(e){if(e===\"selectionchange\"||e===\"keyup\"||e===\"keydown\")return js(Oo)}function ty(e,t){if(e===\"click\")return js(t)}function ny(e,t){if(e===\"input\"||e===\"change\")return js(t)}function ry(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}var $t=typeof Object.is==\"function\"?Object.is:ry;function jo(e,t){if($t(e,t))return!0;if(typeof e!=\"object\"||e===null||typeof t!=\"object\"||t===null)return!1;var o=Object.keys(e),l=Object.keys(t);if(o.length!==l.length)return!1;for(l=0;l<o.length;l++){var c=o[l];if(!h.call(t,c)||!$t(e[c],t[c]))return!1}return!0}function yd(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function xd(e,t){var o=yd(e);e=0;for(var l;o;){if(o.nodeType===3){if(l=e+o.textContent.length,e<=t&&l>=t)return{node:o,offset:t-e};e=l}e:{for(;o;){if(o.nextSibling){o=o.nextSibling;break e}o=o.parentNode}o=void 0}o=yd(o)}}function wd(e,t){return e&&t?e===t?!0:e&&e.nodeType===3?!1:t&&t.nodeType===3?wd(e,t.parentNode):\"contains\"in e?e.contains(t):e.compareDocumentPosition?!!(e.compareDocumentPosition(t)&16):!1:!1}function Sd(){for(var e=window,t=_e();t instanceof e.HTMLIFrameElement;){try{var o=typeof t.contentWindow.location.href==\"string\"}catch{o=!1}if(o)e=t.contentWindow;else break;t=_e(e.document)}return t}function Fl(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t&&(t===\"input\"&&(e.type===\"text\"||e.type===\"search\"||e.type===\"tel\"||e.type===\"url\"||e.type===\"password\")||t===\"textarea\"||e.contentEditable===\"true\")}function oy(e){var t=Sd(),o=e.focusedElem,l=e.selectionRange;if(t!==o&&o&&o.ownerDocument&&wd(o.ownerDocument.documentElement,o)){if(l!==null&&Fl(o)){if(t=l.start,e=l.end,e===void 0&&(e=t),\"selectionStart\"in o)o.selectionStart=t,o.selectionEnd=Math.min(e,o.value.length);else if(e=(t=o.ownerDocument||document)&&t.defaultView||window,e.getSelection){e=e.getSelection();var c=o.textContent.length,p=Math.min(l.start,c);l=l.end===void 0?p:Math.min(l.end,c),!e.extend&&p>l&&(c=l,l=p,p=c),c=xd(o,p);var y=xd(o,l);c&&y&&(e.rangeCount!==1||e.anchorNode!==c.node||e.anchorOffset!==c.offset||e.focusNode!==y.node||e.focusOffset!==y.offset)&&(t=t.createRange(),t.setStart(c.node,c.offset),e.removeAllRanges(),p>l?(e.addRange(t),e.extend(y.node,y.offset)):(t.setEnd(y.node,y.offset),e.addRange(t)))}}for(t=[],e=o;e=e.parentNode;)e.nodeType===1&&t.push({element:e,left:e.scrollLeft,top:e.scrollTop});for(typeof o.focus==\"function\"&&o.focus(),o=0;o<t.length;o++)e=t[o],e.element.scrollLeft=e.left,e.element.scrollTop=e.top}}var sy=f&&\"documentMode\"in document&&11>=document.documentMode,Ir=null,$l=null,_o=null,Vl=!1;function Cd(e,t,o){var l=o.window===o?o.document:o.nodeType===9?o:o.ownerDocument;Vl||Ir==null||Ir!==_e(l)||(l=Ir,\"selectionStart\"in l&&Fl(l)?l={start:l.selectionStart,end:l.selectionEnd}:(l=(l.ownerDocument&&l.ownerDocument.defaultView||window).getSelection(),l={anchorNode:l.anchorNode,anchorOffset:l.anchorOffset,focusNode:l.focusNode,focusOffset:l.focusOffset}),_o&&jo(_o,l)||(_o=l,l=Is($l,\"onSelect\"),0<l.length&&(t=new _l(\"onSelect\",\"select\",null,t,o),e.push({event:t,listeners:l}),t.target=Ir)))}function _s(e,t){var o={};return o[e.toLowerCase()]=t.toLowerCase(),o[\"Webkit\"+e]=\"webkit\"+t,o[\"Moz\"+e]=\"moz\"+t,o}var Ar={animationend:_s(\"Animation\",\"AnimationEnd\"),animationiteration:_s(\"Animation\",\"AnimationIteration\"),animationstart:_s(\"Animation\",\"AnimationStart\"),transitionend:_s(\"Transition\",\"TransitionEnd\")},Bl={},kd={};f&&(kd=document.createElement(\"div\").style,\"AnimationEvent\"in window||(delete Ar.animationend.animation,delete Ar.animationiteration.animation,delete Ar.animationstart.animation),\"TransitionEvent\"in window||delete Ar.transitionend.transition);function Ts(e){if(Bl[e])return Bl[e];if(!Ar[e])return e;var t=Ar[e],o;for(o in t)if(t.hasOwnProperty(o)&&o in kd)return Bl[e]=t[o];return e}var bd=Ts(\"animationend\"),Ed=Ts(\"animationiteration\"),Pd=Ts(\"animationstart\"),Nd=Ts(\"transitionend\"),Rd=new Map,Od=\"abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel\".split(\" \");function Tn(e,t){Rd.set(e,t),u(t,[e])}for(var Ul=0;Ul<Od.length;Ul++){var Hl=Od[Ul],iy=Hl.toLowerCase(),ly=Hl[0].toUpperCase()+Hl.slice(1);Tn(iy,\"on\"+ly)}Tn(bd,\"onAnimationEnd\"),Tn(Ed,\"onAnimationIteration\"),Tn(Pd,\"onAnimationStart\"),Tn(\"dblclick\",\"onDoubleClick\"),Tn(\"focusin\",\"onFocus\"),Tn(\"focusout\",\"onBlur\"),Tn(Nd,\"onTransitionEnd\"),d(\"onMouseEnter\",[\"mouseout\",\"mouseover\"]),d(\"onMouseLeave\",[\"mouseout\",\"mouseover\"]),d(\"onPointerEnter\",[\"pointerout\",\"pointerover\"]),d(\"onPointerLeave\",[\"pointerout\",\"pointerover\"]),u(\"onChange\",\"change click focusin focusout input keydown keyup selectionchange\".split(\" \")),u(\"onSelect\",\"focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange\".split(\" \")),u(\"onBeforeInput\",[\"compositionend\",\"keypress\",\"textInput\",\"paste\"]),u(\"onCompositionEnd\",\"compositionend focusout keydown keypress keyup mousedown\".split(\" \")),u(\"onCompositionStart\",\"compositionstart focusout keydown keypress keyup mousedown\".split(\" \")),u(\"onCompositionUpdate\",\"compositionupdate focusout keydown keypress keyup mousedown\".split(\" \"));var To=\"abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting\".split(\" \"),ay=new Set(\"cancel close invalid load scroll toggle\".split(\" \").concat(To));function jd(e,t,o){var l=e.type||\"unknown-event\";e.currentTarget=o,iv(l,t,void 0,e),e.currentTarget=null}function _d(e,t){t=(t&4)!==0;for(var o=0;o<e.length;o++){var l=e[o],c=l.event;l=l.listeners;e:{var p=void 0;if(t)for(var y=l.length-1;0<=y;y--){var P=l[y],R=P.instance,F=P.currentTarget;if(P=P.listener,R!==p&&c.isPropagationStopped())break e;jd(c,P,F),p=R}else for(y=0;y<l.length;y++){if(P=l[y],R=P.instance,F=P.currentTarget,P=P.listener,R!==p&&c.isPropagationStopped())break e;jd(c,P,F),p=R}}}if(gs)throw e=Sl,gs=!1,Sl=null,e}function Ie(e,t){var o=t[ql];o===void 0&&(o=t[ql]=new Set);var l=e+\"__bubble\";o.has(l)||(Td(t,e,2,!1),o.add(l))}function Wl(e,t,o){var l=0;t&&(l|=4),Td(o,e,l,t)}var Ls=\"_reactListening\"+Math.random().toString(36).slice(2);function Lo(e){if(!e[Ls]){e[Ls]=!0,i.forEach(function(o){o!==\"selectionchange\"&&(ay.has(o)||Wl(o,!1,e),Wl(o,!0,e))});var t=e.nodeType===9?e:e.ownerDocument;t===null||t[Ls]||(t[Ls]=!0,Wl(\"selectionchange\",!1,t))}}function Td(e,t,o,l){switch(td(t)){case 1:var c=Cv;break;case 4:c=kv;break;default:c=Rl}o=c.bind(null,t,o,e),c=void 0,!wl||t!==\"touchstart\"&&t!==\"touchmove\"&&t!==\"wheel\"||(c=!0),l?c!==void 0?e.addEventListener(t,o,{capture:!0,passive:c}):e.addEventListener(t,o,!0):c!==void 0?e.addEventListener(t,o,{passive:c}):e.addEventListener(t,o,!1)}function Kl(e,t,o,l,c){var p=l;if((t&1)===0&&(t&2)===0&&l!==null)e:for(;;){if(l===null)return;var y=l.tag;if(y===3||y===4){var P=l.stateNode.containerInfo;if(P===c||P.nodeType===8&&P.parentNode===c)break;if(y===4)for(y=l.return;y!==null;){var R=y.tag;if((R===3||R===4)&&(R=y.stateNode.containerInfo,R===c||R.nodeType===8&&R.parentNode===c))return;y=y.return}for(;P!==null;){if(y=nr(P),y===null)return;if(R=y.tag,R===5||R===6){l=p=y;continue e}P=P.parentNode}}l=l.return}Mc(function(){var F=p,G=vl(o),Y=[];e:{var K=Rd.get(e);if(K!==void 0){var ie=_l,de=e;switch(e){case\"keypress\":if(Ns(o)===0)break e;case\"keydown\":case\"keyup\":ie=zv;break;case\"focusin\":de=\"focus\",ie=Il;break;case\"focusout\":de=\"blur\",ie=Il;break;case\"beforeblur\":case\"afterblur\":ie=Il;break;case\"click\":if(o.button===2)break e;case\"auxclick\":case\"dblclick\":case\"mousedown\":case\"mousemove\":case\"mouseup\":case\"mouseout\":case\"mouseover\":case\"contextmenu\":ie=od;break;case\"drag\":case\"dragend\":case\"dragenter\":case\"dragexit\":case\"dragleave\":case\"dragover\":case\"dragstart\":case\"drop\":ie=Pv;break;case\"touchcancel\":case\"touchend\":case\"touchmove\":case\"touchstart\":ie=Vv;break;case bd:case Ed:case Pd:ie=Ov;break;case Nd:ie=Uv;break;case\"scroll\":ie=bv;break;case\"wheel\":ie=Wv;break;case\"copy\":case\"cut\":case\"paste\":ie=_v;break;case\"gotpointercapture\":case\"lostpointercapture\":case\"pointercancel\":case\"pointerdown\":case\"pointermove\":case\"pointerout\":case\"pointerover\":case\"pointerup\":ie=id}var he=(t&4)!==0,Ke=!he&&e===\"scroll\",A=he?K!==null?K+\"Capture\":null:K;he=[];for(var j=F,z;j!==null;){z=j;var te=z.stateNode;if(z.tag===5&&te!==null&&(z=te,A!==null&&(te=mo(j,A),te!=null&&he.push(Io(j,te,z)))),Ke)break;j=j.return}0<he.length&&(K=new ie(K,de,null,o,G),Y.push({event:K,listeners:he}))}}if((t&7)===0){e:{if(K=e===\"mouseover\"||e===\"pointerover\",ie=e===\"mouseout\"||e===\"pointerout\",K&&o!==gl&&(de=o.relatedTarget||o.fromElement)&&(nr(de)||de[un]))break e;if((ie||K)&&(K=G.window===G?G:(K=G.ownerDocument)?K.defaultView||K.parentWindow:window,ie?(de=o.relatedTarget||o.toElement,ie=F,de=de?nr(de):null,de!==null&&(Ke=tr(de),de!==Ke||de.tag!==5&&de.tag!==6)&&(de=null)):(ie=null,de=F),ie!==de)){if(he=od,te=\"onMouseLeave\",A=\"onMouseEnter\",j=\"mouse\",(e===\"pointerout\"||e===\"pointerover\")&&(he=id,te=\"onPointerLeave\",A=\"onPointerEnter\",j=\"pointer\"),Ke=ie==null?K:zr(ie),z=de==null?K:zr(de),K=new he(te,j+\"leave\",ie,o,G),K.target=Ke,K.relatedTarget=z,te=null,nr(G)===F&&(he=new he(A,j+\"enter\",de,o,G),he.target=z,he.relatedTarget=Ke,te=he),Ke=te,ie&&de)t:{for(he=ie,A=de,j=0,z=he;z;z=Dr(z))j++;for(z=0,te=A;te;te=Dr(te))z++;for(;0<j-z;)he=Dr(he),j--;for(;0<z-j;)A=Dr(A),z--;for(;j--;){if(he===A||A!==null&&he===A.alternate)break t;he=Dr(he),A=Dr(A)}he=null}else he=null;ie!==null&&Ld(Y,K,ie,he,!1),de!==null&&Ke!==null&&Ld(Y,Ke,de,he,!0)}}e:{if(K=F?zr(F):window,ie=K.nodeName&&K.nodeName.toLowerCase(),ie===\"select\"||ie===\"input\"&&K.type===\"file\")var me=qv;else if(fd(K))if(hd)me=ny;else{me=ey;var ve=Jv}else(ie=K.nodeName)&&ie.toLowerCase()===\"input\"&&(K.type===\"checkbox\"||K.type===\"radio\")&&(me=ty);if(me&&(me=me(e,F))){pd(Y,me,o,G);break e}ve&&ve(e,K,F),e===\"focusout\"&&(ve=K._wrapperState)&&ve.controlled&&K.type===\"number\"&&dl(K,\"number\",K.value)}switch(ve=F?zr(F):window,e){case\"focusin\":(fd(ve)||ve.contentEditable===\"true\")&&(Ir=ve,$l=F,_o=null);break;case\"focusout\":_o=$l=Ir=null;break;case\"mousedown\":Vl=!0;break;case\"contextmenu\":case\"mouseup\":case\"dragend\":Vl=!1,Cd(Y,o,G);break;case\"selectionchange\":if(sy)break;case\"keydown\":case\"keyup\":Cd(Y,o,G)}var ye;if(Dl)e:{switch(e){case\"compositionstart\":var xe=\"onCompositionStart\";break e;case\"compositionend\":xe=\"onCompositionEnd\";break e;case\"compositionupdate\":xe=\"onCompositionUpdate\";break e}xe=void 0}else Lr?cd(e,o)&&(xe=\"onCompositionEnd\"):e===\"keydown\"&&o.keyCode===229&&(xe=\"onCompositionStart\");xe&&(ld&&o.locale!==\"ko\"&&(Lr||xe!==\"onCompositionStart\"?xe===\"onCompositionEnd\"&&Lr&&(ye=nd()):(_n=G,jl=\"value\"in _n?_n.value:_n.textContent,Lr=!0)),ve=Is(F,xe),0<ve.length&&(xe=new sd(xe,e,null,o,G),Y.push({event:xe,listeners:ve}),ye?xe.data=ye:(ye=dd(o),ye!==null&&(xe.data=ye)))),(ye=Gv?Qv(e,o):Yv(e,o))&&(F=Is(F,\"onBeforeInput\"),0<F.length&&(G=new sd(\"onBeforeInput\",\"beforeinput\",null,o,G),Y.push({event:G,listeners:F}),G.data=ye))}_d(Y,t)})}function Io(e,t,o){return{instance:e,listener:t,currentTarget:o}}function Is(e,t){for(var o=t+\"Capture\",l=[];e!==null;){var c=e,p=c.stateNode;c.tag===5&&p!==null&&(c=p,p=mo(e,o),p!=null&&l.unshift(Io(e,p,c)),p=mo(e,t),p!=null&&l.push(Io(e,p,c))),e=e.return}return l}function Dr(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5);return e||null}function Ld(e,t,o,l,c){for(var p=t._reactName,y=[];o!==null&&o!==l;){var P=o,R=P.alternate,F=P.stateNode;if(R!==null&&R===l)break;P.tag===5&&F!==null&&(P=F,c?(R=mo(o,p),R!=null&&y.unshift(Io(o,R,P))):c||(R=mo(o,p),R!=null&&y.push(Io(o,R,P)))),o=o.return}y.length!==0&&e.push({event:t,listeners:y})}var uy=/\\r\\n?/g,cy=/\\u0000|\\uFFFD/g;function Id(e){return(typeof e==\"string\"?e:\"\"+e).replace(uy,`\n`).replace(cy,\"\")}function As(e,t,o){if(t=Id(t),Id(e)!==t&&o)throw Error(s(425))}function Ds(){}var Gl=null,Ql=null;function Yl(e,t){return e===\"textarea\"||e===\"noscript\"||typeof t.children==\"string\"||typeof t.children==\"number\"||typeof t.dangerouslySetInnerHTML==\"object\"&&t.dangerouslySetInnerHTML!==null&&t.dangerouslySetInnerHTML.__html!=null}var Xl=typeof setTimeout==\"function\"?setTimeout:void 0,dy=typeof clearTimeout==\"function\"?clearTimeout:void 0,Ad=typeof Promise==\"function\"?Promise:void 0,fy=typeof queueMicrotask==\"function\"?queueMicrotask:typeof Ad<\"u\"?function(e){return Ad.resolve(null).then(e).catch(py)}:Xl;function py(e){setTimeout(function(){throw e})}function Zl(e,t){var o=t,l=0;do{var c=o.nextSibling;if(e.removeChild(o),c&&c.nodeType===8)if(o=c.data,o===\"/$\"){if(l===0){e.removeChild(c),bo(t);return}l--}else o!==\"$\"&&o!==\"$?\"&&o!==\"$!\"||l++;o=c}while(o);bo(t)}function Ln(e){for(;e!=null;e=e.nextSibling){var t=e.nodeType;if(t===1||t===3)break;if(t===8){if(t=e.data,t===\"$\"||t===\"$!\"||t===\"$?\")break;if(t===\"/$\")return null}}return e}function Dd(e){e=e.previousSibling;for(var t=0;e;){if(e.nodeType===8){var o=e.data;if(o===\"$\"||o===\"$!\"||o===\"$?\"){if(t===0)return e;t--}else o===\"/$\"&&t++}e=e.previousSibling}return null}var Mr=Math.random().toString(36).slice(2),Zt=\"__reactFiber$\"+Mr,Ao=\"__reactProps$\"+Mr,un=\"__reactContainer$\"+Mr,ql=\"__reactEvents$\"+Mr,hy=\"__reactListeners$\"+Mr,my=\"__reactHandles$\"+Mr;function nr(e){var t=e[Zt];if(t)return t;for(var o=e.parentNode;o;){if(t=o[un]||o[Zt]){if(o=t.alternate,t.child!==null||o!==null&&o.child!==null)for(e=Dd(e);e!==null;){if(o=e[Zt])return o;e=Dd(e)}return t}e=o,o=e.parentNode}return null}function Do(e){return e=e[Zt]||e[un],!e||e.tag!==5&&e.tag!==6&&e.tag!==13&&e.tag!==3?null:e}function zr(e){if(e.tag===5||e.tag===6)return e.stateNode;throw Error(s(33))}function Ms(e){return e[Ao]||null}var Jl=[],Fr=-1;function In(e){return{current:e}}function Ae(e){0>Fr||(e.current=Jl[Fr],Jl[Fr]=null,Fr--)}function Le(e,t){Fr++,Jl[Fr]=e.current,e.current=t}var An={},at=In(An),yt=In(!1),rr=An;function $r(e,t){var o=e.type.contextTypes;if(!o)return An;var l=e.stateNode;if(l&&l.__reactInternalMemoizedUnmaskedChildContext===t)return l.__reactInternalMemoizedMaskedChildContext;var c={},p;for(p in o)c[p]=t[p];return l&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=t,e.__reactInternalMemoizedMaskedChildContext=c),c}function xt(e){return e=e.childContextTypes,e!=null}function zs(){Ae(yt),Ae(at)}function Md(e,t,o){if(at.current!==An)throw Error(s(168));Le(at,t),Le(yt,o)}function zd(e,t,o){var l=e.stateNode;if(t=t.childContextTypes,typeof l.getChildContext!=\"function\")return o;l=l.getChildContext();for(var c in l)if(!(c in t))throw Error(s(108,Se(e)||\"Unknown\",c));return M({},o,l)}function Fs(e){return e=(e=e.stateNode)&&e.__reactInternalMemoizedMergedChildContext||An,rr=at.current,Le(at,e),Le(yt,yt.current),!0}function Fd(e,t,o){var l=e.stateNode;if(!l)throw Error(s(169));o?(e=zd(e,t,rr),l.__reactInternalMemoizedMergedChildContext=e,Ae(yt),Ae(at),Le(at,e)):Ae(yt),Le(yt,o)}var cn=null,$s=!1,ea=!1;function $d(e){cn===null?cn=[e]:cn.push(e)}function gy(e){$s=!0,$d(e)}function Dn(){if(!ea&&cn!==null){ea=!0;var e=0,t=Te;try{var o=cn;for(Te=1;e<o.length;e++){var l=o[e];do l=l(!0);while(l!==null)}cn=null,$s=!1}catch(c){throw cn!==null&&(cn=cn.slice(e+1)),Bc(Cl,Dn),c}finally{Te=t,ea=!1}}return null}var Vr=[],Br=0,Vs=null,Bs=0,_t=[],Tt=0,or=null,dn=1,fn=\"\";function sr(e,t){Vr[Br++]=Bs,Vr[Br++]=Vs,Vs=e,Bs=t}function Vd(e,t,o){_t[Tt++]=dn,_t[Tt++]=fn,_t[Tt++]=or,or=e;var l=dn;e=fn;var c=32-Ft(l)-1;l&=~(1<<c),o+=1;var p=32-Ft(t)+c;if(30<p){var y=c-c%5;p=(l&(1<<y)-1).toString(32),l>>=y,c-=y,dn=1<<32-Ft(t)+c|o<<c|l,fn=p+e}else dn=1<<p|o<<c|l,fn=e}function ta(e){e.return!==null&&(sr(e,1),Vd(e,1,0))}function na(e){for(;e===Vs;)Vs=Vr[--Br],Vr[Br]=null,Bs=Vr[--Br],Vr[Br]=null;for(;e===or;)or=_t[--Tt],_t[Tt]=null,fn=_t[--Tt],_t[Tt]=null,dn=_t[--Tt],_t[Tt]=null}var Pt=null,Nt=null,Me=!1,Vt=null;function Bd(e,t){var o=Dt(5,null,null,0);o.elementType=\"DELETED\",o.stateNode=t,o.return=e,t=e.deletions,t===null?(e.deletions=[o],e.flags|=16):t.push(o)}function Ud(e,t){switch(e.tag){case 5:var o=e.type;return t=t.nodeType!==1||o.toLowerCase()!==t.nodeName.toLowerCase()?null:t,t!==null?(e.stateNode=t,Pt=e,Nt=Ln(t.firstChild),!0):!1;case 6:return t=e.pendingProps===\"\"||t.nodeType!==3?null:t,t!==null?(e.stateNode=t,Pt=e,Nt=null,!0):!1;case 13:return t=t.nodeType!==8?null:t,t!==null?(o=or!==null?{id:dn,overflow:fn}:null,e.memoizedState={dehydrated:t,treeContext:o,retryLane:1073741824},o=Dt(18,null,null,0),o.stateNode=t,o.return=e,e.child=o,Pt=e,Nt=null,!0):!1;default:return!1}}function ra(e){return(e.mode&1)!==0&&(e.flags&128)===0}function oa(e){if(Me){var t=Nt;if(t){var o=t;if(!Ud(e,t)){if(ra(e))throw Error(s(418));t=Ln(o.nextSibling);var l=Pt;t&&Ud(e,t)?Bd(l,o):(e.flags=e.flags&-4097|2,Me=!1,Pt=e)}}else{if(ra(e))throw Error(s(418));e.flags=e.flags&-4097|2,Me=!1,Pt=e}}}function Hd(e){for(e=e.return;e!==null&&e.tag!==5&&e.tag!==3&&e.tag!==13;)e=e.return;Pt=e}function Us(e){if(e!==Pt)return!1;if(!Me)return Hd(e),Me=!0,!1;var t;if((t=e.tag!==3)&&!(t=e.tag!==5)&&(t=e.type,t=t!==\"head\"&&t!==\"body\"&&!Yl(e.type,e.memoizedProps)),t&&(t=Nt)){if(ra(e))throw Wd(),Error(s(418));for(;t;)Bd(e,t),t=Ln(t.nextSibling)}if(Hd(e),e.tag===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(s(317));e:{for(e=e.nextSibling,t=0;e;){if(e.nodeType===8){var o=e.data;if(o===\"/$\"){if(t===0){Nt=Ln(e.nextSibling);break e}t--}else o!==\"$\"&&o!==\"$!\"&&o!==\"$?\"||t++}e=e.nextSibling}Nt=null}}else Nt=Pt?Ln(e.stateNode.nextSibling):null;return!0}function Wd(){for(var e=Nt;e;)e=Ln(e.nextSibling)}function Ur(){Nt=Pt=null,Me=!1}function sa(e){Vt===null?Vt=[e]:Vt.push(e)}var vy=O.ReactCurrentBatchConfig;function Mo(e,t,o){if(e=o.ref,e!==null&&typeof e!=\"function\"&&typeof e!=\"object\"){if(o._owner){if(o=o._owner,o){if(o.tag!==1)throw Error(s(309));var l=o.stateNode}if(!l)throw Error(s(147,e));var c=l,p=\"\"+e;return t!==null&&t.ref!==null&&typeof t.ref==\"function\"&&t.ref._stringRef===p?t.ref:(t=function(y){var P=c.refs;y===null?delete P[p]:P[p]=y},t._stringRef=p,t)}if(typeof e!=\"string\")throw Error(s(284));if(!o._owner)throw Error(s(290,e))}return e}function Hs(e,t){throw e=Object.prototype.toString.call(t),Error(s(31,e===\"[object Object]\"?\"object with keys {\"+Object.keys(t).join(\", \")+\"}\":e))}function Kd(e){var t=e._init;return t(e._payload)}function Gd(e){function t(A,j){if(e){var z=A.deletions;z===null?(A.deletions=[j],A.flags|=16):z.push(j)}}function o(A,j){if(!e)return null;for(;j!==null;)t(A,j),j=j.sibling;return null}function l(A,j){for(A=new Map;j!==null;)j.key!==null?A.set(j.key,j):A.set(j.index,j),j=j.sibling;return A}function c(A,j){return A=Hn(A,j),A.index=0,A.sibling=null,A}function p(A,j,z){return A.index=z,e?(z=A.alternate,z!==null?(z=z.index,z<j?(A.flags|=2,j):z):(A.flags|=2,j)):(A.flags|=1048576,j)}function y(A){return e&&A.alternate===null&&(A.flags|=2),A}function P(A,j,z,te){return j===null||j.tag!==6?(j=Xa(z,A.mode,te),j.return=A,j):(j=c(j,z),j.return=A,j)}function R(A,j,z,te){var me=z.type;return me===H?G(A,j,z.props.children,te,z.key):j!==null&&(j.elementType===me||typeof me==\"object\"&&me!==null&&me.$$typeof===J&&Kd(me)===j.type)?(te=c(j,z.props),te.ref=Mo(A,j,z),te.return=A,te):(te=hi(z.type,z.key,z.props,null,A.mode,te),te.ref=Mo(A,j,z),te.return=A,te)}function F(A,j,z,te){return j===null||j.tag!==4||j.stateNode.containerInfo!==z.containerInfo||j.stateNode.implementation!==z.implementation?(j=Za(z,A.mode,te),j.return=A,j):(j=c(j,z.children||[]),j.return=A,j)}function G(A,j,z,te,me){return j===null||j.tag!==7?(j=pr(z,A.mode,te,me),j.return=A,j):(j=c(j,z),j.return=A,j)}function Y(A,j,z){if(typeof j==\"string\"&&j!==\"\"||typeof j==\"number\")return j=Xa(\"\"+j,A.mode,z),j.return=A,j;if(typeof j==\"object\"&&j!==null){switch(j.$$typeof){case B:return z=hi(j.type,j.key,j.props,null,A.mode,z),z.ref=Mo(A,null,j),z.return=A,z;case V:return j=Za(j,A.mode,z),j.return=A,j;case J:var te=j._init;return Y(A,te(j._payload),z)}if(fo(j)||U(j))return j=pr(j,A.mode,z,null),j.return=A,j;Hs(A,j)}return null}function K(A,j,z,te){var me=j!==null?j.key:null;if(typeof z==\"string\"&&z!==\"\"||typeof z==\"number\")return me!==null?null:P(A,j,\"\"+z,te);if(typeof z==\"object\"&&z!==null){switch(z.$$typeof){case B:return z.key===me?R(A,j,z,te):null;case V:return z.key===me?F(A,j,z,te):null;case J:return me=z._init,K(A,j,me(z._payload),te)}if(fo(z)||U(z))return me!==null?null:G(A,j,z,te,null);Hs(A,z)}return null}function ie(A,j,z,te,me){if(typeof te==\"string\"&&te!==\"\"||typeof te==\"number\")return A=A.get(z)||null,P(j,A,\"\"+te,me);if(typeof te==\"object\"&&te!==null){switch(te.$$typeof){case B:return A=A.get(te.key===null?z:te.key)||null,R(j,A,te,me);case V:return A=A.get(te.key===null?z:te.key)||null,F(j,A,te,me);case J:var ve=te._init;return ie(A,j,z,ve(te._payload),me)}if(fo(te)||U(te))return A=A.get(z)||null,G(j,A,te,me,null);Hs(j,te)}return null}function de(A,j,z,te){for(var me=null,ve=null,ye=j,xe=j=0,nt=null;ye!==null&&xe<z.length;xe++){ye.index>xe?(nt=ye,ye=null):nt=ye.sibling;var Oe=K(A,ye,z[xe],te);if(Oe===null){ye===null&&(ye=nt);break}e&&ye&&Oe.alternate===null&&t(A,ye),j=p(Oe,j,xe),ve===null?me=Oe:ve.sibling=Oe,ve=Oe,ye=nt}if(xe===z.length)return o(A,ye),Me&&sr(A,xe),me;if(ye===null){for(;xe<z.length;xe++)ye=Y(A,z[xe],te),ye!==null&&(j=p(ye,j,xe),ve===null?me=ye:ve.sibling=ye,ve=ye);return Me&&sr(A,xe),me}for(ye=l(A,ye);xe<z.length;xe++)nt=ie(ye,A,xe,z[xe],te),nt!==null&&(e&&nt.alternate!==null&&ye.delete(nt.key===null?xe:nt.key),j=p(nt,j,xe),ve===null?me=nt:ve.sibling=nt,ve=nt);return e&&ye.forEach(function(Wn){return t(A,Wn)}),Me&&sr(A,xe),me}function he(A,j,z,te){var me=U(z);if(typeof me!=\"function\")throw Error(s(150));if(z=me.call(z),z==null)throw Error(s(151));for(var ve=me=null,ye=j,xe=j=0,nt=null,Oe=z.next();ye!==null&&!Oe.done;xe++,Oe=z.next()){ye.index>xe?(nt=ye,ye=null):nt=ye.sibling;var Wn=K(A,ye,Oe.value,te);if(Wn===null){ye===null&&(ye=nt);break}e&&ye&&Wn.alternate===null&&t(A,ye),j=p(Wn,j,xe),ve===null?me=Wn:ve.sibling=Wn,ve=Wn,ye=nt}if(Oe.done)return o(A,ye),Me&&sr(A,xe),me;if(ye===null){for(;!Oe.done;xe++,Oe=z.next())Oe=Y(A,Oe.value,te),Oe!==null&&(j=p(Oe,j,xe),ve===null?me=Oe:ve.sibling=Oe,ve=Oe);return Me&&sr(A,xe),me}for(ye=l(A,ye);!Oe.done;xe++,Oe=z.next())Oe=ie(ye,A,xe,Oe.value,te),Oe!==null&&(e&&Oe.alternate!==null&&ye.delete(Oe.key===null?xe:Oe.key),j=p(Oe,j,xe),ve===null?me=Oe:ve.sibling=Oe,ve=Oe);return e&&ye.forEach(function(Xy){return t(A,Xy)}),Me&&sr(A,xe),me}function Ke(A,j,z,te){if(typeof z==\"object\"&&z!==null&&z.type===H&&z.key===null&&(z=z.props.children),typeof z==\"object\"&&z!==null){switch(z.$$typeof){case B:e:{for(var me=z.key,ve=j;ve!==null;){if(ve.key===me){if(me=z.type,me===H){if(ve.tag===7){o(A,ve.sibling),j=c(ve,z.props.children),j.return=A,A=j;break e}}else if(ve.elementType===me||typeof me==\"object\"&&me!==null&&me.$$typeof===J&&Kd(me)===ve.type){o(A,ve.sibling),j=c(ve,z.props),j.ref=Mo(A,ve,z),j.return=A,A=j;break e}o(A,ve);break}else t(A,ve);ve=ve.sibling}z.type===H?(j=pr(z.props.children,A.mode,te,z.key),j.return=A,A=j):(te=hi(z.type,z.key,z.props,null,A.mode,te),te.ref=Mo(A,j,z),te.return=A,A=te)}return y(A);case V:e:{for(ve=z.key;j!==null;){if(j.key===ve)if(j.tag===4&&j.stateNode.containerInfo===z.containerInfo&&j.stateNode.implementation===z.implementation){o(A,j.sibling),j=c(j,z.children||[]),j.return=A,A=j;break e}else{o(A,j);break}else t(A,j);j=j.sibling}j=Za(z,A.mode,te),j.return=A,A=j}return y(A);case J:return ve=z._init,Ke(A,j,ve(z._payload),te)}if(fo(z))return de(A,j,z,te);if(U(z))return he(A,j,z,te);Hs(A,z)}return typeof z==\"string\"&&z!==\"\"||typeof z==\"number\"?(z=\"\"+z,j!==null&&j.tag===6?(o(A,j.sibling),j=c(j,z),j.return=A,A=j):(o(A,j),j=Xa(z,A.mode,te),j.return=A,A=j),y(A)):o(A,j)}return Ke}var Hr=Gd(!0),Qd=Gd(!1),Ws=In(null),Ks=null,Wr=null,ia=null;function la(){ia=Wr=Ks=null}function aa(e){var t=Ws.current;Ae(Ws),e._currentValue=t}function ua(e,t,o){for(;e!==null;){var l=e.alternate;if((e.childLanes&t)!==t?(e.childLanes|=t,l!==null&&(l.childLanes|=t)):l!==null&&(l.childLanes&t)!==t&&(l.childLanes|=t),e===o)break;e=e.return}}function Kr(e,t){Ks=e,ia=Wr=null,e=e.dependencies,e!==null&&e.firstContext!==null&&((e.lanes&t)!==0&&(wt=!0),e.firstContext=null)}function Lt(e){var t=e._currentValue;if(ia!==e)if(e={context:e,memoizedValue:t,next:null},Wr===null){if(Ks===null)throw Error(s(308));Wr=e,Ks.dependencies={lanes:0,firstContext:e}}else Wr=Wr.next=e;return t}var ir=null;function ca(e){ir===null?ir=[e]:ir.push(e)}function Yd(e,t,o,l){var c=t.interleaved;return c===null?(o.next=o,ca(t)):(o.next=c.next,c.next=o),t.interleaved=o,pn(e,l)}function pn(e,t){e.lanes|=t;var o=e.alternate;for(o!==null&&(o.lanes|=t),o=e,e=e.return;e!==null;)e.childLanes|=t,o=e.alternate,o!==null&&(o.childLanes|=t),o=e,e=e.return;return o.tag===3?o.stateNode:null}var Mn=!1;function da(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}function Xd(e,t){e=e.updateQueue,t.updateQueue===e&&(t.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,effects:e.effects})}function hn(e,t){return{eventTime:e,lane:t,tag:0,payload:null,callback:null,next:null}}function zn(e,t,o){var l=e.updateQueue;if(l===null)return null;if(l=l.shared,(Ne&2)!==0){var c=l.pending;return c===null?t.next=t:(t.next=c.next,c.next=t),l.pending=t,pn(e,o)}return c=l.interleaved,c===null?(t.next=t,ca(l)):(t.next=c.next,c.next=t),l.interleaved=t,pn(e,o)}function Gs(e,t,o){if(t=t.updateQueue,t!==null&&(t=t.shared,(o&4194240)!==0)){var l=t.lanes;l&=e.pendingLanes,o|=l,t.lanes=o,El(e,o)}}function Zd(e,t){var o=e.updateQueue,l=e.alternate;if(l!==null&&(l=l.updateQueue,o===l)){var c=null,p=null;if(o=o.firstBaseUpdate,o!==null){do{var y={eventTime:o.eventTime,lane:o.lane,tag:o.tag,payload:o.payload,callback:o.callback,next:null};p===null?c=p=y:p=p.next=y,o=o.next}while(o!==null);p===null?c=p=t:p=p.next=t}else c=p=t;o={baseState:l.baseState,firstBaseUpdate:c,lastBaseUpdate:p,shared:l.shared,effects:l.effects},e.updateQueue=o;return}e=o.lastBaseUpdate,e===null?o.firstBaseUpdate=t:e.next=t,o.lastBaseUpdate=t}function Qs(e,t,o,l){var c=e.updateQueue;Mn=!1;var p=c.firstBaseUpdate,y=c.lastBaseUpdate,P=c.shared.pending;if(P!==null){c.shared.pending=null;var R=P,F=R.next;R.next=null,y===null?p=F:y.next=F,y=R;var G=e.alternate;G!==null&&(G=G.updateQueue,P=G.lastBaseUpdate,P!==y&&(P===null?G.firstBaseUpdate=F:P.next=F,G.lastBaseUpdate=R))}if(p!==null){var Y=c.baseState;y=0,G=F=R=null,P=p;do{var K=P.lane,ie=P.eventTime;if((l&K)===K){G!==null&&(G=G.next={eventTime:ie,lane:0,tag:P.tag,payload:P.payload,callback:P.callback,next:null});e:{var de=e,he=P;switch(K=t,ie=o,he.tag){case 1:if(de=he.payload,typeof de==\"function\"){Y=de.call(ie,Y,K);break e}Y=de;break e;case 3:de.flags=de.flags&-65537|128;case 0:if(de=he.payload,K=typeof de==\"function\"?de.call(ie,Y,K):de,K==null)break e;Y=M({},Y,K);break e;case 2:Mn=!0}}P.callback!==null&&P.lane!==0&&(e.flags|=64,K=c.effects,K===null?c.effects=[P]:K.push(P))}else ie={eventTime:ie,lane:K,tag:P.tag,payload:P.payload,callback:P.callback,next:null},G===null?(F=G=ie,R=Y):G=G.next=ie,y|=K;if(P=P.next,P===null){if(P=c.shared.pending,P===null)break;K=P,P=K.next,K.next=null,c.lastBaseUpdate=K,c.shared.pending=null}}while(!0);if(G===null&&(R=Y),c.baseState=R,c.firstBaseUpdate=F,c.lastBaseUpdate=G,t=c.shared.interleaved,t!==null){c=t;do y|=c.lane,c=c.next;while(c!==t)}else p===null&&(c.shared.lanes=0);ur|=y,e.lanes=y,e.memoizedState=Y}}function qd(e,t,o){if(e=t.effects,t.effects=null,e!==null)for(t=0;t<e.length;t++){var l=e[t],c=l.callback;if(c!==null){if(l.callback=null,l=o,typeof c!=\"function\")throw Error(s(191,c));c.call(l)}}}var zo={},qt=In(zo),Fo=In(zo),$o=In(zo);function lr(e){if(e===zo)throw Error(s(174));return e}function fa(e,t){switch(Le($o,t),Le(Fo,e),Le(qt,zo),e=t.nodeType,e){case 9:case 11:t=(t=t.documentElement)?t.namespaceURI:pl(null,\"\");break;default:e=e===8?t.parentNode:t,t=e.namespaceURI||null,e=e.tagName,t=pl(t,e)}Ae(qt),Le(qt,t)}function Gr(){Ae(qt),Ae(Fo),Ae($o)}function Jd(e){lr($o.current);var t=lr(qt.current),o=pl(t,e.type);t!==o&&(Le(Fo,e),Le(qt,o))}function pa(e){Fo.current===e&&(Ae(qt),Ae(Fo))}var ze=In(0);function Ys(e){for(var t=e;t!==null;){if(t.tag===13){var o=t.memoizedState;if(o!==null&&(o=o.dehydrated,o===null||o.data===\"$?\"||o.data===\"$!\"))return t}else if(t.tag===19&&t.memoizedProps.revealOrder!==void 0){if((t.flags&128)!==0)return t}else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return null;t=t.return}t.sibling.return=t.return,t=t.sibling}return null}var ha=[];function ma(){for(var e=0;e<ha.length;e++)ha[e]._workInProgressVersionPrimary=null;ha.length=0}var Xs=O.ReactCurrentDispatcher,ga=O.ReactCurrentBatchConfig,ar=0,Fe=null,Xe=null,et=null,Zs=!1,Vo=!1,Bo=0,yy=0;function ut(){throw Error(s(321))}function va(e,t){if(t===null)return!1;for(var o=0;o<t.length&&o<e.length;o++)if(!$t(e[o],t[o]))return!1;return!0}function ya(e,t,o,l,c,p){if(ar=p,Fe=t,t.memoizedState=null,t.updateQueue=null,t.lanes=0,Xs.current=e===null||e.memoizedState===null?Cy:ky,e=o(l,c),Vo){p=0;do{if(Vo=!1,Bo=0,25<=p)throw Error(s(301));p+=1,et=Xe=null,t.updateQueue=null,Xs.current=by,e=o(l,c)}while(Vo)}if(Xs.current=ei,t=Xe!==null&&Xe.next!==null,ar=0,et=Xe=Fe=null,Zs=!1,t)throw Error(s(300));return e}function xa(){var e=Bo!==0;return Bo=0,e}function Jt(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return et===null?Fe.memoizedState=et=e:et=et.next=e,et}function It(){if(Xe===null){var e=Fe.alternate;e=e!==null?e.memoizedState:null}else e=Xe.next;var t=et===null?Fe.memoizedState:et.next;if(t!==null)et=t,Xe=e;else{if(e===null)throw Error(s(310));Xe=e,e={memoizedState:Xe.memoizedState,baseState:Xe.baseState,baseQueue:Xe.baseQueue,queue:Xe.queue,next:null},et===null?Fe.memoizedState=et=e:et=et.next=e}return et}function Uo(e,t){return typeof t==\"function\"?t(e):t}function wa(e){var t=It(),o=t.queue;if(o===null)throw Error(s(311));o.lastRenderedReducer=e;var l=Xe,c=l.baseQueue,p=o.pending;if(p!==null){if(c!==null){var y=c.next;c.next=p.next,p.next=y}l.baseQueue=c=p,o.pending=null}if(c!==null){p=c.next,l=l.baseState;var P=y=null,R=null,F=p;do{var G=F.lane;if((ar&G)===G)R!==null&&(R=R.next={lane:0,action:F.action,hasEagerState:F.hasEagerState,eagerState:F.eagerState,next:null}),l=F.hasEagerState?F.eagerState:e(l,F.action);else{var Y={lane:G,action:F.action,hasEagerState:F.hasEagerState,eagerState:F.eagerState,next:null};R===null?(P=R=Y,y=l):R=R.next=Y,Fe.lanes|=G,ur|=G}F=F.next}while(F!==null&&F!==p);R===null?y=l:R.next=P,$t(l,t.memoizedState)||(wt=!0),t.memoizedState=l,t.baseState=y,t.baseQueue=R,o.lastRenderedState=l}if(e=o.interleaved,e!==null){c=e;do p=c.lane,Fe.lanes|=p,ur|=p,c=c.next;while(c!==e)}else c===null&&(o.lanes=0);return[t.memoizedState,o.dispatch]}function Sa(e){var t=It(),o=t.queue;if(o===null)throw Error(s(311));o.lastRenderedReducer=e;var l=o.dispatch,c=o.pending,p=t.memoizedState;if(c!==null){o.pending=null;var y=c=c.next;do p=e(p,y.action),y=y.next;while(y!==c);$t(p,t.memoizedState)||(wt=!0),t.memoizedState=p,t.baseQueue===null&&(t.baseState=p),o.lastRenderedState=p}return[p,l]}function ef(){}function tf(e,t){var o=Fe,l=It(),c=t(),p=!$t(l.memoizedState,c);if(p&&(l.memoizedState=c,wt=!0),l=l.queue,Ca(of.bind(null,o,l,e),[e]),l.getSnapshot!==t||p||et!==null&&et.memoizedState.tag&1){if(o.flags|=2048,Ho(9,rf.bind(null,o,l,c,t),void 0,null),tt===null)throw Error(s(349));(ar&30)!==0||nf(o,t,c)}return c}function nf(e,t,o){e.flags|=16384,e={getSnapshot:t,value:o},t=Fe.updateQueue,t===null?(t={lastEffect:null,stores:null},Fe.updateQueue=t,t.stores=[e]):(o=t.stores,o===null?t.stores=[e]:o.push(e))}function rf(e,t,o,l){t.value=o,t.getSnapshot=l,sf(t)&&lf(e)}function of(e,t,o){return o(function(){sf(t)&&lf(e)})}function sf(e){var t=e.getSnapshot;e=e.value;try{var o=t();return!$t(e,o)}catch{return!0}}function lf(e){var t=pn(e,1);t!==null&&Wt(t,e,1,-1)}function af(e){var t=Jt();return typeof e==\"function\"&&(e=e()),t.memoizedState=t.baseState=e,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:Uo,lastRenderedState:e},t.queue=e,e=e.dispatch=Sy.bind(null,Fe,e),[t.memoizedState,e]}function Ho(e,t,o,l){return e={tag:e,create:t,destroy:o,deps:l,next:null},t=Fe.updateQueue,t===null?(t={lastEffect:null,stores:null},Fe.updateQueue=t,t.lastEffect=e.next=e):(o=t.lastEffect,o===null?t.lastEffect=e.next=e:(l=o.next,o.next=e,e.next=l,t.lastEffect=e)),e}function uf(){return It().memoizedState}function qs(e,t,o,l){var c=Jt();Fe.flags|=e,c.memoizedState=Ho(1|t,o,void 0,l===void 0?null:l)}function Js(e,t,o,l){var c=It();l=l===void 0?null:l;var p=void 0;if(Xe!==null){var y=Xe.memoizedState;if(p=y.destroy,l!==null&&va(l,y.deps)){c.memoizedState=Ho(t,o,p,l);return}}Fe.flags|=e,c.memoizedState=Ho(1|t,o,p,l)}function cf(e,t){return qs(8390656,8,e,t)}function Ca(e,t){return Js(2048,8,e,t)}function df(e,t){return Js(4,2,e,t)}function ff(e,t){return Js(4,4,e,t)}function pf(e,t){if(typeof t==\"function\")return e=e(),t(e),function(){t(null)};if(t!=null)return e=e(),t.current=e,function(){t.current=null}}function hf(e,t,o){return o=o!=null?o.concat([e]):null,Js(4,4,pf.bind(null,t,e),o)}function ka(){}function mf(e,t){var o=It();t=t===void 0?null:t;var l=o.memoizedState;return l!==null&&t!==null&&va(t,l[1])?l[0]:(o.memoizedState=[e,t],e)}function gf(e,t){var o=It();t=t===void 0?null:t;var l=o.memoizedState;return l!==null&&t!==null&&va(t,l[1])?l[0]:(e=e(),o.memoizedState=[e,t],e)}function vf(e,t,o){return(ar&21)===0?(e.baseState&&(e.baseState=!1,wt=!0),e.memoizedState=o):($t(o,t)||(o=Kc(),Fe.lanes|=o,ur|=o,e.baseState=!0),t)}function xy(e,t){var o=Te;Te=o!==0&&4>o?o:4,e(!0);var l=ga.transition;ga.transition={};try{e(!1),t()}finally{Te=o,ga.transition=l}}function yf(){return It().memoizedState}function wy(e,t,o){var l=Bn(e);if(o={lane:l,action:o,hasEagerState:!1,eagerState:null,next:null},xf(e))wf(t,o);else if(o=Yd(e,t,o,l),o!==null){var c=mt();Wt(o,e,l,c),Sf(o,t,l)}}function Sy(e,t,o){var l=Bn(e),c={lane:l,action:o,hasEagerState:!1,eagerState:null,next:null};if(xf(e))wf(t,c);else{var p=e.alternate;if(e.lanes===0&&(p===null||p.lanes===0)&&(p=t.lastRenderedReducer,p!==null))try{var y=t.lastRenderedState,P=p(y,o);if(c.hasEagerState=!0,c.eagerState=P,$t(P,y)){var R=t.interleaved;R===null?(c.next=c,ca(t)):(c.next=R.next,R.next=c),t.interleaved=c;return}}catch{}o=Yd(e,t,c,l),o!==null&&(c=mt(),Wt(o,e,l,c),Sf(o,t,l))}}function xf(e){var t=e.alternate;return e===Fe||t!==null&&t===Fe}function wf(e,t){Vo=Zs=!0;var o=e.pending;o===null?t.next=t:(t.next=o.next,o.next=t),e.pending=t}function Sf(e,t,o){if((o&4194240)!==0){var l=t.lanes;l&=e.pendingLanes,o|=l,t.lanes=o,El(e,o)}}var ei={readContext:Lt,useCallback:ut,useContext:ut,useEffect:ut,useImperativeHandle:ut,useInsertionEffect:ut,useLayoutEffect:ut,useMemo:ut,useReducer:ut,useRef:ut,useState:ut,useDebugValue:ut,useDeferredValue:ut,useTransition:ut,useMutableSource:ut,useSyncExternalStore:ut,useId:ut,unstable_isNewReconciler:!1},Cy={readContext:Lt,useCallback:function(e,t){return Jt().memoizedState=[e,t===void 0?null:t],e},useContext:Lt,useEffect:cf,useImperativeHandle:function(e,t,o){return o=o!=null?o.concat([e]):null,qs(4194308,4,pf.bind(null,t,e),o)},useLayoutEffect:function(e,t){return qs(4194308,4,e,t)},useInsertionEffect:function(e,t){return qs(4,2,e,t)},useMemo:function(e,t){var o=Jt();return t=t===void 0?null:t,e=e(),o.memoizedState=[e,t],e},useReducer:function(e,t,o){var l=Jt();return t=o!==void 0?o(t):t,l.memoizedState=l.baseState=t,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:t},l.queue=e,e=e.dispatch=wy.bind(null,Fe,e),[l.memoizedState,e]},useRef:function(e){var t=Jt();return e={current:e},t.memoizedState=e},useState:af,useDebugValue:ka,useDeferredValue:function(e){return Jt().memoizedState=e},useTransition:function(){var e=af(!1),t=e[0];return e=xy.bind(null,e[1]),Jt().memoizedState=e,[t,e]},useMutableSource:function(){},useSyncExternalStore:function(e,t,o){var l=Fe,c=Jt();if(Me){if(o===void 0)throw Error(s(407));o=o()}else{if(o=t(),tt===null)throw Error(s(349));(ar&30)!==0||nf(l,t,o)}c.memoizedState=o;var p={value:o,getSnapshot:t};return c.queue=p,cf(of.bind(null,l,p,e),[e]),l.flags|=2048,Ho(9,rf.bind(null,l,p,o,t),void 0,null),o},useId:function(){var e=Jt(),t=tt.identifierPrefix;if(Me){var o=fn,l=dn;o=(l&~(1<<32-Ft(l)-1)).toString(32)+o,t=\":\"+t+\"R\"+o,o=Bo++,0<o&&(t+=\"H\"+o.toString(32)),t+=\":\"}else o=yy++,t=\":\"+t+\"r\"+o.toString(32)+\":\";return e.memoizedState=t},unstable_isNewReconciler:!1},ky={readContext:Lt,useCallback:mf,useContext:Lt,useEffect:Ca,useImperativeHandle:hf,useInsertionEffect:df,useLayoutEffect:ff,useMemo:gf,useReducer:wa,useRef:uf,useState:function(){return wa(Uo)},useDebugValue:ka,useDeferredValue:function(e){var t=It();return vf(t,Xe.memoizedState,e)},useTransition:function(){var e=wa(Uo)[0],t=It().memoizedState;return[e,t]},useMutableSource:ef,useSyncExternalStore:tf,useId:yf,unstable_isNewReconciler:!1},by={readContext:Lt,useCallback:mf,useContext:Lt,useEffect:Ca,useImperativeHandle:hf,useInsertionEffect:df,useLayoutEffect:ff,useMemo:gf,useReducer:Sa,useRef:uf,useState:function(){return Sa(Uo)},useDebugValue:ka,useDeferredValue:function(e){var t=It();return Xe===null?t.memoizedState=e:vf(t,Xe.memoizedState,e)},useTransition:function(){var e=Sa(Uo)[0],t=It().memoizedState;return[e,t]},useMutableSource:ef,useSyncExternalStore:tf,useId:yf,unstable_isNewReconciler:!1};function Bt(e,t){if(e&&e.defaultProps){t=M({},t),e=e.defaultProps;for(var o in e)t[o]===void 0&&(t[o]=e[o]);return t}return t}function ba(e,t,o,l){t=e.memoizedState,o=o(l,t),o=o==null?t:M({},t,o),e.memoizedState=o,e.lanes===0&&(e.updateQueue.baseState=o)}var ti={isMounted:function(e){return(e=e._reactInternals)?tr(e)===e:!1},enqueueSetState:function(e,t,o){e=e._reactInternals;var l=mt(),c=Bn(e),p=hn(l,c);p.payload=t,o!=null&&(p.callback=o),t=zn(e,p,c),t!==null&&(Wt(t,e,c,l),Gs(t,e,c))},enqueueReplaceState:function(e,t,o){e=e._reactInternals;var l=mt(),c=Bn(e),p=hn(l,c);p.tag=1,p.payload=t,o!=null&&(p.callback=o),t=zn(e,p,c),t!==null&&(Wt(t,e,c,l),Gs(t,e,c))},enqueueForceUpdate:function(e,t){e=e._reactInternals;var o=mt(),l=Bn(e),c=hn(o,l);c.tag=2,t!=null&&(c.callback=t),t=zn(e,c,l),t!==null&&(Wt(t,e,l,o),Gs(t,e,l))}};function Cf(e,t,o,l,c,p,y){return e=e.stateNode,typeof e.shouldComponentUpdate==\"function\"?e.shouldComponentUpdate(l,p,y):t.prototype&&t.prototype.isPureReactComponent?!jo(o,l)||!jo(c,p):!0}function kf(e,t,o){var l=!1,c=An,p=t.contextType;return typeof p==\"object\"&&p!==null?p=Lt(p):(c=xt(t)?rr:at.current,l=t.contextTypes,p=(l=l!=null)?$r(e,c):An),t=new t(o,p),e.memoizedState=t.state!==null&&t.state!==void 0?t.state:null,t.updater=ti,e.stateNode=t,t._reactInternals=e,l&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=c,e.__reactInternalMemoizedMaskedChildContext=p),t}function bf(e,t,o,l){e=t.state,typeof t.componentWillReceiveProps==\"function\"&&t.componentWillReceiveProps(o,l),typeof t.UNSAFE_componentWillReceiveProps==\"function\"&&t.UNSAFE_componentWillReceiveProps(o,l),t.state!==e&&ti.enqueueReplaceState(t,t.state,null)}function Ea(e,t,o,l){var c=e.stateNode;c.props=o,c.state=e.memoizedState,c.refs={},da(e);var p=t.contextType;typeof p==\"object\"&&p!==null?c.context=Lt(p):(p=xt(t)?rr:at.current,c.context=$r(e,p)),c.state=e.memoizedState,p=t.getDerivedStateFromProps,typeof p==\"function\"&&(ba(e,t,p,o),c.state=e.memoizedState),typeof t.getDerivedStateFromProps==\"function\"||typeof c.getSnapshotBeforeUpdate==\"function\"||typeof c.UNSAFE_componentWillMount!=\"function\"&&typeof c.componentWillMount!=\"function\"||(t=c.state,typeof c.componentWillMount==\"function\"&&c.componentWillMount(),typeof c.UNSAFE_componentWillMount==\"function\"&&c.UNSAFE_componentWillMount(),t!==c.state&&ti.enqueueReplaceState(c,c.state,null),Qs(e,o,c,l),c.state=e.memoizedState),typeof c.componentDidMount==\"function\"&&(e.flags|=4194308)}function Qr(e,t){try{var o=\"\",l=t;do o+=se(l),l=l.return;while(l);var c=o}catch(p){c=`\nError generating stack: `+p.message+`\n`+p.stack}return{value:e,source:t,stack:c,digest:null}}function Pa(e,t,o){return{value:e,source:null,stack:o??null,digest:t??null}}function Na(e,t){try{console.error(t.value)}catch(o){setTimeout(function(){throw o})}}var Ey=typeof WeakMap==\"function\"?WeakMap:Map;function Ef(e,t,o){o=hn(-1,o),o.tag=3,o.payload={element:null};var l=t.value;return o.callback=function(){ai||(ai=!0,Ba=l),Na(e,t)},o}function Pf(e,t,o){o=hn(-1,o),o.tag=3;var l=e.type.getDerivedStateFromError;if(typeof l==\"function\"){var c=t.value;o.payload=function(){return l(c)},o.callback=function(){Na(e,t)}}var p=e.stateNode;return p!==null&&typeof p.componentDidCatch==\"function\"&&(o.callback=function(){Na(e,t),typeof l!=\"function\"&&($n===null?$n=new Set([this]):$n.add(this));var y=t.stack;this.componentDidCatch(t.value,{componentStack:y!==null?y:\"\"})}),o}function Nf(e,t,o){var l=e.pingCache;if(l===null){l=e.pingCache=new Ey;var c=new Set;l.set(t,c)}else c=l.get(t),c===void 0&&(c=new Set,l.set(t,c));c.has(o)||(c.add(o),e=Fy.bind(null,e,t,o),t.then(e,e))}function Rf(e){do{var t;if((t=e.tag===13)&&(t=e.memoizedState,t=t!==null?t.dehydrated!==null:!0),t)return e;e=e.return}while(e!==null);return null}function Of(e,t,o,l,c){return(e.mode&1)===0?(e===t?e.flags|=65536:(e.flags|=128,o.flags|=131072,o.flags&=-52805,o.tag===1&&(o.alternate===null?o.tag=17:(t=hn(-1,1),t.tag=2,zn(o,t,1))),o.lanes|=1),e):(e.flags|=65536,e.lanes=c,e)}var Py=O.ReactCurrentOwner,wt=!1;function ht(e,t,o,l){t.child=e===null?Qd(t,null,o,l):Hr(t,e.child,o,l)}function jf(e,t,o,l,c){o=o.render;var p=t.ref;return Kr(t,c),l=ya(e,t,o,l,p,c),o=xa(),e!==null&&!wt?(t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~c,mn(e,t,c)):(Me&&o&&ta(t),t.flags|=1,ht(e,t,l,c),t.child)}function _f(e,t,o,l,c){if(e===null){var p=o.type;return typeof p==\"function\"&&!Ya(p)&&p.defaultProps===void 0&&o.compare===null&&o.defaultProps===void 0?(t.tag=15,t.type=p,Tf(e,t,p,l,c)):(e=hi(o.type,null,l,t,t.mode,c),e.ref=t.ref,e.return=t,t.child=e)}if(p=e.child,(e.lanes&c)===0){var y=p.memoizedProps;if(o=o.compare,o=o!==null?o:jo,o(y,l)&&e.ref===t.ref)return mn(e,t,c)}return t.flags|=1,e=Hn(p,l),e.ref=t.ref,e.return=t,t.child=e}function Tf(e,t,o,l,c){if(e!==null){var p=e.memoizedProps;if(jo(p,l)&&e.ref===t.ref)if(wt=!1,t.pendingProps=l=p,(e.lanes&c)!==0)(e.flags&131072)!==0&&(wt=!0);else return t.lanes=e.lanes,mn(e,t,c)}return Ra(e,t,o,l,c)}function Lf(e,t,o){var l=t.pendingProps,c=l.children,p=e!==null?e.memoizedState:null;if(l.mode===\"hidden\")if((t.mode&1)===0)t.memoizedState={baseLanes:0,cachePool:null,transitions:null},Le(Xr,Rt),Rt|=o;else{if((o&1073741824)===0)return e=p!==null?p.baseLanes|o:o,t.lanes=t.childLanes=1073741824,t.memoizedState={baseLanes:e,cachePool:null,transitions:null},t.updateQueue=null,Le(Xr,Rt),Rt|=e,null;t.memoizedState={baseLanes:0,cachePool:null,transitions:null},l=p!==null?p.baseLanes:o,Le(Xr,Rt),Rt|=l}else p!==null?(l=p.baseLanes|o,t.memoizedState=null):l=o,Le(Xr,Rt),Rt|=l;return ht(e,t,c,o),t.child}function If(e,t){var o=t.ref;(e===null&&o!==null||e!==null&&e.ref!==o)&&(t.flags|=512,t.flags|=2097152)}function Ra(e,t,o,l,c){var p=xt(o)?rr:at.current;return p=$r(t,p),Kr(t,c),o=ya(e,t,o,l,p,c),l=xa(),e!==null&&!wt?(t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~c,mn(e,t,c)):(Me&&l&&ta(t),t.flags|=1,ht(e,t,o,c),t.child)}function Af(e,t,o,l,c){if(xt(o)){var p=!0;Fs(t)}else p=!1;if(Kr(t,c),t.stateNode===null)ri(e,t),kf(t,o,l),Ea(t,o,l,c),l=!0;else if(e===null){var y=t.stateNode,P=t.memoizedProps;y.props=P;var R=y.context,F=o.contextType;typeof F==\"object\"&&F!==null?F=Lt(F):(F=xt(o)?rr:at.current,F=$r(t,F));var G=o.getDerivedStateFromProps,Y=typeof G==\"function\"||typeof y.getSnapshotBeforeUpdate==\"function\";Y||typeof y.UNSAFE_componentWillReceiveProps!=\"function\"&&typeof y.componentWillReceiveProps!=\"function\"||(P!==l||R!==F)&&bf(t,y,l,F),Mn=!1;var K=t.memoizedState;y.state=K,Qs(t,l,y,c),R=t.memoizedState,P!==l||K!==R||yt.current||Mn?(typeof G==\"function\"&&(ba(t,o,G,l),R=t.memoizedState),(P=Mn||Cf(t,o,P,l,K,R,F))?(Y||typeof y.UNSAFE_componentWillMount!=\"function\"&&typeof y.componentWillMount!=\"function\"||(typeof y.componentWillMount==\"function\"&&y.componentWillMount(),typeof y.UNSAFE_componentWillMount==\"function\"&&y.UNSAFE_componentWillMount()),typeof y.componentDidMount==\"function\"&&(t.flags|=4194308)):(typeof y.componentDidMount==\"function\"&&(t.flags|=4194308),t.memoizedProps=l,t.memoizedState=R),y.props=l,y.state=R,y.context=F,l=P):(typeof y.componentDidMount==\"function\"&&(t.flags|=4194308),l=!1)}else{y=t.stateNode,Xd(e,t),P=t.memoizedProps,F=t.type===t.elementType?P:Bt(t.type,P),y.props=F,Y=t.pendingProps,K=y.context,R=o.contextType,typeof R==\"object\"&&R!==null?R=Lt(R):(R=xt(o)?rr:at.current,R=$r(t,R));var ie=o.getDerivedStateFromProps;(G=typeof ie==\"function\"||typeof y.getSnapshotBeforeUpdate==\"function\")||typeof y.UNSAFE_componentWillReceiveProps!=\"function\"&&typeof y.componentWillReceiveProps!=\"function\"||(P!==Y||K!==R)&&bf(t,y,l,R),Mn=!1,K=t.memoizedState,y.state=K,Qs(t,l,y,c);var de=t.memoizedState;P!==Y||K!==de||yt.current||Mn?(typeof ie==\"function\"&&(ba(t,o,ie,l),de=t.memoizedState),(F=Mn||Cf(t,o,F,l,K,de,R)||!1)?(G||typeof y.UNSAFE_componentWillUpdate!=\"function\"&&typeof y.componentWillUpdate!=\"function\"||(typeof y.componentWillUpdate==\"function\"&&y.componentWillUpdate(l,de,R),typeof y.UNSAFE_componentWillUpdate==\"function\"&&y.UNSAFE_componentWillUpdate(l,de,R)),typeof y.componentDidUpdate==\"function\"&&(t.flags|=4),typeof y.getSnapshotBeforeUpdate==\"function\"&&(t.flags|=1024)):(typeof y.componentDidUpdate!=\"function\"||P===e.memoizedProps&&K===e.memoizedState||(t.flags|=4),typeof y.getSnapshotBeforeUpdate!=\"function\"||P===e.memoizedProps&&K===e.memoizedState||(t.flags|=1024),t.memoizedProps=l,t.memoizedState=de),y.props=l,y.state=de,y.context=R,l=F):(typeof y.componentDidUpdate!=\"function\"||P===e.memoizedProps&&K===e.memoizedState||(t.flags|=4),typeof y.getSnapshotBeforeUpdate!=\"function\"||P===e.memoizedProps&&K===e.memoizedState||(t.flags|=1024),l=!1)}return Oa(e,t,o,l,p,c)}function Oa(e,t,o,l,c,p){If(e,t);var y=(t.flags&128)!==0;if(!l&&!y)return c&&Fd(t,o,!1),mn(e,t,p);l=t.stateNode,Py.current=t;var P=y&&typeof o.getDerivedStateFromError!=\"function\"?null:l.render();return t.flags|=1,e!==null&&y?(t.child=Hr(t,e.child,null,p),t.child=Hr(t,null,P,p)):ht(e,t,P,p),t.memoizedState=l.state,c&&Fd(t,o,!0),t.child}function Df(e){var t=e.stateNode;t.pendingContext?Md(e,t.pendingContext,t.pendingContext!==t.context):t.context&&Md(e,t.context,!1),fa(e,t.containerInfo)}function Mf(e,t,o,l,c){return Ur(),sa(c),t.flags|=256,ht(e,t,o,l),t.child}var ja={dehydrated:null,treeContext:null,retryLane:0};function _a(e){return{baseLanes:e,cachePool:null,transitions:null}}function zf(e,t,o){var l=t.pendingProps,c=ze.current,p=!1,y=(t.flags&128)!==0,P;if((P=y)||(P=e!==null&&e.memoizedState===null?!1:(c&2)!==0),P?(p=!0,t.flags&=-129):(e===null||e.memoizedState!==null)&&(c|=1),Le(ze,c&1),e===null)return oa(t),e=t.memoizedState,e!==null&&(e=e.dehydrated,e!==null)?((t.mode&1)===0?t.lanes=1:e.data===\"$!\"?t.lanes=8:t.lanes=1073741824,null):(y=l.children,e=l.fallback,p?(l=t.mode,p=t.child,y={mode:\"hidden\",children:y},(l&1)===0&&p!==null?(p.childLanes=0,p.pendingProps=y):p=mi(y,l,0,null),e=pr(e,l,o,null),p.return=t,e.return=t,p.sibling=e,t.child=p,t.child.memoizedState=_a(o),t.memoizedState=ja,e):Ta(t,y));if(c=e.memoizedState,c!==null&&(P=c.dehydrated,P!==null))return Ny(e,t,y,l,P,c,o);if(p){p=l.fallback,y=t.mode,c=e.child,P=c.sibling;var R={mode:\"hidden\",children:l.children};return(y&1)===0&&t.child!==c?(l=t.child,l.childLanes=0,l.pendingProps=R,t.deletions=null):(l=Hn(c,R),l.subtreeFlags=c.subtreeFlags&14680064),P!==null?p=Hn(P,p):(p=pr(p,y,o,null),p.flags|=2),p.return=t,l.return=t,l.sibling=p,t.child=l,l=p,p=t.child,y=e.child.memoizedState,y=y===null?_a(o):{baseLanes:y.baseLanes|o,cachePool:null,transitions:y.transitions},p.memoizedState=y,p.childLanes=e.childLanes&~o,t.memoizedState=ja,l}return p=e.child,e=p.sibling,l=Hn(p,{mode:\"visible\",children:l.children}),(t.mode&1)===0&&(l.lanes=o),l.return=t,l.sibling=null,e!==null&&(o=t.deletions,o===null?(t.deletions=[e],t.flags|=16):o.push(e)),t.child=l,t.memoizedState=null,l}function Ta(e,t){return t=mi({mode:\"visible\",children:t},e.mode,0,null),t.return=e,e.child=t}function ni(e,t,o,l){return l!==null&&sa(l),Hr(t,e.child,null,o),e=Ta(t,t.pendingProps.children),e.flags|=2,t.memoizedState=null,e}function Ny(e,t,o,l,c,p,y){if(o)return t.flags&256?(t.flags&=-257,l=Pa(Error(s(422))),ni(e,t,y,l)):t.memoizedState!==null?(t.child=e.child,t.flags|=128,null):(p=l.fallback,c=t.mode,l=mi({mode:\"visible\",children:l.children},c,0,null),p=pr(p,c,y,null),p.flags|=2,l.return=t,p.return=t,l.sibling=p,t.child=l,(t.mode&1)!==0&&Hr(t,e.child,null,y),t.child.memoizedState=_a(y),t.memoizedState=ja,p);if((t.mode&1)===0)return ni(e,t,y,null);if(c.data===\"$!\"){if(l=c.nextSibling&&c.nextSibling.dataset,l)var P=l.dgst;return l=P,p=Error(s(419)),l=Pa(p,l,void 0),ni(e,t,y,l)}if(P=(y&e.childLanes)!==0,wt||P){if(l=tt,l!==null){switch(y&-y){case 4:c=2;break;case 16:c=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:c=32;break;case 536870912:c=268435456;break;default:c=0}c=(c&(l.suspendedLanes|y))!==0?0:c,c!==0&&c!==p.retryLane&&(p.retryLane=c,pn(e,c),Wt(l,e,c,-1))}return Qa(),l=Pa(Error(s(421))),ni(e,t,y,l)}return c.data===\"$?\"?(t.flags|=128,t.child=e.child,t=$y.bind(null,e),c._reactRetry=t,null):(e=p.treeContext,Nt=Ln(c.nextSibling),Pt=t,Me=!0,Vt=null,e!==null&&(_t[Tt++]=dn,_t[Tt++]=fn,_t[Tt++]=or,dn=e.id,fn=e.overflow,or=t),t=Ta(t,l.children),t.flags|=4096,t)}function Ff(e,t,o){e.lanes|=t;var l=e.alternate;l!==null&&(l.lanes|=t),ua(e.return,t,o)}function La(e,t,o,l,c){var p=e.memoizedState;p===null?e.memoizedState={isBackwards:t,rendering:null,renderingStartTime:0,last:l,tail:o,tailMode:c}:(p.isBackwards=t,p.rendering=null,p.renderingStartTime=0,p.last=l,p.tail=o,p.tailMode=c)}function $f(e,t,o){var l=t.pendingProps,c=l.revealOrder,p=l.tail;if(ht(e,t,l.children,o),l=ze.current,(l&2)!==0)l=l&1|2,t.flags|=128;else{if(e!==null&&(e.flags&128)!==0)e:for(e=t.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&Ff(e,o,t);else if(e.tag===19)Ff(e,o,t);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break e;for(;e.sibling===null;){if(e.return===null||e.return===t)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}l&=1}if(Le(ze,l),(t.mode&1)===0)t.memoizedState=null;else switch(c){case\"forwards\":for(o=t.child,c=null;o!==null;)e=o.alternate,e!==null&&Ys(e)===null&&(c=o),o=o.sibling;o=c,o===null?(c=t.child,t.child=null):(c=o.sibling,o.sibling=null),La(t,!1,c,o,p);break;case\"backwards\":for(o=null,c=t.child,t.child=null;c!==null;){if(e=c.alternate,e!==null&&Ys(e)===null){t.child=c;break}e=c.sibling,c.sibling=o,o=c,c=e}La(t,!0,o,null,p);break;case\"together\":La(t,!1,null,null,void 0);break;default:t.memoizedState=null}return t.child}function ri(e,t){(t.mode&1)===0&&e!==null&&(e.alternate=null,t.alternate=null,t.flags|=2)}function mn(e,t,o){if(e!==null&&(t.dependencies=e.dependencies),ur|=t.lanes,(o&t.childLanes)===0)return null;if(e!==null&&t.child!==e.child)throw Error(s(153));if(t.child!==null){for(e=t.child,o=Hn(e,e.pendingProps),t.child=o,o.return=t;e.sibling!==null;)e=e.sibling,o=o.sibling=Hn(e,e.pendingProps),o.return=t;o.sibling=null}return t.child}function Ry(e,t,o){switch(t.tag){case 3:Df(t),Ur();break;case 5:Jd(t);break;case 1:xt(t.type)&&Fs(t);break;case 4:fa(t,t.stateNode.containerInfo);break;case 10:var l=t.type._context,c=t.memoizedProps.value;Le(Ws,l._currentValue),l._currentValue=c;break;case 13:if(l=t.memoizedState,l!==null)return l.dehydrated!==null?(Le(ze,ze.current&1),t.flags|=128,null):(o&t.child.childLanes)!==0?zf(e,t,o):(Le(ze,ze.current&1),e=mn(e,t,o),e!==null?e.sibling:null);Le(ze,ze.current&1);break;case 19:if(l=(o&t.childLanes)!==0,(e.flags&128)!==0){if(l)return $f(e,t,o);t.flags|=128}if(c=t.memoizedState,c!==null&&(c.rendering=null,c.tail=null,c.lastEffect=null),Le(ze,ze.current),l)break;return null;case 22:case 23:return t.lanes=0,Lf(e,t,o)}return mn(e,t,o)}var Vf,Ia,Bf,Uf;Vf=function(e,t){for(var o=t.child;o!==null;){if(o.tag===5||o.tag===6)e.appendChild(o.stateNode);else if(o.tag!==4&&o.child!==null){o.child.return=o,o=o.child;continue}if(o===t)break;for(;o.sibling===null;){if(o.return===null||o.return===t)return;o=o.return}o.sibling.return=o.return,o=o.sibling}},Ia=function(){},Bf=function(e,t,o,l){var c=e.memoizedProps;if(c!==l){e=t.stateNode,lr(qt.current);var p=null;switch(o){case\"input\":c=Je(e,c),l=Je(e,l),p=[];break;case\"select\":c=M({},c,{value:void 0}),l=M({},l,{value:void 0}),p=[];break;case\"textarea\":c=fl(e,c),l=fl(e,l),p=[];break;default:typeof c.onClick!=\"function\"&&typeof l.onClick==\"function\"&&(e.onclick=Ds)}hl(o,l);var y;o=null;for(F in c)if(!l.hasOwnProperty(F)&&c.hasOwnProperty(F)&&c[F]!=null)if(F===\"style\"){var P=c[F];for(y in P)P.hasOwnProperty(y)&&(o||(o={}),o[y]=\"\")}else F!==\"dangerouslySetInnerHTML\"&&F!==\"children\"&&F!==\"suppressContentEditableWarning\"&&F!==\"suppressHydrationWarning\"&&F!==\"autoFocus\"&&(a.hasOwnProperty(F)?p||(p=[]):(p=p||[]).push(F,null));for(F in l){var R=l[F];if(P=c?.[F],l.hasOwnProperty(F)&&R!==P&&(R!=null||P!=null))if(F===\"style\")if(P){for(y in P)!P.hasOwnProperty(y)||R&&R.hasOwnProperty(y)||(o||(o={}),o[y]=\"\");for(y in R)R.hasOwnProperty(y)&&P[y]!==R[y]&&(o||(o={}),o[y]=R[y])}else o||(p||(p=[]),p.push(F,o)),o=R;else F===\"dangerouslySetInnerHTML\"?(R=R?R.__html:void 0,P=P?P.__html:void 0,R!=null&&P!==R&&(p=p||[]).push(F,R)):F===\"children\"?typeof R!=\"string\"&&typeof R!=\"number\"||(p=p||[]).push(F,\"\"+R):F!==\"suppressContentEditableWarning\"&&F!==\"suppressHydrationWarning\"&&(a.hasOwnProperty(F)?(R!=null&&F===\"onScroll\"&&Ie(\"scroll\",e),p||P===R||(p=[])):(p=p||[]).push(F,R))}o&&(p=p||[]).push(\"style\",o);var F=p;(t.updateQueue=F)&&(t.flags|=4)}},Uf=function(e,t,o,l){o!==l&&(t.flags|=4)};function Wo(e,t){if(!Me)switch(e.tailMode){case\"hidden\":t=e.tail;for(var o=null;t!==null;)t.alternate!==null&&(o=t),t=t.sibling;o===null?e.tail=null:o.sibling=null;break;case\"collapsed\":o=e.tail;for(var l=null;o!==null;)o.alternate!==null&&(l=o),o=o.sibling;l===null?t||e.tail===null?e.tail=null:e.tail.sibling=null:l.sibling=null}}function ct(e){var t=e.alternate!==null&&e.alternate.child===e.child,o=0,l=0;if(t)for(var c=e.child;c!==null;)o|=c.lanes|c.childLanes,l|=c.subtreeFlags&14680064,l|=c.flags&14680064,c.return=e,c=c.sibling;else for(c=e.child;c!==null;)o|=c.lanes|c.childLanes,l|=c.subtreeFlags,l|=c.flags,c.return=e,c=c.sibling;return e.subtreeFlags|=l,e.childLanes=o,t}function Oy(e,t,o){var l=t.pendingProps;switch(na(t),t.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return ct(t),null;case 1:return xt(t.type)&&zs(),ct(t),null;case 3:return l=t.stateNode,Gr(),Ae(yt),Ae(at),ma(),l.pendingContext&&(l.context=l.pendingContext,l.pendingContext=null),(e===null||e.child===null)&&(Us(t)?t.flags|=4:e===null||e.memoizedState.isDehydrated&&(t.flags&256)===0||(t.flags|=1024,Vt!==null&&(Wa(Vt),Vt=null))),Ia(e,t),ct(t),null;case 5:pa(t);var c=lr($o.current);if(o=t.type,e!==null&&t.stateNode!=null)Bf(e,t,o,l,c),e.ref!==t.ref&&(t.flags|=512,t.flags|=2097152);else{if(!l){if(t.stateNode===null)throw Error(s(166));return ct(t),null}if(e=lr(qt.current),Us(t)){l=t.stateNode,o=t.type;var p=t.memoizedProps;switch(l[Zt]=t,l[Ao]=p,e=(t.mode&1)!==0,o){case\"dialog\":Ie(\"cancel\",l),Ie(\"close\",l);break;case\"iframe\":case\"object\":case\"embed\":Ie(\"load\",l);break;case\"video\":case\"audio\":for(c=0;c<To.length;c++)Ie(To[c],l);break;case\"source\":Ie(\"error\",l);break;case\"img\":case\"image\":case\"link\":Ie(\"error\",l),Ie(\"load\",l);break;case\"details\":Ie(\"toggle\",l);break;case\"input\":pt(l,p),Ie(\"invalid\",l);break;case\"select\":l._wrapperState={wasMultiple:!!p.multiple},Ie(\"invalid\",l);break;case\"textarea\":Ec(l,p),Ie(\"invalid\",l)}hl(o,p),c=null;for(var y in p)if(p.hasOwnProperty(y)){var P=p[y];y===\"children\"?typeof P==\"string\"?l.textContent!==P&&(p.suppressHydrationWarning!==!0&&As(l.textContent,P,e),c=[\"children\",P]):typeof P==\"number\"&&l.textContent!==\"\"+P&&(p.suppressHydrationWarning!==!0&&As(l.textContent,P,e),c=[\"children\",\"\"+P]):a.hasOwnProperty(y)&&P!=null&&y===\"onScroll\"&&Ie(\"scroll\",l)}switch(o){case\"input\":be(l),Nr(l,p,!0);break;case\"textarea\":be(l),Nc(l);break;case\"select\":case\"option\":break;default:typeof p.onClick==\"function\"&&(l.onclick=Ds)}l=c,t.updateQueue=l,l!==null&&(t.flags|=4)}else{y=c.nodeType===9?c:c.ownerDocument,e===\"http://www.w3.org/1999/xhtml\"&&(e=Rc(o)),e===\"http://www.w3.org/1999/xhtml\"?o===\"script\"?(e=y.createElement(\"div\"),e.innerHTML=\"<script><\\/script>\",e=e.removeChild(e.firstChild)):typeof l.is==\"string\"?e=y.createElement(o,{is:l.is}):(e=y.createElement(o),o===\"select\"&&(y=e,l.multiple?y.multiple=!0:l.size&&(y.size=l.size))):e=y.createElementNS(e,o),e[Zt]=t,e[Ao]=l,Vf(e,t,!1,!1),t.stateNode=e;e:{switch(y=ml(o,l),o){case\"dialog\":Ie(\"cancel\",e),Ie(\"close\",e),c=l;break;case\"iframe\":case\"object\":case\"embed\":Ie(\"load\",e),c=l;break;case\"video\":case\"audio\":for(c=0;c<To.length;c++)Ie(To[c],e);c=l;break;case\"source\":Ie(\"error\",e),c=l;break;case\"img\":case\"image\":case\"link\":Ie(\"error\",e),Ie(\"load\",e),c=l;break;case\"details\":Ie(\"toggle\",e),c=l;break;case\"input\":pt(e,l),c=Je(e,l),Ie(\"invalid\",e);break;case\"option\":c=l;break;case\"select\":e._wrapperState={wasMultiple:!!l.multiple},c=M({},l,{value:void 0}),Ie(\"invalid\",e);break;case\"textarea\":Ec(e,l),c=fl(e,l),Ie(\"invalid\",e);break;default:c=l}hl(o,c),P=c;for(p in P)if(P.hasOwnProperty(p)){var R=P[p];p===\"style\"?_c(e,R):p===\"dangerouslySetInnerHTML\"?(R=R?R.__html:void 0,R!=null&&Oc(e,R)):p===\"children\"?typeof R==\"string\"?(o!==\"textarea\"||R!==\"\")&&po(e,R):typeof R==\"number\"&&po(e,\"\"+R):p!==\"suppressContentEditableWarning\"&&p!==\"suppressHydrationWarning\"&&p!==\"autoFocus\"&&(a.hasOwnProperty(p)?R!=null&&p===\"onScroll\"&&Ie(\"scroll\",e):R!=null&&T(e,p,R,y))}switch(o){case\"input\":be(e),Nr(e,l,!1);break;case\"textarea\":be(e),Nc(e);break;case\"option\":l.value!=null&&e.setAttribute(\"value\",\"\"+re(l.value));break;case\"select\":e.multiple=!!l.multiple,p=l.value,p!=null?Rr(e,!!l.multiple,p,!1):l.defaultValue!=null&&Rr(e,!!l.multiple,l.defaultValue,!0);break;default:typeof c.onClick==\"function\"&&(e.onclick=Ds)}switch(o){case\"button\":case\"input\":case\"select\":case\"textarea\":l=!!l.autoFocus;break e;case\"img\":l=!0;break e;default:l=!1}}l&&(t.flags|=4)}t.ref!==null&&(t.flags|=512,t.flags|=2097152)}return ct(t),null;case 6:if(e&&t.stateNode!=null)Uf(e,t,e.memoizedProps,l);else{if(typeof l!=\"string\"&&t.stateNode===null)throw Error(s(166));if(o=lr($o.current),lr(qt.current),Us(t)){if(l=t.stateNode,o=t.memoizedProps,l[Zt]=t,(p=l.nodeValue!==o)&&(e=Pt,e!==null))switch(e.tag){case 3:As(l.nodeValue,o,(e.mode&1)!==0);break;case 5:e.memoizedProps.suppressHydrationWarning!==!0&&As(l.nodeValue,o,(e.mode&1)!==0)}p&&(t.flags|=4)}else l=(o.nodeType===9?o:o.ownerDocument).createTextNode(l),l[Zt]=t,t.stateNode=l}return ct(t),null;case 13:if(Ae(ze),l=t.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(Me&&Nt!==null&&(t.mode&1)!==0&&(t.flags&128)===0)Wd(),Ur(),t.flags|=98560,p=!1;else if(p=Us(t),l!==null&&l.dehydrated!==null){if(e===null){if(!p)throw Error(s(318));if(p=t.memoizedState,p=p!==null?p.dehydrated:null,!p)throw Error(s(317));p[Zt]=t}else Ur(),(t.flags&128)===0&&(t.memoizedState=null),t.flags|=4;ct(t),p=!1}else Vt!==null&&(Wa(Vt),Vt=null),p=!0;if(!p)return t.flags&65536?t:null}return(t.flags&128)!==0?(t.lanes=o,t):(l=l!==null,l!==(e!==null&&e.memoizedState!==null)&&l&&(t.child.flags|=8192,(t.mode&1)!==0&&(e===null||(ze.current&1)!==0?Ze===0&&(Ze=3):Qa())),t.updateQueue!==null&&(t.flags|=4),ct(t),null);case 4:return Gr(),Ia(e,t),e===null&&Lo(t.stateNode.containerInfo),ct(t),null;case 10:return aa(t.type._context),ct(t),null;case 17:return xt(t.type)&&zs(),ct(t),null;case 19:if(Ae(ze),p=t.memoizedState,p===null)return ct(t),null;if(l=(t.flags&128)!==0,y=p.rendering,y===null)if(l)Wo(p,!1);else{if(Ze!==0||e!==null&&(e.flags&128)!==0)for(e=t.child;e!==null;){if(y=Ys(e),y!==null){for(t.flags|=128,Wo(p,!1),l=y.updateQueue,l!==null&&(t.updateQueue=l,t.flags|=4),t.subtreeFlags=0,l=o,o=t.child;o!==null;)p=o,e=l,p.flags&=14680066,y=p.alternate,y===null?(p.childLanes=0,p.lanes=e,p.child=null,p.subtreeFlags=0,p.memoizedProps=null,p.memoizedState=null,p.updateQueue=null,p.dependencies=null,p.stateNode=null):(p.childLanes=y.childLanes,p.lanes=y.lanes,p.child=y.child,p.subtreeFlags=0,p.deletions=null,p.memoizedProps=y.memoizedProps,p.memoizedState=y.memoizedState,p.updateQueue=y.updateQueue,p.type=y.type,e=y.dependencies,p.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),o=o.sibling;return Le(ze,ze.current&1|2),t.child}e=e.sibling}p.tail!==null&&We()>Zr&&(t.flags|=128,l=!0,Wo(p,!1),t.lanes=4194304)}else{if(!l)if(e=Ys(y),e!==null){if(t.flags|=128,l=!0,o=e.updateQueue,o!==null&&(t.updateQueue=o,t.flags|=4),Wo(p,!0),p.tail===null&&p.tailMode===\"hidden\"&&!y.alternate&&!Me)return ct(t),null}else 2*We()-p.renderingStartTime>Zr&&o!==1073741824&&(t.flags|=128,l=!0,Wo(p,!1),t.lanes=4194304);p.isBackwards?(y.sibling=t.child,t.child=y):(o=p.last,o!==null?o.sibling=y:t.child=y,p.last=y)}return p.tail!==null?(t=p.tail,p.rendering=t,p.tail=t.sibling,p.renderingStartTime=We(),t.sibling=null,o=ze.current,Le(ze,l?o&1|2:o&1),t):(ct(t),null);case 22:case 23:return Ga(),l=t.memoizedState!==null,e!==null&&e.memoizedState!==null!==l&&(t.flags|=8192),l&&(t.mode&1)!==0?(Rt&1073741824)!==0&&(ct(t),t.subtreeFlags&6&&(t.flags|=8192)):ct(t),null;case 24:return null;case 25:return null}throw Error(s(156,t.tag))}function jy(e,t){switch(na(t),t.tag){case 1:return xt(t.type)&&zs(),e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 3:return Gr(),Ae(yt),Ae(at),ma(),e=t.flags,(e&65536)!==0&&(e&128)===0?(t.flags=e&-65537|128,t):null;case 5:return pa(t),null;case 13:if(Ae(ze),e=t.memoizedState,e!==null&&e.dehydrated!==null){if(t.alternate===null)throw Error(s(340));Ur()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 19:return Ae(ze),null;case 4:return Gr(),null;case 10:return aa(t.type._context),null;case 22:case 23:return Ga(),null;case 24:return null;default:return null}}var oi=!1,dt=!1,_y=typeof WeakSet==\"function\"?WeakSet:Set,ue=null;function Yr(e,t){var o=e.ref;if(o!==null)if(typeof o==\"function\")try{o(null)}catch(l){He(e,t,l)}else o.current=null}function Aa(e,t,o){try{o()}catch(l){He(e,t,l)}}var Hf=!1;function Ty(e,t){if(Gl=bs,e=Sd(),Fl(e)){if(\"selectionStart\"in e)var o={start:e.selectionStart,end:e.selectionEnd};else e:{o=(o=e.ownerDocument)&&o.defaultView||window;var l=o.getSelection&&o.getSelection();if(l&&l.rangeCount!==0){o=l.anchorNode;var c=l.anchorOffset,p=l.focusNode;l=l.focusOffset;try{o.nodeType,p.nodeType}catch{o=null;break e}var y=0,P=-1,R=-1,F=0,G=0,Y=e,K=null;t:for(;;){for(var ie;Y!==o||c!==0&&Y.nodeType!==3||(P=y+c),Y!==p||l!==0&&Y.nodeType!==3||(R=y+l),Y.nodeType===3&&(y+=Y.nodeValue.length),(ie=Y.firstChild)!==null;)K=Y,Y=ie;for(;;){if(Y===e)break t;if(K===o&&++F===c&&(P=y),K===p&&++G===l&&(R=y),(ie=Y.nextSibling)!==null)break;Y=K,K=Y.parentNode}Y=ie}o=P===-1||R===-1?null:{start:P,end:R}}else o=null}o=o||{start:0,end:0}}else o=null;for(Ql={focusedElem:e,selectionRange:o},bs=!1,ue=t;ue!==null;)if(t=ue,e=t.child,(t.subtreeFlags&1028)!==0&&e!==null)e.return=t,ue=e;else for(;ue!==null;){t=ue;try{var de=t.alternate;if((t.flags&1024)!==0)switch(t.tag){case 0:case 11:case 15:break;case 1:if(de!==null){var he=de.memoizedProps,Ke=de.memoizedState,A=t.stateNode,j=A.getSnapshotBeforeUpdate(t.elementType===t.type?he:Bt(t.type,he),Ke);A.__reactInternalSnapshotBeforeUpdate=j}break;case 3:var z=t.stateNode.containerInfo;z.nodeType===1?z.textContent=\"\":z.nodeType===9&&z.documentElement&&z.removeChild(z.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(s(163))}}catch(te){He(t,t.return,te)}if(e=t.sibling,e!==null){e.return=t.return,ue=e;break}ue=t.return}return de=Hf,Hf=!1,de}function Ko(e,t,o){var l=t.updateQueue;if(l=l!==null?l.lastEffect:null,l!==null){var c=l=l.next;do{if((c.tag&e)===e){var p=c.destroy;c.destroy=void 0,p!==void 0&&Aa(t,o,p)}c=c.next}while(c!==l)}}function si(e,t){if(t=t.updateQueue,t=t!==null?t.lastEffect:null,t!==null){var o=t=t.next;do{if((o.tag&e)===e){var l=o.create;o.destroy=l()}o=o.next}while(o!==t)}}function Da(e){var t=e.ref;if(t!==null){var o=e.stateNode;e.tag,e=o,typeof t==\"function\"?t(e):t.current=e}}function Wf(e){var t=e.alternate;t!==null&&(e.alternate=null,Wf(t)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(t=e.stateNode,t!==null&&(delete t[Zt],delete t[Ao],delete t[ql],delete t[hy],delete t[my])),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}function Kf(e){return e.tag===5||e.tag===3||e.tag===4}function Gf(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||Kf(e.return))return null;e=e.return}for(e.sibling.return=e.return,e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.flags&2||e.child===null||e.tag===4)continue e;e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function Ma(e,t,o){var l=e.tag;if(l===5||l===6)e=e.stateNode,t?o.nodeType===8?o.parentNode.insertBefore(e,t):o.insertBefore(e,t):(o.nodeType===8?(t=o.parentNode,t.insertBefore(e,o)):(t=o,t.appendChild(e)),o=o._reactRootContainer,o!=null||t.onclick!==null||(t.onclick=Ds));else if(l!==4&&(e=e.child,e!==null))for(Ma(e,t,o),e=e.sibling;e!==null;)Ma(e,t,o),e=e.sibling}function za(e,t,o){var l=e.tag;if(l===5||l===6)e=e.stateNode,t?o.insertBefore(e,t):o.appendChild(e);else if(l!==4&&(e=e.child,e!==null))for(za(e,t,o),e=e.sibling;e!==null;)za(e,t,o),e=e.sibling}var st=null,Ut=!1;function Fn(e,t,o){for(o=o.child;o!==null;)Qf(e,t,o),o=o.sibling}function Qf(e,t,o){if(Xt&&typeof Xt.onCommitFiberUnmount==\"function\")try{Xt.onCommitFiberUnmount(ys,o)}catch{}switch(o.tag){case 5:dt||Yr(o,t);case 6:var l=st,c=Ut;st=null,Fn(e,t,o),st=l,Ut=c,st!==null&&(Ut?(e=st,o=o.stateNode,e.nodeType===8?e.parentNode.removeChild(o):e.removeChild(o)):st.removeChild(o.stateNode));break;case 18:st!==null&&(Ut?(e=st,o=o.stateNode,e.nodeType===8?Zl(e.parentNode,o):e.nodeType===1&&Zl(e,o),bo(e)):Zl(st,o.stateNode));break;case 4:l=st,c=Ut,st=o.stateNode.containerInfo,Ut=!0,Fn(e,t,o),st=l,Ut=c;break;case 0:case 11:case 14:case 15:if(!dt&&(l=o.updateQueue,l!==null&&(l=l.lastEffect,l!==null))){c=l=l.next;do{var p=c,y=p.destroy;p=p.tag,y!==void 0&&((p&2)!==0||(p&4)!==0)&&Aa(o,t,y),c=c.next}while(c!==l)}Fn(e,t,o);break;case 1:if(!dt&&(Yr(o,t),l=o.stateNode,typeof l.componentWillUnmount==\"function\"))try{l.props=o.memoizedProps,l.state=o.memoizedState,l.componentWillUnmount()}catch(P){He(o,t,P)}Fn(e,t,o);break;case 21:Fn(e,t,o);break;case 22:o.mode&1?(dt=(l=dt)||o.memoizedState!==null,Fn(e,t,o),dt=l):Fn(e,t,o);break;default:Fn(e,t,o)}}function Yf(e){var t=e.updateQueue;if(t!==null){e.updateQueue=null;var o=e.stateNode;o===null&&(o=e.stateNode=new _y),t.forEach(function(l){var c=Vy.bind(null,e,l);o.has(l)||(o.add(l),l.then(c,c))})}}function Ht(e,t){var o=t.deletions;if(o!==null)for(var l=0;l<o.length;l++){var c=o[l];try{var p=e,y=t,P=y;e:for(;P!==null;){switch(P.tag){case 5:st=P.stateNode,Ut=!1;break e;case 3:st=P.stateNode.containerInfo,Ut=!0;break e;case 4:st=P.stateNode.containerInfo,Ut=!0;break e}P=P.return}if(st===null)throw Error(s(160));Qf(p,y,c),st=null,Ut=!1;var R=c.alternate;R!==null&&(R.return=null),c.return=null}catch(F){He(c,t,F)}}if(t.subtreeFlags&12854)for(t=t.child;t!==null;)Xf(t,e),t=t.sibling}function Xf(e,t){var o=e.alternate,l=e.flags;switch(e.tag){case 0:case 11:case 14:case 15:if(Ht(t,e),en(e),l&4){try{Ko(3,e,e.return),si(3,e)}catch(he){He(e,e.return,he)}try{Ko(5,e,e.return)}catch(he){He(e,e.return,he)}}break;case 1:Ht(t,e),en(e),l&512&&o!==null&&Yr(o,o.return);break;case 5:if(Ht(t,e),en(e),l&512&&o!==null&&Yr(o,o.return),e.flags&32){var c=e.stateNode;try{po(c,\"\")}catch(he){He(e,e.return,he)}}if(l&4&&(c=e.stateNode,c!=null)){var p=e.memoizedProps,y=o!==null?o.memoizedProps:p,P=e.type,R=e.updateQueue;if(e.updateQueue=null,R!==null)try{P===\"input\"&&p.type===\"radio\"&&p.name!=null&&Pr(c,p),ml(P,y);var F=ml(P,p);for(y=0;y<R.length;y+=2){var G=R[y],Y=R[y+1];G===\"style\"?_c(c,Y):G===\"dangerouslySetInnerHTML\"?Oc(c,Y):G===\"children\"?po(c,Y):T(c,G,Y,F)}switch(P){case\"input\":er(c,p);break;case\"textarea\":Pc(c,p);break;case\"select\":var K=c._wrapperState.wasMultiple;c._wrapperState.wasMultiple=!!p.multiple;var ie=p.value;ie!=null?Rr(c,!!p.multiple,ie,!1):K!==!!p.multiple&&(p.defaultValue!=null?Rr(c,!!p.multiple,p.defaultValue,!0):Rr(c,!!p.multiple,p.multiple?[]:\"\",!1))}c[Ao]=p}catch(he){He(e,e.return,he)}}break;case 6:if(Ht(t,e),en(e),l&4){if(e.stateNode===null)throw Error(s(162));c=e.stateNode,p=e.memoizedProps;try{c.nodeValue=p}catch(he){He(e,e.return,he)}}break;case 3:if(Ht(t,e),en(e),l&4&&o!==null&&o.memoizedState.isDehydrated)try{bo(t.containerInfo)}catch(he){He(e,e.return,he)}break;case 4:Ht(t,e),en(e);break;case 13:Ht(t,e),en(e),c=e.child,c.flags&8192&&(p=c.memoizedState!==null,c.stateNode.isHidden=p,!p||c.alternate!==null&&c.alternate.memoizedState!==null||(Va=We())),l&4&&Yf(e);break;case 22:if(G=o!==null&&o.memoizedState!==null,e.mode&1?(dt=(F=dt)||G,Ht(t,e),dt=F):Ht(t,e),en(e),l&8192){if(F=e.memoizedState!==null,(e.stateNode.isHidden=F)&&!G&&(e.mode&1)!==0)for(ue=e,G=e.child;G!==null;){for(Y=ue=G;ue!==null;){switch(K=ue,ie=K.child,K.tag){case 0:case 11:case 14:case 15:Ko(4,K,K.return);break;case 1:Yr(K,K.return);var de=K.stateNode;if(typeof de.componentWillUnmount==\"function\"){l=K,o=K.return;try{t=l,de.props=t.memoizedProps,de.state=t.memoizedState,de.componentWillUnmount()}catch(he){He(l,o,he)}}break;case 5:Yr(K,K.return);break;case 22:if(K.memoizedState!==null){Jf(Y);continue}}ie!==null?(ie.return=K,ue=ie):Jf(Y)}G=G.sibling}e:for(G=null,Y=e;;){if(Y.tag===5){if(G===null){G=Y;try{c=Y.stateNode,F?(p=c.style,typeof p.setProperty==\"function\"?p.setProperty(\"display\",\"none\",\"important\"):p.display=\"none\"):(P=Y.stateNode,R=Y.memoizedProps.style,y=R!=null&&R.hasOwnProperty(\"display\")?R.display:null,P.style.display=jc(\"display\",y))}catch(he){He(e,e.return,he)}}}else if(Y.tag===6){if(G===null)try{Y.stateNode.nodeValue=F?\"\":Y.memoizedProps}catch(he){He(e,e.return,he)}}else if((Y.tag!==22&&Y.tag!==23||Y.memoizedState===null||Y===e)&&Y.child!==null){Y.child.return=Y,Y=Y.child;continue}if(Y===e)break e;for(;Y.sibling===null;){if(Y.return===null||Y.return===e)break e;G===Y&&(G=null),Y=Y.return}G===Y&&(G=null),Y.sibling.return=Y.return,Y=Y.sibling}}break;case 19:Ht(t,e),en(e),l&4&&Yf(e);break;case 21:break;default:Ht(t,e),en(e)}}function en(e){var t=e.flags;if(t&2){try{e:{for(var o=e.return;o!==null;){if(Kf(o)){var l=o;break e}o=o.return}throw Error(s(160))}switch(l.tag){case 5:var c=l.stateNode;l.flags&32&&(po(c,\"\"),l.flags&=-33);var p=Gf(e);za(e,p,c);break;case 3:case 4:var y=l.stateNode.containerInfo,P=Gf(e);Ma(e,P,y);break;default:throw Error(s(161))}}catch(R){He(e,e.return,R)}e.flags&=-3}t&4096&&(e.flags&=-4097)}function Ly(e,t,o){ue=e,Zf(e)}function Zf(e,t,o){for(var l=(e.mode&1)!==0;ue!==null;){var c=ue,p=c.child;if(c.tag===22&&l){var y=c.memoizedState!==null||oi;if(!y){var P=c.alternate,R=P!==null&&P.memoizedState!==null||dt;P=oi;var F=dt;if(oi=y,(dt=R)&&!F)for(ue=c;ue!==null;)y=ue,R=y.child,y.tag===22&&y.memoizedState!==null?ep(c):R!==null?(R.return=y,ue=R):ep(c);for(;p!==null;)ue=p,Zf(p),p=p.sibling;ue=c,oi=P,dt=F}qf(e)}else(c.subtreeFlags&8772)!==0&&p!==null?(p.return=c,ue=p):qf(e)}}function qf(e){for(;ue!==null;){var t=ue;if((t.flags&8772)!==0){var o=t.alternate;try{if((t.flags&8772)!==0)switch(t.tag){case 0:case 11:case 15:dt||si(5,t);break;case 1:var l=t.stateNode;if(t.flags&4&&!dt)if(o===null)l.componentDidMount();else{var c=t.elementType===t.type?o.memoizedProps:Bt(t.type,o.memoizedProps);l.componentDidUpdate(c,o.memoizedState,l.__reactInternalSnapshotBeforeUpdate)}var p=t.updateQueue;p!==null&&qd(t,p,l);break;case 3:var y=t.updateQueue;if(y!==null){if(o=null,t.child!==null)switch(t.child.tag){case 5:o=t.child.stateNode;break;case 1:o=t.child.stateNode}qd(t,y,o)}break;case 5:var P=t.stateNode;if(o===null&&t.flags&4){o=P;var R=t.memoizedProps;switch(t.type){case\"button\":case\"input\":case\"select\":case\"textarea\":R.autoFocus&&o.focus();break;case\"img\":R.src&&(o.src=R.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(t.memoizedState===null){var F=t.alternate;if(F!==null){var G=F.memoizedState;if(G!==null){var Y=G.dehydrated;Y!==null&&bo(Y)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;default:throw Error(s(163))}dt||t.flags&512&&Da(t)}catch(K){He(t,t.return,K)}}if(t===e){ue=null;break}if(o=t.sibling,o!==null){o.return=t.return,ue=o;break}ue=t.return}}function Jf(e){for(;ue!==null;){var t=ue;if(t===e){ue=null;break}var o=t.sibling;if(o!==null){o.return=t.return,ue=o;break}ue=t.return}}function ep(e){for(;ue!==null;){var t=ue;try{switch(t.tag){case 0:case 11:case 15:var o=t.return;try{si(4,t)}catch(R){He(t,o,R)}break;case 1:var l=t.stateNode;if(typeof l.componentDidMount==\"function\"){var c=t.return;try{l.componentDidMount()}catch(R){He(t,c,R)}}var p=t.return;try{Da(t)}catch(R){He(t,p,R)}break;case 5:var y=t.return;try{Da(t)}catch(R){He(t,y,R)}}}catch(R){He(t,t.return,R)}if(t===e){ue=null;break}var P=t.sibling;if(P!==null){P.return=t.return,ue=P;break}ue=t.return}}var Iy=Math.ceil,ii=O.ReactCurrentDispatcher,Fa=O.ReactCurrentOwner,At=O.ReactCurrentBatchConfig,Ne=0,tt=null,Qe=null,it=0,Rt=0,Xr=In(0),Ze=0,Go=null,ur=0,li=0,$a=0,Qo=null,St=null,Va=0,Zr=1/0,gn=null,ai=!1,Ba=null,$n=null,ui=!1,Vn=null,ci=0,Yo=0,Ua=null,di=-1,fi=0;function mt(){return(Ne&6)!==0?We():di!==-1?di:di=We()}function Bn(e){return(e.mode&1)===0?1:(Ne&2)!==0&&it!==0?it&-it:vy.transition!==null?(fi===0&&(fi=Kc()),fi):(e=Te,e!==0||(e=window.event,e=e===void 0?16:td(e.type)),e)}function Wt(e,t,o,l){if(50<Yo)throw Yo=0,Ua=null,Error(s(185));xo(e,o,l),((Ne&2)===0||e!==tt)&&(e===tt&&((Ne&2)===0&&(li|=o),Ze===4&&Un(e,it)),Ct(e,l),o===1&&Ne===0&&(t.mode&1)===0&&(Zr=We()+500,$s&&Dn()))}function Ct(e,t){var o=e.callbackNode;vv(e,t);var l=Ss(e,e===tt?it:0);if(l===0)o!==null&&Uc(o),e.callbackNode=null,e.callbackPriority=0;else if(t=l&-l,e.callbackPriority!==t){if(o!=null&&Uc(o),t===1)e.tag===0?gy(np.bind(null,e)):$d(np.bind(null,e)),fy(function(){(Ne&6)===0&&Dn()}),o=null;else{switch(Gc(l)){case 1:o=Cl;break;case 4:o=Hc;break;case 16:o=vs;break;case 536870912:o=Wc;break;default:o=vs}o=cp(o,tp.bind(null,e))}e.callbackPriority=t,e.callbackNode=o}}function tp(e,t){if(di=-1,fi=0,(Ne&6)!==0)throw Error(s(327));var o=e.callbackNode;if(qr()&&e.callbackNode!==o)return null;var l=Ss(e,e===tt?it:0);if(l===0)return null;if((l&30)!==0||(l&e.expiredLanes)!==0||t)t=pi(e,l);else{t=l;var c=Ne;Ne|=2;var p=op();(tt!==e||it!==t)&&(gn=null,Zr=We()+500,dr(e,t));do try{My();break}catch(P){rp(e,P)}while(!0);la(),ii.current=p,Ne=c,Qe!==null?t=0:(tt=null,it=0,t=Ze)}if(t!==0){if(t===2&&(c=kl(e),c!==0&&(l=c,t=Ha(e,c))),t===1)throw o=Go,dr(e,0),Un(e,l),Ct(e,We()),o;if(t===6)Un(e,l);else{if(c=e.current.alternate,(l&30)===0&&!Ay(c)&&(t=pi(e,l),t===2&&(p=kl(e),p!==0&&(l=p,t=Ha(e,p))),t===1))throw o=Go,dr(e,0),Un(e,l),Ct(e,We()),o;switch(e.finishedWork=c,e.finishedLanes=l,t){case 0:case 1:throw Error(s(345));case 2:fr(e,St,gn);break;case 3:if(Un(e,l),(l&130023424)===l&&(t=Va+500-We(),10<t)){if(Ss(e,0)!==0)break;if(c=e.suspendedLanes,(c&l)!==l){mt(),e.pingedLanes|=e.suspendedLanes&c;break}e.timeoutHandle=Xl(fr.bind(null,e,St,gn),t);break}fr(e,St,gn);break;case 4:if(Un(e,l),(l&4194240)===l)break;for(t=e.eventTimes,c=-1;0<l;){var y=31-Ft(l);p=1<<y,y=t[y],y>c&&(c=y),l&=~p}if(l=c,l=We()-l,l=(120>l?120:480>l?480:1080>l?1080:1920>l?1920:3e3>l?3e3:4320>l?4320:1960*Iy(l/1960))-l,10<l){e.timeoutHandle=Xl(fr.bind(null,e,St,gn),l);break}fr(e,St,gn);break;case 5:fr(e,St,gn);break;default:throw Error(s(329))}}}return Ct(e,We()),e.callbackNode===o?tp.bind(null,e):null}function Ha(e,t){var o=Qo;return e.current.memoizedState.isDehydrated&&(dr(e,t).flags|=256),e=pi(e,t),e!==2&&(t=St,St=o,t!==null&&Wa(t)),e}function Wa(e){St===null?St=e:St.push.apply(St,e)}function Ay(e){for(var t=e;;){if(t.flags&16384){var o=t.updateQueue;if(o!==null&&(o=o.stores,o!==null))for(var l=0;l<o.length;l++){var c=o[l],p=c.getSnapshot;c=c.value;try{if(!$t(p(),c))return!1}catch{return!1}}}if(o=t.child,t.subtreeFlags&16384&&o!==null)o.return=t,t=o;else{if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return!0;t=t.return}t.sibling.return=t.return,t=t.sibling}}return!0}function Un(e,t){for(t&=~$a,t&=~li,e.suspendedLanes|=t,e.pingedLanes&=~t,e=e.expirationTimes;0<t;){var o=31-Ft(t),l=1<<o;e[o]=-1,t&=~l}}function np(e){if((Ne&6)!==0)throw Error(s(327));qr();var t=Ss(e,0);if((t&1)===0)return Ct(e,We()),null;var o=pi(e,t);if(e.tag!==0&&o===2){var l=kl(e);l!==0&&(t=l,o=Ha(e,l))}if(o===1)throw o=Go,dr(e,0),Un(e,t),Ct(e,We()),o;if(o===6)throw Error(s(345));return e.finishedWork=e.current.alternate,e.finishedLanes=t,fr(e,St,gn),Ct(e,We()),null}function Ka(e,t){var o=Ne;Ne|=1;try{return e(t)}finally{Ne=o,Ne===0&&(Zr=We()+500,$s&&Dn())}}function cr(e){Vn!==null&&Vn.tag===0&&(Ne&6)===0&&qr();var t=Ne;Ne|=1;var o=At.transition,l=Te;try{if(At.transition=null,Te=1,e)return e()}finally{Te=l,At.transition=o,Ne=t,(Ne&6)===0&&Dn()}}function Ga(){Rt=Xr.current,Ae(Xr)}function dr(e,t){e.finishedWork=null,e.finishedLanes=0;var o=e.timeoutHandle;if(o!==-1&&(e.timeoutHandle=-1,dy(o)),Qe!==null)for(o=Qe.return;o!==null;){var l=o;switch(na(l),l.tag){case 1:l=l.type.childContextTypes,l!=null&&zs();break;case 3:Gr(),Ae(yt),Ae(at),ma();break;case 5:pa(l);break;case 4:Gr();break;case 13:Ae(ze);break;case 19:Ae(ze);break;case 10:aa(l.type._context);break;case 22:case 23:Ga()}o=o.return}if(tt=e,Qe=e=Hn(e.current,null),it=Rt=t,Ze=0,Go=null,$a=li=ur=0,St=Qo=null,ir!==null){for(t=0;t<ir.length;t++)if(o=ir[t],l=o.interleaved,l!==null){o.interleaved=null;var c=l.next,p=o.pending;if(p!==null){var y=p.next;p.next=c,l.next=y}o.pending=l}ir=null}return e}function rp(e,t){do{var o=Qe;try{if(la(),Xs.current=ei,Zs){for(var l=Fe.memoizedState;l!==null;){var c=l.queue;c!==null&&(c.pending=null),l=l.next}Zs=!1}if(ar=0,et=Xe=Fe=null,Vo=!1,Bo=0,Fa.current=null,o===null||o.return===null){Ze=1,Go=t,Qe=null;break}e:{var p=e,y=o.return,P=o,R=t;if(t=it,P.flags|=32768,R!==null&&typeof R==\"object\"&&typeof R.then==\"function\"){var F=R,G=P,Y=G.tag;if((G.mode&1)===0&&(Y===0||Y===11||Y===15)){var K=G.alternate;K?(G.updateQueue=K.updateQueue,G.memoizedState=K.memoizedState,G.lanes=K.lanes):(G.updateQueue=null,G.memoizedState=null)}var ie=Rf(y);if(ie!==null){ie.flags&=-257,Of(ie,y,P,p,t),ie.mode&1&&Nf(p,F,t),t=ie,R=F;var de=t.updateQueue;if(de===null){var he=new Set;he.add(R),t.updateQueue=he}else de.add(R);break e}else{if((t&1)===0){Nf(p,F,t),Qa();break e}R=Error(s(426))}}else if(Me&&P.mode&1){var Ke=Rf(y);if(Ke!==null){(Ke.flags&65536)===0&&(Ke.flags|=256),Of(Ke,y,P,p,t),sa(Qr(R,P));break e}}p=R=Qr(R,P),Ze!==4&&(Ze=2),Qo===null?Qo=[p]:Qo.push(p),p=y;do{switch(p.tag){case 3:p.flags|=65536,t&=-t,p.lanes|=t;var A=Ef(p,R,t);Zd(p,A);break e;case 1:P=R;var j=p.type,z=p.stateNode;if((p.flags&128)===0&&(typeof j.getDerivedStateFromError==\"function\"||z!==null&&typeof z.componentDidCatch==\"function\"&&($n===null||!$n.has(z)))){p.flags|=65536,t&=-t,p.lanes|=t;var te=Pf(p,P,t);Zd(p,te);break e}}p=p.return}while(p!==null)}ip(o)}catch(me){t=me,Qe===o&&o!==null&&(Qe=o=o.return);continue}break}while(!0)}function op(){var e=ii.current;return ii.current=ei,e===null?ei:e}function Qa(){(Ze===0||Ze===3||Ze===2)&&(Ze=4),tt===null||(ur&268435455)===0&&(li&268435455)===0||Un(tt,it)}function pi(e,t){var o=Ne;Ne|=2;var l=op();(tt!==e||it!==t)&&(gn=null,dr(e,t));do try{Dy();break}catch(c){rp(e,c)}while(!0);if(la(),Ne=o,ii.current=l,Qe!==null)throw Error(s(261));return tt=null,it=0,Ze}function Dy(){for(;Qe!==null;)sp(Qe)}function My(){for(;Qe!==null&&!av();)sp(Qe)}function sp(e){var t=up(e.alternate,e,Rt);e.memoizedProps=e.pendingProps,t===null?ip(e):Qe=t,Fa.current=null}function ip(e){var t=e;do{var o=t.alternate;if(e=t.return,(t.flags&32768)===0){if(o=Oy(o,t,Rt),o!==null){Qe=o;return}}else{if(o=jy(o,t),o!==null){o.flags&=32767,Qe=o;return}if(e!==null)e.flags|=32768,e.subtreeFlags=0,e.deletions=null;else{Ze=6,Qe=null;return}}if(t=t.sibling,t!==null){Qe=t;return}Qe=t=e}while(t!==null);Ze===0&&(Ze=5)}function fr(e,t,o){var l=Te,c=At.transition;try{At.transition=null,Te=1,zy(e,t,o,l)}finally{At.transition=c,Te=l}return null}function zy(e,t,o,l){do qr();while(Vn!==null);if((Ne&6)!==0)throw Error(s(327));o=e.finishedWork;var c=e.finishedLanes;if(o===null)return null;if(e.finishedWork=null,e.finishedLanes=0,o===e.current)throw Error(s(177));e.callbackNode=null,e.callbackPriority=0;var p=o.lanes|o.childLanes;if(yv(e,p),e===tt&&(Qe=tt=null,it=0),(o.subtreeFlags&2064)===0&&(o.flags&2064)===0||ui||(ui=!0,cp(vs,function(){return qr(),null})),p=(o.flags&15990)!==0,(o.subtreeFlags&15990)!==0||p){p=At.transition,At.transition=null;var y=Te;Te=1;var P=Ne;Ne|=4,Fa.current=null,Ty(e,o),Xf(o,e),oy(Ql),bs=!!Gl,Ql=Gl=null,e.current=o,Ly(o),uv(),Ne=P,Te=y,At.transition=p}else e.current=o;if(ui&&(ui=!1,Vn=e,ci=c),p=e.pendingLanes,p===0&&($n=null),fv(o.stateNode),Ct(e,We()),t!==null)for(l=e.onRecoverableError,o=0;o<t.length;o++)c=t[o],l(c.value,{componentStack:c.stack,digest:c.digest});if(ai)throw ai=!1,e=Ba,Ba=null,e;return(ci&1)!==0&&e.tag!==0&&qr(),p=e.pendingLanes,(p&1)!==0?e===Ua?Yo++:(Yo=0,Ua=e):Yo=0,Dn(),null}function qr(){if(Vn!==null){var e=Gc(ci),t=At.transition,o=Te;try{if(At.transition=null,Te=16>e?16:e,Vn===null)var l=!1;else{if(e=Vn,Vn=null,ci=0,(Ne&6)!==0)throw Error(s(331));var c=Ne;for(Ne|=4,ue=e.current;ue!==null;){var p=ue,y=p.child;if((ue.flags&16)!==0){var P=p.deletions;if(P!==null){for(var R=0;R<P.length;R++){var F=P[R];for(ue=F;ue!==null;){var G=ue;switch(G.tag){case 0:case 11:case 15:Ko(8,G,p)}var Y=G.child;if(Y!==null)Y.return=G,ue=Y;else for(;ue!==null;){G=ue;var K=G.sibling,ie=G.return;if(Wf(G),G===F){ue=null;break}if(K!==null){K.return=ie,ue=K;break}ue=ie}}}var de=p.alternate;if(de!==null){var he=de.child;if(he!==null){de.child=null;do{var Ke=he.sibling;he.sibling=null,he=Ke}while(he!==null)}}ue=p}}if((p.subtreeFlags&2064)!==0&&y!==null)y.return=p,ue=y;else e:for(;ue!==null;){if(p=ue,(p.flags&2048)!==0)switch(p.tag){case 0:case 11:case 15:Ko(9,p,p.return)}var A=p.sibling;if(A!==null){A.return=p.return,ue=A;break e}ue=p.return}}var j=e.current;for(ue=j;ue!==null;){y=ue;var z=y.child;if((y.subtreeFlags&2064)!==0&&z!==null)z.return=y,ue=z;else e:for(y=j;ue!==null;){if(P=ue,(P.flags&2048)!==0)try{switch(P.tag){case 0:case 11:case 15:si(9,P)}}catch(me){He(P,P.return,me)}if(P===y){ue=null;break e}var te=P.sibling;if(te!==null){te.return=P.return,ue=te;break e}ue=P.return}}if(Ne=c,Dn(),Xt&&typeof Xt.onPostCommitFiberRoot==\"function\")try{Xt.onPostCommitFiberRoot(ys,e)}catch{}l=!0}return l}finally{Te=o,At.transition=t}}return!1}function lp(e,t,o){t=Qr(o,t),t=Ef(e,t,1),e=zn(e,t,1),t=mt(),e!==null&&(xo(e,1,t),Ct(e,t))}function He(e,t,o){if(e.tag===3)lp(e,e,o);else for(;t!==null;){if(t.tag===3){lp(t,e,o);break}else if(t.tag===1){var l=t.stateNode;if(typeof t.type.getDerivedStateFromError==\"function\"||typeof l.componentDidCatch==\"function\"&&($n===null||!$n.has(l))){e=Qr(o,e),e=Pf(t,e,1),t=zn(t,e,1),e=mt(),t!==null&&(xo(t,1,e),Ct(t,e));break}}t=t.return}}function Fy(e,t,o){var l=e.pingCache;l!==null&&l.delete(t),t=mt(),e.pingedLanes|=e.suspendedLanes&o,tt===e&&(it&o)===o&&(Ze===4||Ze===3&&(it&130023424)===it&&500>We()-Va?dr(e,0):$a|=o),Ct(e,t)}function ap(e,t){t===0&&((e.mode&1)===0?t=1:(t=ws,ws<<=1,(ws&130023424)===0&&(ws=4194304)));var o=mt();e=pn(e,t),e!==null&&(xo(e,t,o),Ct(e,o))}function $y(e){var t=e.memoizedState,o=0;t!==null&&(o=t.retryLane),ap(e,o)}function Vy(e,t){var o=0;switch(e.tag){case 13:var l=e.stateNode,c=e.memoizedState;c!==null&&(o=c.retryLane);break;case 19:l=e.stateNode;break;default:throw Error(s(314))}l!==null&&l.delete(t),ap(e,o)}var up;up=function(e,t,o){if(e!==null)if(e.memoizedProps!==t.pendingProps||yt.current)wt=!0;else{if((e.lanes&o)===0&&(t.flags&128)===0)return wt=!1,Ry(e,t,o);wt=(e.flags&131072)!==0}else wt=!1,Me&&(t.flags&1048576)!==0&&Vd(t,Bs,t.index);switch(t.lanes=0,t.tag){case 2:var l=t.type;ri(e,t),e=t.pendingProps;var c=$r(t,at.current);Kr(t,o),c=ya(null,t,l,e,c,o);var p=xa();return t.flags|=1,typeof c==\"object\"&&c!==null&&typeof c.render==\"function\"&&c.$$typeof===void 0?(t.tag=1,t.memoizedState=null,t.updateQueue=null,xt(l)?(p=!0,Fs(t)):p=!1,t.memoizedState=c.state!==null&&c.state!==void 0?c.state:null,da(t),c.updater=ti,t.stateNode=c,c._reactInternals=t,Ea(t,l,e,o),t=Oa(null,t,l,!0,p,o)):(t.tag=0,Me&&p&&ta(t),ht(null,t,c,o),t=t.child),t;case 16:l=t.elementType;e:{switch(ri(e,t),e=t.pendingProps,c=l._init,l=c(l._payload),t.type=l,c=t.tag=Uy(l),e=Bt(l,e),c){case 0:t=Ra(null,t,l,e,o);break e;case 1:t=Af(null,t,l,e,o);break e;case 11:t=jf(null,t,l,e,o);break e;case 14:t=_f(null,t,l,Bt(l.type,e),o);break e}throw Error(s(306,l,\"\"))}return t;case 0:return l=t.type,c=t.pendingProps,c=t.elementType===l?c:Bt(l,c),Ra(e,t,l,c,o);case 1:return l=t.type,c=t.pendingProps,c=t.elementType===l?c:Bt(l,c),Af(e,t,l,c,o);case 3:e:{if(Df(t),e===null)throw Error(s(387));l=t.pendingProps,p=t.memoizedState,c=p.element,Xd(e,t),Qs(t,l,null,o);var y=t.memoizedState;if(l=y.element,p.isDehydrated)if(p={element:l,isDehydrated:!1,cache:y.cache,pendingSuspenseBoundaries:y.pendingSuspenseBoundaries,transitions:y.transitions},t.updateQueue.baseState=p,t.memoizedState=p,t.flags&256){c=Qr(Error(s(423)),t),t=Mf(e,t,l,o,c);break e}else if(l!==c){c=Qr(Error(s(424)),t),t=Mf(e,t,l,o,c);break e}else for(Nt=Ln(t.stateNode.containerInfo.firstChild),Pt=t,Me=!0,Vt=null,o=Qd(t,null,l,o),t.child=o;o;)o.flags=o.flags&-3|4096,o=o.sibling;else{if(Ur(),l===c){t=mn(e,t,o);break e}ht(e,t,l,o)}t=t.child}return t;case 5:return Jd(t),e===null&&oa(t),l=t.type,c=t.pendingProps,p=e!==null?e.memoizedProps:null,y=c.children,Yl(l,c)?y=null:p!==null&&Yl(l,p)&&(t.flags|=32),If(e,t),ht(e,t,y,o),t.child;case 6:return e===null&&oa(t),null;case 13:return zf(e,t,o);case 4:return fa(t,t.stateNode.containerInfo),l=t.pendingProps,e===null?t.child=Hr(t,null,l,o):ht(e,t,l,o),t.child;case 11:return l=t.type,c=t.pendingProps,c=t.elementType===l?c:Bt(l,c),jf(e,t,l,c,o);case 7:return ht(e,t,t.pendingProps,o),t.child;case 8:return ht(e,t,t.pendingProps.children,o),t.child;case 12:return ht(e,t,t.pendingProps.children,o),t.child;case 10:e:{if(l=t.type._context,c=t.pendingProps,p=t.memoizedProps,y=c.value,Le(Ws,l._currentValue),l._currentValue=y,p!==null)if($t(p.value,y)){if(p.children===c.children&&!yt.current){t=mn(e,t,o);break e}}else for(p=t.child,p!==null&&(p.return=t);p!==null;){var P=p.dependencies;if(P!==null){y=p.child;for(var R=P.firstContext;R!==null;){if(R.context===l){if(p.tag===1){R=hn(-1,o&-o),R.tag=2;var F=p.updateQueue;if(F!==null){F=F.shared;var G=F.pending;G===null?R.next=R:(R.next=G.next,G.next=R),F.pending=R}}p.lanes|=o,R=p.alternate,R!==null&&(R.lanes|=o),ua(p.return,o,t),P.lanes|=o;break}R=R.next}}else if(p.tag===10)y=p.type===t.type?null:p.child;else if(p.tag===18){if(y=p.return,y===null)throw Error(s(341));y.lanes|=o,P=y.alternate,P!==null&&(P.lanes|=o),ua(y,o,t),y=p.sibling}else y=p.child;if(y!==null)y.return=p;else for(y=p;y!==null;){if(y===t){y=null;break}if(p=y.sibling,p!==null){p.return=y.return,y=p;break}y=y.return}p=y}ht(e,t,c.children,o),t=t.child}return t;case 9:return c=t.type,l=t.pendingProps.children,Kr(t,o),c=Lt(c),l=l(c),t.flags|=1,ht(e,t,l,o),t.child;case 14:return l=t.type,c=Bt(l,t.pendingProps),c=Bt(l.type,c),_f(e,t,l,c,o);case 15:return Tf(e,t,t.type,t.pendingProps,o);case 17:return l=t.type,c=t.pendingProps,c=t.elementType===l?c:Bt(l,c),ri(e,t),t.tag=1,xt(l)?(e=!0,Fs(t)):e=!1,Kr(t,o),kf(t,l,c),Ea(t,l,c,o),Oa(null,t,l,!0,e,o);case 19:return $f(e,t,o);case 22:return Lf(e,t,o)}throw Error(s(156,t.tag))};function cp(e,t){return Bc(e,t)}function By(e,t,o,l){this.tag=e,this.key=o,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.ref=null,this.pendingProps=t,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=l,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function Dt(e,t,o,l){return new By(e,t,o,l)}function Ya(e){return e=e.prototype,!(!e||!e.isReactComponent)}function Uy(e){if(typeof e==\"function\")return Ya(e)?1:0;if(e!=null){if(e=e.$$typeof,e===q)return 11;if(e===fe)return 14}return 2}function Hn(e,t){var o=e.alternate;return o===null?(o=Dt(e.tag,t,e.key,e.mode),o.elementType=e.elementType,o.type=e.type,o.stateNode=e.stateNode,o.alternate=e,e.alternate=o):(o.pendingProps=t,o.type=e.type,o.flags=0,o.subtreeFlags=0,o.deletions=null),o.flags=e.flags&14680064,o.childLanes=e.childLanes,o.lanes=e.lanes,o.child=e.child,o.memoizedProps=e.memoizedProps,o.memoizedState=e.memoizedState,o.updateQueue=e.updateQueue,t=e.dependencies,o.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext},o.sibling=e.sibling,o.index=e.index,o.ref=e.ref,o}function hi(e,t,o,l,c,p){var y=2;if(l=e,typeof e==\"function\")Ya(e)&&(y=1);else if(typeof e==\"string\")y=5;else e:switch(e){case H:return pr(o.children,c,p,t);case $:y=8,c|=8;break;case W:return e=Dt(12,o,t,c|2),e.elementType=W,e.lanes=p,e;case Z:return e=Dt(13,o,t,c),e.elementType=Z,e.lanes=p,e;case ne:return e=Dt(19,o,t,c),e.elementType=ne,e.lanes=p,e;case ee:return mi(o,c,p,t);default:if(typeof e==\"object\"&&e!==null)switch(e.$$typeof){case X:y=10;break e;case Q:y=9;break e;case q:y=11;break e;case fe:y=14;break e;case J:y=16,l=null;break e}throw Error(s(130,e==null?e:typeof e,\"\"))}return t=Dt(y,o,t,c),t.elementType=e,t.type=l,t.lanes=p,t}function pr(e,t,o,l){return e=Dt(7,e,l,t),e.lanes=o,e}function mi(e,t,o,l){return e=Dt(22,e,l,t),e.elementType=ee,e.lanes=o,e.stateNode={isHidden:!1},e}function Xa(e,t,o){return e=Dt(6,e,null,t),e.lanes=o,e}function Za(e,t,o){return t=Dt(4,e.children!==null?e.children:[],e.key,t),t.lanes=o,t.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},t}function Hy(e,t,o,l,c){this.tag=t,this.containerInfo=e,this.finishedWork=this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.pendingContext=this.context=null,this.callbackPriority=0,this.eventTimes=bl(0),this.expirationTimes=bl(-1),this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=bl(0),this.identifierPrefix=l,this.onRecoverableError=c,this.mutableSourceEagerHydrationData=null}function qa(e,t,o,l,c,p,y,P,R){return e=new Hy(e,t,o,P,R),t===1?(t=1,p===!0&&(t|=8)):t=0,p=Dt(3,null,null,t),e.current=p,p.stateNode=e,p.memoizedState={element:l,isDehydrated:o,cache:null,transitions:null,pendingSuspenseBoundaries:null},da(p),e}function Wy(e,t,o){var l=3<arguments.length&&arguments[3]!==void 0?arguments[3]:null;return{$$typeof:V,key:l==null?null:\"\"+l,children:e,containerInfo:t,implementation:o}}function dp(e){if(!e)return An;e=e._reactInternals;e:{if(tr(e)!==e||e.tag!==1)throw Error(s(170));var t=e;do{switch(t.tag){case 3:t=t.stateNode.context;break e;case 1:if(xt(t.type)){t=t.stateNode.__reactInternalMemoizedMergedChildContext;break e}}t=t.return}while(t!==null);throw Error(s(171))}if(e.tag===1){var o=e.type;if(xt(o))return zd(e,o,t)}return t}function fp(e,t,o,l,c,p,y,P,R){return e=qa(o,l,!0,e,c,p,y,P,R),e.context=dp(null),o=e.current,l=mt(),c=Bn(o),p=hn(l,c),p.callback=t??null,zn(o,p,c),e.current.lanes=c,xo(e,c,l),Ct(e,l),e}function gi(e,t,o,l){var c=t.current,p=mt(),y=Bn(c);return o=dp(o),t.context===null?t.context=o:t.pendingContext=o,t=hn(p,y),t.payload={element:e},l=l===void 0?null:l,l!==null&&(t.callback=l),e=zn(c,t,y),e!==null&&(Wt(e,c,y,p),Gs(e,c,y)),y}function vi(e){return e=e.current,e.child?(e.child.tag===5,e.child.stateNode):null}function pp(e,t){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var o=e.retryLane;e.retryLane=o!==0&&o<t?o:t}}function Ja(e,t){pp(e,t),(e=e.alternate)&&pp(e,t)}function Ky(){return null}var hp=typeof reportError==\"function\"?reportError:function(e){console.error(e)};function eu(e){this._internalRoot=e}yi.prototype.render=eu.prototype.render=function(e){var t=this._internalRoot;if(t===null)throw Error(s(409));gi(e,t,null,null)},yi.prototype.unmount=eu.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var t=e.containerInfo;cr(function(){gi(null,e,null,null)}),t[un]=null}};function yi(e){this._internalRoot=e}yi.prototype.unstable_scheduleHydration=function(e){if(e){var t=Xc();e={blockedOn:null,target:e,priority:t};for(var o=0;o<jn.length&&t!==0&&t<jn[o].priority;o++);jn.splice(o,0,e),o===0&&Jc(e)}};function tu(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}function xi(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11&&(e.nodeType!==8||e.nodeValue!==\" react-mount-point-unstable \"))}function mp(){}function Gy(e,t,o,l,c){if(c){if(typeof l==\"function\"){var p=l;l=function(){var F=vi(y);p.call(F)}}var y=fp(t,l,e,0,null,!1,!1,\"\",mp);return e._reactRootContainer=y,e[un]=y.current,Lo(e.nodeType===8?e.parentNode:e),cr(),y}for(;c=e.lastChild;)e.removeChild(c);if(typeof l==\"function\"){var P=l;l=function(){var F=vi(R);P.call(F)}}var R=qa(e,0,!1,null,null,!1,!1,\"\",mp);return e._reactRootContainer=R,e[un]=R.current,Lo(e.nodeType===8?e.parentNode:e),cr(function(){gi(t,R,o,l)}),R}function wi(e,t,o,l,c){var p=o._reactRootContainer;if(p){var y=p;if(typeof c==\"function\"){var P=c;c=function(){var R=vi(y);P.call(R)}}gi(t,y,e,c)}else y=Gy(o,t,e,c,l);return vi(y)}Qc=function(e){switch(e.tag){case 3:var t=e.stateNode;if(t.current.memoizedState.isDehydrated){var o=yo(t.pendingLanes);o!==0&&(El(t,o|1),Ct(t,We()),(Ne&6)===0&&(Zr=We()+500,Dn()))}break;case 13:cr(function(){var l=pn(e,1);if(l!==null){var c=mt();Wt(l,e,1,c)}}),Ja(e,1)}},Pl=function(e){if(e.tag===13){var t=pn(e,134217728);if(t!==null){var o=mt();Wt(t,e,134217728,o)}Ja(e,134217728)}},Yc=function(e){if(e.tag===13){var t=Bn(e),o=pn(e,t);if(o!==null){var l=mt();Wt(o,e,t,l)}Ja(e,t)}},Xc=function(){return Te},Zc=function(e,t){var o=Te;try{return Te=e,t()}finally{Te=o}},yl=function(e,t,o){switch(t){case\"input\":if(er(e,o),t=o.name,o.type===\"radio\"&&t!=null){for(o=e;o.parentNode;)o=o.parentNode;for(o=o.querySelectorAll(\"input[name=\"+JSON.stringify(\"\"+t)+'][type=\"radio\"]'),t=0;t<o.length;t++){var l=o[t];if(l!==e&&l.form===e.form){var c=Ms(l);if(!c)throw Error(s(90));Re(l),er(l,c)}}}break;case\"textarea\":Pc(e,o);break;case\"select\":t=o.value,t!=null&&Rr(e,!!o.multiple,t,!1)}},Ac=Ka,Dc=cr;var Qy={usingClientEntryPoint:!1,Events:[Do,zr,Ms,Lc,Ic,Ka]},Xo={findFiberByHostInstance:nr,bundleType:0,version:\"18.3.1\",rendererPackageName:\"react-dom\"},Yy={bundleType:Xo.bundleType,version:Xo.version,rendererPackageName:Xo.rendererPackageName,rendererConfig:Xo.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:O.ReactCurrentDispatcher,findHostInstanceByFiber:function(e){return e=$c(e),e===null?null:e.stateNode},findFiberByHostInstance:Xo.findFiberByHostInstance||Ky,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:\"18.3.1-next-f1338f8080-20240426\"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<\"u\"){var Si=__REACT_DEVTOOLS_GLOBAL_HOOK__;if(!Si.isDisabled&&Si.supportsFiber)try{ys=Si.inject(Yy),Xt=Si}catch{}}return kt.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=Qy,kt.createPortal=function(e,t){var o=2<arguments.length&&arguments[2]!==void 0?arguments[2]:null;if(!tu(t))throw Error(s(200));return Wy(e,t,null,o)},kt.createRoot=function(e,t){if(!tu(e))throw Error(s(299));var o=!1,l=\"\",c=hp;return t!=null&&(t.unstable_strictMode===!0&&(o=!0),t.identifierPrefix!==void 0&&(l=t.identifierPrefix),t.onRecoverableError!==void 0&&(c=t.onRecoverableError)),t=qa(e,1,!1,null,null,o,!1,l,c),e[un]=t.current,Lo(e.nodeType===8?e.parentNode:e),new eu(t)},kt.findDOMNode=function(e){if(e==null)return null;if(e.nodeType===1)return e;var t=e._reactInternals;if(t===void 0)throw typeof e.render==\"function\"?Error(s(188)):(e=Object.keys(e).join(\",\"),Error(s(268,e)));return e=$c(t),e=e===null?null:e.stateNode,e},kt.flushSync=function(e){return cr(e)},kt.hydrate=function(e,t,o){if(!xi(t))throw Error(s(200));return wi(null,e,t,!0,o)},kt.hydrateRoot=function(e,t,o){if(!tu(e))throw Error(s(405));var l=o!=null&&o.hydratedSources||null,c=!1,p=\"\",y=hp;if(o!=null&&(o.unstable_strictMode===!0&&(c=!0),o.identifierPrefix!==void 0&&(p=o.identifierPrefix),o.onRecoverableError!==void 0&&(y=o.onRecoverableError)),t=fp(t,null,e,1,o??null,c,!1,p,y),e[un]=t.current,Lo(e),l)for(e=0;e<l.length;e++)o=l[e],c=o._getVersion,c=c(o._source),t.mutableSourceEagerHydrationData==null?t.mutableSourceEagerHydrationData=[o,c]:t.mutableSourceEagerHydrationData.push(o,c);return new yi(t)},kt.render=function(e,t,o){if(!xi(t))throw Error(s(200));return wi(null,e,t,!1,o)},kt.unmountComponentAtNode=function(e){if(!xi(e))throw Error(s(40));return e._reactRootContainer?(cr(function(){wi(null,null,e,!1,function(){e._reactRootContainer=null,e[un]=null})}),!0):!1},kt.unstable_batchedUpdates=Ka,kt.unstable_renderSubtreeIntoContainer=function(e,t,o,l){if(!xi(o))throw Error(s(200));if(e==null||e._reactInternals===void 0)throw Error(s(38));return wi(e,t,o,!1,l)},kt.version=\"18.3.1-next-f1338f8080-20240426\",kt}var Pp;function _h(){if(Pp)return su.exports;Pp=1;function n(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>\"u\"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!=\"function\"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n)}catch(r){console.error(r)}}return n(),su.exports=ox(),su.exports}var Np;function sx(){if(Np)return Ci;Np=1;var n=_h();return Ci.createRoot=n.createRoot,Ci.hydrateRoot=n.hydrateRoot,Ci}var ix=sx(),au={};const we=n=>typeof n==\"string\",qo=()=>{let n,r;const s=new Promise((i,a)=>{n=i,r=a});return s.resolve=n,s.reject=r,s},Rp=n=>n==null?\"\":\"\"+n,lx=(n,r,s)=>{n.forEach(i=>{r[i]&&(s[i]=r[i])})},ax=/###/g,Op=n=>n&&n.indexOf(\"###\")>-1?n.replace(ax,\".\"):n,jp=n=>!n||we(n),es=(n,r,s)=>{const i=we(r)?r.split(\".\"):r;let a=0;for(;a<i.length-1;){if(jp(n))return{};const u=Op(i[a]);!n[u]&&s&&(n[u]=new s),Object.prototype.hasOwnProperty.call(n,u)?n=n[u]:n={},++a}return jp(n)?{}:{obj:n,k:Op(i[a])}},_p=(n,r,s)=>{const{obj:i,k:a}=es(n,r,Object);if(i!==void 0||r.length===1){i[a]=s;return}let u=r[r.length-1],d=r.slice(0,r.length-1),f=es(n,d,Object);for(;f.obj===void 0&&d.length;)u=`${d[d.length-1]}.${u}`,d=d.slice(0,d.length-1),f=es(n,d,Object),f?.obj&&typeof f.obj[`${f.k}.${u}`]<\"u\"&&(f.obj=void 0);f.obj[`${f.k}.${u}`]=s},ux=(n,r,s,i)=>{const{obj:a,k:u}=es(n,r,Object);a[u]=a[u]||[],a[u].push(s)},Fi=(n,r)=>{const{obj:s,k:i}=es(n,r);if(s&&Object.prototype.hasOwnProperty.call(s,i))return s[i]},cx=(n,r,s)=>{const i=Fi(n,s);return i!==void 0?i:Fi(r,s)},Th=(n,r,s)=>{for(const i in r)i!==\"__proto__\"&&i!==\"constructor\"&&(i in n?we(n[i])||n[i]instanceof String||we(r[i])||r[i]instanceof String?s&&(n[i]=r[i]):Th(n[i],r[i],s):n[i]=r[i]);return n},hr=n=>n.replace(/[\\-\\[\\]\\/\\{\\}\\(\\)\\*\\+\\?\\.\\\\\\^\\$\\|]/g,\"\\\\$&\");var dx={\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\",\"/\":\"&#x2F;\"};const fx=n=>we(n)?n.replace(/[&<>\"'\\/]/g,r=>dx[r]):n;class px{constructor(r){this.capacity=r,this.regExpMap=new Map,this.regExpQueue=[]}getRegExp(r){const s=this.regExpMap.get(r);if(s!==void 0)return s;const i=new RegExp(r);return this.regExpQueue.length===this.capacity&&this.regExpMap.delete(this.regExpQueue.shift()),this.regExpMap.set(r,i),this.regExpQueue.push(r),i}}const hx=[\" \",\",\",\"?\",\"!\",\";\"],mx=new px(20),gx=(n,r,s)=>{r=r||\"\",s=s||\"\";const i=hx.filter(d=>r.indexOf(d)<0&&s.indexOf(d)<0);if(i.length===0)return!0;const a=mx.getRegExp(`(${i.map(d=>d===\"?\"?\"\\\\?\":d).join(\"|\")})`);let u=!a.test(n);if(!u){const d=n.indexOf(s);d>0&&!a.test(n.substring(0,d))&&(u=!0)}return u},Nu=(n,r,s=\".\")=>{if(!n)return;if(n[r])return Object.prototype.hasOwnProperty.call(n,r)?n[r]:void 0;const i=r.split(s);let a=n;for(let u=0;u<i.length;){if(!a||typeof a!=\"object\")return;let d,f=\"\";for(let h=u;h<i.length;++h)if(h!==u&&(f+=s),f+=i[h],d=a[f],d!==void 0){if([\"string\",\"number\",\"boolean\"].indexOf(typeof d)>-1&&h<i.length-1)continue;u+=h-u+1;break}a=d}return a},rs=n=>n?.replace(/_/g,\"-\"),vx={type:\"logger\",log(n){this.output(\"log\",n)},warn(n){this.output(\"warn\",n)},error(n){this.output(\"error\",n)},output(n,r){console?.[n]?.apply?.(console,r)}};class $i{constructor(r,s={}){this.init(r,s)}init(r,s={}){this.prefix=s.prefix||\"i18next:\",this.logger=r||vx,this.options=s,this.debug=s.debug}log(...r){return this.forward(r,\"log\",\"\",!0)}warn(...r){return this.forward(r,\"warn\",\"\",!0)}error(...r){return this.forward(r,\"error\",\"\")}deprecate(...r){return this.forward(r,\"warn\",\"WARNING DEPRECATED: \",!0)}forward(r,s,i,a){return a&&!this.debug?null:(we(r[0])&&(r[0]=`${i}${this.prefix} ${r[0]}`),this.logger[s](r))}create(r){return new $i(this.logger,{prefix:`${this.prefix}:${r}:`,...this.options})}clone(r){return r=r||this.options,r.prefix=r.prefix||this.prefix,new $i(this.logger,r)}}var rn=new $i;class Yi{constructor(){this.observers={}}on(r,s){return r.split(\" \").forEach(i=>{this.observers[i]||(this.observers[i]=new Map);const a=this.observers[i].get(s)||0;this.observers[i].set(s,a+1)}),this}off(r,s){if(this.observers[r]){if(!s){delete this.observers[r];return}this.observers[r].delete(s)}}emit(r,...s){this.observers[r]&&Array.from(this.observers[r].entries()).forEach(([a,u])=>{for(let d=0;d<u;d++)a(...s)}),this.observers[\"*\"]&&Array.from(this.observers[\"*\"].entries()).forEach(([a,u])=>{for(let d=0;d<u;d++)a.apply(a,[r,...s])})}}class Tp extends Yi{constructor(r,s={ns:[\"translation\"],defaultNS:\"translation\"}){super(),this.data=r||{},this.options=s,this.options.keySeparator===void 0&&(this.options.keySeparator=\".\"),this.options.ignoreJSONStructure===void 0&&(this.options.ignoreJSONStructure=!0)}addNamespaces(r){this.options.ns.indexOf(r)<0&&this.options.ns.push(r)}removeNamespaces(r){const s=this.options.ns.indexOf(r);s>-1&&this.options.ns.splice(s,1)}getResource(r,s,i,a={}){const u=a.keySeparator!==void 0?a.keySeparator:this.options.keySeparator,d=a.ignoreJSONStructure!==void 0?a.ignoreJSONStructure:this.options.ignoreJSONStructure;let f;r.indexOf(\".\")>-1?f=r.split(\".\"):(f=[r,s],i&&(Array.isArray(i)?f.push(...i):we(i)&&u?f.push(...i.split(u)):f.push(i)));const h=Fi(this.data,f);return!h&&!s&&!i&&r.indexOf(\".\")>-1&&(r=f[0],s=f[1],i=f.slice(2).join(\".\")),h||!d||!we(i)?h:Nu(this.data?.[r]?.[s],i,u)}addResource(r,s,i,a,u={silent:!1}){const d=u.keySeparator!==void 0?u.keySeparator:this.options.keySeparator;let f=[r,s];i&&(f=f.concat(d?i.split(d):i)),r.indexOf(\".\")>-1&&(f=r.split(\".\"),a=s,s=f[1]),this.addNamespaces(s),_p(this.data,f,a),u.silent||this.emit(\"added\",r,s,i,a)}addResources(r,s,i,a={silent:!1}){for(const u in i)(we(i[u])||Array.isArray(i[u]))&&this.addResource(r,s,u,i[u],{silent:!0});a.silent||this.emit(\"added\",r,s,i)}addResourceBundle(r,s,i,a,u,d={silent:!1,skipCopy:!1}){let f=[r,s];r.indexOf(\".\")>-1&&(f=r.split(\".\"),a=i,i=s,s=f[1]),this.addNamespaces(s);let h=Fi(this.data,f)||{};d.skipCopy||(i=JSON.parse(JSON.stringify(i))),a?Th(h,i,u):h={...h,...i},_p(this.data,f,h),d.silent||this.emit(\"added\",r,s,i)}removeResourceBundle(r,s){this.hasResourceBundle(r,s)&&delete this.data[r][s],this.removeNamespaces(s),this.emit(\"removed\",r,s)}hasResourceBundle(r,s){return this.getResource(r,s)!==void 0}getResourceBundle(r,s){return s||(s=this.options.defaultNS),this.getResource(r,s)}getDataByLanguage(r){return this.data[r]}hasLanguageSomeTranslations(r){const s=this.getDataByLanguage(r);return!!(s&&Object.keys(s)||[]).find(a=>s[a]&&Object.keys(s[a]).length>0)}toJSON(){return this.data}}var Lh={processors:{},addPostProcessor(n){this.processors[n.name]=n},handle(n,r,s,i,a){return n.forEach(u=>{r=this.processors[u]?.process(r,s,i,a)??r}),r}};const Ih=Symbol(\"i18next/PATH_KEY\");function yx(){const n=[],r=Object.create(null);let s;return r.get=(i,a)=>(s?.revoke?.(),a===Ih?n:(n.push(a),s=Proxy.revocable(i,r),s.proxy)),Proxy.revocable(Object.create(null),r).proxy}function oo(n,r){const{[Ih]:s}=n(yx()),i=r?.keySeparator??\".\",a=r?.nsSeparator??\":\";if(s.length>1&&a){const u=r?.ns,d=Array.isArray(u)?u:null;if(d&&d.length>1&&d.slice(1).includes(s[0]))return`${s[0]}${a}${s.slice(1).join(i)}`}return s.join(i)}const Lp={},uu=n=>!we(n)&&typeof n!=\"boolean\"&&typeof n!=\"number\";class Vi extends Yi{constructor(r,s={}){super(),lx([\"resourceStore\",\"languageUtils\",\"pluralResolver\",\"interpolator\",\"backendConnector\",\"i18nFormat\",\"utils\"],r,this),this.options=s,this.options.keySeparator===void 0&&(this.options.keySeparator=\".\"),this.logger=rn.create(\"translator\")}changeLanguage(r){r&&(this.language=r)}exists(r,s={interpolation:{}}){const i={...s};if(r==null)return!1;const a=this.resolve(r,i);if(a?.res===void 0)return!1;const u=uu(a.res);return!(i.returnObjects===!1&&u)}extractFromKey(r,s){let i=s.nsSeparator!==void 0?s.nsSeparator:this.options.nsSeparator;i===void 0&&(i=\":\");const a=s.keySeparator!==void 0?s.keySeparator:this.options.keySeparator;let u=s.ns||this.options.defaultNS||[];const d=i&&r.indexOf(i)>-1,f=!this.options.userDefinedKeySeparator&&!s.keySeparator&&!this.options.userDefinedNsSeparator&&!s.nsSeparator&&!gx(r,i,a);if(d&&!f){const h=r.match(this.interpolator.nestingRegexp);if(h&&h.length>0)return{key:r,namespaces:we(u)?[u]:u};const m=r.split(i);(i!==a||i===a&&this.options.ns.indexOf(m[0])>-1)&&(u=m.shift()),r=m.join(a)}return{key:r,namespaces:we(u)?[u]:u}}translate(r,s,i){let a=typeof s==\"object\"?{...s}:s;if(typeof a!=\"object\"&&this.options.overloadTranslationOptionHandler&&(a=this.options.overloadTranslationOptionHandler(arguments)),typeof a==\"object\"&&(a={...a}),a||(a={}),r==null)return\"\";typeof r==\"function\"&&(r=oo(r,{...this.options,...a})),Array.isArray(r)||(r=[String(r)]),r=r.map(Z=>typeof Z==\"function\"?oo(Z,{...this.options,...a}):String(Z));const u=a.returnDetails!==void 0?a.returnDetails:this.options.returnDetails,d=a.keySeparator!==void 0?a.keySeparator:this.options.keySeparator,{key:f,namespaces:h}=this.extractFromKey(r[r.length-1],a),m=h[h.length-1];let w=a.nsSeparator!==void 0?a.nsSeparator:this.options.nsSeparator;w===void 0&&(w=\":\");const v=a.lng||this.language,S=a.appendNamespaceToCIMode||this.options.appendNamespaceToCIMode;if(v?.toLowerCase()===\"cimode\")return S?u?{res:`${m}${w}${f}`,usedKey:f,exactUsedKey:f,usedLng:v,usedNS:m,usedParams:this.getUsedParamsDetails(a)}:`${m}${w}${f}`:u?{res:f,usedKey:f,exactUsedKey:f,usedLng:v,usedNS:m,usedParams:this.getUsedParamsDetails(a)}:f;const C=this.resolve(r,a);let k=C?.res;const E=C?.usedKey||f,b=C?.exactUsedKey||f,_=[\"[object Number]\",\"[object Function]\",\"[object RegExp]\"],L=a.joinArrays!==void 0?a.joinArrays:this.options.joinArrays,T=!this.i18nFormat||this.i18nFormat.handleAsObject,O=a.count!==void 0&&!we(a.count),B=Vi.hasDefaultValue(a),V=O?this.pluralResolver.getSuffix(v,a.count,a):\"\",H=a.ordinal&&O?this.pluralResolver.getSuffix(v,a.count,{ordinal:!1}):\"\",$=O&&!a.ordinal&&a.count===0,W=$&&a[`defaultValue${this.options.pluralSeparator}zero`]||a[`defaultValue${V}`]||a[`defaultValue${H}`]||a.defaultValue;let X=k;T&&!k&&B&&(X=W);const Q=uu(X),q=Object.prototype.toString.apply(X);if(T&&X&&Q&&_.indexOf(q)<0&&!(we(L)&&Array.isArray(X))){if(!a.returnObjects&&!this.options.returnObjects){this.options.returnedObjectHandler||this.logger.warn(\"accessing an object - but returnObjects options is not enabled!\");const Z=this.options.returnedObjectHandler?this.options.returnedObjectHandler(E,X,{...a,ns:h}):`key '${f} (${this.language})' returned an object instead of string.`;return u?(C.res=Z,C.usedParams=this.getUsedParamsDetails(a),C):Z}if(d){const Z=Array.isArray(X),ne=Z?[]:{},fe=Z?b:E;for(const J in X)if(Object.prototype.hasOwnProperty.call(X,J)){const ee=`${fe}${d}${J}`;B&&!k?ne[J]=this.translate(ee,{...a,defaultValue:uu(W)?W[J]:void 0,joinArrays:!1,ns:h}):ne[J]=this.translate(ee,{...a,joinArrays:!1,ns:h}),ne[J]===ee&&(ne[J]=X[J])}k=ne}}else if(T&&we(L)&&Array.isArray(k))k=k.join(L),k&&(k=this.extendTranslation(k,r,a,i));else{let Z=!1,ne=!1;!this.isValidLookup(k)&&B&&(Z=!0,k=W),this.isValidLookup(k)||(ne=!0,k=f);const J=(a.missingKeyNoValueFallbackToKey||this.options.missingKeyNoValueFallbackToKey)&&ne?void 0:k,ee=B&&W!==k&&this.options.updateMissing;if(ne||Z||ee){if(this.logger.log(ee?\"updateKey\":\"missingKey\",v,m,f,ee?W:k),d){const N=this.resolve(f,{...a,keySeparator:!1});N&&N.res&&this.logger.warn(\"Seems the loaded translations were in flat JSON format instead of nested. Either set keySeparator: false on init or make sure your translations are published in nested format.\")}let I=[];const U=this.languageUtils.getFallbackCodes(this.options.fallbackLng,a.lng||this.language);if(this.options.saveMissingTo===\"fallback\"&&U&&U[0])for(let N=0;N<U.length;N++)I.push(U[N]);else this.options.saveMissingTo===\"all\"?I=this.languageUtils.toResolveHierarchy(a.lng||this.language):I.push(a.lng||this.language);const M=(N,D,oe)=>{const pe=B&&oe!==k?oe:J;this.options.missingKeyHandler?this.options.missingKeyHandler(N,m,D,pe,ee,a):this.backendConnector?.saveMissing&&this.backendConnector.saveMissing(N,m,D,pe,ee,a),this.emit(\"missingKey\",N,m,D,k)};this.options.saveMissing&&(this.options.saveMissingPlurals&&O?I.forEach(N=>{const D=this.pluralResolver.getSuffixes(N,a);$&&a[`defaultValue${this.options.pluralSeparator}zero`]&&D.indexOf(`${this.options.pluralSeparator}zero`)<0&&D.push(`${this.options.pluralSeparator}zero`),D.forEach(oe=>{M([N],f+oe,a[`defaultValue${oe}`]||W)})}):M(I,f,W))}k=this.extendTranslation(k,r,a,C,i),ne&&k===f&&this.options.appendNamespaceToMissingKey&&(k=`${m}${w}${f}`),(ne||Z)&&this.options.parseMissingKeyHandler&&(k=this.options.parseMissingKeyHandler(this.options.appendNamespaceToMissingKey?`${m}${w}${f}`:f,Z?k:void 0,a))}return u?(C.res=k,C.usedParams=this.getUsedParamsDetails(a),C):k}extendTranslation(r,s,i,a,u){if(this.i18nFormat?.parse)r=this.i18nFormat.parse(r,{...this.options.interpolation.defaultVariables,...i},i.lng||this.language||a.usedLng,a.usedNS,a.usedKey,{resolved:a});else if(!i.skipInterpolation){i.interpolation&&this.interpolator.init({...i,interpolation:{...this.options.interpolation,...i.interpolation}});const h=we(r)&&(i?.interpolation?.skipOnVariables!==void 0?i.interpolation.skipOnVariables:this.options.interpolation.skipOnVariables);let m;if(h){const v=r.match(this.interpolator.nestingRegexp);m=v&&v.length}let w=i.replace&&!we(i.replace)?i.replace:i;if(this.options.interpolation.defaultVariables&&(w={...this.options.interpolation.defaultVariables,...w}),r=this.interpolator.interpolate(r,w,i.lng||this.language||a.usedLng,i),h){const v=r.match(this.interpolator.nestingRegexp),S=v&&v.length;m<S&&(i.nest=!1)}!i.lng&&a&&a.res&&(i.lng=this.language||a.usedLng),i.nest!==!1&&(r=this.interpolator.nest(r,(...v)=>u?.[0]===v[0]&&!i.context?(this.logger.warn(`It seems you are nesting recursively key: ${v[0]} in key: ${s[0]}`),null):this.translate(...v,s),i)),i.interpolation&&this.interpolator.reset()}const d=i.postProcess||this.options.postProcess,f=we(d)?[d]:d;return r!=null&&f?.length&&i.applyPostProcessor!==!1&&(r=Lh.handle(f,r,s,this.options&&this.options.postProcessPassResolved?{i18nResolved:{...a,usedParams:this.getUsedParamsDetails(i)},...i}:i,this)),r}resolve(r,s={}){let i,a,u,d,f;return we(r)&&(r=[r]),Array.isArray(r)&&(r=r.map(h=>typeof h==\"function\"?oo(h,{...this.options,...s}):h)),r.forEach(h=>{if(this.isValidLookup(i))return;const m=this.extractFromKey(h,s),w=m.key;a=w;let v=m.namespaces;this.options.fallbackNS&&(v=v.concat(this.options.fallbackNS));const S=s.count!==void 0&&!we(s.count),C=S&&!s.ordinal&&s.count===0,k=s.context!==void 0&&(we(s.context)||typeof s.context==\"number\")&&s.context!==\"\",E=s.lngs?s.lngs:this.languageUtils.toResolveHierarchy(s.lng||this.language,s.fallbackLng);v.forEach(b=>{this.isValidLookup(i)||(f=b,!Lp[`${E[0]}-${b}`]&&this.utils?.hasLoadedNamespace&&!this.utils?.hasLoadedNamespace(f)&&(Lp[`${E[0]}-${b}`]=!0,this.logger.warn(`key \"${a}\" for languages \"${E.join(\", \")}\" won't get resolved as namespace \"${f}\" was not yet loaded`,\"This means something IS WRONG in your setup. You access the t function before i18next.init / i18next.loadNamespace / i18next.changeLanguage was done. Wait for the callback or Promise to resolve before accessing it!!!\")),E.forEach(_=>{if(this.isValidLookup(i))return;d=_;const L=[w];if(this.i18nFormat?.addLookupKeys)this.i18nFormat.addLookupKeys(L,w,_,b,s);else{let O;S&&(O=this.pluralResolver.getSuffix(_,s.count,s));const B=`${this.options.pluralSeparator}zero`,V=`${this.options.pluralSeparator}ordinal${this.options.pluralSeparator}`;if(S&&(s.ordinal&&O.indexOf(V)===0&&L.push(w+O.replace(V,this.options.pluralSeparator)),L.push(w+O),C&&L.push(w+B)),k){const H=`${w}${this.options.contextSeparator||\"_\"}${s.context}`;L.push(H),S&&(s.ordinal&&O.indexOf(V)===0&&L.push(H+O.replace(V,this.options.pluralSeparator)),L.push(H+O),C&&L.push(H+B))}}let T;for(;T=L.pop();)this.isValidLookup(i)||(u=T,i=this.getResource(_,b,T,s))}))})}),{res:i,usedKey:a,exactUsedKey:u,usedLng:d,usedNS:f}}isValidLookup(r){return r!==void 0&&!(!this.options.returnNull&&r===null)&&!(!this.options.returnEmptyString&&r===\"\")}getResource(r,s,i,a={}){return this.i18nFormat?.getResource?this.i18nFormat.getResource(r,s,i,a):this.resourceStore.getResource(r,s,i,a)}getUsedParamsDetails(r={}){const s=[\"defaultValue\",\"ordinal\",\"context\",\"replace\",\"lng\",\"lngs\",\"fallbackLng\",\"ns\",\"keySeparator\",\"nsSeparator\",\"returnObjects\",\"returnDetails\",\"joinArrays\",\"postProcess\",\"interpolation\"],i=r.replace&&!we(r.replace);let a=i?r.replace:r;if(i&&typeof r.count<\"u\"&&(a.count=r.count),this.options.interpolation.defaultVariables&&(a={...this.options.interpolation.defaultVariables,...a}),!i){a={...a};for(const u of s)delete a[u]}return a}static hasDefaultValue(r){const s=\"defaultValue\";for(const i in r)if(Object.prototype.hasOwnProperty.call(r,i)&&s===i.substring(0,s.length)&&r[i]!==void 0)return!0;return!1}}class Ip{constructor(r){this.options=r,this.supportedLngs=this.options.supportedLngs||!1,this.logger=rn.create(\"languageUtils\")}getScriptPartFromCode(r){if(r=rs(r),!r||r.indexOf(\"-\")<0)return null;const s=r.split(\"-\");return s.length===2||(s.pop(),s[s.length-1].toLowerCase()===\"x\")?null:this.formatLanguageCode(s.join(\"-\"))}getLanguagePartFromCode(r){if(r=rs(r),!r||r.indexOf(\"-\")<0)return r;const s=r.split(\"-\");return this.formatLanguageCode(s[0])}formatLanguageCode(r){if(we(r)&&r.indexOf(\"-\")>-1){let s;try{s=Intl.getCanonicalLocales(r)[0]}catch{}return s&&this.options.lowerCaseLng&&(s=s.toLowerCase()),s||(this.options.lowerCaseLng?r.toLowerCase():r)}return this.options.cleanCode||this.options.lowerCaseLng?r.toLowerCase():r}isSupportedCode(r){return(this.options.load===\"languageOnly\"||this.options.nonExplicitSupportedLngs)&&(r=this.getLanguagePartFromCode(r)),!this.supportedLngs||!this.supportedLngs.length||this.supportedLngs.indexOf(r)>-1}getBestMatchFromCodes(r){if(!r)return null;let s;return r.forEach(i=>{if(s)return;const a=this.formatLanguageCode(i);(!this.options.supportedLngs||this.isSupportedCode(a))&&(s=a)}),!s&&this.options.supportedLngs&&r.forEach(i=>{if(s)return;const a=this.getScriptPartFromCode(i);if(this.isSupportedCode(a))return s=a;const u=this.getLanguagePartFromCode(i);if(this.isSupportedCode(u))return s=u;s=this.options.supportedLngs.find(d=>{if(d===u)return d;if(!(d.indexOf(\"-\")<0&&u.indexOf(\"-\")<0)&&(d.indexOf(\"-\")>0&&u.indexOf(\"-\")<0&&d.substring(0,d.indexOf(\"-\"))===u||d.indexOf(u)===0&&u.length>1))return d})}),s||(s=this.getFallbackCodes(this.options.fallbackLng)[0]),s}getFallbackCodes(r,s){if(!r)return[];if(typeof r==\"function\"&&(r=r(s)),we(r)&&(r=[r]),Array.isArray(r))return r;if(!s)return r.default||[];let i=r[s];return i||(i=r[this.getScriptPartFromCode(s)]),i||(i=r[this.formatLanguageCode(s)]),i||(i=r[this.getLanguagePartFromCode(s)]),i||(i=r.default),i||[]}toResolveHierarchy(r,s){const i=this.getFallbackCodes((s===!1?[]:s)||this.options.fallbackLng||[],r),a=[],u=d=>{d&&(this.isSupportedCode(d)?a.push(d):this.logger.warn(`rejecting language code not found in supportedLngs: ${d}`))};return we(r)&&(r.indexOf(\"-\")>-1||r.indexOf(\"_\")>-1)?(this.options.load!==\"languageOnly\"&&u(this.formatLanguageCode(r)),this.options.load!==\"languageOnly\"&&this.options.load!==\"currentOnly\"&&u(this.getScriptPartFromCode(r)),this.options.load!==\"currentOnly\"&&u(this.getLanguagePartFromCode(r))):we(r)&&u(this.formatLanguageCode(r)),i.forEach(d=>{a.indexOf(d)<0&&u(this.formatLanguageCode(d))}),a}}const Ap={zero:0,one:1,two:2,few:3,many:4,other:5},Dp={select:n=>n===1?\"one\":\"other\",resolvedOptions:()=>({pluralCategories:[\"one\",\"other\"]})};class xx{constructor(r,s={}){this.languageUtils=r,this.options=s,this.logger=rn.create(\"pluralResolver\"),this.pluralRulesCache={}}clearCache(){this.pluralRulesCache={}}getRule(r,s={}){const i=rs(r===\"dev\"?\"en\":r),a=s.ordinal?\"ordinal\":\"cardinal\",u=JSON.stringify({cleanedCode:i,type:a});if(u in this.pluralRulesCache)return this.pluralRulesCache[u];let d;try{d=new Intl.PluralRules(i,{type:a})}catch{if(typeof Intl>\"u\")return this.logger.error(\"No Intl support, please use an Intl polyfill!\"),Dp;if(!r.match(/-|_/))return Dp;const h=this.languageUtils.getLanguagePartFromCode(r);d=this.getRule(h,s)}return this.pluralRulesCache[u]=d,d}needsPlural(r,s={}){let i=this.getRule(r,s);return i||(i=this.getRule(\"dev\",s)),i?.resolvedOptions().pluralCategories.length>1}getPluralFormsOfKey(r,s,i={}){return this.getSuffixes(r,i).map(a=>`${s}${a}`)}getSuffixes(r,s={}){let i=this.getRule(r,s);return i||(i=this.getRule(\"dev\",s)),i?i.resolvedOptions().pluralCategories.sort((a,u)=>Ap[a]-Ap[u]).map(a=>`${this.options.prepend}${s.ordinal?`ordinal${this.options.prepend}`:\"\"}${a}`):[]}getSuffix(r,s,i={}){const a=this.getRule(r,i);return a?`${this.options.prepend}${i.ordinal?`ordinal${this.options.prepend}`:\"\"}${a.select(s)}`:(this.logger.warn(`no plural rule found for: ${r}`),this.getSuffix(\"dev\",s,i))}}const Mp=(n,r,s,i=\".\",a=!0)=>{let u=cx(n,r,s);return!u&&a&&we(s)&&(u=Nu(n,s,i),u===void 0&&(u=Nu(r,s,i))),u},cu=n=>n.replace(/\\$/g,\"$$$$\");class zp{constructor(r={}){this.logger=rn.create(\"interpolator\"),this.options=r,this.format=r?.interpolation?.format||(s=>s),this.init(r)}init(r={}){r.interpolation||(r.interpolation={escapeValue:!0});const{escape:s,escapeValue:i,useRawValueToEscape:a,prefix:u,prefixEscaped:d,suffix:f,suffixEscaped:h,formatSeparator:m,unescapeSuffix:w,unescapePrefix:v,nestingPrefix:S,nestingPrefixEscaped:C,nestingSuffix:k,nestingSuffixEscaped:E,nestingOptionsSeparator:b,maxReplaces:_,alwaysFormat:L}=r.interpolation;this.escape=s!==void 0?s:fx,this.escapeValue=i!==void 0?i:!0,this.useRawValueToEscape=a!==void 0?a:!1,this.prefix=u?hr(u):d||\"{{\",this.suffix=f?hr(f):h||\"}}\",this.formatSeparator=m||\",\",this.unescapePrefix=w?\"\":v||\"-\",this.unescapeSuffix=this.unescapePrefix?\"\":w||\"\",this.nestingPrefix=S?hr(S):C||hr(\"$t(\"),this.nestingSuffix=k?hr(k):E||hr(\")\"),this.nestingOptionsSeparator=b||\",\",this.maxReplaces=_||1e3,this.alwaysFormat=L!==void 0?L:!1,this.resetRegExp()}reset(){this.options&&this.init(this.options)}resetRegExp(){const r=(s,i)=>s?.source===i?(s.lastIndex=0,s):new RegExp(i,\"g\");this.regexp=r(this.regexp,`${this.prefix}(.+?)${this.suffix}`),this.regexpUnescape=r(this.regexpUnescape,`${this.prefix}${this.unescapePrefix}(.+?)${this.unescapeSuffix}${this.suffix}`),this.nestingRegexp=r(this.nestingRegexp,`${this.nestingPrefix}((?:[^()\"']+|\"[^\"]*\"|'[^']*'|\\\\((?:[^()]|\"[^\"]*\"|'[^']*')*\\\\))*?)${this.nestingSuffix}`)}interpolate(r,s,i,a){let u,d,f;const h=this.options&&this.options.interpolation&&this.options.interpolation.defaultVariables||{},m=C=>{if(C.indexOf(this.formatSeparator)<0){const _=Mp(s,h,C,this.options.keySeparator,this.options.ignoreJSONStructure);return this.alwaysFormat?this.format(_,void 0,i,{...a,...s,interpolationkey:C}):_}const k=C.split(this.formatSeparator),E=k.shift().trim(),b=k.join(this.formatSeparator).trim();return this.format(Mp(s,h,E,this.options.keySeparator,this.options.ignoreJSONStructure),b,i,{...a,...s,interpolationkey:E})};this.resetRegExp();const w=a?.missingInterpolationHandler||this.options.missingInterpolationHandler,v=a?.interpolation?.skipOnVariables!==void 0?a.interpolation.skipOnVariables:this.options.interpolation.skipOnVariables;return[{regex:this.regexpUnescape,safeValue:C=>cu(C)},{regex:this.regexp,safeValue:C=>this.escapeValue?cu(this.escape(C)):cu(C)}].forEach(C=>{for(f=0;u=C.regex.exec(r);){const k=u[1].trim();if(d=m(k),d===void 0)if(typeof w==\"function\"){const b=w(r,u,a);d=we(b)?b:\"\"}else if(a&&Object.prototype.hasOwnProperty.call(a,k))d=\"\";else if(v){d=u[0];continue}else this.logger.warn(`missed to pass in variable ${k} for interpolating ${r}`),d=\"\";else!we(d)&&!this.useRawValueToEscape&&(d=Rp(d));const E=C.safeValue(d);if(r=r.replace(u[0],E),v?(C.regex.lastIndex+=d.length,C.regex.lastIndex-=u[0].length):C.regex.lastIndex=0,f++,f>=this.maxReplaces)break}}),r}nest(r,s,i={}){let a,u,d;const f=(h,m)=>{const w=this.nestingOptionsSeparator;if(h.indexOf(w)<0)return h;const v=h.split(new RegExp(`${hr(w)}[ ]*{`));let S=`{${v[1]}`;h=v[0],S=this.interpolate(S,d);const C=S.match(/'/g),k=S.match(/\"/g);((C?.length??0)%2===0&&!k||(k?.length??0)%2!==0)&&(S=S.replace(/'/g,'\"'));try{d=JSON.parse(S),m&&(d={...m,...d})}catch(E){return this.logger.warn(`failed parsing options string in nesting for key ${h}`,E),`${h}${w}${S}`}return d.defaultValue&&d.defaultValue.indexOf(this.prefix)>-1&&delete d.defaultValue,h};for(;a=this.nestingRegexp.exec(r);){let h=[];d={...i},d=d.replace&&!we(d.replace)?d.replace:d,d.applyPostProcessor=!1,delete d.defaultValue;const m=/{.*}/.test(a[1])?a[1].lastIndexOf(\"}\")+1:a[1].indexOf(this.formatSeparator);if(m!==-1&&(h=a[1].slice(m).split(this.formatSeparator).map(w=>w.trim()).filter(Boolean),a[1]=a[1].slice(0,m)),u=s(f.call(this,a[1].trim(),d),d),u&&a[0]===r&&!we(u))return u;we(u)||(u=Rp(u)),u||(this.logger.warn(`missed to resolve ${a[1]} for nesting ${r}`),u=\"\"),h.length&&(u=h.reduce((w,v)=>this.format(w,v,i.lng,{...i,interpolationkey:a[1].trim()}),u.trim())),r=r.replace(a[0],u),this.regexp.lastIndex=0}return r}}const wx=n=>{let r=n.toLowerCase().trim();const s={};if(n.indexOf(\"(\")>-1){const i=n.split(\"(\");r=i[0].toLowerCase().trim();const a=i[1].substring(0,i[1].length-1);r===\"currency\"&&a.indexOf(\":\")<0?s.currency||(s.currency=a.trim()):r===\"relativetime\"&&a.indexOf(\":\")<0?s.range||(s.range=a.trim()):a.split(\";\").forEach(d=>{if(d){const[f,...h]=d.split(\":\"),m=h.join(\":\").trim().replace(/^'+|'+$/g,\"\"),w=f.trim();s[w]||(s[w]=m),m===\"false\"&&(s[w]=!1),m===\"true\"&&(s[w]=!0),isNaN(m)||(s[w]=parseInt(m,10))}})}return{formatName:r,formatOptions:s}},Fp=n=>{const r={};return(s,i,a)=>{let u=a;a&&a.interpolationkey&&a.formatParams&&a.formatParams[a.interpolationkey]&&a[a.interpolationkey]&&(u={...u,[a.interpolationkey]:void 0});const d=i+JSON.stringify(u);let f=r[d];return f||(f=n(rs(i),a),r[d]=f),f(s)}},Sx=n=>(r,s,i)=>n(rs(s),i)(r);class Cx{constructor(r={}){this.logger=rn.create(\"formatter\"),this.options=r,this.init(r)}init(r,s={interpolation:{}}){this.formatSeparator=s.interpolation.formatSeparator||\",\";const i=s.cacheInBuiltFormats?Fp:Sx;this.formats={number:i((a,u)=>{const d=new Intl.NumberFormat(a,{...u});return f=>d.format(f)}),currency:i((a,u)=>{const d=new Intl.NumberFormat(a,{...u,style:\"currency\"});return f=>d.format(f)}),datetime:i((a,u)=>{const d=new Intl.DateTimeFormat(a,{...u});return f=>d.format(f)}),relativetime:i((a,u)=>{const d=new Intl.RelativeTimeFormat(a,{...u});return f=>d.format(f,u.range||\"day\")}),list:i((a,u)=>{const d=new Intl.ListFormat(a,{...u});return f=>d.format(f)})}}add(r,s){this.formats[r.toLowerCase().trim()]=s}addCached(r,s){this.formats[r.toLowerCase().trim()]=Fp(s)}format(r,s,i,a={}){const u=s.split(this.formatSeparator);if(u.length>1&&u[0].indexOf(\"(\")>1&&u[0].indexOf(\")\")<0&&u.find(f=>f.indexOf(\")\")>-1)){const f=u.findIndex(h=>h.indexOf(\")\")>-1);u[0]=[u[0],...u.splice(1,f)].join(this.formatSeparator)}return u.reduce((f,h)=>{const{formatName:m,formatOptions:w}=wx(h);if(this.formats[m]){let v=f;try{const S=a?.formatParams?.[a.interpolationkey]||{},C=S.locale||S.lng||a.locale||a.lng||i;v=this.formats[m](f,C,{...w,...a,...S})}catch(S){this.logger.warn(S)}return v}else this.logger.warn(`there was no format function for ${m}`);return f},r)}}const kx=(n,r)=>{n.pending[r]!==void 0&&(delete n.pending[r],n.pendingCount--)};class bx extends Yi{constructor(r,s,i,a={}){super(),this.backend=r,this.store=s,this.services=i,this.languageUtils=i.languageUtils,this.options=a,this.logger=rn.create(\"backendConnector\"),this.waitingReads=[],this.maxParallelReads=a.maxParallelReads||10,this.readingCalls=0,this.maxRetries=a.maxRetries>=0?a.maxRetries:5,this.retryTimeout=a.retryTimeout>=1?a.retryTimeout:350,this.state={},this.queue=[],this.backend?.init?.(i,a.backend,a)}queueLoad(r,s,i,a){const u={},d={},f={},h={};return r.forEach(m=>{let w=!0;s.forEach(v=>{const S=`${m}|${v}`;!i.reload&&this.store.hasResourceBundle(m,v)?this.state[S]=2:this.state[S]<0||(this.state[S]===1?d[S]===void 0&&(d[S]=!0):(this.state[S]=1,w=!1,d[S]===void 0&&(d[S]=!0),u[S]===void 0&&(u[S]=!0),h[v]===void 0&&(h[v]=!0)))}),w||(f[m]=!0)}),(Object.keys(u).length||Object.keys(d).length)&&this.queue.push({pending:d,pendingCount:Object.keys(d).length,loaded:{},errors:[],callback:a}),{toLoad:Object.keys(u),pending:Object.keys(d),toLoadLanguages:Object.keys(f),toLoadNamespaces:Object.keys(h)}}loaded(r,s,i){const a=r.split(\"|\"),u=a[0],d=a[1];s&&this.emit(\"failedLoading\",u,d,s),!s&&i&&this.store.addResourceBundle(u,d,i,void 0,void 0,{skipCopy:!0}),this.state[r]=s?-1:2,s&&i&&(this.state[r]=0);const f={};this.queue.forEach(h=>{ux(h.loaded,[u],d),kx(h,r),s&&h.errors.push(s),h.pendingCount===0&&!h.done&&(Object.keys(h.loaded).forEach(m=>{f[m]||(f[m]={});const w=h.loaded[m];w.length&&w.forEach(v=>{f[m][v]===void 0&&(f[m][v]=!0)})}),h.done=!0,h.errors.length?h.callback(h.errors):h.callback())}),this.emit(\"loaded\",f),this.queue=this.queue.filter(h=>!h.done)}read(r,s,i,a=0,u=this.retryTimeout,d){if(!r.length)return d(null,{});if(this.readingCalls>=this.maxParallelReads){this.waitingReads.push({lng:r,ns:s,fcName:i,tried:a,wait:u,callback:d});return}this.readingCalls++;const f=(m,w)=>{if(this.readingCalls--,this.waitingReads.length>0){const v=this.waitingReads.shift();this.read(v.lng,v.ns,v.fcName,v.tried,v.wait,v.callback)}if(m&&w&&a<this.maxRetries){setTimeout(()=>{this.read.call(this,r,s,i,a+1,u*2,d)},u);return}d(m,w)},h=this.backend[i].bind(this.backend);if(h.length===2){try{const m=h(r,s);m&&typeof m.then==\"function\"?m.then(w=>f(null,w)).catch(f):f(null,m)}catch(m){f(m)}return}return h(r,s,f)}prepareLoading(r,s,i={},a){if(!this.backend)return this.logger.warn(\"No backend was added via i18next.use. Will not load resources.\"),a&&a();we(r)&&(r=this.languageUtils.toResolveHierarchy(r)),we(s)&&(s=[s]);const u=this.queueLoad(r,s,i,a);if(!u.toLoad.length)return u.pending.length||a(),null;u.toLoad.forEach(d=>{this.loadOne(d)})}load(r,s,i){this.prepareLoading(r,s,{},i)}reload(r,s,i){this.prepareLoading(r,s,{reload:!0},i)}loadOne(r,s=\"\"){const i=r.split(\"|\"),a=i[0],u=i[1];this.read(a,u,\"read\",void 0,void 0,(d,f)=>{d&&this.logger.warn(`${s}loading namespace ${u} for language ${a} failed`,d),!d&&f&&this.logger.log(`${s}loaded namespace ${u} for language ${a}`,f),this.loaded(r,d,f)})}saveMissing(r,s,i,a,u,d={},f=()=>{}){if(this.services?.utils?.hasLoadedNamespace&&!this.services?.utils?.hasLoadedNamespace(s)){this.logger.warn(`did not save key \"${i}\" as the namespace \"${s}\" was not yet loaded`,\"This means something IS WRONG in your setup. You access the t function before i18next.init / i18next.loadNamespace / i18next.changeLanguage was done. Wait for the callback or Promise to resolve before accessing it!!!\");return}if(!(i==null||i===\"\")){if(this.backend?.create){const h={...d,isUpdate:u},m=this.backend.create.bind(this.backend);if(m.length<6)try{let w;m.length===5?w=m(r,s,i,a,h):w=m(r,s,i,a),w&&typeof w.then==\"function\"?w.then(v=>f(null,v)).catch(f):f(null,w)}catch(w){f(w)}else m(r,s,i,a,f,h)}!r||!r[0]||this.store.addResource(r[0],s,i,a)}}}const du=()=>({debug:!1,initAsync:!0,ns:[\"translation\"],defaultNS:[\"translation\"],fallbackLng:[\"dev\"],fallbackNS:!1,supportedLngs:!1,nonExplicitSupportedLngs:!1,load:\"all\",preload:!1,simplifyPluralSuffix:!0,keySeparator:\".\",nsSeparator:\":\",pluralSeparator:\"_\",contextSeparator:\"_\",partialBundledLanguages:!1,saveMissing:!1,updateMissing:!1,saveMissingTo:\"fallback\",saveMissingPlurals:!0,missingKeyHandler:!1,missingInterpolationHandler:!1,postProcess:!1,postProcessPassResolved:!1,returnNull:!1,returnEmptyString:!0,returnObjects:!1,joinArrays:!1,returnedObjectHandler:!1,parseMissingKeyHandler:!1,appendNamespaceToMissingKey:!1,appendNamespaceToCIMode:!1,overloadTranslationOptionHandler:n=>{let r={};if(typeof n[1]==\"object\"&&(r=n[1]),we(n[1])&&(r.defaultValue=n[1]),we(n[2])&&(r.tDescription=n[2]),typeof n[2]==\"object\"||typeof n[3]==\"object\"){const s=n[3]||n[2];Object.keys(s).forEach(i=>{r[i]=s[i]})}return r},interpolation:{escapeValue:!0,format:n=>n,prefix:\"{{\",suffix:\"}}\",formatSeparator:\",\",unescapePrefix:\"-\",nestingPrefix:\"$t(\",nestingSuffix:\")\",nestingOptionsSeparator:\",\",maxReplaces:1e3,skipOnVariables:!0},cacheInBuiltFormats:!0}),$p=n=>(we(n.ns)&&(n.ns=[n.ns]),we(n.fallbackLng)&&(n.fallbackLng=[n.fallbackLng]),we(n.fallbackNS)&&(n.fallbackNS=[n.fallbackNS]),n.supportedLngs?.indexOf?.(\"cimode\")<0&&(n.supportedLngs=n.supportedLngs.concat([\"cimode\"])),typeof n.initImmediate==\"boolean\"&&(n.initAsync=n.initImmediate),n),ki=()=>{},Ex=n=>{Object.getOwnPropertyNames(Object.getPrototypeOf(n)).forEach(s=>{typeof n[s]==\"function\"&&(n[s]=n[s].bind(n))})},Ah=\"__i18next_supportNoticeShown\",Px=()=>!!(typeof globalThis<\"u\"&&globalThis[Ah]||typeof process<\"u\"&&au&&au.I18NEXT_NO_SUPPORT_NOTICE||typeof process<\"u\"&&au),Nx=()=>{typeof globalThis<\"u\"&&(globalThis[Ah]=!0)},Rx=n=>!!(n?.modules?.backend?.name?.indexOf(\"Locize\")>0||n?.modules?.backend?.constructor?.name?.indexOf(\"Locize\")>0||n?.options?.backend?.backends&&n.options.backend.backends.some(r=>r?.name?.indexOf(\"Locize\")>0||r?.constructor?.name?.indexOf(\"Locize\")>0)||n?.options?.backend?.projectId||n?.options?.backend?.backendOptions&&n.options.backend.backendOptions.some(r=>r?.projectId));class ts extends Yi{constructor(r={},s){if(super(),this.options=$p(r),this.services={},this.logger=rn,this.modules={external:[]},Ex(this),s&&!this.isInitialized&&!r.isClone){if(!this.options.initAsync)return this.init(r,s),this;setTimeout(()=>{this.init(r,s)},0)}}init(r={},s){this.isInitializing=!0,typeof r==\"function\"&&(s=r,r={}),r.defaultNS==null&&r.ns&&(we(r.ns)?r.defaultNS=r.ns:r.ns.indexOf(\"translation\")<0&&(r.defaultNS=r.ns[0]));const i=du();this.options={...i,...this.options,...$p(r)},this.options.interpolation={...i.interpolation,...this.options.interpolation},r.keySeparator!==void 0&&(this.options.userDefinedKeySeparator=r.keySeparator),r.nsSeparator!==void 0&&(this.options.userDefinedNsSeparator=r.nsSeparator),typeof this.options.overloadTranslationOptionHandler!=\"function\"&&(this.options.overloadTranslationOptionHandler=i.overloadTranslationOptionHandler),this.options.showSupportNotice!==!1&&!Rx(this)&&!Px()&&(typeof console<\"u\"&&typeof console.info<\"u\"&&console.info(\"🌐 i18next is made possible by our own product, Locize — consider powering your project with managed localization (AI, CDN, integrations): https://locize.com 💙\"),Nx());const a=m=>m?typeof m==\"function\"?new m:m:null;if(!this.options.isClone){this.modules.logger?rn.init(a(this.modules.logger),this.options):rn.init(null,this.options);let m;this.modules.formatter?m=this.modules.formatter:m=Cx;const w=new Ip(this.options);this.store=new Tp(this.options.resources,this.options);const v=this.services;v.logger=rn,v.resourceStore=this.store,v.languageUtils=w,v.pluralResolver=new xx(w,{prepend:this.options.pluralSeparator,simplifyPluralSuffix:this.options.simplifyPluralSuffix}),this.options.interpolation.format&&this.options.interpolation.format!==i.interpolation.format&&this.logger.deprecate(\"init: you are still using the legacy format function, please use the new approach: https://www.i18next.com/translation-function/formatting\"),m&&(!this.options.interpolation.format||this.options.interpolation.format===i.interpolation.format)&&(v.formatter=a(m),v.formatter.init&&v.formatter.init(v,this.options),this.options.interpolation.format=v.formatter.format.bind(v.formatter)),v.interpolator=new zp(this.options),v.utils={hasLoadedNamespace:this.hasLoadedNamespace.bind(this)},v.backendConnector=new bx(a(this.modules.backend),v.resourceStore,v,this.options),v.backendConnector.on(\"*\",(C,...k)=>{this.emit(C,...k)}),this.modules.languageDetector&&(v.languageDetector=a(this.modules.languageDetector),v.languageDetector.init&&v.languageDetector.init(v,this.options.detection,this.options)),this.modules.i18nFormat&&(v.i18nFormat=a(this.modules.i18nFormat),v.i18nFormat.init&&v.i18nFormat.init(this)),this.translator=new Vi(this.services,this.options),this.translator.on(\"*\",(C,...k)=>{this.emit(C,...k)}),this.modules.external.forEach(C=>{C.init&&C.init(this)})}if(this.format=this.options.interpolation.format,s||(s=ki),this.options.fallbackLng&&!this.services.languageDetector&&!this.options.lng){const m=this.services.languageUtils.getFallbackCodes(this.options.fallbackLng);m.length>0&&m[0]!==\"dev\"&&(this.options.lng=m[0])}!this.services.languageDetector&&!this.options.lng&&this.logger.warn(\"init: no languageDetector is used and no lng is defined\"),[\"getResource\",\"hasResourceBundle\",\"getResourceBundle\",\"getDataByLanguage\"].forEach(m=>{this[m]=(...w)=>this.store[m](...w)}),[\"addResource\",\"addResources\",\"addResourceBundle\",\"removeResourceBundle\"].forEach(m=>{this[m]=(...w)=>(this.store[m](...w),this)});const f=qo(),h=()=>{const m=(w,v)=>{this.isInitializing=!1,this.isInitialized&&!this.initializedStoreOnce&&this.logger.warn(\"init: i18next is already initialized. You should call init just once!\"),this.isInitialized=!0,this.options.isClone||this.logger.log(\"initialized\",this.options),this.emit(\"initialized\",this.options),f.resolve(v),s(w,v)};if(this.languages&&!this.isInitialized)return m(null,this.t.bind(this));this.changeLanguage(this.options.lng,m)};return this.options.resources||!this.options.initAsync?h():setTimeout(h,0),f}loadResources(r,s=ki){let i=s;const a=we(r)?r:this.language;if(typeof r==\"function\"&&(i=r),!this.options.resources||this.options.partialBundledLanguages){if(a?.toLowerCase()===\"cimode\"&&(!this.options.preload||this.options.preload.length===0))return i();const u=[],d=f=>{if(!f||f===\"cimode\")return;this.services.languageUtils.toResolveHierarchy(f).forEach(m=>{m!==\"cimode\"&&u.indexOf(m)<0&&u.push(m)})};a?d(a):this.services.languageUtils.getFallbackCodes(this.options.fallbackLng).forEach(h=>d(h)),this.options.preload?.forEach?.(f=>d(f)),this.services.backendConnector.load(u,this.options.ns,f=>{!f&&!this.resolvedLanguage&&this.language&&this.setResolvedLanguage(this.language),i(f)})}else i(null)}reloadResources(r,s,i){const a=qo();return typeof r==\"function\"&&(i=r,r=void 0),typeof s==\"function\"&&(i=s,s=void 0),r||(r=this.languages),s||(s=this.options.ns),i||(i=ki),this.services.backendConnector.reload(r,s,u=>{a.resolve(),i(u)}),a}use(r){if(!r)throw new Error(\"You are passing an undefined module! Please check the object you are passing to i18next.use()\");if(!r.type)throw new Error(\"You are passing a wrong module! Please check the object you are passing to i18next.use()\");return r.type===\"backend\"&&(this.modules.backend=r),(r.type===\"logger\"||r.log&&r.warn&&r.error)&&(this.modules.logger=r),r.type===\"languageDetector\"&&(this.modules.languageDetector=r),r.type===\"i18nFormat\"&&(this.modules.i18nFormat=r),r.type===\"postProcessor\"&&Lh.addPostProcessor(r),r.type===\"formatter\"&&(this.modules.formatter=r),r.type===\"3rdParty\"&&this.modules.external.push(r),this}setResolvedLanguage(r){if(!(!r||!this.languages)&&!([\"cimode\",\"dev\"].indexOf(r)>-1)){for(let s=0;s<this.languages.length;s++){const i=this.languages[s];if(!([\"cimode\",\"dev\"].indexOf(i)>-1)&&this.store.hasLanguageSomeTranslations(i)){this.resolvedLanguage=i;break}}!this.resolvedLanguage&&this.languages.indexOf(r)<0&&this.store.hasLanguageSomeTranslations(r)&&(this.resolvedLanguage=r,this.languages.unshift(r))}}changeLanguage(r,s){this.isLanguageChangingTo=r;const i=qo();this.emit(\"languageChanging\",r);const a=f=>{this.language=f,this.languages=this.services.languageUtils.toResolveHierarchy(f),this.resolvedLanguage=void 0,this.setResolvedLanguage(f)},u=(f,h)=>{h?this.isLanguageChangingTo===r&&(a(h),this.translator.changeLanguage(h),this.isLanguageChangingTo=void 0,this.emit(\"languageChanged\",h),this.logger.log(\"languageChanged\",h)):this.isLanguageChangingTo=void 0,i.resolve((...m)=>this.t(...m)),s&&s(f,(...m)=>this.t(...m))},d=f=>{!r&&!f&&this.services.languageDetector&&(f=[]);const h=we(f)?f:f&&f[0],m=this.store.hasLanguageSomeTranslations(h)?h:this.services.languageUtils.getBestMatchFromCodes(we(f)?[f]:f);m&&(this.language||a(m),this.translator.language||this.translator.changeLanguage(m),this.services.languageDetector?.cacheUserLanguage?.(m)),this.loadResources(m,w=>{u(w,m)})};return!r&&this.services.languageDetector&&!this.services.languageDetector.async?d(this.services.languageDetector.detect()):!r&&this.services.languageDetector&&this.services.languageDetector.async?this.services.languageDetector.detect.length===0?this.services.languageDetector.detect().then(d):this.services.languageDetector.detect(d):d(r),i}getFixedT(r,s,i){const a=(u,d,...f)=>{let h;typeof d!=\"object\"?h=this.options.overloadTranslationOptionHandler([u,d].concat(f)):h={...d},h.lng=h.lng||a.lng,h.lngs=h.lngs||a.lngs,h.ns=h.ns||a.ns,h.keyPrefix!==\"\"&&(h.keyPrefix=h.keyPrefix||i||a.keyPrefix);const m={...this.options,...h};typeof h.keyPrefix==\"function\"&&(h.keyPrefix=oo(h.keyPrefix,m));const w=this.options.keySeparator||\".\";let v;return h.keyPrefix&&Array.isArray(u)?v=u.map(S=>(typeof S==\"function\"&&(S=oo(S,m)),`${h.keyPrefix}${w}${S}`)):(typeof u==\"function\"&&(u=oo(u,m)),v=h.keyPrefix?`${h.keyPrefix}${w}${u}`:u),this.t(v,h)};return we(r)?a.lng=r:a.lngs=r,a.ns=s,a.keyPrefix=i,a}t(...r){return this.translator?.translate(...r)}exists(...r){return this.translator?.exists(...r)}setDefaultNamespace(r){this.options.defaultNS=r}hasLoadedNamespace(r,s={}){if(!this.isInitialized)return this.logger.warn(\"hasLoadedNamespace: i18next was not initialized\",this.languages),!1;if(!this.languages||!this.languages.length)return this.logger.warn(\"hasLoadedNamespace: i18n.languages were undefined or empty\",this.languages),!1;const i=s.lng||this.resolvedLanguage||this.languages[0],a=this.options?this.options.fallbackLng:!1,u=this.languages[this.languages.length-1];if(i.toLowerCase()===\"cimode\")return!0;const d=(f,h)=>{const m=this.services.backendConnector.state[`${f}|${h}`];return m===-1||m===0||m===2};if(s.precheck){const f=s.precheck(this,d);if(f!==void 0)return f}return!!(this.hasResourceBundle(i,r)||!this.services.backendConnector.backend||this.options.resources&&!this.options.partialBundledLanguages||d(i,r)&&(!a||d(u,r)))}loadNamespaces(r,s){const i=qo();return this.options.ns?(we(r)&&(r=[r]),r.forEach(a=>{this.options.ns.indexOf(a)<0&&this.options.ns.push(a)}),this.loadResources(a=>{i.resolve(),s&&s(a)}),i):(s&&s(),Promise.resolve())}loadLanguages(r,s){const i=qo();we(r)&&(r=[r]);const a=this.options.preload||[],u=r.filter(d=>a.indexOf(d)<0&&this.services.languageUtils.isSupportedCode(d));return u.length?(this.options.preload=a.concat(u),this.loadResources(d=>{i.resolve(),s&&s(d)}),i):(s&&s(),Promise.resolve())}dir(r){if(r||(r=this.resolvedLanguage||(this.languages?.length>0?this.languages[0]:this.language)),!r)return\"rtl\";try{const a=new Intl.Locale(r);if(a&&a.getTextInfo){const u=a.getTextInfo();if(u&&u.direction)return u.direction}}catch{}const s=[\"ar\",\"shu\",\"sqr\",\"ssh\",\"xaa\",\"yhd\",\"yud\",\"aao\",\"abh\",\"abv\",\"acm\",\"acq\",\"acw\",\"acx\",\"acy\",\"adf\",\"ads\",\"aeb\",\"aec\",\"afb\",\"ajp\",\"apc\",\"apd\",\"arb\",\"arq\",\"ars\",\"ary\",\"arz\",\"auz\",\"avl\",\"ayh\",\"ayl\",\"ayn\",\"ayp\",\"bbz\",\"pga\",\"he\",\"iw\",\"ps\",\"pbt\",\"pbu\",\"pst\",\"prp\",\"prd\",\"ug\",\"ur\",\"ydd\",\"yds\",\"yih\",\"ji\",\"yi\",\"hbo\",\"men\",\"xmn\",\"fa\",\"jpr\",\"peo\",\"pes\",\"prs\",\"dv\",\"sam\",\"ckb\"],i=this.services?.languageUtils||new Ip(du());return r.toLowerCase().indexOf(\"-latn\")>1?\"ltr\":s.indexOf(i.getLanguagePartFromCode(r))>-1||r.toLowerCase().indexOf(\"-arab\")>1?\"rtl\":\"ltr\"}static createInstance(r={},s){const i=new ts(r,s);return i.createInstance=ts.createInstance,i}cloneInstance(r={},s=ki){const i=r.forkResourceStore;i&&delete r.forkResourceStore;const a={...this.options,...r,isClone:!0},u=new ts(a);if((r.debug!==void 0||r.prefix!==void 0)&&(u.logger=u.logger.clone(r)),[\"store\",\"services\",\"language\"].forEach(f=>{u[f]=this[f]}),u.services={...this.services},u.services.utils={hasLoadedNamespace:u.hasLoadedNamespace.bind(u)},i){const f=Object.keys(this.store.data).reduce((h,m)=>(h[m]={...this.store.data[m]},h[m]=Object.keys(h[m]).reduce((w,v)=>(w[v]={...h[m][v]},w),h[m]),h),{});u.store=new Tp(f,a),u.services.resourceStore=u.store}if(r.interpolation){const h={...du().interpolation,...this.options.interpolation,...r.interpolation},m={...a,interpolation:h};u.services.interpolator=new zp(m)}return u.translator=new Vi(u.services,a),u.translator.on(\"*\",(f,...h)=>{u.emit(f,...h)}),u.init(a,s),u.translator.options=a,u.translator.backendConnector.services.utils={hasLoadedNamespace:u.hasLoadedNamespace.bind(u)},u}toJSON(){return{options:this.options,store:this.store,language:this.language,languages:this.languages,resolvedLanguage:this.resolvedLanguage}}}const vt=ts.createInstance();vt.createInstance;vt.dir;vt.init;vt.loadResources;vt.reloadResources;vt.use;vt.changeLanguage;vt.getFixedT;vt.t;vt.exists;vt.setDefaultNamespace;vt.hasLoadedNamespace;vt.loadNamespaces;vt.loadLanguages;const Ox=(n,r,s,i)=>{const a=[s,{code:r,...i||{}}];if(n?.services?.logger?.forward)return n.services.logger.forward(a,\"warn\",\"react-i18next::\",!0);yr(a[0])&&(a[0]=`react-i18next:: ${a[0]}`),n?.services?.logger?.warn?n.services.logger.warn(...a):console?.warn&&console.warn(...a)},Vp={},Ru=(n,r,s,i)=>{yr(s)&&Vp[s]||(yr(s)&&(Vp[s]=new Date),Ox(n,r,s,i))},Dh=(n,r)=>()=>{if(n.isInitialized)r();else{const s=()=>{setTimeout(()=>{n.off(\"initialized\",s)},0),r()};n.on(\"initialized\",s)}},Ou=(n,r,s)=>{n.loadNamespaces(r,Dh(n,s))},Bp=(n,r,s,i)=>{if(yr(s)&&(s=[s]),n.options.preload&&n.options.preload.indexOf(r)>-1)return Ou(n,s,i);s.forEach(a=>{n.options.ns.indexOf(a)<0&&n.options.ns.push(a)}),n.loadLanguages(r,Dh(n,i))},jx=(n,r,s={})=>!r.languages||!r.languages.length?(Ru(r,\"NO_LANGUAGES\",\"i18n.languages were undefined or empty\",{languages:r.languages}),!0):r.hasLoadedNamespace(n,{lng:s.lng,precheck:(i,a)=>{if(s.bindI18n&&s.bindI18n.indexOf(\"languageChanging\")>-1&&i.services.backendConnector.backend&&i.isLanguageChangingTo&&!a(i.isLanguageChangingTo,n))return!1}}),yr=n=>typeof n==\"string\",_x=n=>typeof n==\"object\"&&n!==null,Tx=/&(?:amp|#38|lt|#60|gt|#62|apos|#39|quot|#34|nbsp|#160|copy|#169|reg|#174|hellip|#8230|#x2F|#47);/g,Lx={\"&amp;\":\"&\",\"&#38;\":\"&\",\"&lt;\":\"<\",\"&#60;\":\"<\",\"&gt;\":\">\",\"&#62;\":\">\",\"&apos;\":\"'\",\"&#39;\":\"'\",\"&quot;\":'\"',\"&#34;\":'\"',\"&nbsp;\":\" \",\"&#160;\":\" \",\"&copy;\":\"©\",\"&#169;\":\"©\",\"&reg;\":\"®\",\"&#174;\":\"®\",\"&hellip;\":\"…\",\"&#8230;\":\"…\",\"&#x2F;\":\"/\",\"&#47;\":\"/\"},Ix=n=>Lx[n],Ax=n=>n.replace(Tx,Ix);let ju={bindI18n:\"languageChanged\",bindI18nStore:\"\",transEmptyNodeValue:\"\",transSupportBasicHtmlNodes:!0,transWrapTextNodes:\"\",transKeepBasicHtmlNodesFor:[\"br\",\"strong\",\"i\",\"p\"],useSuspense:!0,unescape:Ax,transDefaultProps:void 0};const Dx=(n={})=>{ju={...ju,...n}},Mx=()=>ju;let Mh;const zx=n=>{Mh=n},Fx=()=>Mh,$x={type:\"3rdParty\",init(n){Dx(n.options.react),zx(n)}},Vx=x.createContext();class Bx{constructor(){this.usedNamespaces={}}addUsedNamespaces(r){r.forEach(s=>{this.usedNamespaces[s]||(this.usedNamespaces[s]=!0)})}getUsedNamespaces(){return Object.keys(this.usedNamespaces)}}var fu={exports:{}},pu={};var Up;function Ux(){if(Up)return pu;Up=1;var n=Qi();function r(v,S){return v===S&&(v!==0||1/v===1/S)||v!==v&&S!==S}var s=typeof Object.is==\"function\"?Object.is:r,i=n.useState,a=n.useEffect,u=n.useLayoutEffect,d=n.useDebugValue;function f(v,S){var C=S(),k=i({inst:{value:C,getSnapshot:S}}),E=k[0].inst,b=k[1];return u(function(){E.value=C,E.getSnapshot=S,h(E)&&b({inst:E})},[v,C,S]),a(function(){return h(E)&&b({inst:E}),v(function(){h(E)&&b({inst:E})})},[v]),d(C),C}function h(v){var S=v.getSnapshot;v=v.value;try{var C=S();return!s(v,C)}catch{return!0}}function m(v,S){return S()}var w=typeof window>\"u\"||typeof window.document>\"u\"||typeof window.document.createElement>\"u\"?m:f;return pu.useSyncExternalStore=n.useSyncExternalStore!==void 0?n.useSyncExternalStore:w,pu}var Hp;function Hx(){return Hp||(Hp=1,fu.exports=Ux()),fu.exports}var Wx=Hx();const Kx=(n,r)=>{if(yr(r))return r;if(_x(r)&&yr(r.defaultValue))return r.defaultValue;if(typeof n==\"function\")return\"\";if(Array.isArray(n)){const s=n[n.length-1];return typeof s==\"function\"?\"\":s}return n},Gx={t:Kx,ready:!1},Qx=()=>()=>{},Xu=(n,r={})=>{const{i18n:s}=r,{i18n:i,defaultNS:a}=x.useContext(Vx)||{},u=s||i||Fx();u&&!u.reportNamespaces&&(u.reportNamespaces=new Bx),u||Ru(u,\"NO_I18NEXT_INSTANCE\",\"useTranslation: You will need to pass in an i18next instance by using initReactI18next\");const d=x.useMemo(()=>({...Mx(),...u?.options?.react,...r}),[u,r]),{useSuspense:f,keyPrefix:h}=d,m=a||u?.options?.defaultNS,w=yr(m)?[m]:m||[\"translation\"],v=x.useMemo(()=>w,w);u?.reportNamespaces?.addUsedNamespaces?.(v);const S=x.useRef(0),C=x.useCallback(W=>{if(!u)return Qx;const{bindI18n:X,bindI18nStore:Q}=d,q=()=>{S.current+=1,W()};return X&&u.on(X,q),Q&&u.store.on(Q,q),()=>{X&&X.split(\" \").forEach(Z=>u.off(Z,q)),Q&&Q.split(\" \").forEach(Z=>u.store.off(Z,q))}},[u,d]),k=x.useRef(),E=x.useCallback(()=>{if(!u)return Gx;const W=!!(u.isInitialized||u.initializedStoreOnce)&&v.every(fe=>jx(fe,u,d)),X=r.lng||u.language,Q=S.current,q=k.current;if(q&&q.ready===W&&q.lng===X&&q.keyPrefix===h&&q.revision===Q)return q;const ne={t:u.getFixedT(X,d.nsMode===\"fallback\"?v:v[0],h),ready:W,lng:X,keyPrefix:h,revision:Q};return k.current=ne,ne},[u,v,h,d,r.lng]),[b,_]=x.useState(0),{t:L,ready:T}=Wx.useSyncExternalStore(C,E,E);x.useEffect(()=>{if(u&&!T&&!f){const W=()=>_(X=>X+1);r.lng?Bp(u,r.lng,v,W):Ou(u,v,W)}},[u,r.lng,v,T,f,b]);const O=u||{},B=x.useRef(null),V=x.useRef(),H=W=>{const X=Object.getOwnPropertyDescriptors(W);X.__original&&delete X.__original;const Q=Object.create(Object.getPrototypeOf(W),X);if(!Object.prototype.hasOwnProperty.call(Q,\"__original\"))try{Object.defineProperty(Q,\"__original\",{value:W,writable:!1,enumerable:!1,configurable:!1})}catch{}return Q},$=x.useMemo(()=>{const W=O,X=W?.language;let Q=W;W&&(B.current&&B.current.__original===W?V.current!==X?(Q=H(W),B.current=Q,V.current=X):Q=B.current:(Q=H(W),B.current=Q,V.current=X));const q=!T&&!f?(...ne)=>(Ru(u,\"USE_T_BEFORE_READY\",\"useTranslation: t was called before ready. When using useSuspense: false, make sure to check the ready flag before using t.\"),L(...ne)):L,Z=[q,Q,T];return Z.t=q,Z.i18n=Q,Z.ready=T,Z},[L,O,T,O.resolvedLanguage,O.language,O.languages]);if(u&&f&&!T)throw new Promise(W=>{const X=()=>W();r.lng?Bp(u,r.lng,v,X):Ou(u,v,X)});return $};vt.use($x).init({lng:\"zh\",fallbackLng:\"zh\",interpolation:{escapeValue:!1},resources:{zh:{translation:{common:{cancel:\"取消\",confirm:\"确认\",edit:\"编辑\",delete:\"删除\"},apiKeyInput:{placeholder:\"输入新的 API Key，不会回显已有密钥\",show:\"显示新输入的密钥\",hide:\"隐藏新输入的密钥\"},opencode:{headers:\"自定义请求头\",headersHint:\"仅用于非凭据请求头；密钥请使用 API Key 输入框。\",addHeader:\"添加请求头\",noHeaders:\"未配置自定义请求头\",headerName:\"请求头名称\",headerValue:\"请求头值\",headerNamePlaceholder:\"X-Title\",headerValuePlaceholder:\"Grok Bot Switch\",removeHeader:\"删除请求头\"}}}}});const Yx=n=>n.replace(/([a-z0-9])([A-Z])/g,\"$1-$2\").toLowerCase(),Xx=n=>n.replace(/^([A-Z])|[\\s-_]+(\\w)/g,(r,s,i)=>i?i.toUpperCase():s.toLowerCase()),Wp=n=>{const r=Xx(n);return r.charAt(0).toUpperCase()+r.slice(1)},zh=(...n)=>n.filter((r,s,i)=>!!r&&r.trim()!==\"\"&&i.indexOf(r)===s).join(\" \").trim(),Zx=n=>{for(const r in n)if(r.startsWith(\"aria-\")||r===\"role\"||r===\"title\")return!0};var qx={xmlns:\"http://www.w3.org/2000/svg\",width:24,height:24,viewBox:\"0 0 24 24\",fill:\"none\",stroke:\"currentColor\",strokeWidth:2,strokeLinecap:\"round\",strokeLinejoin:\"round\"};const Jx=x.forwardRef(({color:n=\"currentColor\",size:r=24,strokeWidth:s=2,absoluteStrokeWidth:i,className:a=\"\",children:u,iconNode:d,...f},h)=>x.createElement(\"svg\",{ref:h,...qx,width:r,height:r,stroke:n,strokeWidth:i?Number(s)*24/Number(r):s,className:zh(\"lucide\",a),...!u&&!Zx(f)&&{\"aria-hidden\":\"true\"},...f},[...d.map(([m,w])=>x.createElement(m,w)),...Array.isArray(u)?u:[u]]));const Be=(n,r)=>{const s=x.forwardRef(({className:i,...a},u)=>x.createElement(Jx,{ref:u,iconNode:r,className:zh(`lucide-${Yx(Wp(n))}`,`lucide-${n}`,i),...a}));return s.displayName=Wp(n),s};const e0=[[\"path\",{d:\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\",key:\"169zse\"}]],t0=Be(\"activity\",e0);const n0=[[\"path\",{d:\"m12 19-7-7 7-7\",key:\"1l729n\"}],[\"path\",{d:\"M19 12H5\",key:\"x3x0zl\"}]],r0=Be(\"arrow-left\",n0);const o0=[[\"path\",{d:\"M12 8V4H8\",key:\"hb8ula\"}],[\"rect\",{width:\"16\",height:\"12\",x:\"4\",y:\"8\",rx:\"2\",key:\"enze0r\"}],[\"path\",{d:\"M2 14h2\",key:\"vft8re\"}],[\"path\",{d:\"M20 14h2\",key:\"4cs60a\"}],[\"path\",{d:\"M15 13v2\",key:\"1xurst\"}],[\"path\",{d:\"M9 13v2\",key:\"rq6x2g\"}]],s0=Be(\"bot\",o0);const i0=[[\"path\",{d:\"M20 6 9 17l-5-5\",key:\"1gmf2c\"}]],Fh=Be(\"check\",i0);const l0=[[\"path\",{d:\"m6 9 6 6 6-6\",key:\"qrunsl\"}]],Zu=Be(\"chevron-down\",l0);const a0=[[\"path\",{d:\"m9 18 6-6-6-6\",key:\"mthhwq\"}]],u0=Be(\"chevron-right\",a0);const c0=[[\"path\",{d:\"m18 15-6-6-6 6\",key:\"153udz\"}]],d0=Be(\"chevron-up\",c0);const f0=[[\"path\",{d:\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\",key:\"ct8e1f\"}],[\"path\",{d:\"M14.084 14.158a3 3 0 0 1-4.242-4.242\",key:\"151rxh\"}],[\"path\",{d:\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\",key:\"13bj9a\"}],[\"path\",{d:\"m2 2 20 20\",key:\"1ooewy\"}]],p0=Be(\"eye-off\",f0);const h0=[[\"path\",{d:\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\",key:\"1nclc0\"}],[\"circle\",{cx:\"12\",cy:\"12\",r:\"3\",key:\"1v7zrd\"}]],m0=Be(\"eye\",h0);const g0=[[\"circle\",{cx:\"12\",cy:\"12\",r:\"10\",key:\"1mglay\"}],[\"path\",{d:\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\",key:\"13o1zl\"}],[\"path\",{d:\"M2 12h20\",key:\"9i4pu4\"}]],v0=Be(\"globe\",g0);const y0=[[\"circle\",{cx:\"12\",cy:\"12\",r:\"10\",key:\"1mglay\"}],[\"path\",{d:\"M12 16v-4\",key:\"1dtifu\"}],[\"path\",{d:\"M12 8h.01\",key:\"e9boi3\"}]],x0=Be(\"info\",y0);const w0=[[\"path\",{d:\"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z\",key:\"18887p\"}],[\"path\",{d:\"M7 11h10\",key:\"1twpyw\"}],[\"path\",{d:\"M7 15h6\",key:\"d9of3u\"}],[\"path\",{d:\"M7 7h8\",key:\"af5zfr\"}]],S0=Be(\"message-square-text\",w0);const C0=[[\"path\",{d:\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\",key:\"kfwtm\"}]],k0=Be(\"moon\",C0);const b0=[[\"path\",{d:\"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z\",key:\"10ikf1\"}]],$h=Be(\"play\",b0);const E0=[[\"path\",{d:\"M5 12h14\",key:\"1ays0h\"}],[\"path\",{d:\"M12 5v14\",key:\"s699le\"}]],Vh=Be(\"plus\",E0);const P0=[[\"path\",{d:\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\",key:\"v9h5vc\"}],[\"path\",{d:\"M21 3v5h-5\",key:\"1q7to0\"}],[\"path\",{d:\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\",key:\"3uifl3\"}],[\"path\",{d:\"M8 16H3v5\",key:\"1cv678\"}]],N0=Be(\"refresh-cw\",P0);const R0=[[\"path\",{d:\"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\",key:\"1c8476\"}],[\"path\",{d:\"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7\",key:\"1ydtos\"}],[\"path\",{d:\"M7 3v4a1 1 0 0 0 1 1h7\",key:\"t51u73\"}]],O0=Be(\"save\",R0);const j0=[[\"path\",{d:\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\",key:\"1s2grr\"}],[\"path\",{d:\"M20 2v4\",key:\"1rf3ol\"}],[\"path\",{d:\"M22 4h-4\",key:\"gwowj6\"}],[\"circle\",{cx:\"4\",cy:\"20\",r:\"2\",key:\"6kqj1y\"}]],Bh=Be(\"sparkles\",j0);const _0=[[\"path\",{d:\"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7\",key:\"1m0v6g\"}],[\"path\",{d:\"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z\",key:\"ohrbg2\"}]],T0=Be(\"square-pen\",_0);const L0=[[\"circle\",{cx:\"12\",cy:\"12\",r:\"4\",key:\"4exip2\"}],[\"path\",{d:\"M12 2v2\",key:\"tus03m\"}],[\"path\",{d:\"M12 20v2\",key:\"1lh1kg\"}],[\"path\",{d:\"m4.93 4.93 1.41 1.41\",key:\"149t6j\"}],[\"path\",{d:\"m17.66 17.66 1.41 1.41\",key:\"ptbguv\"}],[\"path\",{d:\"M2 12h2\",key:\"1t8f8n\"}],[\"path\",{d:\"M20 12h2\",key:\"1q8mjw\"}],[\"path\",{d:\"m6.34 17.66-1.41 1.41\",key:\"1m8zz5\"}],[\"path\",{d:\"m19.07 4.93-1.41 1.41\",key:\"1shlcs\"}]],I0=Be(\"sun\",L0);const A0=[[\"path\",{d:\"M10 11v6\",key:\"nco0om\"}],[\"path\",{d:\"M14 11v6\",key:\"outv1u\"}],[\"path\",{d:\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\",key:\"miytrc\"}],[\"path\",{d:\"M3 6h18\",key:\"d0wm0j\"}],[\"path\",{d:\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\",key:\"e791ji\"}]],Uh=Be(\"trash-2\",A0);const D0=[[\"path\",{d:\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\",key:\"wmoenq\"}],[\"path\",{d:\"M12 9v4\",key:\"juzpu7\"}],[\"path\",{d:\"M12 17h.01\",key:\"p32p05\"}]],M0=Be(\"triangle-alert\",D0);const z0=[[\"path\",{d:\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z\",key:\"1ngwbx\"}]],F0=Be(\"wrench\",z0);var $0=Object.defineProperty,qu=(n,r)=>$0(n,\"name\",{value:r,configurable:!0});function _u(n,r){if(typeof n==\"function\")return n(r);n!=null&&(n.current=r)}qu(_u,\"setRef\");function Hh(...n){return r=>{let s=!1;const i=n.map(a=>{const u=_u(a,r);return!s&&typeof u==\"function\"&&(s=!0),u});if(s)return()=>{for(let a=0;a<i.length;a++){const u=i[a];typeof u==\"function\"?u():_u(n[a],null)}}}}qu(Hh,\"composeRefs\");function De(...n){return x.useCallback(Hh(...n),n)}qu(De,\"useComposedRefs\");var V0=Object.defineProperty,Qt=(n,r)=>V0(n,\"name\",{value:r,configurable:!0});function Cn(n){const r=x.forwardRef((s,i)=>{let{children:a,...u}=s,d=null,f=!1;const h=[];Tu(a)&&typeof bi==\"function\"&&(a=bi(a._payload)),x.Children.forEach(a,S=>{if(Yh(S)){f=!0;const C=S;let k=\"child\"in C.props?C.props.child:C.props.children;Tu(k)&&typeof bi==\"function\"&&(k=bi(k._payload)),d=U0(C,k),h.push(d?.props?.children)}else h.push(S)}),d?d=x.cloneElement(d,void 0,h):!f&&x.Children.count(a)===1&&x.isValidElement(a)&&(d=a);const m=d?Qh(d):void 0,w=De(i,m);if(!d){if(a||a===0)throw new Error(f?K0(n):W0(n));return a}const v=Gh(u,d.props??{});return d.type!==x.Fragment&&(v.ref=i?w:m),x.cloneElement(d,v)});return r.displayName=`${n}.Slot`,r}Qt(Cn,\"createSlot\");var B0=Cn(\"Slot\"),Wh=Symbol.for(\"radix.slottable\");function Kh(n){const r=Qt(s=>\"child\"in s?s.children(s.child):s.children,\"Slottable\");return r.displayName=`${n}.Slottable`,r.__radixId=Wh,r}Qt(Kh,\"createSlottable\");var U0=Qt((n,r)=>{if(\"child\"in n.props){const s=n.props.child;return x.isValidElement(s)?x.cloneElement(s,void 0,n.props.children(s.props.children)):null}return x.isValidElement(r)?r:null},\"getSlottableElementFromSlottable\");function Gh(n,r){const s={...r};for(const i in r){const a=n[i],u=r[i];/^on[A-Z]/.test(i)?a&&u?s[i]=(...f)=>{const h=u(...f);return a(...f),h}:a&&(s[i]=a):i===\"style\"?s[i]={...a,...u}:i===\"className\"&&(s[i]=[a,u].filter(Boolean).join(\" \"))}return{...n,...s}}Qt(Gh,\"mergeProps\");function Qh(n){let r=Object.getOwnPropertyDescriptor(n.props,\"ref\")?.get,s=r&&\"isReactWarning\"in r&&r.isReactWarning;return s?n.ref:(r=Object.getOwnPropertyDescriptor(n,\"ref\")?.get,s=r&&\"isReactWarning\"in r&&r.isReactWarning,s?n.props.ref:n.props.ref||n.ref)}Qt(Qh,\"getElementRef\");function Yh(n){return x.isValidElement(n)&&typeof n.type==\"function\"&&\"__radixId\"in n.type&&n.type.__radixId===Wh}Qt(Yh,\"isSlottable\");var H0=Symbol.for(\"react.lazy\");function Tu(n){return n!=null&&typeof n==\"object\"&&\"$$typeof\"in n&&n.$$typeof===H0&&\"_payload\"in n&&Xh(n._payload)}Qt(Tu,\"isLazyComponent\");function Xh(n){return typeof n==\"object\"&&n!==null&&\"then\"in n}Qt(Xh,\"isPromiseLike\");var W0=Qt(n=>`${n} failed to slot onto its children. Expected a single React element child or \\`Slottable\\`.`,\"createSlotError\"),K0=Qt(n=>`${n} failed to slot onto its \\`Slottable\\`. Expected \\`Slottable\\` to receive a single React element child.`,\"createSlottableError\"),bi=us[\" use \".trim().toString()];function Zh(n){var r,s,i=\"\";if(typeof n==\"string\"||typeof n==\"number\")i+=n;else if(typeof n==\"object\")if(Array.isArray(n)){var a=n.length;for(r=0;r<a;r++)n[r]&&(s=Zh(n[r]))&&(i&&(i+=\" \"),i+=s)}else for(s in n)n[s]&&(i&&(i+=\" \"),i+=s);return i}function qh(){for(var n,r,s=0,i=\"\",a=arguments.length;s<a;s++)(n=arguments[s])&&(r=Zh(n))&&(i&&(i+=\" \"),i+=r);return i}const Kp=n=>typeof n==\"boolean\"?`${n}`:n===0?\"0\":n,Gp=qh,G0=(n,r)=>s=>{var i;if(r?.variants==null)return Gp(n,s?.class,s?.className);const{variants:a,defaultVariants:u}=r,d=Object.keys(a).map(m=>{const w=s?.[m],v=u?.[m];if(w===null)return null;const S=Kp(w)||Kp(v);return a[m][S]}),f=s&&Object.entries(s).reduce((m,w)=>{let[v,S]=w;return S===void 0||(m[v]=S),m},{}),h=r==null||(i=r.compoundVariants)===null||i===void 0?void 0:i.reduce((m,w)=>{let{class:v,className:S,...C}=w;return Object.entries(C).every(k=>{let[E,b]=k;return Array.isArray(b)?b.includes({...u,...f}[E]):{...u,...f}[E]===b})?[...m,v,S]:m},[]);return Gp(n,d,h,s?.class,s?.className)},Q0=(n,r)=>{const s=new Array(n.length+r.length);for(let i=0;i<n.length;i++)s[i]=n[i];for(let i=0;i<r.length;i++)s[n.length+i]=r[i];return s},Y0=(n,r)=>({classGroupId:n,validator:r}),Jh=(n=new Map,r=null,s)=>({nextPart:n,validators:r,classGroupId:s}),Bi=\"-\",Qp=[],X0=\"arbitrary..\",Z0=n=>{const r=J0(n),{conflictingClassGroups:s,conflictingClassGroupModifiers:i}=n;return{getClassGroupId:d=>{if(d.startsWith(\"[\")&&d.endsWith(\"]\"))return q0(d);const f=d.split(Bi),h=f[0]===\"\"&&f.length>1?1:0;return em(f,h,r)},getConflictingClassGroupIds:(d,f)=>{if(f){const h=i[d],m=s[d];return h?m?Q0(m,h):h:m||Qp}return s[d]||Qp}}},em=(n,r,s)=>{if(n.length-r===0)return s.classGroupId;const a=n[r],u=s.nextPart.get(a);if(u){const m=em(n,r+1,u);if(m)return m}const d=s.validators;if(d===null)return;const f=r===0?n.join(Bi):n.slice(r).join(Bi),h=d.length;for(let m=0;m<h;m++){const w=d[m];if(w.validator(f))return w.classGroupId}},q0=n=>n.slice(1,-1).indexOf(\":\")===-1?void 0:(()=>{const r=n.slice(1,-1),s=r.indexOf(\":\"),i=r.slice(0,s);return i?X0+i:void 0})(),J0=n=>{const{theme:r,classGroups:s}=n;return ew(s,r)},ew=(n,r)=>{const s=Jh();for(const i in n){const a=n[i];Ju(a,s,i,r)}return s},Ju=(n,r,s,i)=>{const a=n.length;for(let u=0;u<a;u++){const d=n[u];tw(d,r,s,i)}},tw=(n,r,s,i)=>{if(typeof n==\"string\"){nw(n,r,s);return}if(typeof n==\"function\"){rw(n,r,s,i);return}ow(n,r,s,i)},nw=(n,r,s)=>{const i=n===\"\"?r:tm(r,n);i.classGroupId=s},rw=(n,r,s,i)=>{if(sw(n)){Ju(n(i),r,s,i);return}r.validators===null&&(r.validators=[]),r.validators.push(Y0(s,n))},ow=(n,r,s,i)=>{const a=Object.entries(n),u=a.length;for(let d=0;d<u;d++){const[f,h]=a[d];Ju(h,tm(r,f),s,i)}},tm=(n,r)=>{let s=n;const i=r.split(Bi),a=i.length;for(let u=0;u<a;u++){const d=i[u];let f=s.nextPart.get(d);f||(f=Jh(),s.nextPart.set(d,f)),s=f}return s},sw=n=>\"isThemeGetter\"in n&&n.isThemeGetter===!0,iw=n=>{if(n<1)return{get:()=>{},set:()=>{}};let r=0,s=Object.create(null),i=Object.create(null);const a=(u,d)=>{s[u]=d,r++,r>n&&(r=0,i=s,s=Object.create(null))};return{get(u){let d=s[u];if(d!==void 0)return d;if((d=i[u])!==void 0)return a(u,d),d},set(u,d){u in s?s[u]=d:a(u,d)}}},Lu=\"!\",Yp=\":\",lw=[],Xp=(n,r,s,i,a)=>({modifiers:n,hasImportantModifier:r,baseClassName:s,maybePostfixModifierPosition:i,isExternal:a}),aw=n=>{const{prefix:r,experimentalParseClassName:s}=n;let i=a=>{const u=[];let d=0,f=0,h=0,m;const w=a.length;for(let E=0;E<w;E++){const b=a[E];if(d===0&&f===0){if(b===Yp){u.push(a.slice(h,E)),h=E+1;continue}if(b===\"/\"){m=E;continue}}b===\"[\"?d++:b===\"]\"?d--:b===\"(\"?f++:b===\")\"&&f--}const v=u.length===0?a:a.slice(h);let S=v,C=!1;v.endsWith(Lu)?(S=v.slice(0,-1),C=!0):v.startsWith(Lu)&&(S=v.slice(1),C=!0);const k=m&&m>h?m-h:void 0;return Xp(u,C,S,k)};if(r){const a=r+Yp,u=i;i=d=>d.startsWith(a)?u(d.slice(a.length)):Xp(lw,!1,d,void 0,!0)}if(s){const a=i;i=u=>s({className:u,parseClassName:a})}return i},uw=n=>{const r=new Map;return n.orderSensitiveModifiers.forEach((s,i)=>{r.set(s,1e6+i)}),s=>{const i=[];let a=[];for(let u=0;u<s.length;u++){const d=s[u],f=d[0]===\"[\",h=r.has(d);f||h?(a.length>0&&(a.sort(),i.push(...a),a=[]),i.push(d)):a.push(d)}return a.length>0&&(a.sort(),i.push(...a)),i}},cw=n=>({cache:iw(n.cacheSize),parseClassName:aw(n),sortModifiers:uw(n),postfixLookupClassGroupIds:dw(n),...Z0(n)}),dw=n=>{const r=Object.create(null),s=n.postfixLookupClassGroups;if(s)for(let i=0;i<s.length;i++)r[s[i]]=!0;return r},fw=/\\s+/,pw=(n,r)=>{const{parseClassName:s,getClassGroupId:i,getConflictingClassGroupIds:a,sortModifiers:u,postfixLookupClassGroupIds:d}=r,f=[],h=n.trim().split(fw);let m=\"\";for(let w=h.length-1;w>=0;w-=1){const v=h[w],{isExternal:S,modifiers:C,hasImportantModifier:k,baseClassName:E,maybePostfixModifierPosition:b}=s(v);if(S){m=v+(m.length>0?\" \"+m:m);continue}let _=!!b,L;if(_){const H=E.substring(0,b);L=i(H);const $=L&&d[L]?i(E):void 0;$&&$!==L&&(L=$,_=!1)}else L=i(E);if(!L){if(!_){m=v+(m.length>0?\" \"+m:m);continue}if(L=i(E),!L){m=v+(m.length>0?\" \"+m:m);continue}_=!1}const T=C.length===0?\"\":C.length===1?C[0]:u(C).join(\":\"),O=k?T+Lu:T,B=O+L;if(f.indexOf(B)>-1)continue;f.push(B);const V=a(L,_);for(let H=0;H<V.length;++H){const $=V[H];f.push(O+$)}m=v+(m.length>0?\" \"+m:m)}return m},hw=(...n)=>{let r=0,s,i,a=\"\";for(;r<n.length;)(s=n[r++])&&(i=nm(s))&&(a&&(a+=\" \"),a+=i);return a},nm=n=>{if(typeof n==\"string\")return n;let r,s=\"\";for(let i=0;i<n.length;i++)n[i]&&(r=nm(n[i]))&&(s&&(s+=\" \"),s+=r);return s},mw=(n,...r)=>{let s,i,a,u;const d=h=>{const m=r.reduce((w,v)=>v(w),n());return s=cw(m),i=s.cache.get,a=s.cache.set,u=f,f(h)},f=h=>{const m=i(h);if(m)return m;const w=pw(h,s);return a(h,w),w};return u=d,(...h)=>u(hw(...h))},gw=[],qe=n=>{const r=s=>s[n]||gw;return r.isThemeGetter=!0,r},rm=/^\\[(?:(\\w[\\w-]*):)?(.+)\\]$/i,om=/^\\((?:(\\w[\\w-]*):)?(.+)\\)$/i,vw=/^\\d+(?:\\.\\d+)?\\/\\d+(?:\\.\\d+)?$/,yw=/^(\\d+(\\.\\d+)?)?(xs|sm|md|lg|xl)$/,xw=/\\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\\b(calc|min|max|clamp)\\(.+\\)|^0$/,ww=/^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix)\\(.+\\)$/,Sw=/^(inset_)?-?((\\d+)?\\.?(\\d+)[a-z]+|0)_-?((\\d+)?\\.?(\\d+)[a-z]+|0)/,Cw=/^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\\(.+\\)$/,Kn=n=>vw.test(n),Ce=n=>!!n&&!Number.isNaN(Number(n)),tn=n=>!!n&&Number.isInteger(Number(n)),hu=n=>n.endsWith(\"%\")&&Ce(n.slice(0,-1)),vn=n=>yw.test(n),sm=()=>!0,kw=n=>xw.test(n)&&!ww.test(n),ec=()=>!1,bw=n=>Sw.test(n),Ew=n=>Cw.test(n),Pw=n=>!ae(n)&&!ce(n),Nw=n=>n.startsWith(\"@container\")&&(n[10]===\"/\"&&n[11]!==void 0||n[11]===\"s\"&&n[16]!==void 0&&n.startsWith(\"-size/\",10)||n[11]===\"n\"&&n[18]!==void 0&&n.startsWith(\"-normal/\",10)),Rw=n=>Zn(n,am,ec),ae=n=>rm.test(n),mr=n=>Zn(n,um,kw),Zp=n=>Zn(n,Dw,Ce),Ow=n=>Zn(n,dm,sm),jw=n=>Zn(n,cm,ec),qp=n=>Zn(n,im,ec),_w=n=>Zn(n,lm,Ew),Ei=n=>Zn(n,fm,bw),ce=n=>om.test(n),Jo=n=>Cr(n,um),Tw=n=>Cr(n,cm),Jp=n=>Cr(n,im),Lw=n=>Cr(n,am),Iw=n=>Cr(n,lm),Pi=n=>Cr(n,fm,!0),Aw=n=>Cr(n,dm,!0),Zn=(n,r,s)=>{const i=rm.exec(n);return i?i[1]?r(i[1]):s(i[2]):!1},Cr=(n,r,s=!1)=>{const i=om.exec(n);return i?i[1]?r(i[1]):s:!1},im=n=>n===\"position\"||n===\"percentage\",lm=n=>n===\"image\"||n===\"url\",am=n=>n===\"length\"||n===\"size\"||n===\"bg-size\",um=n=>n===\"length\",Dw=n=>n===\"number\",cm=n=>n===\"family-name\",dm=n=>n===\"number\"||n===\"weight\",fm=n=>n===\"shadow\",Mw=()=>{const n=qe(\"color\"),r=qe(\"font\"),s=qe(\"text\"),i=qe(\"font-weight\"),a=qe(\"tracking\"),u=qe(\"leading\"),d=qe(\"breakpoint\"),f=qe(\"container\"),h=qe(\"spacing\"),m=qe(\"radius\"),w=qe(\"shadow\"),v=qe(\"inset-shadow\"),S=qe(\"text-shadow\"),C=qe(\"drop-shadow\"),k=qe(\"blur\"),E=qe(\"perspective\"),b=qe(\"aspect\"),_=qe(\"ease\"),L=qe(\"animate\"),T=()=>[\"auto\",\"avoid\",\"all\",\"avoid-page\",\"page\",\"left\",\"right\",\"column\"],O=()=>[\"center\",\"top\",\"bottom\",\"left\",\"right\",\"top-left\",\"left-top\",\"top-right\",\"right-top\",\"bottom-right\",\"right-bottom\",\"bottom-left\",\"left-bottom\"],B=()=>[...O(),ce,ae],V=()=>[\"auto\",\"hidden\",\"clip\",\"visible\",\"scroll\"],H=()=>[\"auto\",\"contain\",\"none\"],$=()=>[ce,ae,h],W=()=>[Kn,\"full\",\"auto\",...$()],X=()=>[tn,\"none\",\"subgrid\",ce,ae],Q=()=>[\"auto\",{span:[\"full\",tn,ce,ae]},tn,ce,ae],q=()=>[tn,\"auto\",ce,ae],Z=()=>[\"auto\",\"min\",\"max\",\"fr\",ce,ae],ne=()=>[\"start\",\"end\",\"center\",\"between\",\"around\",\"evenly\",\"stretch\",\"baseline\",\"center-safe\",\"end-safe\"],fe=()=>[\"start\",\"end\",\"center\",\"stretch\",\"center-safe\",\"end-safe\"],J=()=>[\"auto\",...$()],ee=()=>[Kn,\"auto\",\"full\",\"dvw\",\"dvh\",\"lvw\",\"lvh\",\"svw\",\"svh\",\"min\",\"max\",\"fit\",...$()],I=()=>[Kn,\"screen\",\"full\",\"dvw\",\"lvw\",\"svw\",\"min\",\"max\",\"fit\",...$()],U=()=>[Kn,\"screen\",\"full\",\"lh\",\"dvh\",\"lvh\",\"svh\",\"min\",\"max\",\"fit\",...$()],M=()=>[n,ce,ae],N=()=>[...O(),Jp,qp,{position:[ce,ae]}],D=()=>[\"no-repeat\",{repeat:[\"\",\"x\",\"y\",\"space\",\"round\"]}],oe=()=>[\"auto\",\"cover\",\"contain\",Lw,Rw,{size:[ce,ae]}],pe=()=>[hu,Jo,mr],se=()=>[\"\",\"none\",\"full\",m,ce,ae],ge=()=>[\"\",Ce,Jo,mr],Se=()=>[\"solid\",\"dashed\",\"dotted\",\"double\"],re=()=>[\"normal\",\"multiply\",\"screen\",\"overlay\",\"darken\",\"lighten\",\"color-dodge\",\"color-burn\",\"hard-light\",\"soft-light\",\"difference\",\"exclusion\",\"hue\",\"saturation\",\"color\",\"luminosity\"],le=()=>[Ce,hu,Jp,qp],Pe=()=>[\"\",\"none\",k,ce,ae],be=()=>[\"none\",Ce,ce,ae],Re=()=>[\"none\",Ce,ce,ae],_e=()=>[Ce,ce,ae],Je=()=>[Kn,\"full\",...$()];return{cacheSize:500,theme:{animate:[\"spin\",\"ping\",\"pulse\",\"bounce\"],aspect:[\"video\"],blur:[vn],breakpoint:[vn],color:[sm],container:[vn],\"drop-shadow\":[vn],ease:[\"in\",\"out\",\"in-out\"],font:[Pw],\"font-weight\":[\"thin\",\"extralight\",\"light\",\"normal\",\"medium\",\"semibold\",\"bold\",\"extrabold\",\"black\"],\"inset-shadow\":[vn],leading:[\"none\",\"tight\",\"snug\",\"normal\",\"relaxed\",\"loose\"],perspective:[\"dramatic\",\"near\",\"normal\",\"midrange\",\"distant\",\"none\"],radius:[vn],shadow:[vn],spacing:[\"px\",Ce],text:[vn],\"text-shadow\":[vn],tracking:[\"tighter\",\"tight\",\"normal\",\"wide\",\"wider\",\"widest\"]},classGroups:{aspect:[{aspect:[\"auto\",\"square\",Kn,ae,ce,b]}],container:[\"container\"],\"container-type\":[{\"@container\":[\"\",\"normal\",\"size\",ce,ae]}],\"container-named\":[Nw],columns:[{columns:[Ce,ae,ce,f]}],\"break-after\":[{\"break-after\":T()}],\"break-before\":[{\"break-before\":T()}],\"break-inside\":[{\"break-inside\":[\"auto\",\"avoid\",\"avoid-page\",\"avoid-column\"]}],\"box-decoration\":[{\"box-decoration\":[\"slice\",\"clone\"]}],box:[{box:[\"border\",\"content\"]}],display:[\"block\",\"inline-block\",\"inline\",\"flex\",\"inline-flex\",\"table\",\"inline-table\",\"table-caption\",\"table-cell\",\"table-column\",\"table-column-group\",\"table-footer-group\",\"table-header-group\",\"table-row-group\",\"table-row\",\"flow-root\",\"grid\",\"inline-grid\",\"contents\",\"list-item\",\"hidden\"],sr:[\"sr-only\",\"not-sr-only\"],float:[{float:[\"right\",\"left\",\"none\",\"start\",\"end\"]}],clear:[{clear:[\"left\",\"right\",\"both\",\"none\",\"start\",\"end\"]}],isolation:[\"isolate\",\"isolation-auto\"],\"object-fit\":[{object:[\"contain\",\"cover\",\"fill\",\"none\",\"scale-down\"]}],\"object-position\":[{object:B()}],overflow:[{overflow:V()}],\"overflow-x\":[{\"overflow-x\":V()}],\"overflow-y\":[{\"overflow-y\":V()}],overscroll:[{overscroll:H()}],\"overscroll-x\":[{\"overscroll-x\":H()}],\"overscroll-y\":[{\"overscroll-y\":H()}],position:[\"static\",\"fixed\",\"absolute\",\"relative\",\"sticky\"],inset:[{inset:W()}],\"inset-x\":[{\"inset-x\":W()}],\"inset-y\":[{\"inset-y\":W()}],start:[{\"inset-s\":W(),start:W()}],end:[{\"inset-e\":W(),end:W()}],\"inset-bs\":[{\"inset-bs\":W()}],\"inset-be\":[{\"inset-be\":W()}],top:[{top:W()}],right:[{right:W()}],bottom:[{bottom:W()}],left:[{left:W()}],visibility:[\"visible\",\"invisible\",\"collapse\"],z:[{z:[tn,\"auto\",ce,ae]}],basis:[{basis:[Kn,\"full\",\"auto\",f,...$()]}],\"flex-direction\":[{flex:[\"row\",\"row-reverse\",\"col\",\"col-reverse\"]}],\"flex-wrap\":[{flex:[\"nowrap\",\"wrap\",\"wrap-reverse\"]}],flex:[{flex:[Ce,Kn,\"auto\",\"initial\",\"none\",ae]}],grow:[{grow:[\"\",Ce,ce,ae]}],shrink:[{shrink:[\"\",Ce,ce,ae]}],order:[{order:[tn,\"first\",\"last\",\"none\",ce,ae]}],\"grid-cols\":[{\"grid-cols\":X()}],\"col-start-end\":[{col:Q()}],\"col-start\":[{\"col-start\":q()}],\"col-end\":[{\"col-end\":q()}],\"grid-rows\":[{\"grid-rows\":X()}],\"row-start-end\":[{row:Q()}],\"row-start\":[{\"row-start\":q()}],\"row-end\":[{\"row-end\":q()}],\"grid-flow\":[{\"grid-flow\":[\"row\",\"col\",\"dense\",\"row-dense\",\"col-dense\"]}],\"auto-cols\":[{\"auto-cols\":Z()}],\"auto-rows\":[{\"auto-rows\":Z()}],gap:[{gap:$()}],\"gap-x\":[{\"gap-x\":$()}],\"gap-y\":[{\"gap-y\":$()}],\"justify-content\":[{justify:[...ne(),\"normal\"]}],\"justify-items\":[{\"justify-items\":[...fe(),\"normal\"]}],\"justify-self\":[{\"justify-self\":[\"auto\",...fe()]}],\"align-content\":[{content:[\"normal\",...ne()]}],\"align-items\":[{items:[...fe(),{baseline:[\"\",\"last\"]}]}],\"align-self\":[{self:[\"auto\",...fe(),{baseline:[\"\",\"last\"]}]}],\"place-content\":[{\"place-content\":ne()}],\"place-items\":[{\"place-items\":[...fe(),\"baseline\"]}],\"place-self\":[{\"place-self\":[\"auto\",...fe()]}],p:[{p:$()}],px:[{px:$()}],py:[{py:$()}],ps:[{ps:$()}],pe:[{pe:$()}],pbs:[{pbs:$()}],pbe:[{pbe:$()}],pt:[{pt:$()}],pr:[{pr:$()}],pb:[{pb:$()}],pl:[{pl:$()}],m:[{m:J()}],mx:[{mx:J()}],my:[{my:J()}],ms:[{ms:J()}],me:[{me:J()}],mbs:[{mbs:J()}],mbe:[{mbe:J()}],mt:[{mt:J()}],mr:[{mr:J()}],mb:[{mb:J()}],ml:[{ml:J()}],\"space-x\":[{\"space-x\":$()}],\"space-x-reverse\":[\"space-x-reverse\"],\"space-y\":[{\"space-y\":$()}],\"space-y-reverse\":[\"space-y-reverse\"],size:[{size:ee()}],\"inline-size\":[{inline:[\"auto\",...I()]}],\"min-inline-size\":[{\"min-inline\":[\"auto\",...I()]}],\"max-inline-size\":[{\"max-inline\":[\"none\",...I()]}],\"block-size\":[{block:[\"auto\",...U()]}],\"min-block-size\":[{\"min-block\":[\"auto\",...U()]}],\"max-block-size\":[{\"max-block\":[\"none\",...U()]}],w:[{w:[f,\"screen\",...ee()]}],\"min-w\":[{\"min-w\":[f,\"screen\",\"none\",...ee()]}],\"max-w\":[{\"max-w\":[f,\"screen\",\"none\",\"prose\",{screen:[d]},...ee()]}],h:[{h:[\"screen\",\"lh\",...ee()]}],\"min-h\":[{\"min-h\":[\"screen\",\"lh\",\"none\",...ee()]}],\"max-h\":[{\"max-h\":[\"screen\",\"lh\",...ee()]}],\"font-size\":[{text:[\"base\",s,Jo,mr]}],\"font-smoothing\":[\"antialiased\",\"subpixel-antialiased\"],\"font-style\":[\"italic\",\"not-italic\"],\"font-weight\":[{font:[i,Aw,Ow]}],\"font-stretch\":[{\"font-stretch\":[\"ultra-condensed\",\"extra-condensed\",\"condensed\",\"semi-condensed\",\"normal\",\"semi-expanded\",\"expanded\",\"extra-expanded\",\"ultra-expanded\",hu,ae]}],\"font-family\":[{font:[Tw,jw,r]}],\"font-features\":[{\"font-features\":[ae]}],\"fvn-normal\":[\"normal-nums\"],\"fvn-ordinal\":[\"ordinal\"],\"fvn-slashed-zero\":[\"slashed-zero\"],\"fvn-figure\":[\"lining-nums\",\"oldstyle-nums\"],\"fvn-spacing\":[\"proportional-nums\",\"tabular-nums\"],\"fvn-fraction\":[\"diagonal-fractions\",\"stacked-fractions\"],tracking:[{tracking:[a,ce,ae]}],\"line-clamp\":[{\"line-clamp\":[Ce,\"none\",ce,Zp]}],leading:[{leading:[u,...$()]}],\"list-image\":[{\"list-image\":[\"none\",ce,ae]}],\"list-style-position\":[{list:[\"inside\",\"outside\"]}],\"list-style-type\":[{list:[\"disc\",\"decimal\",\"none\",ce,ae]}],\"text-alignment\":[{text:[\"left\",\"center\",\"right\",\"justify\",\"start\",\"end\"]}],\"placeholder-color\":[{placeholder:M()}],\"text-color\":[{text:M()}],\"text-decoration\":[\"underline\",\"overline\",\"line-through\",\"no-underline\"],\"text-decoration-style\":[{decoration:[...Se(),\"wavy\"]}],\"text-decoration-thickness\":[{decoration:[Ce,\"from-font\",\"auto\",ce,mr]}],\"text-decoration-color\":[{decoration:M()}],\"underline-offset\":[{\"underline-offset\":[Ce,\"auto\",ce,ae]}],\"text-transform\":[\"uppercase\",\"lowercase\",\"capitalize\",\"normal-case\"],\"text-overflow\":[\"truncate\",\"text-ellipsis\",\"text-clip\"],\"text-wrap\":[{text:[\"wrap\",\"nowrap\",\"balance\",\"pretty\"]}],indent:[{indent:$()}],\"tab-size\":[{tab:[tn,ce,ae]}],\"vertical-align\":[{align:[\"baseline\",\"top\",\"middle\",\"bottom\",\"text-top\",\"text-bottom\",\"sub\",\"super\",ce,ae]}],whitespace:[{whitespace:[\"normal\",\"nowrap\",\"pre\",\"pre-line\",\"pre-wrap\",\"break-spaces\"]}],break:[{break:[\"normal\",\"words\",\"all\",\"keep\"]}],wrap:[{wrap:[\"break-word\",\"anywhere\",\"normal\"]}],hyphens:[{hyphens:[\"none\",\"manual\",\"auto\"]}],content:[{content:[\"none\",ce,ae]}],\"bg-attachment\":[{bg:[\"fixed\",\"local\",\"scroll\"]}],\"bg-clip\":[{\"bg-clip\":[\"border\",\"padding\",\"content\",\"text\"]}],\"bg-origin\":[{\"bg-origin\":[\"border\",\"padding\",\"content\"]}],\"bg-position\":[{bg:N()}],\"bg-repeat\":[{bg:D()}],\"bg-size\":[{bg:oe()}],\"bg-image\":[{bg:[\"none\",{linear:[{to:[\"t\",\"tr\",\"r\",\"br\",\"b\",\"bl\",\"l\",\"tl\"]},tn,ce,ae],radial:[\"\",ce,ae],conic:[tn,ce,ae]},Iw,_w]}],\"bg-color\":[{bg:M()}],\"gradient-from-pos\":[{from:pe()}],\"gradient-via-pos\":[{via:pe()}],\"gradient-to-pos\":[{to:pe()}],\"gradient-from\":[{from:M()}],\"gradient-via\":[{via:M()}],\"gradient-to\":[{to:M()}],rounded:[{rounded:se()}],\"rounded-s\":[{\"rounded-s\":se()}],\"rounded-e\":[{\"rounded-e\":se()}],\"rounded-t\":[{\"rounded-t\":se()}],\"rounded-r\":[{\"rounded-r\":se()}],\"rounded-b\":[{\"rounded-b\":se()}],\"rounded-l\":[{\"rounded-l\":se()}],\"rounded-ss\":[{\"rounded-ss\":se()}],\"rounded-se\":[{\"rounded-se\":se()}],\"rounded-ee\":[{\"rounded-ee\":se()}],\"rounded-es\":[{\"rounded-es\":se()}],\"rounded-tl\":[{\"rounded-tl\":se()}],\"rounded-tr\":[{\"rounded-tr\":se()}],\"rounded-br\":[{\"rounded-br\":se()}],\"rounded-bl\":[{\"rounded-bl\":se()}],\"border-w\":[{border:ge()}],\"border-w-x\":[{\"border-x\":ge()}],\"border-w-y\":[{\"border-y\":ge()}],\"border-w-s\":[{\"border-s\":ge()}],\"border-w-e\":[{\"border-e\":ge()}],\"border-w-bs\":[{\"border-bs\":ge()}],\"border-w-be\":[{\"border-be\":ge()}],\"border-w-t\":[{\"border-t\":ge()}],\"border-w-r\":[{\"border-r\":ge()}],\"border-w-b\":[{\"border-b\":ge()}],\"border-w-l\":[{\"border-l\":ge()}],\"divide-x\":[{\"divide-x\":ge()}],\"divide-x-reverse\":[\"divide-x-reverse\"],\"divide-y\":[{\"divide-y\":ge()}],\"divide-y-reverse\":[\"divide-y-reverse\"],\"border-style\":[{border:[...Se(),\"hidden\",\"none\"]}],\"divide-style\":[{divide:[...Se(),\"hidden\",\"none\"]}],\"border-color\":[{border:M()}],\"border-color-x\":[{\"border-x\":M()}],\"border-color-y\":[{\"border-y\":M()}],\"border-color-s\":[{\"border-s\":M()}],\"border-color-e\":[{\"border-e\":M()}],\"border-color-bs\":[{\"border-bs\":M()}],\"border-color-be\":[{\"border-be\":M()}],\"border-color-t\":[{\"border-t\":M()}],\"border-color-r\":[{\"border-r\":M()}],\"border-color-b\":[{\"border-b\":M()}],\"border-color-l\":[{\"border-l\":M()}],\"divide-color\":[{divide:M()}],\"outline-style\":[{outline:[...Se(),\"none\",\"hidden\"]}],\"outline-offset\":[{\"outline-offset\":[Ce,ce,ae]}],\"outline-w\":[{outline:[\"\",Ce,Jo,mr]}],\"outline-color\":[{outline:M()}],shadow:[{shadow:[\"\",\"none\",w,Pi,Ei]}],\"shadow-color\":[{shadow:M()}],\"inset-shadow\":[{\"inset-shadow\":[\"none\",v,Pi,Ei]}],\"inset-shadow-color\":[{\"inset-shadow\":M()}],\"ring-w\":[{ring:ge()}],\"ring-w-inset\":[\"ring-inset\"],\"ring-color\":[{ring:M()}],\"ring-offset-w\":[{\"ring-offset\":[Ce,mr]}],\"ring-offset-color\":[{\"ring-offset\":M()}],\"inset-ring-w\":[{\"inset-ring\":ge()}],\"inset-ring-color\":[{\"inset-ring\":M()}],\"text-shadow\":[{\"text-shadow\":[\"none\",S,Pi,Ei]}],\"text-shadow-color\":[{\"text-shadow\":M()}],opacity:[{opacity:[Ce,ce,ae]}],\"mix-blend\":[{\"mix-blend\":[...re(),\"plus-darker\",\"plus-lighter\"]}],\"bg-blend\":[{\"bg-blend\":re()}],\"mask-clip\":[{\"mask-clip\":[\"border\",\"padding\",\"content\",\"fill\",\"stroke\",\"view\"]},\"mask-no-clip\"],\"mask-composite\":[{mask:[\"add\",\"subtract\",\"intersect\",\"exclude\"]}],\"mask-image-linear-pos\":[{\"mask-linear\":[Ce]}],\"mask-image-linear-from-pos\":[{\"mask-linear-from\":le()}],\"mask-image-linear-to-pos\":[{\"mask-linear-to\":le()}],\"mask-image-linear-from-color\":[{\"mask-linear-from\":M()}],\"mask-image-linear-to-color\":[{\"mask-linear-to\":M()}],\"mask-image-t-from-pos\":[{\"mask-t-from\":le()}],\"mask-image-t-to-pos\":[{\"mask-t-to\":le()}],\"mask-image-t-from-color\":[{\"mask-t-from\":M()}],\"mask-image-t-to-color\":[{\"mask-t-to\":M()}],\"mask-image-r-from-pos\":[{\"mask-r-from\":le()}],\"mask-image-r-to-pos\":[{\"mask-r-to\":le()}],\"mask-image-r-from-color\":[{\"mask-r-from\":M()}],\"mask-image-r-to-color\":[{\"mask-r-to\":M()}],\"mask-image-b-from-pos\":[{\"mask-b-from\":le()}],\"mask-image-b-to-pos\":[{\"mask-b-to\":le()}],\"mask-image-b-from-color\":[{\"mask-b-from\":M()}],\"mask-image-b-to-color\":[{\"mask-b-to\":M()}],\"mask-image-l-from-pos\":[{\"mask-l-from\":le()}],\"mask-image-l-to-pos\":[{\"mask-l-to\":le()}],\"mask-image-l-from-color\":[{\"mask-l-from\":M()}],\"mask-image-l-to-color\":[{\"mask-l-to\":M()}],\"mask-image-x-from-pos\":[{\"mask-x-from\":le()}],\"mask-image-x-to-pos\":[{\"mask-x-to\":le()}],\"mask-image-x-from-color\":[{\"mask-x-from\":M()}],\"mask-image-x-to-color\":[{\"mask-x-to\":M()}],\"mask-image-y-from-pos\":[{\"mask-y-from\":le()}],\"mask-image-y-to-pos\":[{\"mask-y-to\":le()}],\"mask-image-y-from-color\":[{\"mask-y-from\":M()}],\"mask-image-y-to-color\":[{\"mask-y-to\":M()}],\"mask-image-radial\":[{\"mask-radial\":[ce,ae]}],\"mask-image-radial-from-pos\":[{\"mask-radial-from\":le()}],\"mask-image-radial-to-pos\":[{\"mask-radial-to\":le()}],\"mask-image-radial-from-color\":[{\"mask-radial-from\":M()}],\"mask-image-radial-to-color\":[{\"mask-radial-to\":M()}],\"mask-image-radial-shape\":[{\"mask-radial\":[\"circle\",\"ellipse\"]}],\"mask-image-radial-size\":[{\"mask-radial\":[{closest:[\"side\",\"corner\"],farthest:[\"side\",\"corner\"]}]}],\"mask-image-radial-pos\":[{\"mask-radial-at\":O()}],\"mask-image-conic-pos\":[{\"mask-conic\":[Ce]}],\"mask-image-conic-from-pos\":[{\"mask-conic-from\":le()}],\"mask-image-conic-to-pos\":[{\"mask-conic-to\":le()}],\"mask-image-conic-from-color\":[{\"mask-conic-from\":M()}],\"mask-image-conic-to-color\":[{\"mask-conic-to\":M()}],\"mask-mode\":[{mask:[\"alpha\",\"luminance\",\"match\"]}],\"mask-origin\":[{\"mask-origin\":[\"border\",\"padding\",\"content\",\"fill\",\"stroke\",\"view\"]}],\"mask-position\":[{mask:N()}],\"mask-repeat\":[{mask:D()}],\"mask-size\":[{mask:oe()}],\"mask-type\":[{\"mask-type\":[\"alpha\",\"luminance\"]}],\"mask-image\":[{mask:[\"none\",ce,ae]}],filter:[{filter:[\"\",\"none\",ce,ae]}],blur:[{blur:Pe()}],brightness:[{brightness:[Ce,ce,ae]}],contrast:[{contrast:[Ce,ce,ae]}],\"drop-shadow\":[{\"drop-shadow\":[\"\",\"none\",C,Pi,Ei]}],\"drop-shadow-color\":[{\"drop-shadow\":M()}],grayscale:[{grayscale:[\"\",Ce,ce,ae]}],\"hue-rotate\":[{\"hue-rotate\":[Ce,ce,ae]}],invert:[{invert:[\"\",Ce,ce,ae]}],saturate:[{saturate:[Ce,ce,ae]}],sepia:[{sepia:[\"\",Ce,ce,ae]}],\"backdrop-filter\":[{\"backdrop-filter\":[\"\",\"none\",ce,ae]}],\"backdrop-blur\":[{\"backdrop-blur\":Pe()}],\"backdrop-brightness\":[{\"backdrop-brightness\":[Ce,ce,ae]}],\"backdrop-contrast\":[{\"backdrop-contrast\":[Ce,ce,ae]}],\"backdrop-grayscale\":[{\"backdrop-grayscale\":[\"\",Ce,ce,ae]}],\"backdrop-hue-rotate\":[{\"backdrop-hue-rotate\":[Ce,ce,ae]}],\"backdrop-invert\":[{\"backdrop-invert\":[\"\",Ce,ce,ae]}],\"backdrop-opacity\":[{\"backdrop-opacity\":[Ce,ce,ae]}],\"backdrop-saturate\":[{\"backdrop-saturate\":[Ce,ce,ae]}],\"backdrop-sepia\":[{\"backdrop-sepia\":[\"\",Ce,ce,ae]}],\"border-collapse\":[{border:[\"collapse\",\"separate\"]}],\"border-spacing\":[{\"border-spacing\":$()}],\"border-spacing-x\":[{\"border-spacing-x\":$()}],\"border-spacing-y\":[{\"border-spacing-y\":$()}],\"table-layout\":[{table:[\"auto\",\"fixed\"]}],caption:[{caption:[\"top\",\"bottom\"]}],transition:[{transition:[\"\",\"all\",\"colors\",\"opacity\",\"shadow\",\"transform\",\"none\",ce,ae]}],\"transition-behavior\":[{transition:[\"normal\",\"discrete\"]}],duration:[{duration:[Ce,\"initial\",ce,ae]}],ease:[{ease:[\"linear\",\"initial\",_,ce,ae]}],delay:[{delay:[Ce,ce,ae]}],animate:[{animate:[\"none\",L,ce,ae]}],backface:[{backface:[\"hidden\",\"visible\"]}],perspective:[{perspective:[E,ce,ae]}],\"perspective-origin\":[{\"perspective-origin\":B()}],rotate:[{rotate:be()}],\"rotate-x\":[{\"rotate-x\":be()}],\"rotate-y\":[{\"rotate-y\":be()}],\"rotate-z\":[{\"rotate-z\":be()}],scale:[{scale:Re()}],\"scale-x\":[{\"scale-x\":Re()}],\"scale-y\":[{\"scale-y\":Re()}],\"scale-z\":[{\"scale-z\":Re()}],\"scale-3d\":[\"scale-3d\"],skew:[{skew:_e()}],\"skew-x\":[{\"skew-x\":_e()}],\"skew-y\":[{\"skew-y\":_e()}],transform:[{transform:[ce,ae,\"\",\"none\",\"gpu\",\"cpu\"]}],\"transform-origin\":[{origin:B()}],\"transform-style\":[{transform:[\"3d\",\"flat\"]}],translate:[{translate:Je()}],\"translate-x\":[{\"translate-x\":Je()}],\"translate-y\":[{\"translate-y\":Je()}],\"translate-z\":[{\"translate-z\":Je()}],\"translate-none\":[\"translate-none\"],zoom:[{zoom:[tn,ce,ae]}],accent:[{accent:M()}],appearance:[{appearance:[\"none\",\"auto\"]}],\"caret-color\":[{caret:M()}],\"color-scheme\":[{scheme:[\"normal\",\"dark\",\"light\",\"light-dark\",\"only-dark\",\"only-light\"]}],cursor:[{cursor:[\"auto\",\"default\",\"pointer\",\"wait\",\"text\",\"move\",\"help\",\"not-allowed\",\"none\",\"context-menu\",\"progress\",\"cell\",\"crosshair\",\"vertical-text\",\"alias\",\"copy\",\"no-drop\",\"grab\",\"grabbing\",\"all-scroll\",\"col-resize\",\"row-resize\",\"n-resize\",\"e-resize\",\"s-resize\",\"w-resize\",\"ne-resize\",\"nw-resize\",\"se-resize\",\"sw-resize\",\"ew-resize\",\"ns-resize\",\"nesw-resize\",\"nwse-resize\",\"zoom-in\",\"zoom-out\",ce,ae]}],\"field-sizing\":[{\"field-sizing\":[\"fixed\",\"content\"]}],\"pointer-events\":[{\"pointer-events\":[\"auto\",\"none\"]}],resize:[{resize:[\"none\",\"\",\"y\",\"x\"]}],\"scroll-behavior\":[{scroll:[\"auto\",\"smooth\"]}],\"scrollbar-thumb-color\":[{\"scrollbar-thumb\":M()}],\"scrollbar-track-color\":[{\"scrollbar-track\":M()}],\"scrollbar-gutter\":[{\"scrollbar-gutter\":[\"auto\",\"stable\",\"both\"]}],\"scrollbar-w\":[{scrollbar:[\"auto\",\"thin\",\"none\"]}],\"scroll-m\":[{\"scroll-m\":$()}],\"scroll-mx\":[{\"scroll-mx\":$()}],\"scroll-my\":[{\"scroll-my\":$()}],\"scroll-ms\":[{\"scroll-ms\":$()}],\"scroll-me\":[{\"scroll-me\":$()}],\"scroll-mbs\":[{\"scroll-mbs\":$()}],\"scroll-mbe\":[{\"scroll-mbe\":$()}],\"scroll-mt\":[{\"scroll-mt\":$()}],\"scroll-mr\":[{\"scroll-mr\":$()}],\"scroll-mb\":[{\"scroll-mb\":$()}],\"scroll-ml\":[{\"scroll-ml\":$()}],\"scroll-p\":[{\"scroll-p\":$()}],\"scroll-px\":[{\"scroll-px\":$()}],\"scroll-py\":[{\"scroll-py\":$()}],\"scroll-ps\":[{\"scroll-ps\":$()}],\"scroll-pe\":[{\"scroll-pe\":$()}],\"scroll-pbs\":[{\"scroll-pbs\":$()}],\"scroll-pbe\":[{\"scroll-pbe\":$()}],\"scroll-pt\":[{\"scroll-pt\":$()}],\"scroll-pr\":[{\"scroll-pr\":$()}],\"scroll-pb\":[{\"scroll-pb\":$()}],\"scroll-pl\":[{\"scroll-pl\":$()}],\"snap-align\":[{snap:[\"start\",\"end\",\"center\",\"align-none\"]}],\"snap-stop\":[{snap:[\"normal\",\"always\"]}],\"snap-type\":[{snap:[\"none\",\"x\",\"y\",\"both\"]}],\"snap-strictness\":[{snap:[\"mandatory\",\"proximity\"]}],touch:[{touch:[\"auto\",\"none\",\"manipulation\"]}],\"touch-x\":[{\"touch-pan\":[\"x\",\"left\",\"right\"]}],\"touch-y\":[{\"touch-pan\":[\"y\",\"up\",\"down\"]}],\"touch-pz\":[\"touch-pinch-zoom\"],select:[{select:[\"none\",\"text\",\"all\",\"auto\"]}],\"will-change\":[{\"will-change\":[\"auto\",\"scroll\",\"contents\",\"transform\",ce,ae]}],fill:[{fill:[\"none\",...M()]}],\"stroke-w\":[{stroke:[Ce,Jo,mr,Zp]}],stroke:[{stroke:[\"none\",...M()]}],\"forced-color-adjust\":[{\"forced-color-adjust\":[\"auto\",\"none\"]}]},conflictingClassGroups:{\"container-named\":[\"container-type\"],overflow:[\"overflow-x\",\"overflow-y\"],overscroll:[\"overscroll-x\",\"overscroll-y\"],inset:[\"inset-x\",\"inset-y\",\"inset-bs\",\"inset-be\",\"start\",\"end\",\"top\",\"right\",\"bottom\",\"left\"],\"inset-x\":[\"right\",\"left\"],\"inset-y\":[\"top\",\"bottom\"],flex:[\"basis\",\"grow\",\"shrink\"],gap:[\"gap-x\",\"gap-y\"],p:[\"px\",\"py\",\"ps\",\"pe\",\"pbs\",\"pbe\",\"pt\",\"pr\",\"pb\",\"pl\"],px:[\"pr\",\"pl\"],py:[\"pt\",\"pb\"],m:[\"mx\",\"my\",\"ms\",\"me\",\"mbs\",\"mbe\",\"mt\",\"mr\",\"mb\",\"ml\"],mx:[\"mr\",\"ml\"],my:[\"mt\",\"mb\"],size:[\"w\",\"h\"],\"font-size\":[\"leading\"],\"fvn-normal\":[\"fvn-ordinal\",\"fvn-slashed-zero\",\"fvn-figure\",\"fvn-spacing\",\"fvn-fraction\"],\"fvn-ordinal\":[\"fvn-normal\"],\"fvn-slashed-zero\":[\"fvn-normal\"],\"fvn-figure\":[\"fvn-normal\"],\"fvn-spacing\":[\"fvn-normal\"],\"fvn-fraction\":[\"fvn-normal\"],\"line-clamp\":[\"display\",\"overflow\"],rounded:[\"rounded-s\",\"rounded-e\",\"rounded-t\",\"rounded-r\",\"rounded-b\",\"rounded-l\",\"rounded-ss\",\"rounded-se\",\"rounded-ee\",\"rounded-es\",\"rounded-tl\",\"rounded-tr\",\"rounded-br\",\"rounded-bl\"],\"rounded-s\":[\"rounded-ss\",\"rounded-es\"],\"rounded-e\":[\"rounded-se\",\"rounded-ee\"],\"rounded-t\":[\"rounded-tl\",\"rounded-tr\"],\"rounded-r\":[\"rounded-tr\",\"rounded-br\"],\"rounded-b\":[\"rounded-br\",\"rounded-bl\"],\"rounded-l\":[\"rounded-tl\",\"rounded-bl\"],\"border-spacing\":[\"border-spacing-x\",\"border-spacing-y\"],\"border-w\":[\"border-w-x\",\"border-w-y\",\"border-w-s\",\"border-w-e\",\"border-w-bs\",\"border-w-be\",\"border-w-t\",\"border-w-r\",\"border-w-b\",\"border-w-l\"],\"border-w-x\":[\"border-w-r\",\"border-w-l\"],\"border-w-y\":[\"border-w-t\",\"border-w-b\"],\"border-color\":[\"border-color-x\",\"border-color-y\",\"border-color-s\",\"border-color-e\",\"border-color-bs\",\"border-color-be\",\"border-color-t\",\"border-color-r\",\"border-color-b\",\"border-color-l\"],\"border-color-x\":[\"border-color-r\",\"border-color-l\"],\"border-color-y\":[\"border-color-t\",\"border-color-b\"],translate:[\"translate-x\",\"translate-y\",\"translate-none\"],\"translate-none\":[\"translate\",\"translate-x\",\"translate-y\",\"translate-z\"],\"scroll-m\":[\"scroll-mx\",\"scroll-my\",\"scroll-ms\",\"scroll-me\",\"scroll-mbs\",\"scroll-mbe\",\"scroll-mt\",\"scroll-mr\",\"scroll-mb\",\"scroll-ml\"],\"scroll-mx\":[\"scroll-mr\",\"scroll-ml\"],\"scroll-my\":[\"scroll-mt\",\"scroll-mb\"],\"scroll-p\":[\"scroll-px\",\"scroll-py\",\"scroll-ps\",\"scroll-pe\",\"scroll-pbs\",\"scroll-pbe\",\"scroll-pt\",\"scroll-pr\",\"scroll-pb\",\"scroll-pl\"],\"scroll-px\":[\"scroll-pr\",\"scroll-pl\"],\"scroll-py\":[\"scroll-pt\",\"scroll-pb\"],touch:[\"touch-x\",\"touch-y\",\"touch-pz\"],\"touch-x\":[\"touch\"],\"touch-y\":[\"touch\"],\"touch-pz\":[\"touch\"]},conflictingClassGroupModifiers:{\"font-size\":[\"leading\"]},postfixLookupClassGroups:[\"container-type\"],orderSensitiveModifiers:[\"*\",\"**\",\"after\",\"backdrop\",\"before\",\"details-content\",\"file\",\"first-letter\",\"first-line\",\"marker\",\"placeholder\",\"selection\"]}},zw=mw(Mw);function Ve(...n){return zw(qh(n))}const Fw=G0(\"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50\",{variants:{variant:{default:\"bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700\",destructive:\"bg-red-500 text-white hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700\",outline:\"border border-border-default bg-background text-muted-foreground hover:bg-gray-100 hover:text-gray-900 hover:border-border-hover dark:hover:bg-gray-800 dark:hover:text-gray-100\",secondary:\"text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200\",ghost:\"text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800\",mcp:\"bg-emerald-500 text-white hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-700\",link:\"text-blue-500 underline-offset-4 hover:underline dark:text-blue-400\"},size:{default:\"h-9 px-4 py-2\",sm:\"h-8 rounded-md px-3 text-xs\",lg:\"h-10 rounded-md px-8\",icon:\"h-9 w-9 p-1.5\"}},defaultVariants:{variant:\"default\",size:\"default\"}}),$e=x.forwardRef(({className:n,variant:r,size:s,asChild:i=!1,...a},u)=>{const d=i?B0:\"button\";return g.jsx(d,{className:Ve(Fw({variant:r,size:s,className:n})),ref:u,...a})});$e.displayName=\"Button\";const Gn=x.forwardRef(({className:n,type:r,...s},i)=>g.jsx(\"input\",{type:r,className:Ve(\"flex h-9 w-full rounded-md border border-border-default bg-background text-foreground px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:focus:ring-blue-400/20 disabled:cursor-not-allowed disabled:opacity-50\",n),autoComplete:\"off\",autoCorrect:\"off\",autoCapitalize:\"off\",spellCheck:!1,ref:i,...s}));Gn.displayName=\"Input\";var cs=_h(),$w=Object.defineProperty,Vw=(n,r)=>$w(n,\"name\",{value:r,configurable:!0}),Bw=[\"a\",\"button\",\"div\",\"form\",\"h2\",\"h3\",\"img\",\"input\",\"label\",\"li\",\"nav\",\"ol\",\"p\",\"select\",\"span\",\"svg\",\"ul\"],Ue=Bw.reduce((n,r)=>{const s=Cn(`Primitive.${r}`),i=x.forwardRef((a,u)=>{const{asChild:d,...f}=a,h=d?s:r;return typeof window<\"u\"&&(window[Symbol.for(\"radix-ui\")]=!0),g.jsx(h,{...f,ref:u})});return i.displayName=`Primitive.${r}`,{...n,[r]:i}},{});function pm(n,r){n&&cs.flushSync(()=>n.dispatchEvent(r))}Vw(pm,\"dispatchDiscreteCustomEvent\");var Uw=Object.defineProperty,Hw=(n,r)=>Uw(n,\"name\",{value:r,configurable:!0}),Ww=x.forwardRef(Hw(function(r,s){return g.jsx(Ue.label,{...r,ref:s,onMouseDown:i=>{i.target.closest(\"button, input, select, textarea\")||(r.onMouseDown?.(i),!i.defaultPrevented&&i.detail>1&&i.preventDefault())}})},\"Label\")),hm=Ww;const Ot=x.forwardRef(({className:n,...r},s)=>g.jsx(hm,{ref:s,className:Ve(\"text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70\",n),...r}));Ot.displayName=hm.displayName;var Kw=Object.defineProperty,ao=(n,r)=>Kw(n,\"name\",{value:r,configurable:!0}),mm=!!(typeof window<\"u\"&&window.document&&window.document.createElement);function je(n,r,{checkForDefaultPrevented:s=!0}={}){return ao(function(a){if(n?.(a),s===!1||!a||!a.defaultPrevented)return r?.(a)},\"handleEvent\")}ao(je,\"composeEventHandlers\");function Gw(n){if(!mm)throw new Error(\"Cannot access window outside of the DOM\");return n?.ownerDocument?.defaultView??window}ao(Gw,\"getOwnerWindow\");function Iu(n){if(!mm)throw new Error(\"Cannot access document outside of the DOM\");return n?.ownerDocument??document}ao(Iu,\"getOwnerDocument\");function gm(n,r=!1){const{activeElement:s}=Iu(n);if(!s?.nodeName)return null;if(vm(s)&&s.contentDocument)return gm(s.contentDocument.body,r);if(r){const i=s.getAttribute(\"aria-activedescendant\");if(i){const a=Iu(s).getElementById(i);if(a)return a}}return s}ao(gm,\"getActiveElement\");function vm(n){return n.tagName===\"IFRAME\"}ao(vm,\"isFrame\");var Qw=Object.defineProperty,zt=(n,r)=>Qw(n,\"name\",{value:r,configurable:!0});function Yw(n,r){const s=x.createContext(r);s.displayName=n+\"Context\";const i=zt(u=>{const{children:d,...f}=u,h=x.useMemo(()=>f,Object.values(f));return g.jsx(s.Provider,{value:h,children:d})},\"Provider\");i.displayName=n+\"Provider\";function a(u,d={}){const{optional:f=!1}=d,h=x.useContext(s);if(h)return h;if(r!==void 0)return r;if(!f)throw new Error(`\\`${u}\\` must be used within \\`${n}\\``)}return zt(a,\"useContext\"),[i,a]}zt(Yw,\"createContext\");function kr(n,r=[]){let s=[];function i(u,d){const f=x.createContext(d);f.displayName=u+\"Context\";const h=s.length;s=[...s,d];const m=zt(v=>{const{scope:S,children:C,...k}=v,E=S?.[n]?.[h]||f,b=x.useMemo(()=>k,Object.values(k));return g.jsx(E.Provider,{value:b,children:C})},\"Provider\");m.displayName=u+\"Provider\";function w(v,S,C={}){const{optional:k=!1}=C,E=S?.[n]?.[h]||f,b=x.useContext(E);if(b)return b;if(d!==void 0)return d;if(!k)throw new Error(`\\`${v}\\` must be used within \\`${u}\\``)}return zt(w,\"useContext\"),[m,w]}zt(i,\"createContext\");const a=zt(()=>{const u=s.map(d=>x.createContext(d));return zt(function(f){const h=f?.[n]||u;return x.useMemo(()=>({[`__scope${n}`]:{...f,[n]:h}}),[f,h])},\"useScope\")},\"createScope\");return a.scopeName=n,[i,ym(a,...r)]}zt(kr,\"createContextScope\");function ym(...n){const r=n[0];if(n.length===1)return r;const s=zt(()=>{const i=n.map(a=>({useScope:a(),scopeName:a.scopeName}));return zt(function(u){const d=i.reduce((f,{useScope:h,scopeName:m})=>{const v=h(u)[`__scope${m}`];return{...f,...v}},{});return x.useMemo(()=>({[`__scope${r.scopeName}`]:d}),[d])},\"useComposedScopes\")},\"createScope\");return s.scopeName=r.scopeName,s}zt(ym,\"composeContextScopes\");var Ge=globalThis?.document?x.useLayoutEffect:()=>{},Xw=Object.defineProperty,Zw=(n,r)=>Xw(n,\"name\",{value:r,configurable:!0}),qw=us[\" useId \".trim().toString()]||(()=>{}),Jw=0;function vr(n){const[r,s]=x.useState(qw());return Ge(()=>{n||s(i=>i??String(Jw++))},[n]),n||(r?`radix-${r}`:\"\")}Zw(vr,\"useId\");var e1=Object.defineProperty,t1=(n,r)=>e1(n,\"name\",{value:r,configurable:!0}),eh=us[\" useEffectEvent \".trim().toString()],th=us[\" useInsertionEffect \".trim().toString()];function xm(n){if(typeof eh==\"function\")return eh(n);const r=x.useRef(()=>{throw new Error(\"Cannot call an event handler while rendering.\")});return typeof th==\"function\"?th(()=>{r.current=n}):Ge(()=>{r.current=n}),x.useMemo(()=>((...s)=>r.current?.(...s)),[])}t1(xm,\"useEffectEvent\");var n1=Object.defineProperty,ds=(n,r)=>n1(n,\"name\",{value:r,configurable:!0}),r1=us[\" useInsertionEffect \".trim().toString()]||Ge;function os({prop:n,defaultProp:r,onChange:s=ds(()=>{},\"onChange\"),caller:i}){const[a,u,d]=wm({defaultProp:r,onChange:s}),f=n!==void 0,h=f?n:a,m=x.useCallback(w=>{if(f){const v=Sm(w)?w(n):w;v!==n&&d.current?.(v)}else u(w)},[f,n,u,d]);return[h,m]}ds(os,\"useControllableState\");function wm({defaultProp:n,onChange:r}){const[s,i]=x.useState(n),a=x.useRef(s),u=x.useRef(r);return r1(()=>{u.current=r},[r]),x.useEffect(()=>{a.current!==s&&(u.current?.(s),a.current=s)},[s,a]),[s,i,u]}ds(wm,\"useUncontrolledState\");function Sm(n){return typeof n==\"function\"}ds(Sm,\"isFunction\");var nh=Symbol(\"RADIX:SYNC_STATE\");function o1(n,r,s,i){const{prop:a,defaultProp:u,onChange:d,caller:f}=r,h=a!==void 0,m=xm(d),w=[{...s,state:u}];i&&w.push(i);const[v,S]=x.useReducer((b,_)=>{if(_.type===nh)return{...b,state:_.state};const L=n(b,_);return h&&!Object.is(L.state,b.state)&&m(L.state),L},...w),C=v.state,k=x.useRef(C);x.useEffect(()=>{k.current!==C&&(k.current=C,h||m(C))},[C,k,h]);const E=x.useMemo(()=>a!==void 0?{...v,state:a}:v,[v,a]);return x.useEffect(()=>{h&&!Object.is(a,v.state)&&S({type:nh,state:a})},[a,v.state,h]),[E,S]}ds(o1,\"useControllableStateReducer\");var s1=Object.defineProperty,i1=(n,r)=>s1(n,\"name\",{value:r,configurable:!0});function sn(n){const r=x.useRef(n);return x.useEffect(()=>{r.current=n}),x.useMemo(()=>((...s)=>r.current?.(...s)),[])}i1(sn,\"useCallbackRef\");var l1=Object.defineProperty,rt=(n,r)=>l1(n,\"name\",{value:r,configurable:!0}),Au=\"dismissableLayer.update\",a1=\"dismissableLayer.pointerDownOutside\",u1=\"dismissableLayer.focusOutside\",rh,Cm=x.createContext({layers:new Set,layersWithOutsidePointerEventsDisabled:new Set,branches:new Set,dismissableSurfaces:new Set}),tc=x.forwardRef(rt(function(r,s){const{disableOutsidePointerEvents:i=!1,deferPointerDownOutside:a=!1,onEscapeKeyDown:u,onPointerDownOutside:d,onFocusOutside:f,onInteractOutside:h,onDismiss:m,...w}=r,v=x.useContext(Cm),[S,C]=x.useState(null),k=S?.ownerDocument??globalThis?.document,[,E]=x.useState({}),b=De(s,C),_=Array.from(v.layers),[L]=[...v.layersWithOutsidePointerEventsDisabled].slice(-1),T=L?_.indexOf(L):-1,O=S?_.indexOf(S):-1,B=v.layersWithOutsidePointerEventsDisabled.size>0,V=O>=T,H=x.useRef(!1),$=bm(q=>{d?.(q),h?.(q),q.defaultPrevented||m?.()},{ownerDocument:k,deferPointerDownOutside:a,isDeferredPointerDownOutsideRef:H,dismissableSurfaces:v.dismissableSurfaces,shouldHandlePointerDownOutside:x.useCallback(q=>{if(!(q instanceof Node))return!1;const Z=[...v.branches].some(ne=>ne.contains(q));return V&&!Z},[v.branches,V])}),W=Em(q=>{if(a&&H.current)return;const Z=q.target;[...v.branches].some(fe=>fe.contains(Z))||(f?.(q),h?.(q),q.defaultPrevented||m?.())},k),X=S?O===_.length-1:!1,Q=sn(q=>{q.key===\"Escape\"&&(u?.(q),!q.defaultPrevented&&m&&(q.preventDefault(),m()))});return x.useEffect(()=>{if(X)return k.addEventListener(\"keydown\",Q,{capture:!0}),()=>k.removeEventListener(\"keydown\",Q,{capture:!0})},[k,X,Q]),x.useEffect(()=>{if(S)return i&&(v.layersWithOutsidePointerEventsDisabled.size===0&&(rh=k.body.style.pointerEvents,k.body.style.pointerEvents=\"none\"),v.layersWithOutsidePointerEventsDisabled.add(S)),v.layers.add(S),Du(),()=>{i&&(v.layersWithOutsidePointerEventsDisabled.delete(S),v.layersWithOutsidePointerEventsDisabled.size===0&&(k.body.style.pointerEvents=rh))}},[S,k,i,v]),x.useEffect(()=>()=>{S&&(v.layers.delete(S),v.layersWithOutsidePointerEventsDisabled.delete(S),Du())},[S,v]),x.useEffect(()=>{const q=rt(()=>E({}),\"handleUpdate\");return document.addEventListener(Au,q),()=>document.removeEventListener(Au,q)},[]),g.jsx(Ue.div,{...w,ref:b,style:{pointerEvents:B?V?\"auto\":\"none\":void 0,...r.style},onFocusCapture:je(r.onFocusCapture,W.onFocusCapture),onBlurCapture:je(r.onBlurCapture,W.onBlurCapture),onPointerDownCapture:je(r.onPointerDownCapture,$.onPointerDownCapture)})},\"DismissableLayer\"));function km(){const n=x.useContext(Cm),[r,s]=x.useState(null);return x.useEffect(()=>{if(r)return n.dismissableSurfaces.add(r),()=>{n.dismissableSurfaces.delete(r)}},[r,n.dismissableSurfaces]),s}rt(km,\"useDismissableLayerSurface\");var c1=rt(()=>!0,\"IS_TRUE\");function bm(n,r){const{ownerDocument:s=globalThis?.document,deferPointerDownOutside:i=!1,isDeferredPointerDownOutsideRef:a,dismissableSurfaces:u,shouldHandlePointerDownOutside:d=c1}=r,f=sn(n),h=x.useRef(!1),m=x.useRef(!1),w=x.useRef(new Map),v=x.useRef(()=>{});return x.useEffect(()=>{function S(){m.current=!1,a.current=!1,w.current.clear()}rt(S,\"resetOutsideInteraction\");function C(){return Array.from(w.current.values()).some(Boolean)}rt(C,\"isOutsideInteractionIntercepted\");function k(T){if(!m.current)return;const O=T.target;O instanceof Node&&[...u].some(V=>V.contains(O))||w.current.set(T.type,!0),T.type===\"click\"&&window.setTimeout(()=>{m.current&&v.current()},0)}rt(k,\"handleInteractionCapture\");function E(T){m.current&&w.current.set(T.type,!1)}rt(E,\"handleInteractionBubble\");const b=rt(T=>{if(T.target&&!h.current){let O=function(){s.removeEventListener(\"click\",v.current);const V=C();S(),V||nc(a1,f,B,{discrete:!0})};if(rt(O,\"handleAndDispatchPointerDownOutsideEvent\"),!d(T.target)){s.removeEventListener(\"click\",v.current),S(),h.current=!1;return}const B={originalEvent:T};m.current=!0,a.current=i&&T.button===0,w.current.clear(),!i||T.button!==0?O():(s.removeEventListener(\"click\",v.current),v.current=O,s.addEventListener(\"click\",v.current,{once:!0}))}else s.removeEventListener(\"click\",v.current),S();h.current=!1},\"handlePointerDown\"),_=[\"pointerup\",\"mousedown\",\"mouseup\",\"touchstart\",\"touchend\",\"click\"];for(const T of _)s.addEventListener(T,k,!0),s.addEventListener(T,E);const L=window.setTimeout(()=>{s.addEventListener(\"pointerdown\",b)},0);return()=>{window.clearTimeout(L),s.removeEventListener(\"pointerdown\",b),s.removeEventListener(\"click\",v.current);for(const T of _)s.removeEventListener(T,k,!0),s.removeEventListener(T,E)}},[s,f,i,a,u,d]),{onPointerDownCapture:rt(()=>h.current=!0,\"onPointerDownCapture\")}}rt(bm,\"usePointerDownOutside\");function Em(n,r=globalThis?.document){const s=sn(n),i=x.useRef(!1);return x.useEffect(()=>{const a=rt(u=>{u.target&&!i.current&&nc(u1,s,{originalEvent:u},{discrete:!1})},\"handleFocus\");return r.addEventListener(\"focusin\",a),()=>r.removeEventListener(\"focusin\",a)},[r,s]),{onFocusCapture:rt(()=>i.current=!0,\"onFocusCapture\"),onBlurCapture:rt(()=>i.current=!1,\"onBlurCapture\")}}rt(Em,\"useFocusOutside\");function Du(){const n=new CustomEvent(Au);document.dispatchEvent(n)}rt(Du,\"dispatchUpdate\");function nc(n,r,s,{discrete:i}){const a=s.originalEvent.target,u=new CustomEvent(n,{bubbles:!1,cancelable:!0,detail:s});r&&a.addEventListener(n,r,{once:!0}),i?pm(a,u):a.dispatchEvent(u)}rt(nc,\"handleAndDispatchCustomEvent\");var d1=Object.defineProperty,gt=(n,r)=>d1(n,\"name\",{value:r,configurable:!0}),mu=\"focusScope.autoFocusOnMount\",gu=\"focusScope.autoFocusOnUnmount\",oh={bubbles:!1,cancelable:!0},Pm=x.forwardRef(gt(function(r,s){const{loop:i=!1,trapped:a=!1,onMountAutoFocus:u,onUnmountAutoFocus:d,...f}=r,[h,m]=x.useState(null),w=sn(u),v=sn(d),S=x.useRef(null),C=De(s,m),k=x.useRef({paused:!1,pause(){this.paused=!0},resume(){this.paused=!1}}).current;x.useEffect(()=>{if(a){let b=function(O){if(k.paused||!h)return;const B=O.target;h.contains(B)?S.current=B:yn(S.current,{select:!0})},_=function(O){if(k.paused||!h)return;const B=O.relatedTarget;B!==null&&(h.contains(B)||yn(S.current,{select:!0}))},L=function(O){if(document.activeElement===document.body)for(const V of O)V.removedNodes.length>0&&yn(h)};gt(b,\"handleFocusIn\"),gt(_,\"handleFocusOut\"),gt(L,\"handleMutations\"),document.addEventListener(\"focusin\",b),document.addEventListener(\"focusout\",_);const T=new MutationObserver(L);return h&&T.observe(h,{childList:!0,subtree:!0}),()=>{document.removeEventListener(\"focusin\",b),document.removeEventListener(\"focusout\",_),T.disconnect()}}},[a,h,k.paused]),x.useEffect(()=>{if(h){sh.add(k);const b=document.activeElement;if(!h.contains(b)){const L=new CustomEvent(mu,oh);h.addEventListener(mu,w),h.dispatchEvent(L),L.defaultPrevented||(Nm(Tm(rc(h)),{select:!0}),document.activeElement===b&&yn(h))}return()=>{h.removeEventListener(mu,w),setTimeout(()=>{const L=new CustomEvent(gu,oh);h.addEventListener(gu,v),h.dispatchEvent(L),L.defaultPrevented||yn(b??document.body,{select:!0}),h.removeEventListener(gu,v),sh.remove(k)},0)}}},[h,w,v,k]);const E=x.useCallback(b=>{if(!i&&!a||k.paused)return;const _=b.key===\"Tab\"&&!b.altKey&&!b.ctrlKey&&!b.metaKey,L=document.activeElement;if(_&&L){const T=b.currentTarget,[O,B]=Rm(T);O&&B?!b.shiftKey&&L===B?(b.preventDefault(),i&&yn(O,{select:!0})):b.shiftKey&&L===O&&(b.preventDefault(),i&&yn(B,{select:!0})):L===T&&b.preventDefault()}},[i,a,k.paused]);return g.jsx(Ue.div,{tabIndex:-1,...f,ref:C,onKeyDown:E})},\"FocusScope\"));function Nm(n,{select:r=!1}={}){const s=document.activeElement;for(const i of n)if(yn(i,{select:r}),document.activeElement!==s)return}gt(Nm,\"focusFirst\");function Rm(n){const r=rc(n),s=Mu(r,n),i=Mu(r.reverse(),n);return[s,i]}gt(Rm,\"getTabbableEdges\");function rc(n){const r=[],s=document.createTreeWalker(n,NodeFilter.SHOW_ELEMENT,{acceptNode:gt(i=>{const a=i.tagName===\"INPUT\"&&i.type===\"hidden\";return i.disabled||i.hidden||a?NodeFilter.FILTER_SKIP:i.tabIndex>=0?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP},\"acceptNode\")});for(;s.nextNode();)r.push(s.currentNode);return r}gt(rc,\"getTabbableCandidates\");function Mu(n,r){const s=typeof r.checkVisibility==\"function\"&&r.checkVisibility({checkVisibilityCSS:!0});for(const i of n)if(!(s?!i.checkVisibility({checkVisibilityCSS:!0}):Om(i,{upTo:r})))return i}gt(Mu,\"findVisible\");function Om(n,{upTo:r}){if(getComputedStyle(n).visibility===\"hidden\")return!0;for(;n;){if(r!==void 0&&n===r)return!1;if(getComputedStyle(n).display===\"none\")return!0;n=n.parentElement}return!1}gt(Om,\"isHidden\");function jm(n){return n instanceof HTMLInputElement&&\"select\"in n}gt(jm,\"isSelectableInput\");function yn(n,{select:r=!1}={}){if(n&&n.focus){const s=document.activeElement;n.focus({preventScroll:!0}),n!==s&&jm(n)&&r&&n.select()}}gt(yn,\"focus\");var sh=_m();function _m(){let n=[];return{add(r){const s=n[0];r!==s&&s?.pause(),n=zu(n,r),n.unshift(r)},remove(r){n=zu(n,r),n[0]?.resume()}}}gt(_m,\"createFocusScopesStack\");function zu(n,r){const s=[...n],i=s.indexOf(r);return i!==-1&&s.splice(i,1),s}gt(zu,\"arrayRemove\");function Tm(n){return n.filter(r=>r.tagName!==\"A\")}gt(Tm,\"removeLinks\");var f1=Object.defineProperty,p1=(n,r)=>f1(n,\"name\",{value:r,configurable:!0}),Lm=x.forwardRef(p1(function(r,s){const{container:i,...a}=r,[u,d]=x.useState(!1);Ge(()=>d(!0),[]);const f=i||u&&globalThis?.document?.body;return f?cs.createPortal(g.jsx(Ue.div,{...a,ref:s}),f):null},\"Portal\")),h1=Object.defineProperty,kn=(n,r)=>h1(n,\"name\",{value:r,configurable:!0});function Im(n,r){return x.useReducer((s,i)=>r[s][i]??s,n)}kn(Im,\"useStateMachine\");var fs=kn(n=>{const{present:r,children:s}=n,i=Am(r),a=typeof s==\"function\"?s({present:i.isPresent}):x.Children.only(s),u=Dm(i.ref,Mm(a));return typeof s==\"function\"||i.isPresent?x.cloneElement(a,{ref:u}):null},\"Presence\");function Am(n){const[r,s]=x.useState(),i=x.useRef(null),a=x.useRef(n),u=x.useRef(\"none\"),d=x.useRef(void 0),f=n?\"mounted\":\"unmounted\",[h,m]=Im(f,{mounted:{UNMOUNT:\"unmounted\",ANIMATION_OUT:\"unmountSuspended\"},unmountSuspended:{MOUNT:\"mounted\",ANIMATION_END:\"unmounted\"},unmounted:{MOUNT:\"mounted\"}});return x.useEffect(()=>{h===\"mounted\"?(u.current=d.current??ro(i.current),d.current=void 0):u.current=\"none\"},[h]),Ge(()=>{const w=i.current,v=a.current;if(v!==n){const C=u.current,k=ro(w);n?(d.current=k,m(\"MOUNT\")):k===\"none\"||w?.display===\"none\"?m(\"UNMOUNT\"):m(v&&C!==k?\"ANIMATION_OUT\":\"UNMOUNT\"),a.current=n}},[n,m]),Ge(()=>{if(r){let w;const v=r.ownerDocument.defaultView??window,S=kn(k=>{const b=ro(i.current).includes(CSS.escape(k.animationName));if(k.target===r&&b&&(m(\"ANIMATION_END\"),!a.current)){const _=r.style.animationFillMode;r.style.animationFillMode=\"forwards\",w=v.setTimeout(()=>{r.style.animationFillMode===\"forwards\"&&(r.style.animationFillMode=_)})}},\"handleAnimationEnd\"),C=kn(k=>{k.target===r&&(u.current=ro(i.current))},\"handleAnimationStart\");return r.addEventListener(\"animationstart\",C),r.addEventListener(\"animationcancel\",S),r.addEventListener(\"animationend\",S),()=>{v.clearTimeout(w),r.removeEventListener(\"animationstart\",C),r.removeEventListener(\"animationcancel\",S),r.removeEventListener(\"animationend\",S)}}else m(\"ANIMATION_END\")},[r,m]),{isPresent:[\"mounted\",\"unmountSuspended\"].includes(h),ref:x.useCallback(w=>{if(w){const v=getComputedStyle(w);i.current=v,d.current=ro(v)}else i.current=null;s(w)},[])}}kn(Am,\"usePresence\");function Fu(n,r){if(typeof n==\"function\")return n(r);n!=null&&(n.current=r)}kn(Fu,\"setRef\");function Dm(...n){const r=x.useRef(n);return r.current=n,x.useCallback(s=>{const i=r.current;let a=!1;const u=i.map(d=>{const f=Fu(d,s);return!a&&typeof f==\"function\"&&(a=!0),f});if(a)return()=>{for(let d=0;d<u.length;d++){const f=u[d];typeof f==\"function\"?f():Fu(i[d],null)}}},[])}kn(Dm,\"useStableComposedRefs\");function ro(n){return n?.animationName||\"none\"}kn(ro,\"getAnimationName\");function Mm(n){let r=Object.getOwnPropertyDescriptor(n.props,\"ref\")?.get,s=r&&\"isReactWarning\"in r&&r.isReactWarning;return s?n.ref:(r=Object.getOwnPropertyDescriptor(n,\"ref\")?.get,s=r&&\"isReactWarning\"in r&&r.isReactWarning,s?n.props.ref:n.props.ref||n.ref)}kn(Mm,\"getElementRef\");var m1=Object.defineProperty,oc=(n,r)=>m1(n,\"name\",{value:r,configurable:!0}),Ni=0,Jr=null;function g1(n){return Xi(),n.children}oc(g1,\"FocusGuards\");function Xi(){x.useEffect(()=>{Jr||(Jr={start:$u(),end:$u()});const{start:n,end:r}=Jr;return document.body.firstElementChild!==n&&document.body.insertAdjacentElement(\"afterbegin\",n),document.body.lastElementChild!==r&&document.body.insertAdjacentElement(\"beforeend\",r),Ni++,()=>{Ni===1&&(Jr?.start.remove(),Jr?.end.remove(),Jr=null),Ni=Math.max(0,Ni-1)}},[])}oc(Xi,\"useFocusGuards\");function $u(){const n=document.createElement(\"span\");return n.setAttribute(\"data-radix-focus-guard\",\"\"),n.tabIndex=0,n.style.outline=\"none\",n.style.opacity=\"0\",n.style.position=\"fixed\",n.style.pointerEvents=\"none\",n}oc($u,\"createFocusGuard\");var nn=function(){return nn=Object.assign||function(r){for(var s,i=1,a=arguments.length;i<a;i++){s=arguments[i];for(var u in s)Object.prototype.hasOwnProperty.call(s,u)&&(r[u]=s[u])}return r},nn.apply(this,arguments)};function zm(n,r){var s={};for(var i in n)Object.prototype.hasOwnProperty.call(n,i)&&r.indexOf(i)<0&&(s[i]=n[i]);if(n!=null&&typeof Object.getOwnPropertySymbols==\"function\")for(var a=0,i=Object.getOwnPropertySymbols(n);a<i.length;a++)r.indexOf(i[a])<0&&Object.prototype.propertyIsEnumerable.call(n,i[a])&&(s[i[a]]=n[i[a]]);return s}function v1(n,r,s){if(s||arguments.length===2)for(var i=0,a=r.length,u;i<a;i++)(u||!(i in r))&&(u||(u=Array.prototype.slice.call(r,0,i)),u[i]=r[i]);return n.concat(u||Array.prototype.slice.call(r))}var Ai=\"right-scroll-bar-position\",Di=\"width-before-scroll-bar\",y1=\"with-scroll-bars-hidden\",x1=\"--removed-body-scroll-bar-size\";function vu(n,r){return typeof n==\"function\"?n(r):n&&(n.current=r),n}function w1(n,r){var s=x.useState(function(){return{value:n,callback:r,facade:{get current(){return s.value},set current(i){var a=s.value;a!==i&&(s.value=i,s.callback(i,a))}}}})[0];return s.callback=r,s.facade}var S1=typeof window<\"u\"?x.useLayoutEffect:x.useEffect,ih=new WeakMap;function C1(n,r){var s=w1(null,function(i){return n.forEach(function(a){return vu(a,i)})});return S1(function(){var i=ih.get(s);if(i){var a=new Set(i),u=new Set(n),d=s.current;a.forEach(function(f){u.has(f)||vu(f,null)}),u.forEach(function(f){a.has(f)||vu(f,d)})}ih.set(s,n)},[n]),s}function k1(n){return n}function b1(n,r){r===void 0&&(r=k1);var s=[],i=!1,a={read:function(){if(i)throw new Error(\"Sidecar: could not `read` from an `assigned` medium. `read` could be used only with `useMedium`.\");return s.length?s[s.length-1]:n},useMedium:function(u){var d=r(u,i);return s.push(d),function(){s=s.filter(function(f){return f!==d})}},assignSyncMedium:function(u){for(i=!0;s.length;){var d=s;s=[],d.forEach(u)}s={push:function(f){return u(f)},filter:function(){return s}}},assignMedium:function(u){i=!0;var d=[];if(s.length){var f=s;s=[],f.forEach(u),d=s}var h=function(){var w=d;d=[],w.forEach(u)},m=function(){return Promise.resolve().then(h)};m(),s={push:function(w){d.push(w),m()},filter:function(w){return d=d.filter(w),s}}}};return a}function E1(n){n===void 0&&(n={});var r=b1(null);return r.options=nn({async:!0,ssr:!1},n),r}var Fm=function(n){var r=n.sideCar,s=zm(n,[\"sideCar\"]);if(!r)throw new Error(\"Sidecar: please provide `sideCar` property to import the right car\");var i=r.read();if(!i)throw new Error(\"Sidecar medium not found\");return x.createElement(i,nn({},s))};Fm.isSideCarExport=!0;function P1(n,r){return n.useMedium(r),Fm}var $m=E1(),yu=function(){},Zi=x.forwardRef(function(n,r){var s=x.useRef(null),i=x.useState({onScrollCapture:yu,onWheelCapture:yu,onTouchMoveCapture:yu}),a=i[0],u=i[1],d=n.forwardProps,f=n.children,h=n.className,m=n.removeScrollBar,w=n.enabled,v=n.shards,S=n.sideCar,C=n.noRelative,k=n.noIsolation,E=n.inert,b=n.allowPinchZoom,_=n.as,L=_===void 0?\"div\":_,T=n.gapMode,O=zm(n,[\"forwardProps\",\"children\",\"className\",\"removeScrollBar\",\"enabled\",\"shards\",\"sideCar\",\"noRelative\",\"noIsolation\",\"inert\",\"allowPinchZoom\",\"as\",\"gapMode\"]),B=S,V=C1([s,r]),H=nn(nn({},O),a);return x.createElement(x.Fragment,null,w&&x.createElement(B,{sideCar:$m,removeScrollBar:m,shards:v,noRelative:C,noIsolation:k,inert:E,setCallbacks:u,allowPinchZoom:!!b,lockRef:s,gapMode:T}),d?x.cloneElement(x.Children.only(f),nn(nn({},H),{ref:V})):x.createElement(L,nn({},H,{className:h,ref:V}),f))});Zi.defaultProps={enabled:!0,removeScrollBar:!0,inert:!1};Zi.classNames={fullWidth:Di,zeroRight:Ai};var N1=function(){if(typeof __webpack_nonce__<\"u\")return __webpack_nonce__};function R1(){if(!document)return null;var n=document.createElement(\"style\");n.type=\"text/css\";var r=N1();return r&&n.setAttribute(\"nonce\",r),n}function O1(n,r){n.styleSheet?n.styleSheet.cssText=r:n.appendChild(document.createTextNode(r))}function j1(n){var r=document.head||document.getElementsByTagName(\"head\")[0];r.appendChild(n)}var _1=function(){var n=0,r=null;return{add:function(s){n==0&&(r=R1())&&(O1(r,s),j1(r)),n++},remove:function(){n--,!n&&r&&(r.parentNode&&r.parentNode.removeChild(r),r=null)}}},T1=function(){var n=_1();return function(r,s){x.useEffect(function(){return n.add(r),function(){n.remove()}},[r&&s])}},Vm=function(){var n=T1(),r=function(s){var i=s.styles,a=s.dynamic;return n(i,a),null};return r},L1={left:0,top:0,right:0,gap:0},xu=function(n){return parseInt(n||\"\",10)||0},I1=function(n){var r=window.getComputedStyle(document.body),s=r[n===\"padding\"?\"paddingLeft\":\"marginLeft\"],i=r[n===\"padding\"?\"paddingTop\":\"marginTop\"],a=r[n===\"padding\"?\"paddingRight\":\"marginRight\"];return[xu(s),xu(i),xu(a)]},A1=function(n){if(n===void 0&&(n=\"margin\"),typeof window>\"u\")return L1;var r=I1(n),s=document.documentElement.clientWidth,i=window.innerWidth;return{left:r[0],top:r[1],right:r[2],gap:Math.max(0,i-s+r[2]-r[0])}},D1=Vm(),so=\"data-scroll-locked\",M1=function(n,r,s,i){var a=n.left,u=n.top,d=n.right,f=n.gap;return s===void 0&&(s=\"margin\"),`\n  .`.concat(y1,` {\n   overflow: hidden `).concat(i,`;\n   padding-right: `).concat(f,\"px \").concat(i,`;\n  }\n  body[`).concat(so,`] {\n    overflow: hidden `).concat(i,`;\n    overscroll-behavior: contain;\n    `).concat([r&&\"position: relative \".concat(i,\";\"),s===\"margin\"&&`\n    padding-left: `.concat(a,`px;\n    padding-top: `).concat(u,`px;\n    padding-right: `).concat(d,`px;\n    margin-left:0;\n    margin-top:0;\n    margin-right: `).concat(f,\"px \").concat(i,`;\n    `),s===\"padding\"&&\"padding-right: \".concat(f,\"px \").concat(i,\";\")].filter(Boolean).join(\"\"),`\n  }\n  \n  .`).concat(Ai,` {\n    right: `).concat(f,\"px \").concat(i,`;\n  }\n  \n  .`).concat(Di,` {\n    margin-right: `).concat(f,\"px \").concat(i,`;\n  }\n  \n  .`).concat(Ai,\" .\").concat(Ai,` {\n    right: 0 `).concat(i,`;\n  }\n  \n  .`).concat(Di,\" .\").concat(Di,` {\n    margin-right: 0 `).concat(i,`;\n  }\n  \n  body[`).concat(so,`] {\n    `).concat(x1,\": \").concat(f,`px;\n  }\n`)},lh=function(){var n=parseInt(document.body.getAttribute(so)||\"0\",10);return isFinite(n)?n:0},z1=function(){x.useEffect(function(){return document.body.setAttribute(so,(lh()+1).toString()),function(){var n=lh()-1;n<=0?document.body.removeAttribute(so):document.body.setAttribute(so,n.toString())}},[])},F1=function(n){var r=n.noRelative,s=n.noImportant,i=n.gapMode,a=i===void 0?\"margin\":i;z1();var u=x.useMemo(function(){return A1(a)},[a]);return x.createElement(D1,{styles:M1(u,!r,a,s?\"\":\"!important\")})},Vu=!1;if(typeof window<\"u\")try{var Ri=Object.defineProperty({},\"passive\",{get:function(){return Vu=!0,!0}});window.addEventListener(\"test\",Ri,Ri),window.removeEventListener(\"test\",Ri,Ri)}catch{Vu=!1}var eo=Vu?{passive:!1}:!1,$1=function(n){return n.tagName===\"TEXTAREA\"},Bm=function(n,r){if(!(n instanceof Element))return!1;var s=window.getComputedStyle(n);return s[r]!==\"hidden\"&&!(s.overflowY===s.overflowX&&!$1(n)&&s[r]===\"visible\")},V1=function(n){return Bm(n,\"overflowY\")},B1=function(n){return Bm(n,\"overflowX\")},ah=function(n,r){var s=r.ownerDocument,i=r;do{typeof ShadowRoot<\"u\"&&i instanceof ShadowRoot&&(i=i.host);var a=Um(n,i);if(a){var u=Hm(n,i),d=u[1],f=u[2];if(d>f)return!0}i=i.parentNode}while(i&&i!==s.body);return!1},U1=function(n){var r=n.scrollTop,s=n.scrollHeight,i=n.clientHeight;return[r,s,i]},H1=function(n){var r=n.scrollLeft,s=n.scrollWidth,i=n.clientWidth;return[r,s,i]},Um=function(n,r){return n===\"v\"?V1(r):B1(r)},Hm=function(n,r){return n===\"v\"?U1(r):H1(r)},W1=function(n,r){return n===\"h\"&&r===\"rtl\"?-1:1},K1=function(n,r,s,i,a){var u=W1(n,window.getComputedStyle(r).direction),d=u*i,f=s.target,h=r.contains(f),m=!1,w=d>0,v=0,S=0;do{if(!f)break;var C=Hm(n,f),k=C[0],E=C[1],b=C[2],_=E-b-u*k;(k||_)&&Um(n,f)&&(v+=_,S+=k);var L=f.parentNode;f=L&&L.nodeType===Node.DOCUMENT_FRAGMENT_NODE?L.host:L}while(!h&&f!==document.body||h&&(r.contains(f)||r===f));return(w&&Math.abs(v)<1||!w&&Math.abs(S)<1)&&(m=!0),m},Oi=function(n){return\"changedTouches\"in n?[n.changedTouches[0].clientX,n.changedTouches[0].clientY]:[0,0]},uh=function(n){return[n.deltaX,n.deltaY]},ch=function(n){return n&&\"current\"in n?n.current:n},G1=function(n,r){return n[0]===r[0]&&n[1]===r[1]},Q1=function(n){return`\n  .block-interactivity-`.concat(n,` {pointer-events: none;}\n  .allow-interactivity-`).concat(n,` {pointer-events: all;}\n`)},Y1=0,to=[];function X1(n){var r=x.useRef([]),s=x.useRef([0,0]),i=x.useRef(),a=x.useState(Y1++)[0],u=x.useState(Vm)[0],d=x.useRef(n);x.useEffect(function(){d.current=n},[n]),x.useEffect(function(){if(n.inert){document.body.classList.add(\"block-interactivity-\".concat(a));var E=v1([n.lockRef.current],(n.shards||[]).map(ch),!0).filter(Boolean);return E.forEach(function(b){return b.classList.add(\"allow-interactivity-\".concat(a))}),function(){document.body.classList.remove(\"block-interactivity-\".concat(a)),E.forEach(function(b){return b.classList.remove(\"allow-interactivity-\".concat(a))})}}},[n.inert,n.lockRef.current,n.shards]);var f=x.useCallback(function(E,b){if(\"touches\"in E&&E.touches.length===2||E.type===\"wheel\"&&E.ctrlKey)return!d.current.allowPinchZoom;var _=Oi(E),L=s.current,T=\"deltaX\"in E?E.deltaX:L[0]-_[0],O=\"deltaY\"in E?E.deltaY:L[1]-_[1],B,V=E.target,H=Math.abs(T)>Math.abs(O)?\"h\":\"v\";if(\"touches\"in E&&H===\"h\"&&V.type===\"range\")return!1;var $=window.getSelection(),W=$&&$.anchorNode,X=W?W===V||W.contains(V):!1;if(X)return!1;var Q=ah(H,V);if(!Q)return!0;if(Q?B=H:(B=H===\"v\"?\"h\":\"v\",Q=ah(H,V)),!Q)return!1;if(!i.current&&\"changedTouches\"in E&&(T||O)&&(i.current=B),!B)return!0;var q=i.current||B;return K1(q,b,E,q===\"h\"?T:O)},[]),h=x.useCallback(function(E){var b=E;if(!(!to.length||to[to.length-1]!==u)){var _=\"deltaY\"in b?uh(b):Oi(b),L=r.current.filter(function(B){return B.name===b.type&&(B.target===b.target||b.target===B.shadowParent)&&G1(B.delta,_)})[0];if(L&&L.should){b.cancelable&&b.preventDefault();return}if(!L){var T=(d.current.shards||[]).map(ch).filter(Boolean).filter(function(B){return B.contains(b.target)}),O=T.length>0?f(b,T[0]):!d.current.noIsolation;O&&b.cancelable&&b.preventDefault()}}},[]),m=x.useCallback(function(E,b,_,L){var T={name:E,delta:b,target:_,should:L,shadowParent:Z1(_)};r.current.push(T),setTimeout(function(){r.current=r.current.filter(function(O){return O!==T})},1)},[]),w=x.useCallback(function(E){s.current=Oi(E),i.current=void 0},[]),v=x.useCallback(function(E){m(E.type,uh(E),E.target,f(E,n.lockRef.current))},[]),S=x.useCallback(function(E){m(E.type,Oi(E),E.target,f(E,n.lockRef.current))},[]);x.useEffect(function(){return to.push(u),n.setCallbacks({onScrollCapture:v,onWheelCapture:v,onTouchMoveCapture:S}),document.addEventListener(\"wheel\",h,eo),document.addEventListener(\"touchmove\",h,eo),document.addEventListener(\"touchstart\",w,eo),function(){to=to.filter(function(E){return E!==u}),document.removeEventListener(\"wheel\",h,eo),document.removeEventListener(\"touchmove\",h,eo),document.removeEventListener(\"touchstart\",w,eo)}},[]);var C=n.removeScrollBar,k=n.inert;return x.createElement(x.Fragment,null,k?x.createElement(u,{styles:Q1(a)}):null,C?x.createElement(F1,{noRelative:n.noRelative,gapMode:n.gapMode}):null)}function Z1(n){for(var r=null;n!==null;)n instanceof ShadowRoot&&(r=n.host,n=n.host),n=n.parentNode;return r}const q1=P1($m,X1);var sc=x.forwardRef(function(n,r){return x.createElement(Zi,nn({},n,{ref:r,sideCar:q1}))});sc.classNames=Zi.classNames;var J1=function(n){if(typeof document>\"u\")return null;var r=Array.isArray(n)?n[0]:n;return r.ownerDocument.body},no=new WeakMap,ji=new WeakMap,_i={},wu=0,Wm=function(n){return n&&(n.host||Wm(n.parentNode))},eS=function(n,r){return r.map(function(s){if(n.contains(s))return s;var i=Wm(s);return i&&n.contains(i)?i:(console.error(\"aria-hidden\",s,\"in not contained inside\",n,\". Doing nothing\"),null)}).filter(function(s){return!!s})},tS=function(n,r,s,i){var a=eS(r,Array.isArray(n)?n:[n]);_i[s]||(_i[s]=new WeakMap);var u=_i[s],d=[],f=new Set,h=new Set(a),m=function(v){!v||f.has(v)||(f.add(v),m(v.parentNode))};a.forEach(m);var w=function(v){!v||h.has(v)||Array.prototype.forEach.call(v.children,function(S){if(f.has(S))w(S);else try{var C=S.getAttribute(i),k=C!==null&&C!==\"false\",E=(no.get(S)||0)+1,b=(u.get(S)||0)+1;no.set(S,E),u.set(S,b),d.push(S),E===1&&k&&ji.set(S,!0),b===1&&S.setAttribute(s,\"true\"),k||S.setAttribute(i,\"true\")}catch(_){console.error(\"aria-hidden: cannot operate on \",S,_)}})};return w(r),f.clear(),wu++,function(){d.forEach(function(v){var S=no.get(v)-1,C=u.get(v)-1;no.set(v,S),u.set(v,C),S||(ji.has(v)||v.removeAttribute(i),ji.delete(v)),C||v.removeAttribute(s)}),wu--,wu||(no=new WeakMap,no=new WeakMap,ji=new WeakMap,_i={})}},Km=function(n,r,s){s===void 0&&(s=\"data-aria-hidden\");var i=Array.from(Array.isArray(n)?n:[n]),a=J1(n);return a?(i.push.apply(i,Array.from(a.querySelectorAll(\"[aria-live], script\"))),tS(i,a,s,\"aria-hidden\")):function(){return null}},nS=Object.defineProperty,Yt=(n,r)=>nS(n,\"name\",{value:r,configurable:!0}),ic=\"Dialog\",[Gm,ab]=kr(ic),[rS,En]=Gm(ic),oS=Yt(n=>{const{__scopeDialog:r,children:s,open:i,defaultOpen:a,onOpenChange:u,modal:d=!0}=n,f=x.useRef(null),h=x.useRef(null),[m,w]=os({prop:i,defaultProp:a??!1,onChange:u,caller:ic}),[v,S]=x.useState(0),[C,k]=x.useState(0);return g.jsx(rS,{scope:r,triggerRef:f,contentRef:h,contentId:vr(),titleId:vr(),descriptionId:vr(),titlePresent:v>0,descriptionPresent:C>0,setTitleCount:S,setDescriptionCount:k,open:m,onOpenChange:w,onOpenToggle:x.useCallback(()=>w(E=>!E),[w]),modal:d,children:s})},\"Dialog\"),Qm=\"DialogPortal\",[sS,Ym]=Gm(Qm,{forceMount:void 0}),iS=Yt(n=>{const{__scopeDialog:r,forceMount:s,children:i,container:a}=n,u=En(Qm,r);return g.jsx(sS,{scope:r,forceMount:s,children:x.Children.map(i,d=>g.jsx(fs,{present:s||u.open,children:g.jsx(Lm,{asChild:!0,container:a,children:d})}))})},\"DialogPortal\"),Bu=\"DialogOverlay\",Xm=x.forwardRef(Yt(function(r,s){const i=Ym(Bu,r.__scopeDialog),{forceMount:a=i.forceMount,...u}=r,d=En(Bu,r.__scopeDialog);return d.modal?g.jsx(fs,{present:a||d.open,children:g.jsx(aS,{...u,ref:s})}):null},\"DialogOverlay\")),lS=Cn(\"DialogOverlay.RemoveScroll\"),aS=x.forwardRef(Yt(function(r,s){const{__scopeDialog:i,...a}=r,u=En(Bu,i),d=km(),f=De(s,d);return g.jsx(sc,{as:lS,allowPinchZoom:!0,shards:[u.contentRef],children:g.jsx(Ue.div,{\"data-state\":lc(u.open),...a,ref:f,style:{pointerEvents:\"auto\",...a.style}})})},\"DialogOverlayImpl\")),ss=\"DialogContent\",Zm=x.forwardRef(Yt(function(r,s){const i=Ym(ss,r.__scopeDialog),{forceMount:a=i.forceMount,...u}=r,d=En(ss,r.__scopeDialog);return g.jsx(fs,{present:a||d.open,children:d.modal?g.jsx(uS,{...u,ref:s}):g.jsx(cS,{...u,ref:s})})},\"DialogContent\")),uS=x.forwardRef(Yt(function(r,s){const i=En(ss,r.__scopeDialog),a=x.useRef(null),u=De(s,i.contentRef,a);return x.useEffect(()=>{const d=a.current;if(d)return Km(d)},[]),g.jsx(qm,{...r,ref:u,trapFocus:i.open,disableOutsidePointerEvents:i.open,onCloseAutoFocus:je(r.onCloseAutoFocus,d=>{d.preventDefault(),i.triggerRef.current?.focus()}),onPointerDownOutside:je(r.onPointerDownOutside,d=>{const f=d.detail.originalEvent,h=f.button===0&&f.ctrlKey===!0;(f.button===2||h)&&d.preventDefault()}),onFocusOutside:je(r.onFocusOutside,d=>d.preventDefault())})},\"DialogContentModal\")),cS=x.forwardRef(Yt(function(r,s){const i=En(ss,r.__scopeDialog),a=x.useRef(!1),u=x.useRef(!1);return g.jsx(qm,{...r,ref:s,trapFocus:!1,disableOutsidePointerEvents:!1,onCloseAutoFocus:d=>{r.onCloseAutoFocus?.(d),d.defaultPrevented||(a.current||i.triggerRef.current?.focus(),d.preventDefault()),a.current=!1,u.current=!1},onInteractOutside:d=>{r.onInteractOutside?.(d),d.defaultPrevented||(a.current=!0,d.detail.originalEvent.type===\"pointerdown\"&&(u.current=!0));const f=d.target;i.triggerRef.current?.contains(f)&&d.preventDefault(),d.detail.originalEvent.type===\"focusin\"&&u.current&&d.preventDefault()}})},\"DialogContentNonModal\")),qm=x.forwardRef(Yt(function(r,s){const{__scopeDialog:i,trapFocus:a,onOpenAutoFocus:u,onCloseAutoFocus:d,...f}=r,h=En(ss,i);return Xi(),g.jsx(g.Fragment,{children:g.jsx(Pm,{asChild:!0,loop:!0,trapped:a,onMountAutoFocus:u,onUnmountAutoFocus:d,children:g.jsx(tc,{role:\"dialog\",id:h.contentId,\"aria-describedby\":h.descriptionPresent?h.descriptionId:void 0,\"aria-labelledby\":h.titlePresent?h.titleId:void 0,\"data-state\":lc(h.open),...f,ref:s,deferPointerDownOutside:!0,onDismiss:()=>h.onOpenChange(!1)})})})},\"DialogContentImpl\")),dS=\"DialogTitle\",Jm=x.forwardRef(Yt(function(r,s){const{__scopeDialog:i,...a}=r,u=En(dS,i),{setTitleCount:d}=u;return Ge(()=>(d(f=>f+1),()=>d(f=>f-1)),[d]),g.jsx(Ue.h2,{id:u.titleId,...a,ref:s})},\"DialogTitle\")),fS=\"DialogDescription\",eg=x.forwardRef(Yt(function(r,s){const{__scopeDialog:i,...a}=r,u=En(fS,i),{setDescriptionCount:d}=u;return Ge(()=>(d(f=>f+1),()=>d(f=>f-1)),[d]),g.jsx(Ue.p,{id:u.descriptionId,...a,ref:s})},\"DialogDescription\"));function lc(n){return n?\"open\":\"closed\"}Yt(lc,\"getState\");const ac=oS,pS=iS,tg=x.forwardRef(({className:n,zIndex:r=\"base\",...s},i)=>{const a={base:\"z-40\",nested:\"z-50\",alert:\"z-[60]\",top:\"z-[110]\"};return g.jsx(Xm,{ref:i,className:Ve(\"fixed inset-0 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0\",a[r],n),...s})});tg.displayName=Xm.displayName;const qi=x.forwardRef(({className:n,children:r,zIndex:s=\"base\",variant:i=\"default\",overlayClassName:a,...u},d)=>{const f={base:\"z-40\",nested:\"z-50\",alert:\"z-[60]\",top:\"z-[110]\"},h={default:\"fixed left-1/2 top-1/2 flex flex-col w-full max-w-lg max-h-[90vh] translate-x-[-50%] translate-y-[-50%] border border-border-default bg-background text-foreground shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg\",fullscreen:\"fixed inset-0 flex flex-col w-screen h-screen translate-x-0 translate-y-0 bg-background text-foreground p-0 sm:rounded-none shadow-none\"}[i];return g.jsxs(pS,{children:[g.jsx(tg,{zIndex:s,className:a}),g.jsx(Zm,{ref:d,className:Ve(h,f[s],n),onInteractOutside:m=>{m.preventDefault()},...u,children:r})]})});qi.displayName=Zm.displayName;const uc=({className:n,...r})=>g.jsx(\"div\",{className:Ve(\"flex flex-col space-y-1.5 text-center sm:text-left px-6 py-5 border-b border-border-default bg-muted/20 flex-shrink-0\",n),...r});uc.displayName=\"DialogHeader\";const cc=({className:n,...r})=>g.jsx(\"div\",{className:Ve(\"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:items-center px-6 py-5 border-t border-border-default bg-muted/20 flex-shrink-0\",n),...r});cc.displayName=\"DialogFooter\";const Ji=x.forwardRef(({className:n,...r},s)=>g.jsx(Jm,{ref:s,className:Ve(\"text-lg font-semibold leading-tight tracking-tight\",n),...r}));Ji.displayName=Jm.displayName;const el=x.forwardRef(({className:n,...r},s)=>g.jsx(eg,{ref:s,className:Ve(\"text-sm text-muted-foreground\",n),...r}));el.displayName=eg.displayName;const ng=x.forwardRef(({className:n,checked:r,onChange:s,onCheckedChange:i,\"aria-checked\":a,...u},d)=>{const f=x.useRef(null),h=r===\"indeterminate\";return x.useImperativeHandle(d,()=>f.current),x.useLayoutEffect(()=>{f.current&&(f.current.indeterminate=h)}),g.jsx(\"input\",{...u,ref:f,type:\"checkbox\",checked:h?!1:r,\"aria-checked\":h?\"mixed\":a,onChange:m=>{s?.(m),i?.(m.target.checked)},className:Ve(\"w-4 h-4 text-blue-500 bg-white dark:bg-gray-800 border-border-default rounded focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-2\",n)})});ng.displayName=\"Checkbox\";function hS({isOpen:n,title:r,message:s,confirmText:i,cancelText:a,variant:u=\"destructive\",zIndex:d=\"alert\",checkboxLabel:f,checkboxDefaultChecked:h=!1,pending:m=!1,onConfirm:w,onCancel:v}){const{t:S}=Xu(),[C,k]=x.useState(h);x.useEffect(()=>{n&&k(h)},[n,h]);const E=u===\"info\"?x0:M0,b=u===\"info\"?\"h-5 w-5 text-blue-500\":\"h-5 w-5 text-destructive\";return g.jsx(ac,{open:n,onOpenChange:_=>{!_&&!m&&v()},children:g.jsxs(qi,{className:\"max-w-sm\",zIndex:d,children:[g.jsxs(uc,{className:\"space-y-3 border-b-0 bg-transparent pb-0\",children:[g.jsxs(Ji,{className:\"flex items-center gap-2 text-lg font-semibold\",children:[g.jsx(E,{className:b}),r]}),g.jsx(el,{className:\"whitespace-pre-line text-sm leading-relaxed\",children:s})]}),f?g.jsxs(\"label\",{className:\"flex cursor-pointer select-none items-start gap-2 px-6 pt-3\",children:[g.jsx(ng,{checked:C,disabled:m,onCheckedChange:_=>k(_===!0),className:\"mt-0.5\"}),g.jsx(\"span\",{className:\"text-sm leading-relaxed\",children:f})]}):null,g.jsxs(cc,{className:\"flex gap-2 border-t-0 bg-transparent pt-2 sm:justify-end\",children:[g.jsx($e,{variant:\"outline\",onClick:v,disabled:m,children:a||S(\"common.cancel\")}),g.jsx($e,{variant:u===\"info\"?\"default\":\"destructive\",disabled:m,onClick:()=>w(f?C:!1),children:i||S(\"common.confirm\")})]})]})})}const mS=[\"top\",\"right\",\"bottom\",\"left\"],Yn=Math.min,wn=Math.max,Ui=Math.round,Ti=Math.floor,Sn=n=>({x:n,y:n}),gS={left:\"right\",right:\"left\",bottom:\"top\",top:\"bottom\"};function rg(n,r,s){return wn(n,Yn(r,s))}function bn(n,r){return typeof n==\"function\"?n(r):n}function Xn(n){return n.split(\"-\")[0]}function uo(n){return n.split(\"-\")[1]}function dc(n){return n===\"x\"?\"y\":\"x\"}function fc(n){return n===\"y\"?\"height\":\"width\"}function on(n){const r=n[0];return r===\"t\"||r===\"b\"?\"y\":\"x\"}function pc(n){return dc(on(n))}function vS(n,r,s){s===void 0&&(s=!1);const i=uo(n),a=pc(n),u=fc(a);let d=a===\"x\"?i===(s?\"end\":\"start\")?\"right\":\"left\":i===\"start\"?\"bottom\":\"top\";return r.reference[u]>r.floating[u]&&(d=Hi(d)),[d,Hi(d)]}function yS(n){const r=Hi(n);return[Uu(n),r,Uu(r)]}function Uu(n){return n.includes(\"start\")?n.replace(\"start\",\"end\"):n.replace(\"end\",\"start\")}const dh=[\"left\",\"right\"],fh=[\"right\",\"left\"],xS=[\"top\",\"bottom\"],wS=[\"bottom\",\"top\"];function SS(n,r,s){switch(n){case\"top\":case\"bottom\":return s?r?fh:dh:r?dh:fh;case\"left\":case\"right\":return r?xS:wS;default:return[]}}function CS(n,r,s,i){const a=uo(n);let u=SS(Xn(n),s===\"start\",i);return a&&(u=u.map(d=>d+\"-\"+a),r&&(u=u.concat(u.map(Uu)))),u}function Hi(n){const r=Xn(n);return gS[r]+n.slice(r.length)}function kS(n){var r,s,i,a;return{top:(r=n.top)!=null?r:0,right:(s=n.right)!=null?s:0,bottom:(i=n.bottom)!=null?i:0,left:(a=n.left)!=null?a:0}}function og(n){return typeof n!=\"number\"?kS(n):{top:n,right:n,bottom:n,left:n}}function Wi(n){const{x:r,y:s,width:i,height:a}=n;return{width:i,height:a,top:s,left:r,right:r+i,bottom:s+a,x:r,y:s}}function ph(n,r,s){let{reference:i,floating:a}=n;const u=on(r),d=pc(r),f=fc(d),h=Xn(r),m=u===\"y\",w=i.x+i.width/2-a.width/2,v=i.y+i.height/2-a.height/2,S=i[f]/2-a[f]/2;let C;switch(h){case\"top\":C={x:w,y:i.y-a.height};break;case\"bottom\":C={x:w,y:i.y+i.height};break;case\"right\":C={x:i.x+i.width,y:v};break;case\"left\":C={x:i.x-a.width,y:v};break;default:C={x:i.x,y:i.y}}const k=uo(r);return k&&(C[d]+=S*(k===\"end\"?1:-1)*(s&&m?-1:1)),C}async function bS(n,r){var s;r===void 0&&(r={});const{x:i,y:a,platform:u,rects:d,elements:f,strategy:h}=n,{boundary:m=\"clippingAncestors\",rootBoundary:w=\"viewport\",elementContext:v=\"floating\",altBoundary:S=!1,padding:C=0}=bn(r,n),k=og(C),b=f[S?v===\"floating\"?\"reference\":\"floating\":v],_=Wi(await u.getClippingRect({element:(s=await(u.isElement==null?void 0:u.isElement(b)))==null||s?b:b.contextElement||await(u.getDocumentElement==null?void 0:u.getDocumentElement(f.floating)),boundary:m,rootBoundary:w,strategy:h})),L=v===\"floating\"?{x:i,y:a,width:d.floating.width,height:d.floating.height}:d.reference,T=await(u.getOffsetParent==null?void 0:u.getOffsetParent(f.floating)),O=await(u.isElement==null?void 0:u.isElement(T))&&await(u.getScale==null?void 0:u.getScale(T))||{x:1,y:1},B=Wi(u.convertOffsetParentRelativeRectToViewportRelativeRect?await u.convertOffsetParentRelativeRectToViewportRelativeRect({elements:f,rect:L,offsetParent:T,strategy:h}):L);return{top:(_.top-B.top+k.top)/O.y,bottom:(B.bottom-_.bottom+k.bottom)/O.y,left:(_.left-B.left+k.left)/O.x,right:(B.right-_.right+k.right)/O.x}}const ES=50,PS=async(n,r,s)=>{const{placement:i=\"bottom\",strategy:a=\"absolute\",middleware:u=[],platform:d}=s,f=d.detectOverflow?d:{...d,detectOverflow:bS},h=await(d.isRTL==null?void 0:d.isRTL(r));let m=await d.getElementRects({reference:n,floating:r,strategy:a}),{x:w,y:v}=ph(m,i,h),S=i,C=0;const k={};for(let E=0;E<u.length;E++){const b=u[E];if(!b)continue;const{name:_,fn:L}=b,{x:T,y:O,data:B,reset:V}=await L({x:w,y:v,initialPlacement:i,placement:S,strategy:a,middlewareData:k,rects:m,platform:f,elements:{reference:n,floating:r}});w=T??w,v=O??v,k[_]={...k[_],...B},V&&C<ES&&(C++,typeof V==\"object\"&&(V.placement&&(S=V.placement),V.rects&&(m=V.rects===!0?await d.getElementRects({reference:n,floating:r,strategy:a}):V.rects),{x:w,y:v}=ph(m,S,h)),E=-1)}return{x:w,y:v,placement:S,strategy:a,middlewareData:k}},NS=n=>({name:\"arrow\",options:n,async fn(r){const{x:s,y:i,placement:a,rects:u,platform:d,elements:f,middlewareData:h}=r,{element:m,padding:w=0}=bn(n,r)||{};if(m==null)return{};const v=og(w),S={x:s,y:i},C=pc(a),k=fc(C),E=await d.getDimensions(m),b=C===\"y\",_=b?\"top\":\"left\",L=b?\"bottom\":\"right\",T=b?\"clientHeight\":\"clientWidth\",O=u.reference[k]+u.reference[C]-S[C]-u.floating[k],B=S[C]-u.reference[C],V=await(d.getOffsetParent==null?void 0:d.getOffsetParent(m));let H=V?V[T]:0;(!H||!await(d.isElement==null?void 0:d.isElement(V)))&&(H=f.floating[T]||u.floating[k]);const $=O/2-B/2,W=H/2-E[k]/2-1,X=Yn(v[_],W),Q=Yn(v[L],W),q=H-E[k]-Q,Z=H/2-E[k]/2+$,ne=rg(X,Z,q),fe=!h.arrow&&uo(a)!=null&&Z!==ne&&u.reference[k]/2-(Z<X?X:Q)-E[k]/2<0,J=fe?Z<X?Z-X:Z-q:0;return{[C]:S[C]+J,data:{[C]:ne,centerOffset:Z-ne-J,...fe&&{alignmentOffset:J}},reset:fe}}}),RS=function(n){return n===void 0&&(n={}),{name:\"flip\",options:n,async fn(r){var s,i;const{placement:a,middlewareData:u,rects:d,initialPlacement:f,platform:h,elements:m}=r,{mainAxis:w=!0,crossAxis:v=!0,fallbackPlacements:S,fallbackStrategy:C=\"bestFit\",fallbackAxisSideDirection:k=\"none\",flipAlignment:E=!0,...b}=bn(n,r);if((s=u.arrow)!=null&&s.alignmentOffset)return{};const _=Xn(a),L=on(f),T=Xn(f)===f,O=await(h.isRTL==null?void 0:h.isRTL(m.floating)),B=S||(T||!E?[Hi(f)]:yS(f)),V=k!==\"none\";!S&&V&&B.push(...CS(f,E,k,O));const H=[f,...B],$=await h.detectOverflow(r,b),W=[];let X=((i=u.flip)==null?void 0:i.overflows)||[];if(w&&W.push($[_]),v){const ne=vS(a,d,O);W.push($[ne[0]],$[ne[1]])}if(X=[...X,{placement:a,overflows:W}],!W.every(ne=>ne<=0)){var Q,q;const ne=(((Q=u.flip)==null?void 0:Q.index)||0)+1,fe=H[ne];if(fe&&(!(v===\"alignment\"?L!==on(fe):!1)||X.every(I=>on(I.placement)===L?I.overflows[0]>0:!0)))return{data:{index:ne,overflows:X},reset:{placement:fe}};let J=(q=X.filter(ee=>ee.overflows[0]<=0).sort((ee,I)=>ee.overflows[1]-I.overflows[1])[0])==null?void 0:q.placement;if(!J)switch(C){case\"bestFit\":{var Z;const ee=(Z=X.filter(I=>{if(V){const U=on(I.placement);return U===L||U===\"y\"}return!0}).map(I=>[I.placement,I.overflows.filter(U=>U>0).reduce((U,M)=>U+M,0)]).sort((I,U)=>I[1]-U[1])[0])==null?void 0:Z[0];ee&&(J=ee);break}case\"initialPlacement\":J=f;break}if(a!==J)return{reset:{placement:J}}}return{}}}};function hh(n,r){return{top:n.top-r.height,right:n.right-r.width,bottom:n.bottom-r.height,left:n.left-r.width}}function mh(n){return mS.some(r=>n[r]>=0)}const OS=function(n){return n===void 0&&(n={}),{name:\"hide\",options:n,async fn(r){const{rects:s,platform:i}=r,{strategy:a=\"referenceHidden\",...u}=bn(n,r);switch(a){case\"referenceHidden\":{const d=await i.detectOverflow(r,{...u,elementContext:\"reference\"}),f=hh(d,s.reference);return{data:{referenceHiddenOffsets:f,referenceHidden:mh(f)}}}case\"escaped\":{const d=await i.detectOverflow(r,{...u,altBoundary:!0}),f=hh(d,s.floating);return{data:{escapedOffsets:f,escaped:mh(f)}}}default:return{}}}}},sg=new Set([\"left\",\"top\"]);async function jS(n,r){const{placement:s,platform:i,elements:a}=n,u=await(i.isRTL==null?void 0:i.isRTL(a.floating)),d=Xn(s),f=uo(s),h=on(s)===\"y\",m=sg.has(d)?-1:1,w=u&&h?-1:1,v=bn(r,n);let{mainAxis:S,crossAxis:C,alignmentAxis:k}=typeof v==\"number\"?{mainAxis:v,crossAxis:0,alignmentAxis:null}:{mainAxis:v.mainAxis||0,crossAxis:v.crossAxis||0,alignmentAxis:v.alignmentAxis};return f&&typeof k==\"number\"&&(C=f===\"end\"?k*-1:k),h?{x:C*w,y:S*m}:{x:S*m,y:C*w}}const _S=function(n){return n===void 0&&(n=0),{name:\"offset\",options:n,async fn(r){var s,i;const{x:a,y:u,placement:d,middlewareData:f}=r,h=await jS(r,n);return d===((s=f.offset)==null?void 0:s.placement)&&(i=f.arrow)!=null&&i.alignmentOffset?{}:{x:a+h.x,y:u+h.y,data:{...h,placement:d}}}}},TS=function(n){return n===void 0&&(n={}),{name:\"shift\",options:n,async fn(r){const{x:s,y:i,placement:a,platform:u}=r,{mainAxis:d=!0,crossAxis:f=!1,limiter:h={fn:L=>{let{x:T,y:O}=L;return{x:T,y:O}}},...m}=bn(n,r),w={x:s,y:i},v=await u.detectOverflow(r,m),S=on(a),C=dc(S);let k=w[C],E=w[S];const b=(L,T)=>rg(T+v[L===\"y\"?\"top\":\"left\"],T,T-v[L===\"y\"?\"bottom\":\"right\"]);d&&(k=b(C,k)),f&&(E=b(S,E));const _=h.fn({...r,[C]:k,[S]:E});return{..._,data:{x:_.x-s,y:_.y-i,enabled:{[C]:d,[S]:f}}}}}},LS=function(n){return n===void 0&&(n={}),{options:n,fn(r){var s,i;const{x:a,y:u,placement:d,rects:f,middlewareData:h}=r,{offset:m=0,mainAxis:w=!0,crossAxis:v=!0}=bn(n,r),S={x:a,y:u},C=on(d),k=dc(C);let E=S[k],b=S[C];const _=bn(m,r),L=typeof _==\"number\"?{mainAxis:_,crossAxis:0}:{mainAxis:(s=_.mainAxis)!=null?s:0,crossAxis:(i=_.crossAxis)!=null?i:0};if(w){const B=k===\"y\"?\"height\":\"width\",V=f.reference[k]-f.floating[B]+L.mainAxis,H=f.reference[k]+f.reference[B]-L.mainAxis;E<V?E=V:E>H&&(E=H)}if(v){var T,O;const B=k===\"y\"?\"width\":\"height\",V=sg.has(Xn(d)),H=f.reference[C]-f.floating[B]+(V&&((T=h.offset)==null?void 0:T[C])||0)+(V?0:L.crossAxis),$=f.reference[C]+f.reference[B]+(V?0:((O=h.offset)==null?void 0:O[C])||0)-(V?L.crossAxis:0);b<H?b=H:b>$&&(b=$)}return{[k]:E,[C]:b}}}},IS=function(n){return n===void 0&&(n={}),{name:\"size\",options:n,async fn(r){const{placement:s,rects:i,platform:a,elements:u}=r,{apply:d=()=>{},...f}=bn(n,r),h=await a.detectOverflow(r,f),m=Xn(s),w=uo(s),v=on(s)===\"y\",{width:S,height:C}=i.floating;let k,E;m===\"top\"||m===\"bottom\"?(k=m,E=w===(await(a.isRTL==null?void 0:a.isRTL(u.floating))?\"start\":\"end\")?\"left\":\"right\"):(E=m,k=w===\"end\"?\"top\":\"bottom\");const b=C-h.top-h.bottom,_=S-h.left-h.right,L=Yn(C-h[k],b),T=Yn(S-h[E],_),O=r.middlewareData.shift,B=!O;let V=L,H=T;O!=null&&O.enabled.x&&(H=_),O!=null&&O.enabled.y&&(V=b),B&&!w&&(v?H=S-2*wn(h.left,h.right):V=C-2*wn(h.top,h.bottom)),await d({...r,availableWidth:H,availableHeight:V});const $=await a.getDimensions(u.floating);return S!==$.width||C!==$.height?{reset:{rects:!0}}:{}}}};function tl(){return typeof window<\"u\"}function co(n){return ig(n)?(n.nodeName||\"\").toLowerCase():\"#document\"}function bt(n){var r;return(n==null||(r=n.ownerDocument)==null?void 0:r.defaultView)||window}function Pn(n){var r;return(r=(ig(n)?n.ownerDocument:n.document)||window.document)==null?void 0:r.documentElement}function ig(n){return tl()?n instanceof Node||n instanceof bt(n).Node:!1}function ln(n){return tl()?n instanceof Element||n instanceof bt(n).Element:!1}function qn(n){return tl()?n instanceof HTMLElement||n instanceof bt(n).HTMLElement:!1}function gh(n){return!tl()||typeof ShadowRoot>\"u\"?!1:n instanceof ShadowRoot||n instanceof bt(n).ShadowRoot}function nl(n){const{overflow:r,overflowX:s,overflowY:i,display:a}=an(n);return/auto|scroll|overlay|hidden|clip/.test(r+i+s)&&a!==\"inline\"&&a!==\"contents\"}function AS(n){return/^(table|td|th)$/.test(co(n))}function rl(n){try{if(n.matches(\":popover-open\"))return!0}catch{}try{return n.matches(\":modal\")}catch{return!1}}const DS=/transform|translate|scale|rotate|perspective|filter/,MS=/paint|layout|strict|content/,gr=n=>!!n&&n!==\"none\";let Su;function hc(n){const r=ln(n)?an(n):n;return gr(r.transform)||gr(r.translate)||gr(r.scale)||gr(r.rotate)||gr(r.perspective)||!mc()&&(gr(r.backdropFilter)||gr(r.filter))||DS.test(r.willChange||\"\")||MS.test(r.contain||\"\")}function zS(n){let r=xr(n);for(;qn(r)&&!is(r);){if(hc(r))return r;if(rl(r))return null;r=xr(r)}return null}function mc(){return Su==null&&(Su=typeof CSS<\"u\"&&CSS.supports&&CSS.supports(\"-webkit-backdrop-filter\",\"none\")),Su}function is(n){return/^(html|body|#document)$/.test(co(n))}function an(n){return bt(n).getComputedStyle(n)}function ol(n){return ln(n)?{scrollLeft:n.scrollLeft,scrollTop:n.scrollTop}:{scrollLeft:n.scrollX,scrollTop:n.scrollY}}function xr(n){if(co(n)===\"html\")return n;const r=n.assignedSlot||n.parentNode||gh(n)&&n.host||Pn(n);return gh(r)?r.host:r}function lg(n){const r=xr(n);return is(r)?(n.ownerDocument||n).body:qn(r)&&nl(r)?r:lg(r)}function ls(n,r,s){var i;r===void 0&&(r=[]),s===void 0&&(s=!0);const a=lg(n),u=a===((i=n.ownerDocument)==null?void 0:i.body),d=bt(a);if(u){const f=Hu(d);return r.concat(d,d.visualViewport||[],nl(a)?a:[],f&&s?ls(f):[])}else return r.concat(a,ls(a,[],s))}function Hu(n){return n.parent&&Object.getPrototypeOf(n.parent)?n.frameElement:null}function ag(n){const r=an(n);let s=parseFloat(r.width)||0,i=parseFloat(r.height)||0;const a=qn(n),u=a?n.offsetWidth:s,d=a?n.offsetHeight:i,f=Ui(s)!==u||Ui(i)!==d;return f&&(s=u,i=d),{width:s,height:i,$:f}}function gc(n){return ln(n)?n:n.contextElement}function io(n){const r=gc(n);if(!qn(r))return Sn(1);const s=r.getBoundingClientRect(),{width:i,height:a,$:u}=ag(r);let d=(u?Ui(s.width):s.width)/i,f=(u?Ui(s.height):s.height)/a;return(!d||!Number.isFinite(d))&&(d=1),(!f||!Number.isFinite(f))&&(f=1),{x:d,y:f}}const FS=Sn(0);function ug(n){const r=bt(n);return!mc()||!r.visualViewport?FS:{x:r.visualViewport.offsetLeft,y:r.visualViewport.offsetTop}}function $S(n,r,s){return r===void 0&&(r=!1),!!s&&r&&s===bt(n)}function wr(n,r,s,i){r===void 0&&(r=!1),s===void 0&&(s=!1);const a=n.getBoundingClientRect(),u=gc(n);let d=Sn(1);r&&(i?ln(i)&&(d=io(i)):d=io(n));const f=$S(u,s,i)?ug(u):Sn(0);let h=(a.left+f.x)/d.x,m=(a.top+f.y)/d.y,w=a.width/d.x,v=a.height/d.y;if(u&&i){const S=bt(u),C=ln(i)?bt(i):i;let k=S,E=Hu(k);for(;E&&C!==k;){const b=io(E),_=E.getBoundingClientRect(),L=an(E),T=_.left+(E.clientLeft+parseFloat(L.paddingLeft))*b.x,O=_.top+(E.clientTop+parseFloat(L.paddingTop))*b.y;h*=b.x,m*=b.y,w*=b.x,v*=b.y,h+=T,m+=O,k=bt(E),E=Hu(k)}}return Wi({width:w,height:v,x:h,y:m})}function sl(n,r){const s=ol(n).scrollLeft;return r?r.left+s:wr(Pn(n)).left+s}function cg(n,r){const s=n.getBoundingClientRect(),i=s.left+r.scrollLeft-sl(n,s),a=s.top+r.scrollTop;return{x:i,y:a}}function VS(n){let{elements:r,rect:s,offsetParent:i,strategy:a}=n;const u=a===\"fixed\",d=Pn(i),f=r?rl(r.floating):!1;if(i===d||f&&u)return s;let h={scrollLeft:0,scrollTop:0},m=Sn(1);const w=Sn(0),v=qn(i);if((v||!u)&&((co(i)!==\"body\"||nl(d))&&(h=ol(i)),v)){const C=wr(i);m=io(i),w.x=C.x+i.clientLeft,w.y=C.y+i.clientTop}const S=d&&!v&&!u?cg(d,h):Sn(0);return{width:s.width*m.x,height:s.height*m.y,x:s.x*m.x-h.scrollLeft*m.x+w.x+S.x,y:s.y*m.y-h.scrollTop*m.y+w.y+S.y}}function BS(n){return n.getClientRects?Array.from(n.getClientRects()):[]}function US(n){const r=ol(n),s=n.ownerDocument.body,i=wn(n.scrollWidth,n.clientWidth,s.scrollWidth,s.clientWidth),a=wn(n.scrollHeight,n.clientHeight,s.scrollHeight,s.clientHeight);let u=-r.scrollLeft+sl(n);const d=-r.scrollTop;return an(s).direction===\"rtl\"&&(u+=wn(n.clientWidth,s.clientWidth)-i),{width:i,height:a,x:u,y:d}}const HS=25;function WS(n,r,s){s===void 0&&(s=\"viewport\");const i=s===\"layoutViewport\",a=bt(n),u=Pn(n),d=a.visualViewport;let f=u.clientWidth,h=u.clientHeight,m=0,w=0;if(d){const S=!mc()||r===\"fixed\";i?S||(m=-d.offsetLeft,w=-d.offsetTop):(f=d.width,h=d.height,S&&(m=d.offsetLeft,w=d.offsetTop))}if(sl(u)<=0){const S=u.ownerDocument,C=S.body,k=getComputedStyle(C),E=S.compatMode===\"CSS1Compat\"&&parseFloat(k.marginLeft)+parseFloat(k.marginRight)||0,b=Math.abs(u.clientWidth-C.clientWidth-E),_=getComputedStyle(u).scrollbarGutter===\"stable both-edges\"?b/2:b;_<=HS&&(f-=_)}return{width:f,height:h,x:m,y:w}}function KS(n,r){const s=wr(n,!0,r===\"fixed\"),i=s.top+n.clientTop,a=s.left+n.clientLeft,u=io(n),d=n.clientWidth*u.x,f=n.clientHeight*u.y,h=a*u.x,m=i*u.y;return{width:d,height:f,x:h,y:m}}function vh(n,r,s){let i;if(r===\"viewport\"||r===\"layoutViewport\")i=WS(n,s,r);else if(r===\"document\")i=US(Pn(n));else if(ln(r))i=KS(r,s);else{const a=ug(n);i={x:r.x-a.x,y:r.y-a.y,width:r.width,height:r.height}}return Wi(i)}function GS(n,r){const s=r.get(n);if(s)return s;let i=ls(n,[],!1).filter(f=>ln(f)&&co(f)!==\"body\"),a=null;const u=an(n).position===\"fixed\";let d=u?xr(n):n;for(;ln(d)&&!is(d);){const f=an(d),h=hc(d),m=a?a.position:u?\"fixed\":\"\";!h&&(m===\"fixed\"||m===\"absolute\"&&f.position===\"static\")?i=i.filter(v=>v!==d):a=f,d=xr(d)}return r.set(n,i),i}function QS(n){let{element:r,boundary:s,rootBoundary:i,strategy:a}=n;const d=[...s===\"clippingAncestors\"?rl(r)?[]:GS(r,this._c):[].concat(s),i],f=vh(r,d[0],a);let h=f.top,m=f.right,w=f.bottom,v=f.left;for(let S=1;S<d.length;S++){const C=vh(r,d[S],a);h=wn(C.top,h),m=Yn(C.right,m),w=Yn(C.bottom,w),v=wn(C.left,v)}return{width:m-v,height:w-h,x:v,y:h}}function YS(n){const{width:r,height:s}=ag(n);return{width:r,height:s}}function XS(n,r,s){const i=qn(r),a=Pn(r),u=s===\"fixed\",d=wr(n,!0,u,r);let f={scrollLeft:0,scrollTop:0};const h=Sn(0);if((i||!u)&&((co(r)!==\"body\"||nl(a))&&(f=ol(r)),i)){const S=wr(r,!0,u,r);h.x=S.x+r.clientLeft,h.y=S.y+r.clientTop}!i&&a&&(h.x=sl(a));const m=a&&!i&&!u?cg(a,f):Sn(0),w=d.left+f.scrollLeft-h.x-m.x,v=d.top+f.scrollTop-h.y-m.y;return{x:w,y:v,width:d.width,height:d.height}}function Cu(n){return an(n).position===\"static\"}function yh(n,r){if(!qn(n)||an(n).position===\"fixed\")return null;if(r)return r(n);let s=n.offsetParent;return Pn(n)===s&&(s=s.ownerDocument.body),s}function dg(n,r){const s=bt(n);if(rl(n))return s;if(!qn(n)){let a=xr(n);for(;a&&!is(a);){if(ln(a)&&!Cu(a))return a;a=xr(a)}return s}let i=yh(n,r);for(;i&&AS(i)&&Cu(i);)i=yh(i,r);return i&&is(i)&&Cu(i)&&!hc(i)?s:i||zS(n)||s}const ZS=async function(n){const r=this.getOffsetParent||dg,s=this.getDimensions,i=await s(n.floating);return{reference:XS(n.reference,await r(n.floating),n.strategy),floating:{x:0,y:0,width:i.width,height:i.height}}};function qS(n){return an(n).direction===\"rtl\"}const JS={convertOffsetParentRelativeRectToViewportRelativeRect:VS,getDocumentElement:Pn,getClippingRect:QS,getOffsetParent:dg,getElementRects:ZS,getClientRects:BS,getDimensions:YS,getScale:io,isElement:ln,isRTL:qS};function fg(n,r){return n.x===r.x&&n.y===r.y&&n.width===r.width&&n.height===r.height}function eC(n,r,s){let i=null,a;const u=Pn(n);function d(){var w;clearTimeout(a),(w=i)==null||w.disconnect(),i=null}function f(w,v){w===void 0&&(w=!1),v===void 0&&(v=1),d();const S=n.getBoundingClientRect(),{left:C,top:k,width:E,height:b}=S;if(w||r(),!E||!b)return;const _=Ti(k),L=Ti(u.clientWidth-(C+E)),T=Ti(u.clientHeight-(k+b)),O=Ti(C),V={rootMargin:-_+\"px \"+-L+\"px \"+-T+\"px \"+-O+\"px\",threshold:wn(0,Yn(1,v))||1};let H=!0;function $(W){const X=W[0].intersectionRatio;if(!fg(S,n.getBoundingClientRect()))return f();if(X!==v){if(!H)return f();X?f(!1,X):a=setTimeout(()=>{f(!1,1e-7)},1e3)}H=!1}try{i=new IntersectionObserver($,{...V,root:u.ownerDocument})}catch{i=new IntersectionObserver($,V)}i.observe(n)}const h=bt(n),m=()=>f(s);return h.addEventListener(\"resize\",m),f(!0),()=>{h.removeEventListener(\"resize\",m),d()}}function tC(n,r,s,i){i===void 0&&(i={});const{ancestorScroll:a=!0,ancestorResize:u=!0,elementResize:d=typeof ResizeObserver==\"function\",layoutShift:f=typeof IntersectionObserver==\"function\",animationFrame:h=!1}=i,m=gc(n),w=a||u?[...m?ls(m):[],...r?ls(r):[]]:[];w.forEach(_=>{a&&_.addEventListener(\"scroll\",s),u&&_.addEventListener(\"resize\",s)});const v=m&&f?eC(m,s,u):null;let S=-1,C=null;d&&(C=new ResizeObserver(_=>{let[L]=_;L&&L.target===m&&C&&r&&(C.unobserve(r),cancelAnimationFrame(S),S=requestAnimationFrame(()=>{var T;(T=C)==null||T.observe(r)})),s()}),m&&!h&&C.observe(m),r&&C.observe(r));let k,E=h?wr(n):null;h&&b();function b(){const _=wr(n);E&&!fg(E,_)&&s(),E=_,k=requestAnimationFrame(b)}return s(),()=>{var _;w.forEach(L=>{a&&L.removeEventListener(\"scroll\",s),u&&L.removeEventListener(\"resize\",s)}),v?.(),(_=C)==null||_.disconnect(),C=null,h&&cancelAnimationFrame(k)}}const nC=_S,rC=TS,oC=RS,sC=IS,iC=OS,xh=NS,lC=LS,aC=(n,r,s)=>{const i=new Map,a=s??{},u={...JS,...a.platform,_c:i};return PS(n,r,{...a,platform:u})};var uC=typeof document<\"u\",cC=function(){},Mi=uC?x.useLayoutEffect:cC;function Ki(n,r){if(n===r)return!0;if(typeof n!=typeof r)return!1;if(typeof n==\"function\"&&n.toString()===r.toString())return!0;let s,i,a;if(n&&r&&typeof n==\"object\"){if(Array.isArray(n)){if(s=n.length,s!==r.length)return!1;for(i=s;i--!==0;)if(!Ki(n[i],r[i]))return!1;return!0}if(a=Object.keys(n),s=a.length,s!==Object.keys(r).length)return!1;for(i=s;i--!==0;)if(!{}.hasOwnProperty.call(r,a[i]))return!1;for(i=s;i--!==0;){const u=a[i];if(!(u===\"_owner\"&&n.$$typeof)&&!Ki(n[u],r[u]))return!1}return!0}return n!==n&&r!==r}function pg(n){return typeof window>\"u\"?1:(n.ownerDocument.defaultView||window).devicePixelRatio||1}function wh(n,r){const s=pg(n);return Math.round(r*s)/s}function ku(n){const r=x.useRef(n);return Mi(()=>{r.current=n}),r}function dC(n){n===void 0&&(n={});const{placement:r=\"bottom\",strategy:s=\"absolute\",middleware:i=[],platform:a,elements:{reference:u,floating:d}={},transform:f=!0,whileElementsMounted:h,open:m}=n,[w,v]=x.useState({x:0,y:0,strategy:s,placement:r,middlewareData:{},isPositioned:!1}),[S,C]=x.useState(i);Ki(S,i)||C(i);const[k,E]=x.useState(null),[b,_]=x.useState(null),L=x.useCallback(I=>{I!==V.current&&(V.current=I,E(I))},[]),T=x.useCallback(I=>{I!==H.current&&(H.current=I,_(I))},[]),O=u||k,B=d||b,V=x.useRef(null),H=x.useRef(null),$=x.useRef(w),W=h!=null,X=ku(h),Q=ku(a),q=ku(m),Z=x.useCallback(()=>{if(!V.current||!H.current)return;const I={placement:r,strategy:s,middleware:S};Q.current&&(I.platform=Q.current),aC(V.current,H.current,I).then(U=>{const M={...U,isPositioned:q.current!==!1};ne.current&&!Ki($.current,M)&&($.current=M,cs.flushSync(()=>{v(M)}))})},[S,r,s,Q,q]);Mi(()=>{m===!1&&$.current.isPositioned&&($.current.isPositioned=!1,v(I=>({...I,isPositioned:!1})))},[m]);const ne=x.useRef(!1);Mi(()=>(ne.current=!0,()=>{ne.current=!1}),[]),Mi(()=>{if(O&&(V.current=O),B&&(H.current=B),O&&B){if(X.current)return X.current(O,B,Z);Z()}},[O,B,Z,X,W]);const fe=x.useMemo(()=>({reference:V,floating:H,setReference:L,setFloating:T}),[L,T]),J=x.useMemo(()=>({reference:O,floating:B}),[O,B]),ee=x.useMemo(()=>{const I={position:s,left:0,top:0};if(!J.floating)return I;const U=wh(J.floating,w.x),M=wh(J.floating,w.y);return f?{...I,transform:\"translate(\"+U+\"px, \"+M+\"px)\",...pg(J.floating)>=1.5&&{willChange:\"transform\"}}:{position:s,left:U,top:M}},[s,f,J.floating,w.x,w.y]);return x.useMemo(()=>({...w,update:Z,refs:fe,elements:J,floatingStyles:ee}),[w,Z,fe,J,ee])}const fC=n=>{function r(s){return{}.hasOwnProperty.call(s,\"current\")}return{name:\"arrow\",options:n,fn(s){const{element:i,padding:a}=typeof n==\"function\"?n(s):n;return i&&r(i)?i.current!=null?xh({element:i.current,padding:a}).fn(s):{}:i?xh({element:i,padding:a}).fn(s):{}}}},pC=(n,r)=>{const s=nC(n);return{name:s.name,fn:s.fn,options:[n,r]}},hC=(n,r)=>{const s=rC(n);return{name:s.name,fn:s.fn,options:[n,r]}},mC=(n,r)=>({fn:lC(n).fn,options:[n,r]}),gC=(n,r)=>{const s=oC(n);return{name:s.name,fn:s.fn,options:[n,r]}},vC=(n,r)=>{const s=sC(n);return{name:s.name,fn:s.fn,options:[n,r]}},yC=(n,r)=>{const s=iC(n);return{name:s.name,fn:s.fn,options:[n,r]}},xC=(n,r)=>{const s=fC(n);return{name:s.name,fn:s.fn,options:[n,r]}};var wC=Object.defineProperty,SC=(n,r)=>wC(n,\"name\",{value:r,configurable:!0});function hg(n){const[r,s]=x.useState(void 0);return Ge(()=>{if(n){s({width:n.offsetWidth,height:n.offsetHeight});const i=new ResizeObserver(a=>{if(!Array.isArray(a)||!a.length)return;const u=a[0];let d,f;if(\"borderBoxSize\"in u){const h=u.borderBoxSize,m=Array.isArray(h)?h[0]:h;d=m.inlineSize,f=m.blockSize}else d=n.offsetWidth,f=n.offsetHeight;s({width:d,height:f})});return i.observe(n,{box:\"border-box\"}),()=>i.unobserve(n)}else s(void 0)},[n]),r}SC(hg,\"useSize\");var CC=Object.defineProperty,Qn=(n,r)=>CC(n,\"name\",{value:r,configurable:!0}),mg=\"Popper\",[gg,il]=kr(mg),[kC,vg]=gg(mg),bC=Qn(n=>{const{__scopePopper:r,children:s}=n,[i,a]=x.useState(null),[u,d]=x.useState(void 0);return g.jsx(kC,{scope:r,anchor:i,onAnchorChange:a,placementState:u,setPlacementState:d,children:s})},\"Popper\"),EC=\"PopperAnchor\",PC=x.forwardRef(Qn(function(r,s){const{__scopePopper:i,virtualRef:a,...u}=r,d=vg(EC,i),f=x.useRef(null),h=d.onAnchorChange,m=x.useCallback(E=>{f.current=E,E&&h(E)},[h]),w=De(s,m),v=x.useRef(null);x.useEffect(()=>{if(!a)return;const E=v.current;v.current=a.current,E!==v.current&&h(v.current)});const S=d.placementState&&ll(d.placementState),C=S?.[0],k=S?.[1];return a?null:g.jsx(Ue.div,{\"data-radix-popper-side\":C,\"data-radix-popper-align\":k,...u,ref:w})},\"PopperAnchor\")),yg=\"PopperContent\",[NC,ub]=gg(yg),RC=x.forwardRef(Qn(function(r,s){const{__scopePopper:i,side:a=\"bottom\",sideOffset:u=0,align:d=\"center\",alignOffset:f=0,arrowPadding:h=0,avoidCollisions:m=!0,collisionBoundary:w=[],collisionPadding:v=0,sticky:S=\"partial\",hideWhenDetached:C=!1,updatePositionStrategy:k=\"optimized\",onPlaced:E,...b}=r,_=vg(yg,i),[L,T]=x.useState(null),O=De(s,T),[B,V]=x.useState(null),H=hg(B),$=H?.width??0,W=H?.height??0,X=a+(d!==\"center\"?\"-\"+d:\"\"),Q=typeof v==\"number\"?v:{top:0,right:0,bottom:0,left:0,...v},q=Array.isArray(w)?w:[w],Z=q.length>0,ne={padding:Q,boundary:q.filter(xg),altBoundary:Z},{refs:fe,floatingStyles:J,placement:ee,isPositioned:I,middlewareData:U}=dC({strategy:\"fixed\",placement:X,whileElementsMounted:Qn((...le)=>tC(...le,{animationFrame:k===\"always\"}),\"whileElementsMounted\"),elements:{reference:_.anchor},middleware:[pC({mainAxis:u+W,alignmentAxis:f}),m&&hC({mainAxis:!0,crossAxis:!1,limiter:S===\"partial\"?mC():void 0,...ne}),m&&gC({...ne}),vC({...ne,apply:Qn(({elements:le,rects:Pe,availableWidth:be,availableHeight:Re})=>{const{width:_e,height:Je}=Pe.reference,pt=le.floating.style;pt.setProperty(\"--radix-popper-available-width\",`${be}px`),pt.setProperty(\"--radix-popper-available-height\",`${Re}px`),pt.setProperty(\"--radix-popper-anchor-width\",`${_e}px`),pt.setProperty(\"--radix-popper-anchor-height\",`${Je}px`)},\"apply\")}),B&&xC({element:B,padding:h}),OC({arrowWidth:$,arrowHeight:W}),C&&yC({strategy:\"referenceHidden\",...ne,boundary:Z?ne.boundary:void 0})]}),M=_.setPlacementState;Ge(()=>(M(ee),()=>{M(void 0)}),[ee,M]);const[N,D]=ll(ee),oe=sn(E);Ge(()=>{I&&oe?.()},[I,oe]);const pe=U.arrow?.x,se=U.arrow?.y,ge=U.arrow?.centerOffset!==0,[Se,re]=x.useState();return Ge(()=>{L&&re(window.getComputedStyle(L).zIndex)},[L]),g.jsx(\"div\",{ref:fe.setFloating,\"data-radix-popper-content-wrapper\":\"\",style:{...J,transform:I?J.transform:\"translate(0, -200%)\",minWidth:\"max-content\",zIndex:Se,\"--radix-popper-transform-origin\":[U.transformOrigin?.x,U.transformOrigin?.y].join(\" \"),...U.hide?.referenceHidden&&{visibility:\"hidden\",pointerEvents:\"none\"}},dir:r.dir,children:g.jsx(NC,{scope:i,placedSide:N,placedAlign:D,onArrowChange:V,arrowX:pe,arrowY:se,shouldHideArrow:ge,children:g.jsx(Ue.div,{\"data-side\":N,\"data-align\":D,...b,ref:O,style:{...b.style,animation:I?b.style?.animation:\"none\"}})})})},\"PopperContent\"));function xg(n){return n!==null}Qn(xg,\"isNotNull\");var OC=Qn(n=>({name:\"transformOrigin\",options:n,fn(r){const{placement:s,rects:i,middlewareData:a}=r,d=a.arrow?.centerOffset!==0,f=d?0:n.arrowWidth,h=d?0:n.arrowHeight,[m,w]=ll(s),v={start:\"0%\",center:\"50%\",end:\"100%\"}[w],S=(a.arrow?.x??0)+f/2,C=(a.arrow?.y??0)+h/2;let k=\"\",E=\"\";return m===\"bottom\"?(k=d?v:`${S}px`,E=`${-h}px`):m===\"top\"?(k=d?v:`${S}px`,E=`${i.floating.height+h}px`):m===\"right\"?(k=`${-h}px`,E=d?v:`${C}px`):m===\"left\"&&(k=`${i.floating.width+h}px`,E=d?v:`${C}px`),{data:{x:k,y:E}}}}),\"transformOrigin\");function ll(n){const[r,s=\"center\"]=n.split(\"-\");return[r,s]}Qn(ll,\"getSideAndAlignFromPlacement\");var wg=bC,Sg=PC,Cg=RC,jC=Object.defineProperty,_C=(n,r)=>jC(n,\"name\",{value:r,configurable:!0}),kg=Object.freeze({position:\"absolute\",border:0,width:1,height:1,padding:0,margin:-1,overflow:\"hidden\",clip:\"rect(0, 0, 0, 0)\",whiteSpace:\"nowrap\",wordWrap:\"normal\"}),TC=x.forwardRef(_C(function(r,s){return g.jsx(Ue.span,{...r,ref:s,style:{...kg,...r.style}})},\"VisuallyHidden\")),LC=TC,IC=Object.defineProperty,lt=(n,r)=>IC(n,\"name\",{value:r,configurable:!0}),[vc,cb]=kr(\"Tooltip\",[il]),yc=il(),AC=\"TooltipProvider\",DC=700,Wu=\"tooltip.open\",[MC,xc]=vc(AC),zC=lt(n=>{const{__scopeTooltip:r,delayDuration:s=DC,skipDelayDuration:i=300,disableHoverableContent:a=!1,children:u}=n,d=x.useRef(!0),f=x.useRef(!1),h=x.useRef(0);return x.useEffect(()=>{const m=h.current;return()=>window.clearTimeout(m)},[]),g.jsx(MC,{scope:r,isOpenDelayedRef:d,delayDuration:s,onOpen:x.useCallback(()=>{i<=0||(window.clearTimeout(h.current),d.current=!1)},[i]),onClose:x.useCallback(()=>{i<=0||(window.clearTimeout(h.current),h.current=window.setTimeout(()=>d.current=!0,i))},[i]),isPointerInTransitRef:f,onPointerInTransitChange:x.useCallback(m=>{f.current=m},[]),disableHoverableContent:a,children:u})},\"TooltipProvider\"),Ku=\"Tooltip\",[FC,al]=vc(Ku),$C=lt(n=>{const{__scopeTooltip:r,children:s,open:i,defaultOpen:a,onOpenChange:u,disableHoverableContent:d,delayDuration:f}=n,h=xc(Ku,n.__scopeTooltip),m=yc(r),[w,v]=x.useState(null),[S,C]=x.useState(void 0),k=vr(),E=x.useRef(0),b=d??h.disableHoverableContent,_=f??h.delayDuration,L=x.useRef(!1),[T,O]=os({prop:i,defaultProp:a??!1,onChange:lt(X=>{X?(h.onOpen(),document.dispatchEvent(new CustomEvent(Wu))):h.onClose(),u?.(X)},\"onChange\"),caller:Ku}),B=x.useMemo(()=>T?L.current?\"delayed-open\":\"instant-open\":\"closed\",[T]),V=x.useCallback(()=>{window.clearTimeout(E.current),E.current=0,L.current=!1,O(!0)},[O]),H=x.useCallback(()=>{window.clearTimeout(E.current),E.current=0,O(!1)},[O]),$=x.useCallback(()=>{window.clearTimeout(E.current),E.current=window.setTimeout(()=>{L.current=!0,O(!0),E.current=0},_)},[_,O]);x.useEffect(()=>()=>{E.current&&(window.clearTimeout(E.current),E.current=0)},[]);const W=S??k;return g.jsx(wg,{...m,children:g.jsx(FC,{scope:r,contentId:W,setContentId:C,open:T,stateAttribute:B,trigger:w,onTriggerChange:v,onTriggerEnter:x.useCallback(()=>{h.isOpenDelayedRef.current?$():V()},[h.isOpenDelayedRef,$,V]),onTriggerLeave:x.useCallback(()=>{b?H():(window.clearTimeout(E.current),E.current=0)},[H,b]),onOpen:V,onClose:H,disableHoverableContent:b,children:s})})},\"Tooltip\"),Sh=\"TooltipTrigger\",VC=x.forwardRef(lt(function(r,s){const{__scopeTooltip:i,...a}=r,u=al(Sh,i),d=xc(Sh,i),f=yc(i),h=x.useRef(null),m=De(s,h,u.onTriggerChange),w=x.useRef(!1),v=x.useRef(!1),S=x.useCallback(()=>w.current=!1,[]);return x.useEffect(()=>()=>document.removeEventListener(\"pointerup\",S),[S]),g.jsx(Sg,{asChild:!0,...f,children:g.jsx(Ue.button,{\"aria-describedby\":u.open?u.contentId:void 0,\"data-state\":u.stateAttribute,...a,ref:m,onPointerMove:je(r.onPointerMove,C=>{C.pointerType!==\"touch\"&&!v.current&&!d.isPointerInTransitRef.current&&(u.onTriggerEnter(),v.current=!0)}),onPointerLeave:je(r.onPointerLeave,()=>{u.onTriggerLeave(),v.current=!1}),onPointerDown:je(r.onPointerDown,()=>{u.open&&u.onClose(),w.current=!0,document.addEventListener(\"pointerup\",S,{once:!0})}),onFocus:je(r.onFocus,()=>{w.current||u.onOpen()}),onBlur:je(r.onBlur,u.onClose),onClick:je(r.onClick,u.onClose)})})},\"TooltipTrigger\")),BC=\"TooltipPortal\",[db,UC]=vc(BC,{forceMount:void 0}),as=\"TooltipContent\",HC=x.forwardRef(lt(function(r,s){const i=UC(as,r.__scopeTooltip),{forceMount:a=i.forceMount,side:u=\"top\",...d}=r,f=al(as,r.__scopeTooltip);return g.jsx(fs,{present:a||f.open,children:f.disableHoverableContent?g.jsx(bg,{side:u,...d,ref:s}):g.jsx(WC,{side:u,...d,ref:s})})},\"TooltipContent\")),WC=x.forwardRef(lt(function(r,s){const i=al(as,r.__scopeTooltip),a=xc(as,r.__scopeTooltip),u=x.useRef(null),d=De(s,u),[f,h]=x.useState(null),{trigger:m,onClose:w}=i,v=u.current,{onPointerInTransitChange:S}=a,C=x.useCallback(()=>{h(null),S(!1)},[S]),k=x.useCallback((E,b)=>{const _=E.currentTarget,L={x:E.clientX,y:E.clientY},T=Eg(L,_.getBoundingClientRect()),O=Pg(L,T),B=Ng(b.getBoundingClientRect()),V=Og([...O,...B]);h(V),S(!0)},[S]);return x.useEffect(()=>()=>C(),[C]),x.useEffect(()=>{if(m&&v){const E=lt(_=>k(_,v),\"handleTriggerLeave\"),b=lt(_=>k(_,m),\"handleContentLeave\");return m.addEventListener(\"pointerleave\",E),v.addEventListener(\"pointerleave\",b),()=>{m.removeEventListener(\"pointerleave\",E),v.removeEventListener(\"pointerleave\",b)}}},[m,v,k,C]),x.useEffect(()=>{if(f){const E=lt(b=>{const _=b.target,L={x:b.clientX,y:b.clientY},T=m?.contains(_)||v?.contains(_),O=!Rg(L,f);T?C():O&&(C(),w())},\"handleTrackPointerGrace\");return document.addEventListener(\"pointermove\",E),()=>document.removeEventListener(\"pointermove\",E)}},[m,v,f,w,C]),g.jsx(bg,{...r,ref:d})},\"TooltipContentHoverable\")),KC=Kh(\"TooltipContent\"),bg=x.forwardRef(lt(function(r,s){const{__scopeTooltip:i,children:a,\"aria-label\":u,id:d,onEscapeKeyDown:f,onPointerDownOutside:h,...m}=r,w=al(as,i),v=yc(i),{onClose:S}=w;x.useEffect(()=>(document.addEventListener(Wu,S),()=>document.removeEventListener(Wu,S)),[S]),x.useEffect(()=>{if(w.trigger){const k=lt(E=>{E.target instanceof Node&&E.target.contains(w.trigger)&&S()},\"handleScroll\");return window.addEventListener(\"scroll\",k,{capture:!0}),()=>window.removeEventListener(\"scroll\",k,{capture:!0})}},[w.trigger,S]);const{setContentId:C}=w;return Ge(()=>(C(d),()=>{C(void 0)}),[d,C]),g.jsx(tc,{asChild:!0,disableOutsidePointerEvents:!1,onEscapeKeyDown:f,onPointerDownOutside:h,onFocusOutside:k=>k.preventDefault(),onDismiss:S,children:g.jsxs(Cg,{\"data-state\":w.stateAttribute,role:u?void 0:\"tooltip\",id:u?void 0:w.contentId,...v,...m,ref:s,style:{...m.style,\"--radix-tooltip-content-transform-origin\":\"var(--radix-popper-transform-origin)\",\"--radix-tooltip-content-available-width\":\"var(--radix-popper-available-width)\",\"--radix-tooltip-content-available-height\":\"var(--radix-popper-available-height)\",\"--radix-tooltip-trigger-width\":\"var(--radix-popper-anchor-width)\",\"--radix-tooltip-trigger-height\":\"var(--radix-popper-anchor-height)\"},children:[g.jsx(KC,{children:a}),u?g.jsx(LC,{id:w.contentId,role:\"tooltip\",children:u}):null]})})},\"TooltipContentImpl\"));function Eg(n,r){const s=Math.abs(r.top-n.y),i=Math.abs(r.bottom-n.y),a=Math.abs(r.right-n.x),u=Math.abs(r.left-n.x);switch(Math.min(s,i,a,u)){case u:return\"left\";case a:return\"right\";case s:return\"top\";case i:return\"bottom\";default:throw new Error(\"unreachable\")}}lt(Eg,\"getExitSideFromRect\");function Pg(n,r,s=5){const i=[];switch(r){case\"top\":i.push({x:n.x-s,y:n.y+s},{x:n.x+s,y:n.y+s});break;case\"bottom\":i.push({x:n.x-s,y:n.y-s},{x:n.x+s,y:n.y-s});break;case\"left\":i.push({x:n.x+s,y:n.y-s},{x:n.x+s,y:n.y+s});break;case\"right\":i.push({x:n.x-s,y:n.y-s},{x:n.x-s,y:n.y+s});break}return i}lt(Pg,\"getPaddedExitPoints\");function Ng(n){const{top:r,right:s,bottom:i,left:a}=n;return[{x:a,y:r},{x:s,y:r},{x:s,y:i},{x:a,y:i}]}lt(Ng,\"getPointsFromRect\");function Rg(n,r){const{x:s,y:i}=n;let a=!1;for(let u=0,d=r.length-1;u<r.length;d=u++){const f=r[u],h=r[d],m=f.x,w=f.y,v=h.x,S=h.y;w>i!=S>i&&s<(v-m)*(i-w)/(S-w)+m&&(a=!a)}return a}lt(Rg,\"isPointInPolygon\");function Og(n){const r=n.slice();return r.sort((s,i)=>s.x<i.x?-1:s.x>i.x?1:s.y<i.y?-1:s.y>i.y?1:0),jg(r)}lt(Og,\"getHull\");function jg(n){if(n.length<=1)return n.slice();const r=[];for(let i=0;i<n.length;i++){const a=n[i];for(;r.length>=2;){const u=r[r.length-1],d=r[r.length-2];if((u.x-d.x)*(a.y-d.y)>=(u.y-d.y)*(a.x-d.x))r.pop();else break}r.push(a)}r.pop();const s=[];for(let i=n.length-1;i>=0;i--){const a=n[i];for(;s.length>=2;){const u=s[s.length-1],d=s[s.length-2];if((u.x-d.x)*(a.y-d.y)>=(u.y-d.y)*(a.x-d.x))s.pop();else break}s.push(a)}return s.pop(),r.length===1&&s.length===1&&r[0].x===s[0].x&&r[0].y===s[0].y?r:r.concat(s)}lt(jg,\"getHullPresorted\");var GC=zC,QC=$C,YC=VC,_g=HC;const XC=GC,ZC=QC,qC=YC,Tg=x.forwardRef(({className:n,sideOffset:r=4,...s},i)=>g.jsx(_g,{ref:i,sideOffset:r,className:Ve(\"z-[100] overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2\",n),...s}));Tg.displayName=_g.displayName;const JC={info:\"bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300\",muted:\"bg-slate-200 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200\",success:\"bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300\",warning:\"bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300\"};function xn({label:n,tone:r=\"muted\",title:s,className:i}){const a=g.jsx(\"span\",{className:Ve(\"inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold\",JC[r],s&&\"cursor-help outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1\",i),tabIndex:s?0:void 0,children:n});return s?g.jsx(XC,{delayDuration:250,children:g.jsxs(ZC,{children:[g.jsx(qC,{asChild:!0,children:a}),g.jsx(Tg,{className:\"max-w-xs leading-relaxed\",children:s})]})}):a}function ek({active:n,official:r,busy:s,switching:i,onUse:a,onEdit:u,onTest:d,onDelete:f}){const h=\"h-8 w-8 p-1\";return g.jsxs(\"div\",{className:\"provider-actions flex items-center gap-1.5\",children:[g.jsxs($e,{size:\"sm\",variant:n?\"secondary\":\"default\",disabled:s||n,onClick:a,className:\"w-fit px-2.5\",children:[n?g.jsx(Fh,{className:\"h-4 w-4\"}):g.jsx($h,{className:\"h-4 w-4\"}),i?\"切换中\":n?\"使用中\":\"使用\"]}),!r&&g.jsxs(\"div\",{className:\"flex items-center gap-1\",children:[g.jsx($e,{size:\"icon\",variant:\"ghost\",disabled:s,onClick:u,\"aria-label\":\"编辑\",title:\"编辑\",className:h,children:g.jsx(T0,{className:\"h-4 w-4\"})}),g.jsx($e,{size:\"icon\",variant:\"ghost\",disabled:s,onClick:d,\"aria-label\":\"测试\",title:\"发一条测试请求\",className:h,children:g.jsx(t0,{className:\"h-4 w-4\"})}),g.jsx($e,{size:\"icon\",variant:\"ghost\",disabled:s||n,onClick:f,\"aria-label\":\"删除\",title:n?\"使用中的来源不能删除\":\"删除\",className:h+\" hover:text-red-500\",children:g.jsx(Uh,{className:\"h-4 w-4\"})})]})]})}const tk={\"openai-chat\":\"Chat\",\"openai-responses\":\"Responses\",\"anthropic-messages\":\"Anthropic\"};function Ch({name:n,provider:r,active:s,busy:i,switching:a,onUse:u,onEdit:d,onTest:f,onDelete:h}){const m=r==null,w=r?.authType===\"codex\",v=r?r.valid?\"POST \"+r.summary.split(\" \")[1]:r.summary:\"Grok Bot 原生推理，走你的 Grok 额度\";return g.jsx(\"article\",{\"aria-label\":n,className:Ve(\"provider-card relative overflow-hidden rounded-xl border border-border p-4 bg-card text-card-foreground group shadow-sm\",s&&\"border-blue-500/60 shadow-blue-500/10\"),children:g.jsxs(\"div\",{className:\"relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between\",children:[g.jsxs(\"div\",{className:\"flex min-w-0 flex-1 items-start gap-3\",children:[g.jsx(\"div\",{className:\"h-9 w-9 flex-shrink-0 rounded-lg bg-muted flex items-center justify-center border border-border\",children:m?g.jsx(s0,{size:20}):w?g.jsx(Bh,{size:20}):g.jsx(v0,{size:20})}),g.jsxs(\"div\",{className:\"min-w-0 flex-1 space-y-2\",children:[g.jsxs(\"div\",{className:\"flex flex-wrap items-center gap-2 min-h-7\",children:[g.jsx(\"h3\",{className:\"text-base font-semibold leading-snug break-words\",children:m?\"官方 Grok\":n}),g.jsx(xn,{label:m?\"原厂通道\":tk[r.protocol]??r.protocol,tone:m?\"muted\":\"info\"}),s&&g.jsx(xn,{label:\"使用中\",tone:\"success\"}),r&&!r.valid&&g.jsx(xn,{label:\"配置无效\",tone:\"warning\",title:r.summary})]}),g.jsx(\"p\",{className:\"endpoint text-xs text-muted-foreground font-mono break-all\",children:v}),r&&g.jsxs(\"div\",{className:\"flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground\",children:[g.jsx(\"span\",{children:r.model}),g.jsx(\"span\",{children:w?\"ChatGPT 登录\":r.authType===\"none\"?\"无需密钥\":r.hasKey?\"已保存密钥\":\"未填密钥\"}),r.parameters?.reasoningEffort&&g.jsxs(\"span\",{children:[\"reasoning \",r.parameters.reasoningEffort]})]})]})]}),g.jsx(ek,{active:s,official:m,busy:i,switching:a,onUse:u,onEdit:d,onTest:f,onDelete:h})]})})}function nk({title:n,onClose:r,children:s,footer:i,pending:a=!1}){return g.jsx(ac,{open:!0,onOpenChange:u=>{!u&&!a&&r()},children:g.jsxs(qi,{variant:\"fullscreen\",\"aria-describedby\":\"panel-description\",onEscapeKeyDown:u=>{a&&u.preventDefault()},children:[g.jsx(\"div\",{className:\"flex-shrink-0 flex items-center h-16 border-b border-border bg-background\",children:g.jsxs(\"div\",{className:\"px-6 w-full flex items-center gap-4\",children:[g.jsx($e,{variant:\"outline\",size:\"icon\",\"aria-label\":\"返回供应商\",disabled:a,onClick:r,children:g.jsx(r0,{className:\"h-4 w-4\"})}),g.jsx(Ji,{children:n}),g.jsx(el,{id:\"panel-description\",className:\"sr-only\",children:\"供应商配置，密钥单独保存。\"})]})}),g.jsx(\"div\",{className:\"flex-1 overflow-y-auto overscroll-contain\",children:g.jsx(\"div\",{className:\"px-6 py-6 space-y-6 w-full max-w-4xl mx-auto\",children:s})}),i&&g.jsx(\"div\",{className:\"flex-shrink-0 py-4 border-t border-border bg-background\",children:g.jsx(\"div\",{className:\"px-6 flex items-center justify-end gap-3 max-w-4xl mx-auto\",children:i})})]})})}const ns=x.forwardRef(({value:n,onValueChange:r,normalize:s,onBlur:i,onCompositionStart:a,onCompositionEnd:u,...d},f)=>{const h=x.useRef(!1),m=x.useRef(n),[w,v]=x.useState(n);x.useEffect(()=>{m.current=n,h.current||v(n)},[n]);const S=x.useCallback(C=>{const k=s?s(C):C;v(k),k!==m.current&&(m.current=k,r(k))},[s,r]);return g.jsx(Gn,{...d,ref:f,value:w,onChange:C=>{const k=C.currentTarget.value;if(h.current){v(k);return}S(k)},onBlur:C=>{h.current?(h.current=!1,S(C.currentTarget.value)):(m.current=n,v(n)),i?.(C)},onCompositionStart:C=>{h.current=!0,v(C.currentTarget.value),a?.(C)},onCompositionEnd:C=>{const k=C.currentTarget.value;h.current=!1,S(k),u?.(C)}})});ns.displayName=\"ImeSafeInput\";var rk=Object.defineProperty,ok=(n,r)=>rk(n,\"name\",{value:r,configurable:!0});function Gu(n,[r,s]){return Math.min(s,Math.max(r,n))}ok(Gu,\"clamp\");var sk=Object.defineProperty,ot=(n,r)=>sk(n,\"name\",{value:r,configurable:!0});function Lg(n){const r=n+\"CollectionProvider\",[s,i]=kr(r),[a,u]=s(r,{collectionRef:{current:null},itemMap:new Map}),d=ot(E=>{const{scope:b,children:_}=E,L=x.useRef(null),T=x.useRef(new Map).current;return g.jsx(a,{scope:b,itemMap:T,collectionRef:L,children:_})},\"CollectionProvider\");d.displayName=r;const f=n+\"CollectionSlot\",h=Cn(f),m=x.forwardRef((E,b)=>{const{scope:_,children:L}=E,T=u(f,_),O=De(b,T.collectionRef);return g.jsx(h,{ref:O,children:L})});m.displayName=f;const w=n+\"CollectionItemSlot\",v=\"data-radix-collection-item\",S=Cn(w),C=x.forwardRef((E,b)=>{const{scope:_,children:L,...T}=E,O=x.useRef(null),B=De(b,O),V=u(w,_);return x.useEffect(()=>(V.itemMap.set(O,{ref:O,...T}),()=>{V.itemMap.delete(O)})),g.jsx(S,{[v]:\"\",ref:B,children:L})});C.displayName=w;function k(E){const b=u(n+\"CollectionConsumer\",E);return x.useCallback(()=>{const L=b.collectionRef.current;if(!L)return[];const T=Array.from(L.querySelectorAll(`[${v}]`));return Array.from(b.itemMap.values()).sort((V,H)=>T.indexOf(V.ref.current)-T.indexOf(H.ref.current))},[b.collectionRef,b.itemMap])}return ot(k,\"useCollection\"),[{Provider:d,Slot:m,ItemSlot:C},k,i]}ot(Lg,\"createCollection\");var kh=new WeakMap,Ye,jt,bu=(jt=class extends Map{constructor(s){super(s);yp(this,Ye);nu(this,Ye,[...super.keys()]),kh.set(this,!0)}set(s,i){return kh.get(this)&&(this.has(s)?ft(this,Ye)[ft(this,Ye).indexOf(s)]=s:ft(this,Ye).push(s)),super.set(s,i),this}insert(s,i,a){const u=this.has(i),d=ft(this,Ye).length,f=wc(s);let h=f>=0?f:d+f;const m=h<0||h>=d?-1:h;if(m===this.size||u&&m===this.size-1||m===-1)return this.set(i,a),this;const w=this.size+(u?0:1);f<0&&h++;const v=[...ft(this,Ye)];let S,C=!1;for(let k=h;k<w;k++)if(h===k){let E=v[k];v[k]===i&&(E=v[k+1]),u&&this.delete(i),S=this.get(E),this.set(i,a)}else{!C&&v[k-1]===i&&(C=!0);const E=v[C?k:k-1],b=S;S=this.get(E),this.delete(E),this.set(E,b)}return this}with(s,i,a){const u=new jt(this);return u.insert(s,i,a),u}before(s){const i=ft(this,Ye).indexOf(s)-1;if(!(i<0))return this.entryAt(i)}setBefore(s,i,a){const u=ft(this,Ye).indexOf(s);return u===-1?this:this.insert(u,i,a)}after(s){let i=ft(this,Ye).indexOf(s);if(i=i===-1||i===this.size-1?-1:i+1,i!==-1)return this.entryAt(i)}setAfter(s,i,a){const u=ft(this,Ye).indexOf(s);return u===-1?this:this.insert(u+1,i,a)}first(){return this.entryAt(0)}last(){return this.entryAt(-1)}clear(){return nu(this,Ye,[]),super.clear()}delete(s){const i=super.delete(s);return i&&ft(this,Ye).splice(ft(this,Ye).indexOf(s),1),i}deleteAt(s){const i=this.keyAt(s);return i!==void 0?this.delete(i):!1}at(s){const i=zi(ft(this,Ye),s);if(i!==void 0)return this.get(i)}entryAt(s){const i=zi(ft(this,Ye),s);if(i!==void 0)return[i,this.get(i)]}indexOf(s){return ft(this,Ye).indexOf(s)}keyAt(s){return zi(ft(this,Ye),s)}from(s,i){const a=this.indexOf(s);if(a===-1)return;let u=a+i;return u<0&&(u=0),u>=this.size&&(u=this.size-1),this.at(u)}keyFrom(s,i){const a=this.indexOf(s);if(a===-1)return;let u=a+i;return u<0&&(u=0),u>=this.size&&(u=this.size-1),this.keyAt(u)}find(s,i){let a=0;for(const u of this){if(Reflect.apply(s,i,[u,a,this]))return u;a++}}findIndex(s,i){let a=0;for(const u of this){if(Reflect.apply(s,i,[u,a,this]))return a;a++}return-1}filter(s,i){const a=[];let u=0;for(const d of this)Reflect.apply(s,i,[d,u,this])&&a.push(d),u++;return new jt(a)}map(s,i){const a=[];let u=0;for(const d of this)a.push([d[0],Reflect.apply(s,i,[d,u,this])]),u++;return new jt(a)}reduce(...s){const[i,a]=s;let u=0,d=a??this.at(0);for(const f of this)u===0&&s.length===1?d=f:d=Reflect.apply(i,this,[d,f,u,this]),u++;return d}reduceRight(...s){const[i,a]=s;let u=a??this.at(-1);for(let d=this.size-1;d>=0;d--){const f=this.at(d);d===this.size-1&&s.length===1?u=f:u=Reflect.apply(i,this,[u,f,d,this])}return u}toSorted(s){const i=[...this.entries()].sort(s);return new jt(i)}toReversed(){const s=new jt;for(let i=this.size-1;i>=0;i--){const a=this.keyAt(i),u=this.get(a);s.set(a,u)}return s}toSpliced(...s){const i=[...this.entries()];return i.splice(...s),new jt(i)}slice(s,i){const a=new jt;let u=this.size-1;if(s===void 0)return a;s<0&&(s=s+this.size),i!==void 0&&i>0&&(u=i-1);for(let d=s;d<=u;d++){const f=this.keyAt(d),h=this.get(f);a.set(f,h)}return a}every(s,i){let a=0;for(const u of this){if(!Reflect.apply(s,i,[u,a,this]))return!1;a++}return!0}some(s,i){let a=0;for(const u of this){if(Reflect.apply(s,i,[u,a,this]))return!0;a++}return!1}},Ye=new WeakMap,ot(jt,\"OrderedDict\"),jt);function zi(n,r){if(\"at\"in Array.prototype)return Array.prototype.at.call(n,r);const s=Ig(n,r);return s===-1?void 0:n[s]}ot(zi,\"at\");function Ig(n,r){const s=n.length,i=wc(r),a=i>=0?i:s+i;return a<0||a>=s?-1:a}ot(Ig,\"toSafeIndex\");function wc(n){return n!==n||n===0?0:Math.trunc(n)}ot(wc,\"toSafeInteger\");function ik(n){const r=n+\"CollectionProvider\",[s,i]=kr(r),[a,u]=s(r,{collectionElement:null,collectionRef:{current:null},collectionRefObject:{current:null},itemMap:new bu,setItemMap:ot(()=>{},\"setItemMap\")}),d=ot(({state:T,...O})=>T?g.jsx(h,{...O,state:T}):g.jsx(f,{...O}),\"CollectionProvider\");d.displayName=r;const f=ot(T=>{const O=b();return g.jsx(h,{...T,state:O})},\"CollectionInit\");f.displayName=r+\"Init\";const h=ot(T=>{const{scope:O,children:B,state:V}=T,H=x.useRef(null),[$,W]=x.useState(null),X=De(H,W),[Q,q]=V;return x.useEffect(()=>{if(!$)return;const Z=Mg(()=>{});return Z.observe($,{childList:!0,subtree:!0}),()=>{Z.disconnect()}},[$]),g.jsx(a,{scope:O,itemMap:Q,setItemMap:q,collectionRef:X,collectionRefObject:H,collectionElement:$,children:B})},\"CollectionProviderImpl\");h.displayName=r+\"Impl\";const m=n+\"CollectionSlot\",w=Cn(m),v=x.forwardRef((T,O)=>{const{scope:B,children:V}=T,H=u(m,B),$=De(O,H.collectionRef);return g.jsx(w,{ref:$,children:V})});v.displayName=m;const S=n+\"CollectionItemSlot\",C=\"data-radix-collection-item\",k=Cn(S),E=x.forwardRef((T,O)=>{const{scope:B,children:V,...H}=T,$=x.useRef(null),[W,X]=x.useState(null),Q=De(O,$,X),q=u(S,B),{setItemMap:Z}=q,ne=x.useRef(H);Ag(ne.current,H)||(ne.current=H);const fe=ne.current;return x.useEffect(()=>{const J=fe;return Z(ee=>W?ee.has(W)?ee.set(W,{...J,element:W}).toSorted(Qu):(ee.set(W,{...J,element:W}),ee.toSorted(Qu)):ee),()=>{Z(ee=>!W||!ee.has(W)?ee:(ee.delete(W),new bu(ee)))}},[W,fe,Z]),g.jsx(k,{[C]:\"\",ref:Q,children:V})});E.displayName=S;function b(){return x.useState(new bu)}ot(b,\"useInitCollection\");function _(T){const{itemMap:O}=u(n+\"CollectionConsumer\",T);return O}return ot(_,\"useCollection\"),[{Provider:d,Slot:v,ItemSlot:E},{createCollectionScope:i,useCollection:_,useInitCollection:b}]}ot(ik,\"createCollection\");function Ag(n,r){if(n===r)return!0;if(typeof n!=\"object\"||typeof r!=\"object\"||n==null||r==null)return!1;const s=Object.keys(n),i=Object.keys(r);if(s.length!==i.length)return!1;for(const a of s)if(!Object.prototype.hasOwnProperty.call(r,a)||n[a]!==r[a])return!1;return!0}ot(Ag,\"shallowEqual\");function Dg(n,r){return!!(r.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_PRECEDING)}ot(Dg,\"isElementPreceding\");function Qu(n,r){return!n[1].element||!r[1].element?0:Dg(n[1].element,r[1].element)?-1:1}ot(Qu,\"sortByDocumentPosition\");function Mg(n){return new MutationObserver(s=>{for(const i of s)if(i.type===\"childList\"){n();return}})}ot(Mg,\"getChildListObserver\");var lk=Object.defineProperty,ak=(n,r)=>lk(n,\"name\",{value:r,configurable:!0}),uk=x.createContext(void 0);function zg(n){const r=x.useContext(uk);return n||r||\"ltr\"}ak(zg,\"useDirection\");var ck=Object.defineProperty,dk=(n,r)=>ck(n,\"name\",{value:r,configurable:!0});function Fg(n){const r=x.useRef({value:n,previous:n});return x.useMemo(()=>(r.current.value!==n&&(r.current.previous=r.current.value,r.current.value=n),r.current.previous),[n])}dk(Fg,\"usePrevious\");var fk=Object.defineProperty,Ee=(n,r)=>fk(n,\"name\",{value:r,configurable:!0}),pk=[\" \",\"Enter\",\"ArrowUp\",\"ArrowDown\"],hk=[\" \",\"Enter\"],lo=\"Select\",[ul,cl,mk]=Lg(lo),[br,fb]=kr(lo,[mk,il]),Sc=il(),[gk,Jn]=br(lo),[vk,yk]=br(lo);function $g(n){const{__scopeSelect:r,children:s,open:i,defaultOpen:a,onOpenChange:u,value:d,defaultValue:f,onValueChange:h,dir:m,name:w,autoComplete:v,disabled:S,required:C,form:k,internal_do_not_use_render:E}=n,b=Sc(r),[_,L]=x.useState(null),[T,O]=x.useState(null),[B,V]=x.useState(!1),H=zg(m),[$,W]=os({prop:i,defaultProp:a??!1,onChange:u,caller:lo}),[X,Q]=os({prop:d,defaultProp:f,onChange:h,caller:lo}),q=x.useRef(null),Z=x.useRef(X);x.useEffect(()=>{const D=k?_?.ownerDocument.getElementById(k):_?.form;if(D instanceof HTMLFormElement){const oe=Ee(()=>Q(Z.current),\"reset\");return D.addEventListener(\"reset\",oe),()=>D.removeEventListener(\"reset\",oe)}},[k,_,Q]);const ne=_?!!k||!!_.closest(\"form\"):!0,[fe,J]=x.useState(new Set),ee=vr(),I=Array.from(fe).map(D=>D.props.value).join(\";\"),U=x.useCallback(D=>{J(oe=>new Set(oe).add(D))},[]),M=x.useCallback(D=>{J(oe=>{const pe=new Set(oe);return pe.delete(D),pe})},[]),N={required:C,trigger:_,onTriggerChange:L,valueNode:T,onValueNodeChange:O,valueNodeHasChildren:B,onValueNodeHasChildrenChange:V,contentId:ee,value:X,onValueChange:Q,open:$,onOpenChange:W,dir:H,triggerPointerDownPosRef:q,disabled:S,name:w,autoComplete:v,form:k,nativeOptions:fe,nativeSelectKey:I,isFormControl:ne};return g.jsx(wg,{...b,children:g.jsx(gk,{scope:r,...N,children:g.jsx(ul.Provider,{scope:r,children:g.jsx(vk,{scope:r,onNativeOptionAdd:U,onNativeOptionRemove:M,children:Yg(E)?E(N):s})})})})}Ee($g,\"SelectProvider\");var xk=Ee(n=>{const{__scopeSelect:r,children:s,...i}=n;return g.jsx($g,{__scopeSelect:r,...i,internal_do_not_use_render:({isFormControl:a})=>g.jsxs(g.Fragment,{children:[s,a?g.jsx(Hk,{__scopeSelect:r}):null]})})},\"Select\"),wk=\"SelectTrigger\",Vg=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,disabled:a=!1,...u}=r,d=Sc(i),f=Jn(wk,i),h=f.disabled||a,m=De(s,f.onTriggerChange),w=cl(i),v=x.useRef(\"touch\"),[S,C,k]=kc(b=>{const _=w().filter(O=>!O.disabled),L=_.find(O=>O.value===f.value),T=bc(_,b,L);T!==void 0&&f.onValueChange(T.value)}),E=Ee(b=>{h||(f.onOpenChange(!0),k()),b&&(f.triggerPointerDownPosRef.current={x:Math.round(b.pageX),y:Math.round(b.pageY)})},\"handleOpen\");return g.jsx(Sg,{asChild:!0,...d,children:g.jsx(Ue.button,{type:\"button\",role:\"combobox\",\"aria-controls\":f.open?f.contentId:void 0,\"aria-expanded\":f.open,\"aria-required\":f.required,\"aria-autocomplete\":\"none\",dir:f.dir,\"data-state\":f.open?\"open\":\"closed\",disabled:h,\"data-disabled\":h?\"\":void 0,\"data-placeholder\":ps(f.value)?\"\":void 0,...u,ref:m,onClick:je(u.onClick,b=>{b.currentTarget.focus(),v.current!==\"mouse\"&&E(b)}),onPointerDown:je(u.onPointerDown,b=>{v.current=b.pointerType;const _=b.target;_.hasPointerCapture(b.pointerId)&&_.releasePointerCapture(b.pointerId),b.button===0&&b.ctrlKey===!1&&b.pointerType===\"mouse\"&&(E(b),b.preventDefault())}),onKeyDown:je(u.onKeyDown,b=>{const _=S.current!==\"\";!(b.ctrlKey||b.altKey||b.metaKey)&&b.key.length===1&&C(b.key),!(_&&b.key===\" \")&&pk.includes(b.key)&&(E(),b.preventDefault())})})})},\"SelectTrigger\")),Sk=\"SelectValue\",Ck=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,className:a,style:u,children:d,placeholder:f=\"\",...h}=r,m=Jn(Sk,i),{onValueNodeHasChildrenChange:w}=m,v=d!==void 0,S=De(s,m.onValueNodeChange);Ge(()=>{w(v)},[w,v]);const C=ps(m.value);return g.jsx(Ue.span,{...h,asChild:C?!1:h.asChild,ref:S,style:{pointerEvents:\"none\"},children:g.jsx(x.Fragment,{children:C?f:d},C?\"placeholder\":\"value\")})},\"SelectValue\")),kk=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,children:a,...u}=r;return g.jsx(Ue.span,{\"aria-hidden\":!0,...u,ref:s,children:a||\"▼\"})},\"SelectIcon\")),bk=\"SelectPortal\",[Ek,Pk]=br(bk,{forceMount:void 0}),Nk=Ee(n=>{const{__scopeSelect:r,forceMount:s,...i}=n;return g.jsx(Ek,{scope:n.__scopeSelect,forceMount:s,children:g.jsx(Lm,{asChild:!0,...i})})},\"SelectPortal\"),Sr=\"SelectContent\",Bg=x.forwardRef(Ee(function(r,s){const i=Pk(Sr,r.__scopeSelect),{forceMount:a=i.forceMount,...u}=r,d=Jn(Sr,r.__scopeSelect),[f,h]=x.useState();return Ge(()=>{h(new DocumentFragment)},[]),g.jsx(fs,{present:a||d.open,children:({present:m})=>m?g.jsx(jk,{...u,ref:s}):g.jsx(Rk,{...u,fragment:f})})},\"SelectContent\")),Rk=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,children:a,fragment:u}=r;return u?cs.createPortal(g.jsx(Ug,{scope:i,children:g.jsx(ul.Slot,{scope:i,children:g.jsx(\"div\",{ref:s,children:a})})}),u):null},\"SelectContentFragment\")),Gt=10,[Ug,Er]=br(Sr),Ok=Cn(\"SelectContent.RemoveScroll\"),jk=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i}=r,{position:a=\"item-aligned\",onCloseAutoFocus:u,onEscapeKeyDown:d,onPointerDownOutside:f,side:h,sideOffset:m,align:w,alignOffset:v,arrowPadding:S,collisionBoundary:C,collisionPadding:k,sticky:E,hideWhenDetached:b,avoidCollisions:_,...L}=r,T=Jn(Sr,i),[O,B]=x.useState(null),[V,H]=x.useState(null),$=De(s,B),[W,X]=x.useState(null),[Q,q]=x.useState(null),Z=cl(i),[ne,fe]=x.useState(!1),J=x.useRef(!1);x.useEffect(()=>{if(O)return Km(O)},[O]),Xi();const ee=x.useCallback(re=>{const[le,...Pe]=Z().map(_e=>_e.ref.current),[be]=Pe.slice(-1),Re=document.activeElement;for(const _e of re)if(_e===Re||(_e?.scrollIntoView({block:\"nearest\"}),_e===le&&V&&(V.scrollTop=0),_e===be&&V&&(V.scrollTop=V.scrollHeight),_e?.focus(),document.activeElement!==Re))return},[Z,V]),I=x.useCallback(()=>ee([W,O]),[ee,W,O]);x.useEffect(()=>{ne&&I()},[ne,I]);const{onOpenChange:U,triggerPointerDownPosRef:M}=T;x.useEffect(()=>{if(O){let re={x:0,y:0};const le=Ee(be=>{re={x:Math.abs(Math.round(be.pageX)-(M.current?.x??0)),y:Math.abs(Math.round(be.pageY)-(M.current?.y??0))}},\"handlePointerMove\"),Pe=Ee(be=>{re.x<=10&&re.y<=10?be.preventDefault():be.composedPath().includes(O)||U(!1),document.removeEventListener(\"pointermove\",le),M.current=null},\"handlePointerUp\");return M.current!==null&&(document.addEventListener(\"pointermove\",le),document.addEventListener(\"pointerup\",Pe,{capture:!0,once:!0})),()=>{document.removeEventListener(\"pointermove\",le),document.removeEventListener(\"pointerup\",Pe,{capture:!0})}}},[O,U,M]),x.useEffect(()=>{const re=Ee(()=>U(!1),\"close\");return window.addEventListener(\"blur\",re),window.addEventListener(\"resize\",re),()=>{window.removeEventListener(\"blur\",re),window.removeEventListener(\"resize\",re)}},[U]);const[N,D]=kc(re=>{const le=Z().filter(Re=>!Re.disabled),Pe=le.find(Re=>Re.ref.current===document.activeElement),be=bc(le,re,Pe);be&&setTimeout(()=>be.ref.current?.focus())}),oe=x.useCallback((re,le,Pe)=>{const be=!J.current&&!Pe;(T.value!==void 0&&T.value===le||be)&&(X(re),be&&(J.current=!0))},[T.value]),pe=x.useCallback(()=>O?.focus(),[O]),se=x.useCallback((re,le,Pe)=>{const be=!J.current&&!Pe;(T.value!==void 0&&T.value===le||be)&&q(re)},[T.value]),ge=a===\"popper\"?bh:_k,Se=ge===bh?{side:h,sideOffset:m,align:w,alignOffset:v,arrowPadding:S,collisionBoundary:C,collisionPadding:k,sticky:E,hideWhenDetached:b,avoidCollisions:_}:{};return g.jsx(Ug,{scope:i,content:O,viewport:V,onViewportChange:H,itemRefCallback:oe,selectedItem:W,onItemLeave:pe,itemTextRefCallback:se,focusSelectedItem:I,selectedItemText:Q,position:a,isPositioned:ne,searchRef:N,children:g.jsx(sc,{as:Ok,allowPinchZoom:!0,children:g.jsx(Pm,{asChild:!0,trapped:T.open,onMountAutoFocus:re=>{re.preventDefault()},onUnmountAutoFocus:je(u,re=>{T.trigger?.focus({preventScroll:!0}),re.preventDefault()}),children:g.jsx(tc,{asChild:!0,disableOutsidePointerEvents:!0,onEscapeKeyDown:d,onPointerDownOutside:f,onFocusOutside:re=>re.preventDefault(),onDismiss:()=>T.onOpenChange(!1),children:g.jsx(ge,{role:\"listbox\",id:T.contentId,\"data-state\":T.open?\"open\":\"closed\",dir:T.dir,onContextMenu:re=>re.preventDefault(),...L,...Se,onPlaced:()=>fe(!0),ref:$,style:{display:\"flex\",flexDirection:\"column\",outline:\"none\",...L.style},onKeyDown:je(L.onKeyDown,re=>{const le=re.ctrlKey||re.altKey||re.metaKey;if(re.key===\"Tab\"&&re.preventDefault(),!le&&re.key.length===1&&D(re.key),[\"ArrowUp\",\"ArrowDown\",\"Home\",\"End\"].includes(re.key)){let be=Z().filter(Re=>!Re.disabled).map(Re=>Re.ref.current);if([\"ArrowUp\",\"End\"].includes(re.key)&&(be=be.slice().reverse()),[\"ArrowUp\",\"ArrowDown\"].includes(re.key)){const Re=re.target,_e=be.indexOf(Re);be=be.slice(_e+1)}setTimeout(()=>ee(be)),re.preventDefault()}})})})})})})},\"SelectContentImpl\")),_k=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,onPlaced:a,...u}=r,d=Jn(Sr,i),f=Er(Sr,i),[h,m]=x.useState(null),[w,v]=x.useState(null),S=De(s,v),C=cl(i),k=x.useRef(!1),E=x.useRef(!0),{viewport:b,selectedItem:_,selectedItemText:L,focusSelectedItem:T}=f,O=x.useCallback(()=>{if(d.trigger&&d.valueNode&&h&&w&&b&&_&&L){const $=d.trigger.getBoundingClientRect(),W=w.getBoundingClientRect(),X=d.valueNode.getBoundingClientRect(),Q=L.getBoundingClientRect();if(d.dir!==\"rtl\"){const Re=Q.left-W.left,_e=X.left-Re,Je=$.left-_e,pt=$.width+Je,Pr=Math.max(pt,W.width),er=window.innerWidth-Gt,Nr=Gu(_e,[Gt,Math.max(Gt,er-Pr)]);h.style.minWidth=pt+\"px\",h.style.left=Nr+\"px\"}else{const Re=W.right-Q.right,_e=window.innerWidth-X.right-Re,Je=window.innerWidth-$.right-_e,pt=$.width+Je,Pr=Math.max(pt,W.width),er=window.innerWidth-Gt,Nr=Gu(_e,[Gt,Math.max(Gt,er-Pr)]);h.style.minWidth=pt+\"px\",h.style.right=Nr+\"px\"}const q=C(),Z=window.innerHeight-Gt*2,ne=b.scrollHeight,fe=window.getComputedStyle(w),J=parseInt(fe.borderTopWidth,10),ee=parseInt(fe.paddingTop,10),I=parseInt(fe.borderBottomWidth,10),U=parseInt(fe.paddingBottom,10),M=J+ee+ne+U+I,N=Math.min(_.offsetHeight*5,M),D=window.getComputedStyle(b),oe=parseInt(D.paddingTop,10),pe=parseInt(D.paddingBottom,10),se=$.top+$.height/2-Gt,ge=Z-se,Se=_.offsetHeight/2,re=_.offsetTop+Se,le=J+ee+re,Pe=M-le;if(le<=se){const Re=q.length>0&&_===q[q.length-1].ref.current;h.style.bottom=\"0px\";const _e=w.clientHeight-b.offsetTop-b.offsetHeight,Je=Math.max(ge,Se+(Re?pe:0)+_e+I),pt=le+Je;h.style.height=pt+\"px\"}else{const Re=q.length>0&&_===q[0].ref.current;h.style.top=\"0px\";const Je=Math.max(se,J+b.offsetTop+(Re?oe:0)+Se)+Pe;h.style.height=Je+\"px\",b.scrollTop=le-se+b.offsetTop}h.style.margin=`${Gt}px 0`,h.style.minHeight=N+\"px\",h.style.maxHeight=Z+\"px\",a?.(),requestAnimationFrame(()=>k.current=!0)}},[C,d.trigger,d.valueNode,h,w,b,_,L,d.dir,a]);Ge(()=>O(),[O]);const[B,V]=x.useState();Ge(()=>{w&&V(window.getComputedStyle(w).zIndex)},[w]);const H=x.useCallback($=>{$&&E.current===!0&&(O(),T?.(),E.current=!1)},[O,T]);return g.jsx(Tk,{scope:i,contentWrapper:h,shouldExpandOnScrollRef:k,onScrollButtonChange:H,children:g.jsx(\"div\",{ref:m,style:{display:\"flex\",flexDirection:\"column\",position:\"fixed\",zIndex:B},children:g.jsx(Ue.div,{...u,ref:S,style:{boxSizing:\"border-box\",maxHeight:\"100%\",...u.style}})})})},\"SelectItemAlignedPosition\")),bh=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,align:a=\"start\",collisionPadding:u=Gt,...d}=r,f=Sc(i);return g.jsx(Cg,{...f,...d,ref:s,align:a,collisionPadding:u,style:{boxSizing:\"border-box\",...d.style,\"--radix-select-content-transform-origin\":\"var(--radix-popper-transform-origin)\",\"--radix-select-content-available-width\":\"var(--radix-popper-available-width)\",\"--radix-select-content-available-height\":\"var(--radix-popper-available-height)\",\"--radix-select-trigger-width\":\"var(--radix-popper-anchor-width)\",\"--radix-select-trigger-height\":\"var(--radix-popper-anchor-height)\"}})},\"SelectPopperPosition\")),[Tk,Cc]=br(Sr,{}),Eh=\"SelectViewport\",Lk=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,nonce:a,...u}=r,d=Er(Eh,i),f=Cc(Eh,i),h=De(s,d.onViewportChange),m=x.useRef(0);return g.jsxs(g.Fragment,{children:[g.jsx(\"style\",{dangerouslySetInnerHTML:{__html:\"[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}\"},nonce:a}),g.jsx(ul.Slot,{scope:i,children:g.jsx(Ue.div,{\"data-radix-select-viewport\":\"\",role:\"presentation\",...u,ref:h,style:{position:\"relative\",flex:1,overflow:\"hidden auto\",...u.style},onScroll:je(u.onScroll,w=>{const v=w.currentTarget,{contentWrapper:S,shouldExpandOnScrollRef:C}=f;if(C?.current&&S){const k=Math.abs(m.current-v.scrollTop);if(k>0){const E=window.innerHeight-Gt*2,b=parseFloat(S.style.minHeight),_=parseFloat(S.style.height),L=Math.max(b,_);if(L<E){const T=L+k,O=Math.min(E,T),B=T-O;S.style.height=O+\"px\",S.style.bottom===\"0px\"&&(v.scrollTop=B>0?B:0,S.style.justifyContent=\"flex-end\")}}}m.current=v.scrollTop})})})]})},\"SelectViewport\")),Ik=\"SelectGroup\",[pb,Ak]=br(Ik),Dk=\"SelectLabel\",Hg=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,...a}=r,u=Ak(Dk,i);return g.jsx(Ue.div,{id:u.id,...a,ref:s})},\"SelectLabel\")),Yu=\"SelectItem\",[Mk,Wg]=br(Yu),Kg=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,value:a,disabled:u=!1,textValue:d,...f}=r,h=Jn(Yu,i),m=Er(Yu,i),w=h.value===a,[v,S]=x.useState(d??\"\"),[C,k]=x.useState(!1),E=sn(O=>m.itemRefCallback?.(O,a,u)),b=De(s,E),_=vr(),L=x.useRef(\"touch\"),T=Ee(()=>{u||(h.onValueChange(a),h.onOpenChange(!1))},\"handleSelect\");return g.jsx(Mk,{scope:i,value:a,disabled:u,textId:_,isSelected:w,onItemTextChange:x.useCallback(O=>{S(B=>B||(O?.textContent??\"\").trim())},[]),children:g.jsx(ul.ItemSlot,{scope:i,value:a,disabled:u,textValue:v,children:g.jsx(Ue.div,{role:\"option\",\"aria-labelledby\":_,\"data-highlighted\":C?\"\":void 0,\"aria-selected\":w&&C,\"data-state\":w?\"checked\":\"unchecked\",\"aria-disabled\":u||void 0,\"data-disabled\":u?\"\":void 0,tabIndex:u?void 0:-1,...f,ref:b,onFocus:je(f.onFocus,()=>k(!0)),onBlur:je(f.onBlur,()=>k(!1)),onClick:je(f.onClick,()=>{L.current!==\"mouse\"&&T()}),onPointerUp:je(f.onPointerUp,()=>{L.current===\"mouse\"&&T()}),onPointerDown:je(f.onPointerDown,O=>{L.current=O.pointerType}),onPointerMove:je(f.onPointerMove,O=>{L.current=O.pointerType,u?m.onItemLeave?.():L.current===\"mouse\"&&O.currentTarget.focus({preventScroll:!0})}),onPointerLeave:je(f.onPointerLeave,O=>{O.currentTarget===document.activeElement&&m.onItemLeave?.()}),onKeyDown:je(f.onKeyDown,O=>{u||O.target!==O.currentTarget||m.searchRef?.current!==\"\"&&O.key===\" \"||(hk.includes(O.key)&&T(),O.key===\" \"&&O.preventDefault())})})})})},\"SelectItem\")),Li=\"SelectItemText\",zk=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,className:a,style:u,...d}=r,f=Jn(Li,i),h=Er(Li,i),m=Wg(Li,i),w=yk(Li,i),[v,S]=x.useState(null),C=sn(T=>h.itemTextRefCallback?.(T,m.value,m.disabled)),k=De(s,S,m.onItemTextChange,C),E=v?.textContent,b=x.useMemo(()=>g.jsx(\"option\",{value:m.value,disabled:m.disabled,children:E},m.value),[m.disabled,m.value,E]),{onNativeOptionAdd:_,onNativeOptionRemove:L}=w;return Ge(()=>(_(b),()=>L(b)),[_,L,b]),g.jsxs(g.Fragment,{children:[g.jsx(Ue.span,{id:m.textId,...d,ref:k}),m.isSelected&&f.valueNode&&!f.valueNodeHasChildren&&!ps(f.value)?cs.createPortal(d.children,f.valueNode):null]})},\"SelectItemText\")),Fk=\"SelectItemIndicator\",$k=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,...a}=r;return Wg(Fk,i).isSelected?g.jsx(Ue.span,{\"aria-hidden\":!0,...a,ref:s}):null},\"SelectItemIndicator\")),Ph=\"SelectScrollUpButton\",Vk=x.forwardRef(Ee(function(r,s){const i=Er(Ph,r.__scopeSelect),a=Cc(Ph,r.__scopeSelect),[u,d]=x.useState(!1),f=De(s,a.onScrollButtonChange);return Ge(()=>{if(i.viewport&&i.isPositioned){let h=function(){const w=m.scrollTop>0;d(w)};Ee(h,\"handleScroll\");const m=i.viewport;return h(),m.addEventListener(\"scroll\",h),()=>m.removeEventListener(\"scroll\",h)}},[i.viewport,i.isPositioned]),u?g.jsx(Gg,{...r,ref:f,onAutoScroll:()=>{const{viewport:h,selectedItem:m}=i;h&&m&&(h.scrollTop=h.scrollTop-m.offsetHeight)}}):null},\"SelectScrollUpButton\")),Nh=\"SelectScrollDownButton\",Bk=x.forwardRef(Ee(function(r,s){const i=Er(Nh,r.__scopeSelect),a=Cc(Nh,r.__scopeSelect),[u,d]=x.useState(!1),f=De(s,a.onScrollButtonChange);return Ge(()=>{if(i.viewport&&i.isPositioned){let h=function(){const w=m.scrollHeight-m.clientHeight,v=Math.ceil(m.scrollTop)<w;d(v)};Ee(h,\"handleScroll\");const m=i.viewport;return h(),m.addEventListener(\"scroll\",h),()=>m.removeEventListener(\"scroll\",h)}},[i.viewport,i.isPositioned]),u?g.jsx(Gg,{...r,ref:f,onAutoScroll:()=>{const{viewport:h,selectedItem:m}=i;h&&m&&(h.scrollTop=h.scrollTop+m.offsetHeight)}}):null},\"SelectScrollDownButton\")),Gg=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,onAutoScroll:a,...u}=r,d=Er(\"SelectScrollButton\",i),f=x.useRef(null),h=cl(i),m=x.useCallback(()=>{f.current!==null&&(window.clearInterval(f.current),f.current=null)},[]);return x.useEffect(()=>()=>m(),[m]),Ge(()=>{h().find(v=>v.ref.current===document.activeElement)?.ref.current?.scrollIntoView({block:\"nearest\"})},[h]),g.jsx(Ue.div,{\"aria-hidden\":!0,...u,ref:s,style:{flexShrink:0,...u.style},onPointerDown:je(u.onPointerDown,()=>{f.current===null&&(f.current=window.setInterval(a,50))}),onPointerMove:je(u.onPointerMove,()=>{d.onItemLeave?.(),f.current===null&&(f.current=window.setInterval(a,50))}),onPointerLeave:je(u.onPointerLeave,()=>{m()})})},\"SelectScrollButtonImpl\")),Qg=x.forwardRef(Ee(function(r,s){const{__scopeSelect:i,...a}=r;return g.jsx(Ue.div,{\"aria-hidden\":!0,...a,ref:s})},\"SelectSeparator\")),Uk=\"SelectBubbleInput\",Hk=x.forwardRef(Ee(function({__scopeSelect:r,...s},i){const a=Jn(Uk,r),{value:u,onValueChange:d,required:f,disabled:h,name:m,autoComplete:w,form:v}=a,{nativeOptions:S,nativeSelectKey:C}=a,k=x.useRef(null),E=De(i,k),b=u??\"\",_=Fg(b),L=Array.from(S).some(T=>(T.props.value??\"\")===\"\");return x.useEffect(()=>{const T=k.current;if(!T)return;const O=window.HTMLSelectElement.prototype,V=Object.getOwnPropertyDescriptor(O,\"value\").set;if(_!==b&&V){const H=new Event(\"change\",{bubbles:!0});V.call(T,b),T.dispatchEvent(H)}},[_,b]),g.jsxs(Ue.select,{\"aria-hidden\":!0,required:f,tabIndex:-1,name:m,autoComplete:w,disabled:h,form:v,onChange:T=>d(T.target.value),...s,style:{...kg,...s.style},ref:E,defaultValue:b,children:[ps(u)&&!L?g.jsx(\"option\",{value:\"\"}):null,Array.from(S)]},C)},\"SelectBubbleInput\"));function Yg(n){return typeof n==\"function\"}Ee(Yg,\"isFunction\");function ps(n){return n===\"\"||n===void 0}Ee(ps,\"shouldShowPlaceholder\");function kc(n){const r=sn(n),s=x.useRef(\"\"),i=x.useRef(0),a=x.useCallback(d=>{const f=s.current+d;r(f),Ee((function h(m){s.current=m,window.clearTimeout(i.current),m!==\"\"&&(i.current=window.setTimeout(()=>h(\"\"),1e3))}),\"updateSearch\")(f)},[r]),u=x.useCallback(()=>{s.current=\"\",window.clearTimeout(i.current)},[]);return x.useEffect(()=>()=>window.clearTimeout(i.current),[]),[s,a,u]}Ee(kc,\"useTypeaheadSearch\");function bc(n,r,s){const a=r.length>1&&Array.from(r).every(m=>m===r[0])?r[0]:r,u=s?n.indexOf(s):-1;let d=Xg(n,Math.max(u,0));a.length===1&&(d=d.filter(m=>m!==s));const h=d.find(m=>m.textValue.toLowerCase().startsWith(a.toLowerCase()));return h!==s?h:void 0}Ee(bc,\"findNextItem\");function Xg(n,r){return n.map((s,i)=>n[(r+i)%n.length])}Ee(Xg,\"wrapArray\");const Wk=xk,Kk=Ck,Zg=x.forwardRef(({className:n,children:r,...s},i)=>g.jsxs(Vg,{ref:i,className:Ve(\"flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-border-default bg-background px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:border-border-active disabled:cursor-not-allowed disabled:opacity-50\",n),...s,children:[r,g.jsx(kk,{asChild:!0,children:g.jsx(Zu,{className:\"h-4 w-4 opacity-50\"})})]}));Zg.displayName=Vg.displayName;const qg=x.forwardRef(({className:n,children:r,position:s=\"popper\",...i},a)=>g.jsx(Nk,{children:g.jsxs(Bg,{ref:a,className:Ve(\"relative z-[100] max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border border-border-default bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2\",n),position:s,...i,children:[g.jsx(Vk,{className:\"flex cursor-default items-center justify-center bg-popover py-1\",children:g.jsx(d0,{className:\"h-4 w-4\"})}),g.jsx(Lk,{className:Ve(\"p-1\",s===\"popper\"&&\"h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]\"),children:r}),g.jsx(Bk,{className:\"flex cursor-default items-center justify-center bg-popover py-1\",children:g.jsx(Zu,{className:\"h-4 w-4\"})})]})}));qg.displayName=Bg.displayName;const Gk=x.forwardRef(({className:n,...r},s)=>g.jsx(Hg,{ref:s,className:Ve(\"px-2 py-1.5 text-sm font-semibold\",n),...r}));Gk.displayName=Hg.displayName;const Jg=x.forwardRef(({className:n,children:r,...s},i)=>g.jsxs(Kg,{ref:i,className:Ve(\"relative flex w-full cursor-default select-none items-center rounded-sm pl-7 pr-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50\",n),...s,children:[g.jsx(\"span\",{className:\"absolute left-2 flex h-3.5 w-3.5 items-center justify-center\",children:g.jsx($k,{children:g.jsx(Fh,{className:\"h-4 w-4\"})})}),g.jsx(zk,{children:r})]}));Jg.displayName=Kg.displayName;const Qk=x.forwardRef(({className:n,...r},s)=>g.jsx(Qg,{ref:s,className:Ve(\"-mx-1 my-1 h-px bg-muted\",n),...r}));Qk.displayName=Qg.displayName;const Yk=({value:n,onChange:r,placeholder:s,disabled:i=!1,required:a=!1,label:u=\"API Key\",id:d=\"apiKey\"})=>{const{t:f}=Xu(),[h,m]=x.useState(!1),w=()=>{m(!h)},v=`w-full px-3 py-2 pr-10 border rounded-lg text-sm transition-colors ${i?\"bg-muted border-border-default text-muted-foreground cursor-not-allowed\":\"border-border-default bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:focus:ring-blue-400/20\"}`;return g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsxs(\"label\",{htmlFor:d,className:\"block text-sm font-medium text-foreground\",children:[u,\" \",a&&\"*\"]}),g.jsxs(\"div\",{className:\"relative\",children:[g.jsx(\"input\",{type:h?\"text\":\"password\",id:d,value:n,onChange:S=>r(S.target.value),placeholder:s??f(\"apiKeyInput.placeholder\"),disabled:i,required:a,autoComplete:\"off\",className:v}),!i&&n&&g.jsx(\"button\",{type:\"button\",onClick:w,className:\"absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground transition-colors\",\"aria-label\":f(h?\"apiKeyInput.hide\":\"apiKeyInput.show\"),children:h?g.jsx(p0,{size:16}):g.jsx(m0,{size:16})})]})]})},Gi=\"draft-header:\";function Xk(n){const r={};for(const[s,i]of Object.entries(n)){const a=s.trim();a&&!s.startsWith(Gi)&&(r[a]=i)}return r}function Zk({headerName:n,onChange:r,ariaLabel:s,placeholder:i}){const a=n.startsWith(Gi),u=a?\"\":n,[d,f]=x.useState(u);return x.useEffect(()=>{f(a?\"\":n)},[n,a]),g.jsx(Gn,{value:d,onChange:h=>f(h.target.value),onKeyDown:h=>{h.key===\"Enter\"&&(h.preventDefault(),h.currentTarget.blur())},onBlur:()=>{const h=d.trim();if(!h){f(u);return}h!==n&&(r(h)||f(u))},\"aria-label\":s,placeholder:i,className:\"min-w-0 flex-1\"})}function qk(n){let r=Date.now();for(;`${Gi}${r}`in n;)r+=1;return`${Gi}${r}`}function Jk({headers:n,onHeadersChange:r,className:s}){const{t:i}=Xu(),a=()=>{r({...n,[qk(n)]:\"\"})},u=h=>{const m={...n};delete m[h],r(m)},d=(h,m)=>{const w=m.toLowerCase();if(Object.keys(n).some(S=>S!==h&&S.toLowerCase()===w))return!1;const v={};for(const[S,C]of Object.entries(n))v[S===h?m:S]=C;return r(v),!0},f=(h,m)=>{r({...n,[h]:m})};return g.jsxs(\"div\",{className:Ve(\"space-y-2 border-l border-border-default pl-3\",s),children:[g.jsxs(\"div\",{className:\"flex items-start justify-between gap-3\",children:[g.jsxs(\"div\",{className:\"max-w-3xl space-y-1\",children:[g.jsx(Ot,{children:i(\"opencode.headers\",{defaultValue:\"Headers\"})}),g.jsx(\"p\",{className:\"text-xs text-muted-foreground\",children:i(\"opencode.headersHint\",{defaultValue:\"Optional HTTP headers sent with provider requests, such as HTTP-Referer or X-Title.\"})})]}),g.jsxs($e,{type:\"button\",variant:\"outline\",size:\"sm\",onClick:a,\"aria-label\":i(\"opencode.addHeader\",{defaultValue:\"Add header\"}),className:\"h-7 shrink-0 gap-1\",children:[g.jsx(Vh,{className:\"h-3.5 w-3.5\"}),i(\"opencode.addHeader\",{defaultValue:\"Add\"})]})]}),g.jsx(\"div\",{className:\"max-w-3xl\",\"aria-live\":\"polite\",children:Object.keys(n).length===0?g.jsx(\"p\",{className:\"py-1 text-sm text-muted-foreground\",children:i(\"opencode.noHeaders\",{defaultValue:\"No custom headers configured\"})}):g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsxs(\"div\",{className:\"mb-1 flex items-center gap-2 px-1 text-xs text-muted-foreground\",children:[g.jsx(\"span\",{className:\"flex-1\",children:i(\"opencode.headerName\",{defaultValue:\"Header\"})}),g.jsx(\"span\",{className:\"flex-1\",children:i(\"opencode.headerValue\",{defaultValue:\"Value\"})}),g.jsx(\"span\",{className:\"w-9\"})]}),Object.entries(n).map(([h,m])=>g.jsxs(\"div\",{className:\"flex items-center gap-2\",children:[g.jsx(Zk,{headerName:h,onChange:w=>d(h,w),ariaLabel:i(\"opencode.headerName\",{defaultValue:\"Header\"}),placeholder:i(\"opencode.headerNamePlaceholder\",{defaultValue:\"X-Title\"})}),g.jsx(ns,{value:m,onValueChange:w=>f(h,w),\"aria-label\":i(\"opencode.headerValue\",{defaultValue:\"Value\"}),placeholder:i(\"opencode.headerValuePlaceholder\",{defaultValue:\"CC Switch\"}),className:\"min-w-0 flex-1\"}),g.jsx($e,{type:\"button\",variant:\"ghost\",size:\"icon\",onClick:()=>u(h),\"aria-label\":i(\"opencode.removeHeader\",{defaultValue:\"Remove header\"}),className:\"h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive\",children:g.jsx(Uh,{className:\"h-4 w-4\"})})]},h))]})})]})}const eb={\"openai-chat\":\"/chat/completions\",\"openai-responses\":\"/responses\",\"anthropic-messages\":\"/messages\"},ev={\"openai-chat\":\"OpenAI Chat Completions（推荐，兼容最广）\",\"openai-responses\":\"OpenAI Responses\",\"anthropic-messages\":\"Anthropic Messages（Claude）\"};function Rh(n,r,s){return(r||\"https://api.example.com/v1\").replace(/\\/+$/,\"\")+(s&&s.trim()?s.trim():eb[n])}const tb=new URLSearchParams(window.location.search).get(\"t\")??\"\";async function Kt(n,r){const s=await fetch(n,{method:r===void 0?\"GET\":\"POST\",headers:{\"x-gs-token\":tb,\"content-type\":\"application/json\"},body:r===void 0?void 0:JSON.stringify(r)}),i=await s.json().catch(()=>({}));if(!s.ok)throw new Error(i.error??s.statusText);return i}const Mt={state:()=>Kt(\"/api/state\"),saveProvider:n=>Kt(\"/api/providers\",n),deleteProvider:n=>Kt(\"/api/providers/delete\",{name:n}),test:n=>Kt(\"/api/test\",{name:n}),use:n=>Kt(\"/api/use\",{name:n}),official:()=>Kt(\"/api/official\",{}),restart:()=>Kt(\"/api/restart\",{}),restore:()=>Kt(\"/api/restore\",{}),codexInstall:()=>Kt(\"/api/codex/install\",{}),codexLogin:(n,r)=>Kt(\"/api/codex/login\",{name:n,model:r}),codexCancel:()=>Kt(\"/api/codex/cancel\",{})},Ii=[{id:\"custom\",label:\"自定义 / 中转站\",protocol:\"openai-chat\",url:\"\",model:\"\",note:\"填中转站给你的根地址，一般以 /v1 结尾\"},{id:\"openai\",label:\"OpenAI\",protocol:\"openai-chat\",url:\"https://api.openai.com/v1\",model:\"gpt-5\"},{id:\"deepseek\",label:\"DeepSeek\",protocol:\"openai-chat\",url:\"https://api.deepseek.com\",model:\"deepseek-chat\"},{id:\"xai\",label:\"xAI\",protocol:\"openai-chat\",url:\"https://api.x.ai/v1\",model:\"grok-4\"},{id:\"kimi\",label:\"Kimi\",protocol:\"openai-chat\",url:\"https://api.moonshot.cn/v1\",model:\"kimi-k2-0905-preview\"},{id:\"qwen\",label:\"通义千问\",protocol:\"openai-chat\",url:\"https://dashscope.aliyuncs.com/compatible-mode/v1\",model:\"qwen3-max\"},{id:\"openrouter\",label:\"OpenRouter\",protocol:\"openai-chat\",url:\"https://openrouter.ai/api/v1\",model:\"openai/gpt-5\"},{id:\"anthropic\",label:\"Anthropic\",protocol:\"anthropic-messages\",url:\"https://api.anthropic.com/v1\",model:\"claude-sonnet-4-5\"}],nb=Object.keys(ev);function Oh({id:n,label:r,value:s,onChange:i,options:a,disabled:u=!1}){return g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{htmlFor:n,children:r}),g.jsxs(Wk,{value:s,onValueChange:i,disabled:u,children:[g.jsx(Zg,{id:n,children:g.jsx(Kk,{})}),g.jsx(qg,{children:a.map(([d,f])=>g.jsx(Jg,{value:d,children:f},d))})]})]})}function rb({editing:n,initial:r,takenNames:s,onClose:i,onSaved:a}){const[u,d]=x.useState(n?\"\":\"custom\"),[f,h]=x.useState(n??\"\"),[m,w]=x.useState(r?.protocol??\"openai-chat\"),[v,S]=x.useState(r?.baseUrl??\"\"),[C,k]=x.useState(r?.model??\"\"),[E,b]=x.useState(\"\"),[_,L]=x.useState(r?.authType&&r.authType!==\"codex\"?r.authType:\"default\"),[T,O]=x.useState(r?.endpointPath??\"\"),[B,V]=x.useState(r?.parameters?.reasoningEffort??\"\"),[H,$]=x.useState(r?.parameters?.maxTokens?String(r.parameters.maxTokens):\"\"),[W,X]=x.useState(r?.headers??{}),[Q,q]=x.useState(!!(r?.endpointPath||r?.parameters||r?.headers&&Object.keys(r.headers).length)),[Z,ne]=x.useState(null),[fe,J]=x.useState(null),ee=r?.authType===\"codex\",I=x.useMemo(()=>n?null:/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(f)?s.includes(f)?\"已有同名来源，保存会覆盖它\":null:f?\"只能用英文、数字、点、下划线、横线\":null,[f,n,s]);function U(D){const oe=Ii.find(pe=>pe.id===D);d(D),oe&&(w(oe.protocol),oe.url&&S(oe.url),oe.model&&k(oe.model),!f&&D!==\"custom\"&&h(D))}async function M(D,oe){D?.preventDefault(),J(null);const pe={name:f.trim(),protocol:m,baseUrl:v.trim(),model:C.trim(),apiKey:E,authType:ee?\"codex\":_===\"default\"?\"\":_,endpointPath:T.trim(),reasoning:B.trim(),maxTokens:H.trim(),headers:Object.entries(Xk(W)).map(([se,ge])=>`${se}: ${ge}`)};if(!pe.name)return J(\"请填写名字\");if(!pe.baseUrl)return J(\"请填写接口根地址\");if(!pe.model)return J(\"请填写模型\");if(!n&&!ee&&_!==\"none\"&&!E)return J(\"请填写 API key（不需要的话把认证方式改成“无”）\");ne(oe?\"use\":\"save\");try{const se=await Mt.saveProvider(pe);if(se.probe&&!se.probe.ok){J(\"已保存，但测试请求失败：\"+se.probe.error+\"。请检查地址、key、模型。\"),a(se.state,pe.name,se.probe,!1);return}a(se.state,pe.name,se.probe,oe)}catch(se){J(se instanceof Error?se.message:String(se))}finally{ne(null)}}const N=Z!==null;return g.jsx(nk,{title:n?`编辑 ${n}`:\"添加模型来源\",onClose:i,pending:N,footer:g.jsxs(g.Fragment,{children:[g.jsx($e,{variant:\"outline\",disabled:N,onClick:i,children:\"取消\"}),g.jsxs($e,{variant:\"outline\",disabled:N,onClick:()=>{M(null,!1)},children:[g.jsx(O0,{className:\"h-4 w-4\"}),Z===\"save\"?\"测试中…\":\"测试并保存\"]}),g.jsxs($e,{disabled:N,onClick:()=>{M(null,!0)},children:[g.jsx($h,{className:\"h-4 w-4\"}),Z===\"use\"?\"测试中…\":\"测试、保存并使用\"]})]}),children:g.jsxs(\"form\",{id:\"provider-form\",className:\"space-y-6\",onSubmit:D=>{M(D,!0)},children:[!n&&g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{children:\"快速填入\"}),g.jsx(\"div\",{className:\"flex flex-wrap gap-2\",children:Ii.map(D=>g.jsx(\"button\",{type:\"button\",onClick:()=>U(D.id),className:Ve(\"rounded-full border px-3 py-1 text-xs transition-colors\",u===D.id?\"border-primary bg-primary text-primary-foreground\":\"border-border bg-muted/40 text-foreground hover:border-primary/60\"),children:D.label},D.id))}),Ii.find(D=>D.id===u)?.note&&g.jsx(\"p\",{className:\"text-xs text-muted-foreground\",children:Ii.find(D=>D.id===u)?.note})]}),g.jsxs(\"div\",{className:\"grid gap-4 sm:grid-cols-2\",children:[g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{htmlFor:\"name\",children:\"名字（聊天里用 /gs use 名字）\"}),g.jsx(ns,{id:\"name\",value:f,onValueChange:h,placeholder:\"myapi\",disabled:!!n,autoComplete:\"off\"}),I&&g.jsx(\"p\",{className:\"text-xs text-amber-600 dark:text-amber-400\",children:I})]}),g.jsx(Oh,{id:\"protocol\",label:\"协议\",value:m,onChange:D=>w(D),options:nb.map(D=>[D,ev[D]]),disabled:ee})]}),g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{htmlFor:\"baseUrl\",children:\"接口根地址\"}),g.jsx(ns,{id:\"baseUrl\",value:v,onValueChange:S,placeholder:\"https://api.example.com/v1\",autoComplete:\"off\",spellCheck:!1,disabled:ee}),g.jsxs(\"p\",{className:\"text-xs text-muted-foreground font-mono break-all\",children:[\"实际请求 \",Rh(m,v,T)]})]}),g.jsxs(\"div\",{className:\"grid gap-4 sm:grid-cols-2\",children:[g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{htmlFor:\"model\",children:\"模型\"}),g.jsx(ns,{id:\"model\",value:C,onValueChange:k,placeholder:\"gpt-5\",autoComplete:\"off\",spellCheck:!1})]}),ee?g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{children:\"认证\"}),g.jsx(\"p\",{className:\"text-sm text-muted-foreground pt-2\",children:\"ChatGPT 登录，不需要 API key\"})]}):g.jsx(Yk,{id:\"apiKey\",value:E,onChange:b,label:n?\"API key（留空 = 不改）\":\"API key\",placeholder:n?\"留空则保留已保存的 key\":\"sk-...\",disabled:_===\"none\"})]}),g.jsx(\"button\",{type:\"button\",className:\"text-sm text-muted-foreground hover:text-foreground\",onClick:()=>q(D=>!D),children:Q?\"▾ 收起高级选项\":\"▸ 高级选项（认证方式、自定义路径、reasoning、请求头）\"}),Q&&g.jsxs(\"div\",{className:\"space-y-6 rounded-xl border border-border bg-muted/20 p-4\",children:[g.jsxs(\"div\",{className:\"grid gap-4 sm:grid-cols-2\",children:[!ee&&g.jsx(Oh,{id:\"authType\",label:\"认证方式\",value:_,onChange:L,options:[[\"default\",\"按协议默认\"],[\"bearer\",\"Authorization: Bearer\"],[\"x-api-key\",\"x-api-key\"],[\"none\",\"无\"]]}),g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{htmlFor:\"endpointPath\",children:\"自定义请求路径\"}),g.jsx(Gn,{id:\"endpointPath\",value:T,onChange:D=>O(D.target.value),placeholder:\"默认 \"+Rh(m,\"\",\"\").replace(/^https?:\\/\\/[^/]+/,\"\").replace(/^\\/v1/,\"\"),autoComplete:\"off\"})]}),g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{htmlFor:\"reasoning\",children:\"reasoning effort（OpenAI 协议）\"}),g.jsx(Gn,{id:\"reasoning\",value:B,onChange:D=>V(D.target.value),placeholder:\"low / medium / high\",autoComplete:\"off\",disabled:m===\"anthropic-messages\"})]}),g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(Ot,{htmlFor:\"maxTokens\",children:\"max tokens\"}),g.jsx(Gn,{id:\"maxTokens\",type:\"number\",min:1,value:H,onChange:D=>$(D.target.value),placeholder:m===\"anthropic-messages\"?\"默认 8192\":\"不限制\"})]})]}),g.jsx(Jk,{headers:W,onHeadersChange:X})]}),fe&&g.jsx(\"p\",{role:\"alert\",className:\"text-sm text-red-600 dark:text-red-300 break-words\",children:fe})]})})}const Eu=n=>n instanceof Error?n.message:String(n);function ob(){const[n,r]=x.useState(()=>localStorage.getItem(\"gs-theme\")===\"dark\"||localStorage.getItem(\"gs-theme\")==null&&window.matchMedia(\"(prefers-color-scheme: dark)\").matches);return x.useEffect(()=>{document.documentElement.classList.toggle(\"dark\",n),localStorage.setItem(\"gs-theme\",n?\"dark\":\"light\")},[n]),{dark:n,toggle:()=>r(s=>!s)}}function sb(n){return n.raw?n.raw:[(n.ts??\"\").slice(11,19),n.provider??\"-\",n.model??\"-\",n.kind??\"-\",\"HTTP \"+(n.status??0),(n.ms??0)+\"ms\",n.usage?`${n.usage.promptTokens}+${n.usage.completionTokens}`:\"\",n.error?\"ERROR \"+n.error:\"\"].filter(Boolean).join(\"  \")}function ib(){const[n,r]=x.useState(null),[s,i]=x.useState(null),[a,u]=x.useState(null),[d,f]=x.useState(null),[h,m]=x.useState(null),[w,v]=x.useState(!1),[S,C]=x.useState(!1),[k,E]=x.useState([]),[b,_]=x.useState(\"chatgpt\"),[L,T]=x.useState(\"\"),O=ob(),B=x.useRef(void 0),V=x.useCallback((I,U=\"info\")=>{const M=Date.now()+Math.random();E(N=>[...N,{id:M,text:I,tone:U}]),window.setTimeout(()=>E(N=>N.filter(D=>D.id!==M)),U===\"bad\"?8e3:3500)},[]),H=x.useCallback(async()=>{try{const I=await Mt.state();r(I),i(null),!L&&I.codex.defaultModel&&T(I.codex.defaultModel)}catch(I){i(Eu(I))}},[L]);x.useEffect(()=>{H()},[H]),x.useEffect(()=>{if(window.clearTimeout(B.current),!n)return;const I=Object.values(n.codex.jobs).some(U=>U.status===\"running\")||n.host.runningCurrentBundle===!1;return B.current=window.setTimeout(()=>{H()},I?2e3:15e3),()=>window.clearTimeout(B.current)},[n,H]),x.useEffect(()=>{window.location.hash===\"#add\"&&n&&!d&&f({editing:null})},[n!=null]);async function $(I,U,M){u(I);try{const N=await U();N.state&&r(N.state),V(M??N.lines?.join(\" \")??\"完成\",\"ok\")}catch(N){V(Eu(N),\"bad\")}finally{u(null)}}async function W(I){u(\"test:\"+I),V(`正在向 ${I} 发测试请求…`);try{const{probe:U}=await Mt.test(I);V(U.ok?`${I} 正常：${U.ms}ms，回复 ${JSON.stringify(U.text)}`:`${I} 失败：${U.error}`,U.ok?\"ok\":\"bad\"),H()}catch(U){V(Eu(U),\"bad\")}finally{u(null)}}function X(I,U,M,N){r(I),!(M&&!M.ok)&&(f(null),V(M?`${U} 测试通过（${M.ms}ms）`:`${U} 已保存`,\"ok\"),N&&$(\"use:\"+U,()=>Mt.use(U)))}if(s&&!n)return g.jsx(\"div\",{className:\"min-h-screen flex items-center justify-center p-6 text-center\",children:g.jsxs(\"div\",{className:\"space-y-2\",children:[g.jsx(\"p\",{className:\"text-lg font-semibold\",children:\"无法连接面板服务\"}),g.jsx(\"p\",{className:\"text-sm text-muted-foreground\",children:s}),g.jsx(\"p\",{className:\"text-xs text-muted-foreground\",children:\"请用 `ui` 命令打印出的完整地址（带令牌）重新打开。\"})]})});if(!n)return g.jsx(\"div\",{className:\"min-h-screen flex items-center justify-center text-muted-foreground text-sm\",children:\"加载中…\"});const{host:Q}=n,q=Object.keys(n.providers),Z=n.active?n.providers[n.active]:null,ne=Q.runningCurrentBundle===!1||Q.supervisor.pending!=null,fe=n.codex,J=fe.jobs[\"codex-login\"],ee=fe.jobs[\"codex-install\"];return g.jsxs(\"div\",{className:\"min-h-screen bg-background text-foreground\",children:[g.jsx(\"header\",{className:\"sticky top-0 z-30 w-full bg-background/95 backdrop-blur border-b border-border\",children:g.jsxs(\"div\",{className:\"flex h-16 items-center justify-between gap-2 px-4 sm:px-6 max-w-5xl mx-auto\",children:[g.jsxs(\"div\",{className:\"flex items-center gap-3 min-w-0\",children:[g.jsx(\"div\",{className:\"h-9 w-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm\",children:\"GS\"}),g.jsxs(\"div\",{className:\"min-w-0\",children:[g.jsx(\"h1\",{className:\"text-base font-semibold leading-tight\",children:\"Grok Bot Switch\"}),g.jsxs(\"p\",{className:\"text-xs text-muted-foreground\",children:[\"v\",n.version]})]})]}),g.jsxs(\"div\",{className:\"flex items-center gap-1.5\",children:[g.jsxs($e,{variant:\"ghost\",size:\"sm\",onClick:()=>v(!0),title:\"聊天里的切换命令\",children:[g.jsx(S0,{className:\"h-4 w-4\"}),g.jsx(\"span\",{className:\"hidden sm:inline\",children:\"聊天命令\"})]}),g.jsx($e,{variant:\"ghost\",size:\"icon\",onClick:O.toggle,\"aria-label\":\"切换主题\",children:O.dark?g.jsx(I0,{className:\"h-4 w-4\"}):g.jsx(k0,{className:\"h-4 w-4\"})}),g.jsx($e,{variant:\"ghost\",size:\"icon\",onClick:()=>{H()},\"aria-label\":\"刷新\",children:g.jsx(N0,{className:\"h-4 w-4\"})}),g.jsxs($e,{size:\"sm\",onClick:()=>f({editing:null}),children:[g.jsx(Vh,{className:\"h-4 w-4\"}),\"添加\"]})]})]})}),g.jsxs(\"main\",{className:\"max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6\",children:[g.jsxs(\"section\",{className:\"rounded-xl border border-border bg-card p-4 shadow-sm flex flex-wrap items-center gap-4\",children:[g.jsxs(\"div\",{className:\"flex-1 min-w-[220px]\",children:[g.jsx(\"p\",{className:\"text-xs text-muted-foreground\",children:\"当前对话使用\"}),g.jsxs(\"div\",{className:\"flex flex-wrap items-center gap-2 mt-1\",children:[g.jsx(\"span\",{className:\"text-lg font-semibold\",children:n.route===\"official\"?\"官方 Grok\":n.route===\"external\"?n.active:\"配置有误\"}),n.route===\"external\"&&Z&&g.jsx(xn,{label:Z.protocol===\"anthropic-messages\"?\"Anthropic\":Z.protocol===\"openai-responses\"?\"Responses\":\"Chat\",tone:\"info\"}),ne&&g.jsx(xn,{label:\"等待主程序重启\",tone:\"warning\",title:\"补丁刚更新，Grok 的 supervisor 会在没有 Bot 忙碌时重启主程序，之后新对话生效。\"})]}),g.jsx(\"p\",{className:\"text-xs text-muted-foreground font-mono break-all mt-1\",children:n.route===\"external\"&&Z?Z.summary:n.route===\"error\"?n.routeError:\"选择下面任一来源后，下一条消息生效\"})]}),g.jsxs(\"div\",{className:\"flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground\",children:[g.jsx(Pu,{ok:Q.exists&&Q.patched,warn:Q.exists&&!Q.patched,label:Q.exists?Q.patched?\"补丁已就位\":\"未打补丁\":\"未找到主程序\"}),g.jsx(Pu,{ok:Q.process!=null&&Q.runningCurrentBundle!==!1,warn:Q.process==null||Q.runningCurrentBundle===!1,label:Q.process?Q.runningCurrentBundle===!1?\"重启待执行\":\"主程序运行中\":\"主程序未运行\"}),g.jsx(Pu,{ok:!Q.supervisor.busy,warn:Q.supervisor.busy,label:Q.supervisor.busy?\"Bot 忙碌中\":\"空闲\"})]})]}),g.jsxs(\"section\",{className:\"space-y-3\",children:[g.jsxs(\"div\",{className:\"flex items-center justify-between px-1\",children:[g.jsx(\"h2\",{className:\"text-sm font-medium text-muted-foreground\",children:\"模型来源\"}),g.jsx(\"span\",{className:\"text-xs text-muted-foreground\",children:q.length?`${q.length} 个自定义来源`:\"\"})]}),g.jsx(Ch,{name:\"official\",provider:null,active:n.route===\"official\",busy:a!=null,switching:a===\"official\",onUse:()=>{$(\"official\",()=>Mt.official(),\"已切回官方 Grok，下一条消息生效\")}}),q.length===0&&g.jsx(\"div\",{className:\"rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground\",children:'还没有自定义模型来源。点右上角\"添加\"，或在下方用 ChatGPT 登录。'}),q.map(I=>g.jsx(Ch,{name:I,provider:n.providers[I],active:n.active===I,busy:a!=null,switching:a===\"use:\"+I,onUse:()=>{$(\"use:\"+I,()=>Mt.use(I))},onEdit:()=>f({editing:I}),onTest:()=>{W(I)},onDelete:()=>m({kind:\"delete\",name:I})},I))]}),g.jsxs(\"section\",{className:\"space-y-3\",children:[g.jsx(\"h2\",{className:\"text-sm font-medium text-muted-foreground px-1\",children:\"ChatGPT 订阅\"}),g.jsx(\"article\",{className:\"rounded-xl border border-border bg-card p-4 shadow-sm\",children:g.jsxs(\"div\",{className:\"flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between\",children:[g.jsxs(\"div\",{className:\"flex min-w-0 flex-1 items-start gap-3\",children:[g.jsx(\"div\",{className:\"h-9 w-9 flex-shrink-0 rounded-lg bg-muted flex items-center justify-center border border-border\",children:g.jsx(Bh,{size:20})}),g.jsxs(\"div\",{className:\"min-w-0 flex-1 space-y-2\",children:[g.jsxs(\"div\",{className:\"flex flex-wrap items-center gap-2\",children:[g.jsx(\"h3\",{className:\"text-base font-semibold\",children:\"用 ChatGPT Plus / Pro 额度\"}),fe.installed?fe.loggedIn?g.jsx(xn,{label:\"已登录\",tone:\"success\"}):g.jsx(xn,{label:\"未登录\",tone:\"muted\"}):g.jsx(xn,{label:\"未安装 Codex CLI\",tone:\"warning\"}),g.jsx(xn,{label:\"实验性\",tone:\"muted\",title:\"让 Codex 后端为非 Codex 程序提供服务，在 OpenAI 条款上属擦边行为，账号有被限制的可能。\"})]}),g.jsx(\"p\",{className:\"text-xs text-muted-foreground\",children:\"不需要 API key，登录在你自己的设备上完成，云端只保存登录凭据。\"}),fe.installed&&J?.status===\"running\"&&g.jsxs(\"ol\",{className:\"text-sm space-y-1 list-decimal pl-5\",children:[g.jsxs(\"li\",{children:[\"在你自己的手机或电脑浏览器打开 \",g.jsx(\"span\",{className:\"font-mono font-semibold break-all\",children:J.url??\"…\"})]}),g.jsxs(\"li\",{children:[\"输入验证码 \",g.jsx(\"span\",{className:\"font-mono text-2xl font-bold tracking-widest text-primary\",children:J.code??\"获取中…\"})]}),g.jsx(\"li\",{children:\"登录完成后这里会自动更新\"})]}),fe.installed&&J?.status!==\"running\"&&g.jsxs(\"div\",{className:\"grid gap-3 sm:grid-cols-2 max-w-xl\",children:[g.jsxs(\"div\",{className:\"space-y-1\",children:[g.jsx(Ot,{htmlFor:\"codex-name\",children:\"保存为来源名\"}),g.jsx(Gn,{id:\"codex-name\",value:b,onChange:I=>_(I.target.value)})]}),g.jsxs(\"div\",{className:\"space-y-1\",children:[g.jsx(Ot,{htmlFor:\"codex-model\",children:\"模型\"}),g.jsx(Gn,{id:\"codex-model\",value:L,onChange:I=>T(I.target.value),placeholder:\"gpt-5.4\"})]})]}),J?.status===\"done\"&&g.jsxs(\"p\",{className:\"text-sm text-emerald-600 dark:text-emerald-400\",children:[\"登录成功，已保存来源。\",J.error]}),J?.status===\"failed\"&&g.jsx(\"p\",{className:\"text-sm text-red-600 dark:text-red-300\",children:J.error??\"登录失败\"}),ee?.status===\"failed\"&&g.jsx(\"p\",{className:\"text-sm text-red-600 dark:text-red-300\",children:ee.error}),!fe.installed&&ee?.output&&g.jsx(\"pre\",{className:\"text-xs bg-muted rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap\",children:ee.output})]})]}),g.jsx(\"div\",{className:\"flex-shrink-0\",children:fe.installed?J?.status===\"running\"?g.jsx($e,{size:\"sm\",variant:\"outline\",onClick:()=>{$(\"codex-cancel\",()=>Mt.codexCancel(),\"已取消\")},children:\"取消\"}):g.jsx($e,{size:\"sm\",disabled:a!=null,onClick:()=>{$(\"codex-login\",()=>Mt.codexLogin(b||\"chatgpt\",L),\"已开始登录流程\")},children:fe.loggedIn?\"重新登录并保存\":\"登录 ChatGPT\"}):g.jsx($e,{size:\"sm\",disabled:a!=null||ee?.status===\"running\",onClick:()=>{$(\"codex-install\",()=>Mt.codexInstall(),\"开始安装 Codex CLI\")},children:ee?.status===\"running\"?\"安装中…\":\"安装 Codex CLI\"})})]})})]}),g.jsxs(\"section\",{className:\"space-y-3\",children:[g.jsx(\"h2\",{className:\"text-sm font-medium text-muted-foreground px-1\",children:\"用量与记录\"}),g.jsxs(\"div\",{className:\"rounded-xl border border-border bg-card p-4 shadow-sm space-y-3\",children:[Object.keys(n.usage).length===0?g.jsx(\"p\",{className:\"text-sm text-muted-foreground\",children:\"还没有外部请求。\"}):g.jsxs(\"table\",{className:\"w-full text-sm\",children:[g.jsx(\"thead\",{children:g.jsxs(\"tr\",{className:\"text-xs text-muted-foreground\",children:[g.jsx(\"th\",{className:\"text-left font-medium pb-2\",children:\"来源\"}),g.jsx(\"th\",{className:\"text-right font-medium pb-2\",children:\"请求\"}),g.jsx(\"th\",{className:\"text-right font-medium pb-2\",children:\"失败\"}),g.jsx(\"th\",{className:\"text-right font-medium pb-2\",children:\"输入 token\"}),g.jsx(\"th\",{className:\"text-right font-medium pb-2\",children:\"输出 token\"})]})}),g.jsx(\"tbody\",{children:Object.entries(n.usage).map(([I,U])=>g.jsxs(\"tr\",{className:\"border-t border-border\",children:[g.jsx(\"td\",{className:\"py-2\",children:I}),g.jsx(\"td\",{className:\"py-2 text-right\",children:U.requests}),g.jsx(\"td\",{className:\"py-2 text-right\",children:U.failed}),g.jsx(\"td\",{className:\"py-2 text-right\",children:U.promptTokens.toLocaleString()}),g.jsx(\"td\",{className:\"py-2 text-right\",children:U.completionTokens.toLocaleString()})]},I))})]}),n.recent.length>0&&g.jsx(\"pre\",{className:\"text-xs bg-muted rounded-lg p-3 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono\",children:n.recent.map(sb).join(`\n`)})]})]}),g.jsxs(\"section\",{children:[g.jsxs(\"button\",{type:\"button\",className:\"flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground px-1\",onClick:()=>C(I=>!I),children:[S?g.jsx(Zu,{className:\"h-4 w-4\"}):g.jsx(u0,{className:\"h-4 w-4\"}),g.jsx(F0,{className:\"h-4 w-4\"}),\"主程序与补丁状态 · 维护操作\"]}),S&&g.jsxs(\"div\",{className:\"mt-3 rounded-xl border border-border bg-card p-4 shadow-sm space-y-3 text-sm\",children:[g.jsxs(\"dl\",{className:\"grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs\",children:[g.jsx(\"dt\",{className:\"text-muted-foreground\",children:\"主程序\"}),g.jsxs(\"dd\",{className:\"break-all\",children:[Q.path,Q.version?` · ${Q.version}`:\"\",\" · \",Q.patched?`已打补丁 ${Q.patchVersion}`:\"未打补丁\"]}),g.jsx(\"dt\",{className:\"text-muted-foreground\",children:\"进程\"}),g.jsx(\"dd\",{children:Q.process?`pid ${Q.process.pid}${Q.process.startedAtMs?\" · 启动于 \"+new Date(Q.process.startedAtMs).toLocaleString():\"\"}`:\"未运行\"}),g.jsx(\"dt\",{className:\"text-muted-foreground\",children:\"supervisor\"}),g.jsxs(\"dd\",{children:[Q.supervisor.busy?\"有 Bot 在忙\":\"空闲\",Q.supervisor.pending?` · 待处理命令 ${Q.supervisor.pending.id}`:\"\"]}),g.jsx(\"dt\",{className:\"text-muted-foreground\",children:\"配置文件\"}),g.jsx(\"dd\",{className:\"break-all\",children:n.configPath})]}),g.jsxs(\"div\",{className:\"flex flex-wrap gap-2\",children:[g.jsx($e,{variant:\"outline\",size:\"sm\",disabled:a!=null,onClick:()=>{$(\"restart\",()=>Mt.restart())},children:\"请求重启主程序\"}),g.jsx($e,{variant:\"outline\",size:\"sm\",disabled:a!=null,className:\"text-destructive\",onClick:()=>m({kind:\"restore\"}),children:\"卸载补丁并恢复原厂\"})]})]})]})]}),d&&g.jsx(rb,{editing:d.editing,initial:d.editing?n.providers[d.editing]:null,takenNames:q,onClose:()=>f(null),onSaved:X}),g.jsx(hS,{isOpen:h!=null,title:h?.kind===\"delete\"?`删除来源 ${h.name}`:\"卸载补丁\",message:h?.kind===\"delete\"?\"只删除这条配置，不影响其它来源。\":\"主程序恢复为原厂文件并重启一次；已保存的来源配置不会删除。\",confirmText:h?.kind===\"delete\"?\"删除\":\"卸载\",pending:a!=null,onCancel:()=>m(null),onConfirm:()=>{const I=h;m(null),I&&(I.kind===\"delete\"?$(\"delete\",()=>Mt.deleteProvider(I.name),`已删除 ${I.name}`):$(\"restore\",()=>Mt.restore()))}}),g.jsx(ac,{open:w,onOpenChange:v,children:g.jsxs(qi,{children:[g.jsxs(uc,{children:[g.jsx(Ji,{children:\"在聊天里切换\"}),g.jsx(el,{children:\"这些消息在云端主程序里直接处理，不发给任何模型、不花 token，任何平台都一样。\"})]}),g.jsxs(\"div\",{className:\"space-y-2 text-sm\",children:[g.jsxs(\"p\",{children:[g.jsx(\"code\",{className:\"rounded bg-muted px-1.5 py-0.5 font-mono\",children:\"/gs use 名字\"}),\" 切到某个来源，下一条消息生效\"]}),g.jsxs(\"p\",{children:[g.jsx(\"code\",{className:\"rounded bg-muted px-1.5 py-0.5 font-mono\",children:\"/gs official\"}),\" 切回官方 Grok\"]}),g.jsxs(\"p\",{children:[g.jsx(\"code\",{className:\"rounded bg-muted px-1.5 py-0.5 font-mono\",children:\"/gs status\"}),\" 看当前走哪里、保存了哪些来源\"]}),g.jsx(\"p\",{className:\"text-muted-foreground text-xs pt-2\",children:'添加来源（带 key）只能在这个面板或云端终端里做；聊天命令不接受 key。给用外部模型的 Bot 建议关掉\"本机执行\"，否则模型可能把命令跑到你自己的电脑上。'})]}),g.jsx(cc,{children:g.jsx($e,{onClick:()=>v(!1),children:\"知道了\"})})]})}),g.jsx(\"div\",{className:\"fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-[min(520px,calc(100vw-32px))] pointer-events-none\",children:k.map(I=>g.jsx(\"div\",{className:Ve(\"rounded-lg px-4 py-2.5 text-sm shadow-lg text-white break-all\",I.tone===\"ok\"?\"bg-emerald-700\":I.tone===\"bad\"?\"bg-red-700\":\"bg-slate-800\"),children:I.text},I.id))})]})}function Pu({ok:n,warn:r,label:s}){return g.jsxs(\"span\",{className:\"inline-flex items-center gap-1.5\",children:[g.jsx(\"span\",{className:Ve(\"h-2 w-2 rounded-full\",n?\"bg-emerald-500\":r?\"bg-amber-500\":\"bg-red-500\")}),s]})}ix.createRoot(document.getElementById(\"root\")).render(g.jsx(jh.StrictMode,{children:g.jsx(ib,{})}));</script>\n    <style rel=\"stylesheet\" crossorigin>*,:before,:after{--tw-border-spacing-x: 0;--tw-border-spacing-y: 0;--tw-translate-x: 0;--tw-translate-y: 0;--tw-rotate: 0;--tw-skew-x: 0;--tw-skew-y: 0;--tw-scale-x: 1;--tw-scale-y: 1;--tw-pan-x: ;--tw-pan-y: ;--tw-pinch-zoom: ;--tw-scroll-snap-strictness: proximity;--tw-gradient-from-position: ;--tw-gradient-via-position: ;--tw-gradient-to-position: ;--tw-ordinal: ;--tw-slashed-zero: ;--tw-numeric-figure: ;--tw-numeric-spacing: ;--tw-numeric-fraction: ;--tw-ring-inset: ;--tw-ring-offset-width: 0px;--tw-ring-offset-color: #fff;--tw-ring-color: rgb(10 132 255 / .5);--tw-ring-offset-shadow: 0 0 #0000;--tw-ring-shadow: 0 0 #0000;--tw-shadow: 0 0 #0000;--tw-shadow-colored: 0 0 #0000;--tw-blur: ;--tw-brightness: ;--tw-contrast: ;--tw-grayscale: ;--tw-hue-rotate: ;--tw-invert: ;--tw-saturate: ;--tw-sepia: ;--tw-drop-shadow: ;--tw-backdrop-blur: ;--tw-backdrop-brightness: ;--tw-backdrop-contrast: ;--tw-backdrop-grayscale: ;--tw-backdrop-hue-rotate: ;--tw-backdrop-invert: ;--tw-backdrop-opacity: ;--tw-backdrop-saturate: ;--tw-backdrop-sepia: ;--tw-contain-size: ;--tw-contain-layout: ;--tw-contain-paint: ;--tw-contain-style: }::backdrop{--tw-border-spacing-x: 0;--tw-border-spacing-y: 0;--tw-translate-x: 0;--tw-translate-y: 0;--tw-rotate: 0;--tw-skew-x: 0;--tw-skew-y: 0;--tw-scale-x: 1;--tw-scale-y: 1;--tw-pan-x: ;--tw-pan-y: ;--tw-pinch-zoom: ;--tw-scroll-snap-strictness: proximity;--tw-gradient-from-position: ;--tw-gradient-via-position: ;--tw-gradient-to-position: ;--tw-ordinal: ;--tw-slashed-zero: ;--tw-numeric-figure: ;--tw-numeric-spacing: ;--tw-numeric-fraction: ;--tw-ring-inset: ;--tw-ring-offset-width: 0px;--tw-ring-offset-color: #fff;--tw-ring-color: rgb(10 132 255 / .5);--tw-ring-offset-shadow: 0 0 #0000;--tw-ring-shadow: 0 0 #0000;--tw-shadow: 0 0 #0000;--tw-shadow-colored: 0 0 #0000;--tw-blur: ;--tw-brightness: ;--tw-contrast: ;--tw-grayscale: ;--tw-hue-rotate: ;--tw-invert: ;--tw-saturate: ;--tw-sepia: ;--tw-drop-shadow: ;--tw-backdrop-blur: ;--tw-backdrop-brightness: ;--tw-backdrop-contrast: ;--tw-backdrop-grayscale: ;--tw-backdrop-hue-rotate: ;--tw-backdrop-invert: ;--tw-backdrop-opacity: ;--tw-backdrop-saturate: ;--tw-backdrop-sepia: ;--tw-contain-size: ;--tw-contain-layout: ;--tw-contain-paint: ;--tw-contain-style: }*,:before,:after{box-sizing:border-box;border-width:0;border-style:solid;border-color:#e4e4e7}:before,:after{--tw-content: \"\"}html,:host{line-height:1.5;-webkit-text-size-adjust:100%;-moz-tab-size:4;-o-tab-size:4;tab-size:4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;font-feature-settings:normal;font-variation-settings:normal;-webkit-tap-highlight-color:transparent}body{margin:0;line-height:inherit}hr{height:0;color:inherit;border-top-width:1px}abbr:where([title]){-webkit-text-decoration:underline dotted;text-decoration:underline dotted}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;text-decoration:inherit}b,strong{font-weight:bolder}code,kbd,samp,pre{font-family:ui-monospace,SFMono-Regular,SF Mono,Consolas,Liberation Mono,Menlo,monospace;font-feature-settings:normal;font-variation-settings:normal;font-size:1em}small{font-size:80%}sub,sup{font-size:75%;line-height:0;position:relative;vertical-align:baseline}sub{bottom:-.25em}sup{top:-.5em}table{text-indent:0;border-color:inherit;border-collapse:collapse}button,input,optgroup,select,textarea{font-family:inherit;font-feature-settings:inherit;font-variation-settings:inherit;font-size:100%;font-weight:inherit;line-height:inherit;letter-spacing:inherit;color:inherit;margin:0;padding:0}button,select{text-transform:none}button,input:where([type=button]),input:where([type=reset]),input:where([type=submit]){-webkit-appearance:button;background-color:transparent;background-image:none}:-moz-focusring{outline:auto}:-moz-ui-invalid{box-shadow:none}progress{vertical-align:baseline}::-webkit-inner-spin-button,::-webkit-outer-spin-button{height:auto}[type=search]{-webkit-appearance:textfield;outline-offset:-2px}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-file-upload-button{-webkit-appearance:button;font:inherit}summary{display:list-item}blockquote,dl,dd,h1,h2,h3,h4,h5,h6,hr,figure,p,pre{margin:0}fieldset{margin:0;padding:0}legend{padding:0}ol,ul,menu{list-style:none;margin:0;padding:0}dialog{padding:0}textarea{resize:vertical}input::-moz-placeholder,textarea::-moz-placeholder{opacity:1;color:#a1a1aa}input::placeholder,textarea::placeholder{opacity:1;color:#a1a1aa}button,[role=button]{cursor:pointer}:disabled{cursor:default}img,svg,video,canvas,audio,iframe,embed,object{display:block;vertical-align:middle}img,video{max-width:100%;height:auto}[hidden]:where(:not([hidden=until-found])){display:none}:root{--background: 0 0% 100%;--foreground: 240 10% 3.9%;--card: 0 0% 100%;--card-foreground: 240 10% 3.9%;--popover: 0 0% 100%;--popover-foreground: 240 10% 3.9%;--primary: 210 100% 56%;--primary-foreground: 0 0% 100%;--secondary: 240 4.8% 95.9%;--secondary-foreground: 240 5.9% 10%;--muted: 240 4.8% 95.9%;--muted-foreground: 240 3.8% 46.1%;--accent: 240 4.8% 95.9%;--accent-foreground: 240 5.9% 10%;--destructive: 0 84.2% 60.2%;--destructive-foreground: 0 0% 98%;--border: 240 5.9% 90%;--input: 240 5.9% 90%;--ring: 210 100% 56%;--radius: .5rem}.dark{--background: 240 5% 12%;--foreground: 0 0% 98%;--card: 240 5% 16%;--card-foreground: 0 0% 98%;--popover: 240 5% 16%;--popover-foreground: 0 0% 98%;--primary: 210 100% 54%;--primary-foreground: 0 0% 100%;--secondary: 240 5% 18%;--secondary-foreground: 0 0% 98%;--muted: 240 5% 18%;--muted-foreground: 240 5% 64.9%;--accent: 240 5% 18%;--accent-foreground: 0 0% 98%;--destructive: 0 62.8% 30.6%;--destructive-foreground: 0 0% 98%;--border: 240 5% 24%;--input: 240 5% 24%;--ring: 210 100% 54%}*{box-sizing:border-box}html{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;color-scheme:light}html.dark{color-scheme:dark}body{margin:0;background-color:hsl(var(--background));font-size:.875rem;line-height:1.25rem;color:hsl(var(--foreground))}button,a,input,select{touch-action:manipulation}button{min-height:36px}:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:3px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}.pointer-events-none{pointer-events:none}.visible{visibility:visible}.fixed{position:fixed}.absolute{position:absolute}.relative{position:relative}.sticky{position:sticky}.inset-0{inset:0}.inset-y-0{top:0;bottom:0}.bottom-6{bottom:1.5rem}.left-1\\/2{left:50%}.left-2{left:.5rem}.right-0{right:0}.top-0{top:0}.top-1\\/2{top:50%}.z-30{z-index:30}.z-40{z-index:40}.z-50{z-index:50}.z-\\[100\\]{z-index:100}.z-\\[110\\]{z-index:110}.z-\\[60\\]{z-index:60}.-mx-1{margin-left:-.25rem;margin-right:-.25rem}.mx-auto{margin-left:auto;margin-right:auto}.my-1{margin-top:.25rem;margin-bottom:.25rem}.mb-1{margin-bottom:.25rem}.mt-0\\.5{margin-top:.125rem}.mt-1{margin-top:.25rem}.mt-3{margin-top:.75rem}.block{display:block}.flex{display:flex}.inline-flex{display:inline-flex}.table{display:table}.grid{display:grid}.hidden{display:none}.h-10{height:2.5rem}.h-16{height:4rem}.h-2{height:.5rem}.h-3\\.5{height:.875rem}.h-4{height:1rem}.h-5{height:1.25rem}.h-7{height:1.75rem}.h-8{height:2rem}.h-9{height:2.25rem}.h-\\[var\\(--radix-select-trigger-height\\)\\]{height:var(--radix-select-trigger-height)}.h-px{height:1px}.h-screen{height:100vh}.max-h-40{max-height:10rem}.max-h-56{max-height:14rem}.max-h-\\[90vh\\]{max-height:90vh}.max-h-\\[min\\(24rem\\,var\\(--radix-select-content-available-height\\)\\)\\]{max-height:min(24rem,var(--radix-select-content-available-height))}.min-h-7{min-height:1.75rem}.min-h-screen{min-height:100vh}.w-2{width:.5rem}.w-3\\.5{width:.875rem}.w-4{width:1rem}.w-5{width:1.25rem}.w-8{width:2rem}.w-9{width:2.25rem}.w-\\[min\\(520px\\,calc\\(100vw-32px\\)\\)\\]{width:min(520px,calc(100vw - 32px))}.w-fit{width:-moz-fit-content;width:fit-content}.w-full{width:100%}.w-screen{width:100vw}.min-w-0{min-width:0px}.min-w-\\[220px\\]{min-width:220px}.min-w-\\[8rem\\]{min-width:8rem}.min-w-\\[var\\(--radix-select-trigger-width\\)\\]{min-width:var(--radix-select-trigger-width)}.max-w-3xl{max-width:48rem}.max-w-4xl{max-width:56rem}.max-w-5xl{max-width:64rem}.max-w-lg{max-width:32rem}.max-w-sm{max-width:24rem}.max-w-xl{max-width:36rem}.max-w-xs{max-width:20rem}.flex-1{flex:1 1 0%}.flex-shrink-0,.shrink-0{flex-shrink:0}.-translate-x-1\\/2{--tw-translate-x: -50%;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skew(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.translate-x-0{--tw-translate-x: 0px;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skew(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.translate-x-\\[-50\\%\\]{--tw-translate-x: -50%;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skew(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.translate-y-0{--tw-translate-y: 0px;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skew(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.translate-y-\\[-50\\%\\]{--tw-translate-y: -50%;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skew(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.cursor-default{cursor:default}.cursor-help{cursor:help}.cursor-not-allowed{cursor:not-allowed}.cursor-pointer{cursor:pointer}.select-none{-webkit-user-select:none;-moz-user-select:none;user-select:none}.list-decimal{list-style-type:decimal}.grid-cols-\\[auto_1fr\\]{grid-template-columns:auto 1fr}.flex-col{flex-direction:column}.flex-col-reverse{flex-direction:column-reverse}.flex-wrap{flex-wrap:wrap}.items-start{align-items:flex-start}.items-center{align-items:center}.justify-end{justify-content:flex-end}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.gap-1{gap:.25rem}.gap-1\\.5{gap:.375rem}.gap-2{gap:.5rem}.gap-3{gap:.75rem}.gap-4{gap:1rem}.gap-x-3{-moz-column-gap:.75rem;column-gap:.75rem}.gap-x-4{-moz-column-gap:1rem;column-gap:1rem}.gap-y-1{row-gap:.25rem}.space-y-1>:not([hidden])~:not([hidden]){--tw-space-y-reverse: 0;margin-top:calc(.25rem * calc(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.25rem * var(--tw-space-y-reverse))}.space-y-1\\.5>:not([hidden])~:not([hidden]){--tw-space-y-reverse: 0;margin-top:calc(.375rem * calc(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.375rem * var(--tw-space-y-reverse))}.space-y-2>:not([hidden])~:not([hidden]){--tw-space-y-reverse: 0;margin-top:calc(.5rem * calc(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.5rem * var(--tw-space-y-reverse))}.space-y-3>:not([hidden])~:not([hidden]){--tw-space-y-reverse: 0;margin-top:calc(.75rem * calc(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.75rem * var(--tw-space-y-reverse))}.space-y-6>:not([hidden])~:not([hidden]){--tw-space-y-reverse: 0;margin-top:calc(1.5rem * calc(1 - var(--tw-space-y-reverse)));margin-bottom:calc(1.5rem * var(--tw-space-y-reverse))}.overflow-auto{overflow:auto}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}.overflow-x-hidden{overflow-x:hidden}.overscroll-contain{overscroll-behavior:contain}.whitespace-nowrap{white-space:nowrap}.whitespace-pre-line{white-space:pre-line}.whitespace-pre-wrap{white-space:pre-wrap}.break-words{overflow-wrap:break-word}.break-all{word-break:break-all}.rounded{border-radius:.25rem}.rounded-full{border-radius:9999px}.rounded-lg{border-radius:.75rem}.rounded-md{border-radius:.5rem}.rounded-sm{border-radius:.375rem}.rounded-xl{border-radius:.875rem}.border{border-width:1px}.border-b{border-bottom-width:1px}.border-b-0{border-bottom-width:0px}.border-l{border-left-width:1px}.border-t{border-top-width:1px}.border-t-0{border-top-width:0px}.border-dashed{border-style:dashed}.border-blue-500\\/60{border-color:#0a84ff99}.border-border{border-color:hsl(var(--border))}.border-primary{border-color:hsl(var(--primary))}.bg-amber-100{--tw-bg-opacity: 1;background-color:rgb(254 243 199 / var(--tw-bg-opacity, 1))}.bg-amber-500{--tw-bg-opacity: 1;background-color:rgb(245 158 11 / var(--tw-bg-opacity, 1))}.bg-background{background-color:hsl(var(--background))}.bg-background\\/95{background-color:hsl(var(--background) / .95)}.bg-black\\/50{background-color:#00000080}.bg-blue-500{--tw-bg-opacity: 1;background-color:rgb(10 132 255 / var(--tw-bg-opacity, 1))}.bg-card{background-color:hsl(var(--card))}.bg-emerald-100{--tw-bg-opacity: 1;background-color:rgb(209 250 229 / var(--tw-bg-opacity, 1))}.bg-emerald-500{--tw-bg-opacity: 1;background-color:rgb(16 185 129 / var(--tw-bg-opacity, 1))}.bg-emerald-700{--tw-bg-opacity: 1;background-color:rgb(4 120 87 / var(--tw-bg-opacity, 1))}.bg-muted{background-color:hsl(var(--muted))}.bg-muted\\/20{background-color:hsl(var(--muted) / .2)}.bg-muted\\/40{background-color:hsl(var(--muted) / .4)}.bg-popover{background-color:hsl(var(--popover))}.bg-primary{background-color:hsl(var(--primary))}.bg-red-500{--tw-bg-opacity: 1;background-color:rgb(239 68 68 / var(--tw-bg-opacity, 1))}.bg-red-700{--tw-bg-opacity: 1;background-color:rgb(185 28 28 / var(--tw-bg-opacity, 1))}.bg-sky-100{--tw-bg-opacity: 1;background-color:rgb(224 242 254 / var(--tw-bg-opacity, 1))}.bg-slate-200{--tw-bg-opacity: 1;background-color:rgb(226 232 240 / var(--tw-bg-opacity, 1))}.bg-slate-800{--tw-bg-opacity: 1;background-color:rgb(30 41 59 / var(--tw-bg-opacity, 1))}.bg-transparent{background-color:transparent}.bg-white{--tw-bg-opacity: 1;background-color:rgb(255 255 255 / var(--tw-bg-opacity, 1))}.p-0{padding:0}.p-1{padding:.25rem}.p-1\\.5{padding:.375rem}.p-2{padding:.5rem}.p-3{padding:.75rem}.p-4{padding:1rem}.p-6{padding:1.5rem}.p-8{padding:2rem}.px-1{padding-left:.25rem;padding-right:.25rem}.px-1\\.5{padding-left:.375rem;padding-right:.375rem}.px-2{padding-left:.5rem;padding-right:.5rem}.px-2\\.5{padding-left:.625rem;padding-right:.625rem}.px-3{padding-left:.75rem;padding-right:.75rem}.px-4{padding-left:1rem;padding-right:1rem}.px-6{padding-left:1.5rem;padding-right:1.5rem}.px-8{padding-left:2rem;padding-right:2rem}.py-0\\.5{padding-top:.125rem;padding-bottom:.125rem}.py-1{padding-top:.25rem;padding-bottom:.25rem}.py-1\\.5{padding-top:.375rem;padding-bottom:.375rem}.py-2{padding-top:.5rem;padding-bottom:.5rem}.py-2\\.5{padding-top:.625rem;padding-bottom:.625rem}.py-4{padding-top:1rem;padding-bottom:1rem}.py-5{padding-top:1.25rem;padding-bottom:1.25rem}.py-6{padding-top:1.5rem;padding-bottom:1.5rem}.pb-0{padding-bottom:0}.pb-2{padding-bottom:.5rem}.pl-3{padding-left:.75rem}.pl-5{padding-left:1.25rem}.pl-7{padding-left:1.75rem}.pr-10{padding-right:2.5rem}.pr-2{padding-right:.5rem}.pr-3{padding-right:.75rem}.pt-2{padding-top:.5rem}.pt-3{padding-top:.75rem}.text-left{text-align:left}.text-center{text-align:center}.text-right{text-align:right}.font-mono{font-family:ui-monospace,SFMono-Regular,SF Mono,Consolas,Liberation Mono,Menlo,monospace}.text-2xl{font-size:1.5rem;line-height:2rem}.text-\\[10px\\]{font-size:10px}.text-base{font-size:1rem;line-height:1.5rem}.text-lg{font-size:1.125rem;line-height:1.75rem}.text-sm{font-size:.875rem;line-height:1.25rem}.text-xs{font-size:.75rem;line-height:1rem}.font-bold{font-weight:700}.font-medium{font-weight:500}.font-semibold{font-weight:600}.leading-none{line-height:1}.leading-relaxed{line-height:1.625}.leading-snug{line-height:1.375}.leading-tight{line-height:1.25}.tracking-tight{letter-spacing:-.025em}.tracking-widest{letter-spacing:.1em}.text-amber-600{--tw-text-opacity: 1;color:rgb(217 119 6 / var(--tw-text-opacity, 1))}.text-amber-700{--tw-text-opacity: 1;color:rgb(180 83 9 / var(--tw-text-opacity, 1))}.text-blue-500{--tw-text-opacity: 1;color:rgb(10 132 255 / var(--tw-text-opacity, 1))}.text-card-foreground{color:hsl(var(--card-foreground))}.text-destructive{color:hsl(var(--destructive))}.text-emerald-600{--tw-text-opacity: 1;color:rgb(5 150 105 / var(--tw-text-opacity, 1))}.text-emerald-700{--tw-text-opacity: 1;color:rgb(4 120 87 / var(--tw-text-opacity, 1))}.text-foreground{color:hsl(var(--foreground))}.text-gray-500{--tw-text-opacity: 1;color:rgb(113 113 122 / var(--tw-text-opacity, 1))}.text-muted-foreground{color:hsl(var(--muted-foreground))}.text-popover-foreground{color:hsl(var(--popover-foreground))}.text-primary{color:hsl(var(--primary))}.text-primary-foreground{color:hsl(var(--primary-foreground))}.text-red-600{--tw-text-opacity: 1;color:rgb(220 38 38 / var(--tw-text-opacity, 1))}.text-sky-700{--tw-text-opacity: 1;color:rgb(3 105 161 / var(--tw-text-opacity, 1))}.text-slate-700{--tw-text-opacity: 1;color:rgb(51 65 85 / var(--tw-text-opacity, 1))}.text-white{--tw-text-opacity: 1;color:rgb(255 255 255 / var(--tw-text-opacity, 1))}.underline-offset-4{text-underline-offset:4px}.opacity-50{opacity:.5}.shadow-lg{--tw-shadow: 0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1);--tw-shadow-colored: 0 10px 15px -3px var(--tw-shadow-color), 0 4px 6px -4px var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000),var(--tw-ring-shadow, 0 0 #0000),var(--tw-shadow)}.shadow-md{--tw-shadow: 0 4px 6px -1px rgb(0 0 0 / .1), 0 2px 4px -2px rgb(0 0 0 / .1);--tw-shadow-colored: 0 4px 6px -1px var(--tw-shadow-color), 0 2px 4px -2px var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000),var(--tw-ring-shadow, 0 0 #0000),var(--tw-shadow)}.shadow-none{--tw-shadow: 0 0 #0000;--tw-shadow-colored: 0 0 #0000;box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000),var(--tw-ring-shadow, 0 0 #0000),var(--tw-shadow)}.shadow-sm{--tw-shadow: 0 1px 2px 0 rgb(0 0 0 / .05);--tw-shadow-colored: 0 1px 2px 0 var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000),var(--tw-ring-shadow, 0 0 #0000),var(--tw-shadow)}.shadow-blue-500\\/10{--tw-shadow-color: rgb(10 132 255 / .1);--tw-shadow: var(--tw-shadow-colored)}.outline-none{outline:2px solid transparent;outline-offset:2px}.outline{outline-style:solid}.ring-offset-background{--tw-ring-offset-color: hsl(var(--background))}.blur{--tw-blur: blur(8px);filter:var(--tw-blur) var(--tw-brightness) var(--tw-contrast) var(--tw-grayscale) var(--tw-hue-rotate) var(--tw-invert) var(--tw-saturate) var(--tw-sepia) var(--tw-drop-shadow)}.filter{filter:var(--tw-blur) var(--tw-brightness) var(--tw-contrast) var(--tw-grayscale) var(--tw-hue-rotate) var(--tw-invert) var(--tw-saturate) var(--tw-sepia) var(--tw-drop-shadow)}.backdrop-blur{--tw-backdrop-blur: blur(8px);-webkit-backdrop-filter:var(--tw-backdrop-blur) var(--tw-backdrop-brightness) var(--tw-backdrop-contrast) var(--tw-backdrop-grayscale) var(--tw-backdrop-hue-rotate) var(--tw-backdrop-invert) var(--tw-backdrop-opacity) var(--tw-backdrop-saturate) var(--tw-backdrop-sepia);backdrop-filter:var(--tw-backdrop-blur) var(--tw-backdrop-brightness) var(--tw-backdrop-contrast) var(--tw-backdrop-grayscale) var(--tw-backdrop-hue-rotate) var(--tw-backdrop-invert) var(--tw-backdrop-opacity) var(--tw-backdrop-saturate) var(--tw-backdrop-sepia)}.backdrop-blur-sm{--tw-backdrop-blur: blur(4px);-webkit-backdrop-filter:var(--tw-backdrop-blur) var(--tw-backdrop-brightness) var(--tw-backdrop-contrast) var(--tw-backdrop-grayscale) var(--tw-backdrop-hue-rotate) var(--tw-backdrop-invert) var(--tw-backdrop-opacity) var(--tw-backdrop-saturate) var(--tw-backdrop-sepia);backdrop-filter:var(--tw-backdrop-blur) var(--tw-backdrop-brightness) var(--tw-backdrop-contrast) var(--tw-backdrop-grayscale) var(--tw-backdrop-hue-rotate) var(--tw-backdrop-invert) var(--tw-backdrop-opacity) var(--tw-backdrop-saturate) var(--tw-backdrop-sepia)}.transition-colors{transition-property:color,background-color,border-color,text-decoration-color,fill,stroke;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:.15s}.duration-200{transition-duration:.2s}.border-border-default{border-color:hsl(var(--border))}.workspace{background:hsl(var(--muted) / .6);min-height:100vh}.endpoint{overflow-wrap:anywhere;word-break:break-word;font-variant-numeric:tabular-nums}.provider-card{transition-property:border-color,box-shadow}.provider-actions{flex-wrap:wrap}.provider-actions button{min-width:36px}.dialog-scroll{overflow-y:auto;overscroll-behavior:contain;padding:24px}@media(max-width:639px){button{min-height:40px}.provider-actions button{min-width:40px}.dialog-scroll{padding:16px}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}.file\\:border-0::file-selector-button{border-width:0px}.file\\:bg-transparent::file-selector-button{background-color:transparent}.file\\:text-sm::file-selector-button{font-size:.875rem;line-height:1.25rem}.file\\:font-medium::file-selector-button{font-weight:500}.file\\:text-foreground::file-selector-button{color:hsl(var(--foreground))}.placeholder\\:text-muted-foreground::-moz-placeholder{color:hsl(var(--muted-foreground))}.placeholder\\:text-muted-foreground::placeholder{color:hsl(var(--muted-foreground))}.hover\\:border-primary\\/60:hover{border-color:hsl(var(--primary) / .6)}.hover\\:bg-blue-600:hover{--tw-bg-opacity: 1;background-color:rgb(0 96 223 / var(--tw-bg-opacity, 1))}.hover\\:bg-emerald-600:hover{--tw-bg-opacity: 1;background-color:rgb(5 150 105 / var(--tw-bg-opacity, 1))}.hover\\:bg-gray-100:hover{--tw-bg-opacity: 1;background-color:rgb(244 244 245 / var(--tw-bg-opacity, 1))}.hover\\:bg-muted\\/50:hover{background-color:hsl(var(--muted) / .5)}.hover\\:bg-red-600:hover{--tw-bg-opacity: 1;background-color:rgb(220 38 38 / var(--tw-bg-opacity, 1))}.hover\\:text-destructive:hover{color:hsl(var(--destructive))}.hover\\:text-foreground:hover{color:hsl(var(--foreground))}.hover\\:text-gray-900:hover{--tw-text-opacity: 1;color:rgb(44 44 46 / var(--tw-text-opacity, 1))}.hover\\:text-red-500:hover{--tw-text-opacity: 1;color:rgb(239 68 68 / var(--tw-text-opacity, 1))}.hover\\:underline:hover{text-decoration-line:underline}.focus\\:bg-accent:focus{background-color:hsl(var(--accent))}.focus\\:text-accent-foreground:focus{color:hsl(var(--accent-foreground))}.focus\\:outline-none:focus{outline:2px solid transparent;outline-offset:2px}.focus\\:ring-2:focus{--tw-ring-offset-shadow: var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);--tw-ring-shadow: var(--tw-ring-inset) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color);box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),var(--tw-shadow, 0 0 #0000)}.focus\\:ring-blue-500:focus{--tw-ring-opacity: 1;--tw-ring-color: rgb(10 132 255 / var(--tw-ring-opacity, 1))}.focus\\:ring-blue-500\\/20:focus{--tw-ring-color: rgb(10 132 255 / .2)}.focus-visible\\:outline-none:focus-visible{outline:2px solid transparent;outline-offset:2px}.focus-visible\\:ring-1:focus-visible{--tw-ring-offset-shadow: var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);--tw-ring-shadow: var(--tw-ring-inset) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color);box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),var(--tw-shadow, 0 0 #0000)}.focus-visible\\:ring-2:focus-visible{--tw-ring-offset-shadow: var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);--tw-ring-shadow: var(--tw-ring-inset) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color);box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),var(--tw-shadow, 0 0 #0000)}.focus-visible\\:ring-ring:focus-visible{--tw-ring-color: hsl(var(--ring))}.focus-visible\\:ring-offset-1:focus-visible{--tw-ring-offset-width: 1px}.disabled\\:pointer-events-none:disabled{pointer-events:none}.disabled\\:cursor-not-allowed:disabled{cursor:not-allowed}.disabled\\:opacity-50:disabled{opacity:.5}.peer:disabled~.peer-disabled\\:cursor-not-allowed{cursor:not-allowed}.peer:disabled~.peer-disabled\\:opacity-70{opacity:.7}.data-\\[disabled\\]\\:pointer-events-none[data-disabled]{pointer-events:none}.data-\\[disabled\\]\\:opacity-50[data-disabled]{opacity:.5}@media(min-width:640px){.sm\\:inline{display:inline}.sm\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.sm\\:flex-row{flex-direction:row}.sm\\:items-start{align-items:flex-start}.sm\\:items-center{align-items:center}.sm\\:justify-end{justify-content:flex-end}.sm\\:justify-between{justify-content:space-between}.sm\\:rounded-lg{border-radius:.75rem}.sm\\:rounded-none{border-radius:0}.sm\\:px-6{padding-left:1.5rem;padding-right:1.5rem}.sm\\:text-left{text-align:left}}.dark\\:bg-amber-900\\/40:where(.dark,.dark *){background-color:#78350f66}.dark\\:bg-blue-600:where(.dark,.dark *){--tw-bg-opacity: 1;background-color:rgb(0 96 223 / var(--tw-bg-opacity, 1))}.dark\\:bg-emerald-600:where(.dark,.dark *){--tw-bg-opacity: 1;background-color:rgb(5 150 105 / var(--tw-bg-opacity, 1))}.dark\\:bg-emerald-900\\/40:where(.dark,.dark *){background-color:#064e3b66}.dark\\:bg-gray-800:where(.dark,.dark *){--tw-bg-opacity: 1;background-color:rgb(58 58 60 / var(--tw-bg-opacity, 1))}.dark\\:bg-red-600:where(.dark,.dark *){--tw-bg-opacity: 1;background-color:rgb(220 38 38 / var(--tw-bg-opacity, 1))}.dark\\:bg-sky-900\\/40:where(.dark,.dark *){background-color:#0c4a6e66}.dark\\:bg-slate-700\\/60:where(.dark,.dark *){background-color:#33415599}.dark\\:text-amber-300:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(252 211 77 / var(--tw-text-opacity, 1))}.dark\\:text-amber-400:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(251 191 36 / var(--tw-text-opacity, 1))}.dark\\:text-blue-400:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(64 156 255 / var(--tw-text-opacity, 1))}.dark\\:text-emerald-300:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(110 231 183 / var(--tw-text-opacity, 1))}.dark\\:text-emerald-400:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(52 211 153 / var(--tw-text-opacity, 1))}.dark\\:text-gray-400:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(161 161 170 / var(--tw-text-opacity, 1))}.dark\\:text-red-300:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(252 165 165 / var(--tw-text-opacity, 1))}.dark\\:text-sky-300:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(125 211 252 / var(--tw-text-opacity, 1))}.dark\\:text-slate-200:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(226 232 240 / var(--tw-text-opacity, 1))}.dark\\:hover\\:bg-blue-700:hover:where(.dark,.dark *){--tw-bg-opacity: 1;background-color:rgb(29 78 216 / var(--tw-bg-opacity, 1))}.dark\\:hover\\:bg-emerald-700:hover:where(.dark,.dark *){--tw-bg-opacity: 1;background-color:rgb(4 120 87 / var(--tw-bg-opacity, 1))}.dark\\:hover\\:bg-gray-800:hover:where(.dark,.dark *){--tw-bg-opacity: 1;background-color:rgb(58 58 60 / var(--tw-bg-opacity, 1))}.dark\\:hover\\:bg-red-700:hover:where(.dark,.dark *){--tw-bg-opacity: 1;background-color:rgb(185 28 28 / var(--tw-bg-opacity, 1))}.dark\\:hover\\:text-gray-100:hover:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(244 244 245 / var(--tw-text-opacity, 1))}.dark\\:hover\\:text-gray-200:hover:where(.dark,.dark *){--tw-text-opacity: 1;color:rgb(228 228 231 / var(--tw-text-opacity, 1))}.dark\\:focus\\:ring-blue-400:focus:where(.dark,.dark *){--tw-ring-opacity: 1;--tw-ring-color: rgb(64 156 255 / var(--tw-ring-opacity, 1))}.dark\\:focus\\:ring-blue-400\\/20:focus:where(.dark,.dark *){--tw-ring-color: rgb(64 156 255 / .2)}</style>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <noscript>请启用 JavaScript。</noscript>\n  </body>\n</html>\n";
// grok-switch command line. build.mjs appends this after the injectable
// payload (adapters + runtime.cjs), so grokSwitch* functions are in scope.
// This part is never injected into the host bundle.

var cliFs = require("node:fs");
var cliPath = require("node:path");
var cliChildProcess = require("node:child_process");

var CLI_VERSION = "0.8.1";
var CLI_HOST_PATH = process.env.GROK_SWITCH_HOST || "/home/box/sand-host/host-main.cjs";
var CLI_HOST_VERSION_PATH = cliPath.join(cliPath.dirname(CLI_HOST_PATH), "version");
var CLI_BACKUP_PATH = CLI_HOST_PATH + ".grok-switch.orig";
var CLI_SUPERVISOR_DIR = process.env.GROK_SWITCH_SUPERVISOR_DIR || "/tmp/sand-supervisor";
var CLI_PROC_ROOT = process.env.GROK_SWITCH_PROC || "/proc";
var CLI_CONFIG_DIR = GROK_SWITCH_DIR;
var CLI_CONFIG_PATH = GROK_SWITCH_CONFIG_PATH;
var CLI_LOG_PATH = GROK_SWITCH_LOG_PATH;

var CLI_PAYLOAD_BEGIN = "// GROK_SWITCH_PAYLOAD_BEGIN";
var CLI_PAYLOAD_END = "// GROK_SWITCH_PAYLOAD_END";
var CLI_PATCH_BEGIN = "// GROK_SWITCH_BEGIN";
var CLI_PATCH_END = "// GROK_SWITCH_END";
var CLI_HOST_FACTORY = "function createHostInference(";
var CLI_RENAMED_FACTORY = "function __grokSwitchOriginalCreateHostInference(";
var CLI_REQUIRED_HOST_NAMES = ["BasePromptExecutor", "BasePromptBuilder", "function createCursorSandInference("];

var CLI_USAGE = [
  "grok-switch " + CLI_VERSION + " - route Grok Bot inference to your own model API",
  "",
  "usage: node grok-switch.cjs <command> [options]",
  "",
  "  install [--no-ui] [--port N]    patch the host now, request its one-time restart, start the panel",
  "  use <name> [provider options]   switch to a saved provider (saves and test-requests it first if options given)",
  "  official                        switch back to official Grok; saved providers are kept",
  "  add <name> <provider options>   save or update a provider without switching",
  "  remove <name>                   delete a saved provider",
  "  list                            show saved providers",
  "  status [--json]                 show host patch, process, supervisor and config state",
  "  test <name> [--json]            send one small request to a provider and print the reply",
  "  log [N]                         show the last N upstream requests (default 20)",
  "  restart                         ask the supervisor to restart the host when idle",
  "  restore                         remove the patch from the host bundle and restart",
  "  ui [--background] [--port N]    web panel on 127.0.0.1 for configuring providers (ui stop / ui status / ui --new-token)",
  "",
  "provider options:",
  "  --url <baseUrl>                 e.g. https://api.openai.com/v1 (required)",
  "  --model <id>                    model id sent to the provider (required)",
  "  --protocol <p>                  openai-chat (default) | openai-responses | anthropic-messages",
  "  --key <apiKey>                  API key; or --key-file <path>; or env GROK_SWITCH_API_KEY",
  "  --auth <type>                   bearer | x-api-key | none | codex (default depends on protocol)",
  "                                  codex = sign with the ChatGPT login from `codex login` (~/.codex/auth.json);",
  "                                  implies openai-responses and " + GROK_SWITCH_CODEX_BASE_URL,
  "  --endpoint <path>               override the request path, e.g. /v1/chat/completions",
  "  --header <Name: value>          extra request header (repeatable)",
  "  --reasoning <effort>            reasoningEffort parameter (OpenAI protocols)",
  "  --max-tokens <n>                maxTokens parameter (Anthropic default 8192)",
  "  --no-test                       skip the test request `use` sends before switching",
  "",
  "in chat (any platform, no terminal): /gs use <name>   /gs official   /gs status",
  "",
  "files: " + CLI_CONFIG_PATH + " (config, mode 600), " + CLI_LOG_PATH + " (request log)",
  "host:  " + CLI_HOST_PATH
].join("\n");

class CliError extends Error {}

function cliParseArgs(argv) {
  var positional = [];
  var flags = {};
  for (var i = 0; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg.slice(0, 2) !== "--") {
      positional.push(arg);
      continue;
    }
    var eq = arg.indexOf("=");
    var name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    var value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (name === "json" || name === "force" || name === "no-test" || name === "background" || name === "no-ui" || name === "new-token") {
      value = true;
    } else {
      if (i + 1 >= argv.length) throw new CliError("--" + name + " needs a value");
      i += 1;
      value = argv[i];
    }
    if (name === "header") {
      if (flags.header == null) flags.header = [];
      flags.header.push(value);
    } else {
      flags[name] = value;
    }
  }
  return { positional: positional, flags: flags };
}

// ---------------------------------------------------------------------------
// Config file

function cliReadRawConfig() {
  var text = grokSwitchReadConfigText();
  if (text == null) return { active: null, providers: {} };
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new CliError(CLI_CONFIG_PATH + " is not valid JSON; fix or delete it");
  }
  if (!grokSwitchIsPlainObject(parsed)) throw new CliError(CLI_CONFIG_PATH + " must contain a JSON object");
  if (parsed.providers == null) parsed.providers = {};
  if (parsed.active === void 0) parsed.active = null;
  return parsed;
}

function cliWriteConfig(config) {
  cliFs.mkdirSync(CLI_CONFIG_DIR, { recursive: true, mode: 448 });
  try {
    cliFs.chmodSync(CLI_CONFIG_DIR, 448);
  } catch (_error) {}
  var tmp = CLI_CONFIG_PATH + "." + process.pid + ".tmp";
  cliFs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 384 });
  cliFs.renameSync(tmp, CLI_CONFIG_PATH);
}

function cliRequireProviderName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new CliError("provider name must be 1-64 letters, digits, '.', '_' or '-'");
  }
  return name;
}

function cliHasProviderFlags(flags) {
  var names = ["url", "model", "protocol", "key", "key-file", "auth", "endpoint", "header", "reasoning", "max-tokens"];
  for (var i = 0; i < names.length; i += 1) {
    if (flags[names[i]] != null) return true;
  }
  return false;
}

function cliReadKey(flags) {
  if (flags.key != null) return String(flags.key);
  if (flags["key-file"] != null) return cliFs.readFileSync(String(flags["key-file"]), "utf8").trim();
  if (process.env.GROK_SWITCH_API_KEY != null) return process.env.GROK_SWITCH_API_KEY;
  return null;
}

// Builds the raw provider entry from flags, merging over an existing entry so
// `use name --model x` can change one field.
// Model named in the Codex CLI config, used as the default for --auth codex.
function cliCodexConfiguredModel() {
  try {
    var home = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() ? process.env.CODEX_HOME.trim() : require("node:os").homedir() + "/.codex";
    var match = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(cliFs.readFileSync(home + "/config.toml", "utf8"));
    return match ? match[1].trim() : null;
  } catch (_error) {
    return null;
  }
}

function cliProviderFromFlags(name, flags, existing) {
  var entry = existing != null ? JSON.parse(JSON.stringify(existing)) : {};
  if (flags.auth != null) entry.authType = String(flags.auth);
  var codex = entry.authType === "codex";
  if (flags.protocol != null) entry.protocol = String(flags.protocol);
  if (entry.protocol == null) entry.protocol = codex ? "openai-responses" : "openai-chat";
  if (flags.url != null) entry.baseUrl = String(flags.url);
  if (entry.baseUrl == null && codex) entry.baseUrl = GROK_SWITCH_CODEX_BASE_URL;
  if (flags.model != null) entry.model = String(flags.model);
  if (entry.model == null && codex) entry.model = cliCodexConfiguredModel();
  var key = cliReadKey(flags);
  if (key != null) entry.apiKey = key;
  if (flags.endpoint != null) entry.endpointPath = String(flags.endpoint);
  if (flags.header != null) {
    entry.headers = entry.headers || {};
    for (var i = 0; i < flags.header.length; i += 1) {
      var raw = String(flags.header[i]);
      var colon = raw.indexOf(":");
      if (colon <= 0) throw new CliError("--header must look like 'Name: value'");
      entry.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    }
  }
  if (flags.reasoning != null || flags["max-tokens"] != null) {
    entry.parameters = entry.parameters || {};
    if (flags.reasoning != null) entry.parameters.reasoningEffort = String(flags.reasoning);
    if (flags["max-tokens"] != null) {
      var n = Number(flags["max-tokens"]);
      if (!Number.isInteger(n) || n < 1) throw new CliError("--max-tokens must be a positive integer");
      entry.parameters.maxTokens = n;
    }
  }
  if (entry.baseUrl == null) throw new CliError("--url is required");
  if (entry.model == null) throw new CliError(codex ? "--model is required (no model in ~/.codex/config.toml)" : "--model is required");
  if (codex) {
    try {
      grokSwitchCodexCredentials();
    } catch (error) {
      throw new CliError(error.message);
    }
  }
  try {
    grokSwitchNormalizeProvider(name, entry);
  } catch (error) {
    throw new CliError(error.message);
  }
  return entry;
}

function cliDescribeProvider(provider) {
  return provider.protocol + " " + provider.baseUrl + provider.endpointPath + " model=" + provider.model;
}

// ---------------------------------------------------------------------------
// Host bundle patching

function cliPayload() {
  var self = cliFs.readFileSync(__filename, "utf8");
  var begin = self.indexOf(CLI_PAYLOAD_BEGIN);
  var end = self.indexOf(CLI_PAYLOAD_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new CliError("this file is not a built grok-switch bundle; run `npm run build` and use dist/grok-switch.cjs");
  }
  return self.slice(begin, end + CLI_PAYLOAD_END.length) + "\n";
}

function cliCount(text, needle) {
  var count = 0;
  var index = 0;
  for (;;) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

// Returns { stock, patched, version } where stock is the bundle text with our
// patch removed (identical to the original file when no patch is present).
function cliInspectBundle(text) {
  var begin = text.indexOf(CLI_PATCH_BEGIN);
  var end = text.indexOf(CLI_PATCH_END);
  if (begin === -1 && end === -1) return { stock: text, patched: false, version: null };
  if (begin === -1 || end === -1 || end < begin) {
    throw new CliError("host bundle contains a damaged grok-switch patch; restore it from " + CLI_BACKUP_PATH);
  }
  var lineEnd = text.indexOf("\n", begin);
  var version = text.slice(begin + CLI_PATCH_BEGIN.length, lineEnd).trim();
  var stop = end + CLI_PATCH_END.length;
  if (text[stop] === "\n") stop += 1;
  var stock = text.slice(0, begin) + text.slice(stop);
  if (cliCount(stock, CLI_RENAMED_FACTORY) !== 1) {
    throw new CliError("host bundle contains a damaged grok-switch patch; restore it from " + CLI_BACKUP_PATH);
  }
  stock = stock.replace(CLI_RENAMED_FACTORY, CLI_HOST_FACTORY);
  return { stock: stock, patched: true, version: version };
}

function cliAssertPatchable(stock) {
  var factories = cliCount(stock, CLI_HOST_FACTORY);
  if (factories !== 1) {
    throw new CliError("host bundle has " + factories + " createHostInference definitions (expected 1); this Grok Bot version is not supported yet");
  }
  for (var i = 0; i < CLI_REQUIRED_HOST_NAMES.length; i += 1) {
    if (stock.indexOf(CLI_REQUIRED_HOST_NAMES[i]) === -1) {
      throw new CliError("host bundle lacks " + CLI_REQUIRED_HOST_NAMES[i] + "; this Grok Bot version is not supported yet");
    }
  }
}

function cliBuildPatched(stock) {
  var block = CLI_PATCH_BEGIN + " " + CLI_VERSION + "\n" + cliPayload() + CLI_PATCH_END + "\n";
  return stock.replace(CLI_HOST_FACTORY, block + CLI_RENAMED_FACTORY);
}

function cliNodeCheck(path) {
  var result = cliChildProcess.spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status !== 0) {
    var detail = String(result.stderr || result.stdout).trim().split("\n").filter(Boolean).slice(0, 4).join(" | ");
    throw new CliError("patched bundle failed `node --check`: " + detail);
  }
}

function cliWriteBundle(text) {
  var mode = 420;
  try {
    mode = cliFs.statSync(CLI_HOST_PATH).mode & 511;
  } catch (_error) {}
  // Keep the .cjs extension so `node --check` parses it as CommonJS.
  var tmp = CLI_HOST_PATH + ".grok-switch-tmp.cjs";
  cliFs.writeFileSync(tmp, text, { mode: mode });
  try {
    cliNodeCheck(tmp);
  } catch (error) {
    try {
      cliFs.unlinkSync(tmp);
    } catch (_unlink) {}
    throw error;
  }
  cliFs.renameSync(tmp, CLI_HOST_PATH);
}

function cliReadBundle() {
  try {
    return cliFs.readFileSync(CLI_HOST_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new CliError("host bundle not found at " + CLI_HOST_PATH + "; run this inside the Grok Bot cloud machine");
    throw error;
  }
}

// Ensures the host bundle on disk carries the current patch.
// Returns "unchanged" | "patched" | "updated".
function cliEnsurePatched() {
  var text = cliReadBundle();
  var info = cliInspectBundle(text);
  if (info.patched && info.version === CLI_VERSION) return "unchanged";
  cliAssertPatchable(info.stock);
  if (!info.patched) cliFs.writeFileSync(CLI_BACKUP_PATH, info.stock, { mode: 384 });
  cliWriteBundle(cliBuildPatched(info.stock));
  return info.patched ? "updated" : "patched";
}

function cliUnpatch() {
  var text = cliReadBundle();
  var info = cliInspectBundle(text);
  if (!info.patched) return false;
  cliWriteBundle(info.stock);
  try {
    cliFs.unlinkSync(CLI_BACKUP_PATH);
  } catch (_error) {}
  return true;
}

// ---------------------------------------------------------------------------
// Host process and supervisor

function cliBootTimeMs() {
  var stat = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, "stat"), "utf8");
  var match = /^btime (\d+)/m.exec(stat);
  return match ? Number(match[1]) * 1000 : null;
}

function cliFindHostProcess() {
  var entries;
  try {
    entries = cliFs.readdirSync(CLI_PROC_ROOT);
  } catch (_error) {
    return null;
  }
  var boot = null;
  try {
    boot = cliBootTimeMs();
  } catch (_error) {}
  for (var i = 0; i < entries.length; i += 1) {
    if (!/^\d+$/.test(entries[i]) || Number(entries[i]) === process.pid) continue;
    var cmdline;
    try {
      cmdline = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, entries[i], "cmdline"), "utf8").split("\0");
    } catch (_error) {
      continue;
    }
    if (cmdline.indexOf(CLI_HOST_PATH) === -1) continue;
    var startedAtMs = null;
    try {
      var stat = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, entries[i], "stat"), "utf8");
      var fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      var startTicks = Number(fields[19]);
      if (boot != null && Number.isFinite(startTicks)) startedAtMs = boot + startTicks * 10;
    } catch (_error) {}
    return { pid: Number(entries[i]), startedAtMs: startedAtMs };
  }
  return null;
}

function cliSupervisorState() {
  var commandPath = cliPath.join(CLI_SUPERVISOR_DIR, "command.json");
  var state = { busy: cliFs.existsSync(cliPath.join(CLI_SUPERVISOR_DIR, "agent.busy")), pending: null };
  if (cliFs.existsSync(commandPath)) {
    try {
      state.pending = JSON.parse(cliFs.readFileSync(commandPath, "utf8"));
    } catch (_error) {
      state.pending = { id: "unreadable" };
    }
  }
  return state;
}

// Asks the supervisor to restart the host. The supervisor applies restart
// commands only when no agent is busy, so this is safe to issue any time.
function cliRequestRestart(reason) {
  var state = cliSupervisorState();
  if (state.pending != null) return { issued: false, pending: state.pending };
  cliFs.mkdirSync(CLI_SUPERVISOR_DIR, { recursive: true });
  var command = {
    id: "grok-switch-" + Date.now(),
    kind: "restart",
    issuedAtMs: Date.now(),
    reason: reason
  };
  var commandPath = cliPath.join(CLI_SUPERVISOR_DIR, "command.json");
  cliFs.writeFileSync(commandPath + ".part", JSON.stringify(command));
  cliFs.renameSync(commandPath + ".part", commandPath);
  return { issued: true, command: command };
}

function cliHostState() {
  var text = null;
  try {
    text = cliReadBundle();
  } catch (_error) {}
  var info = text == null ? null : cliInspectBundle(text);
  var bundleMtimeMs = null;
  try {
    bundleMtimeMs = cliFs.statSync(CLI_HOST_PATH).mtimeMs;
  } catch (_error) {}
  var version = null;
  try {
    version = cliFs.readFileSync(CLI_HOST_VERSION_PATH, "utf8").trim();
  } catch (_error) {}
  var proc = cliFindHostProcess();
  var runningCurrent = null;
  if (proc != null && proc.startedAtMs != null && bundleMtimeMs != null) {
    runningCurrent = proc.startedAtMs >= bundleMtimeMs;
  }
  return {
    path: CLI_HOST_PATH,
    exists: text != null,
    version: version,
    patched: info == null ? false : info.patched,
    patchVersion: info == null ? null : info.version,
    backupExists: cliFs.existsSync(CLI_BACKUP_PATH),
    process: proc,
    runningCurrentBundle: runningCurrent,
    supervisor: cliSupervisorState()
  };
}

// ---------------------------------------------------------------------------
// Commands

// Output sink. The web panel captures command output by swapping it.
var cliSink = null;

function cliPrint(line) {
  if (cliSink != null) cliSink.push(line);
  else process.stdout.write(line + "\n");
}

// `status | head` closes the pipe early; that is not an error worth a stack trace.
process.stdout.on("error", function (error) {
  if (error && error.code === "EPIPE") process.exit(0);
});

async function cliCapture(fn) {
  var lines = [];
  var previous = cliSink;
  cliSink = lines;
  try {
    await fn();
  } finally {
    cliSink = previous;
  }
  return lines;
}

function cliCommandAdd(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  config.providers[name] = cliProviderFromFlags(name, args.flags, config.providers[name]);
  cliWriteConfig(config);
  cliPrint("saved provider " + name + ": " + cliDescribeProvider(grokSwitchNormalizeProvider(name, config.providers[name])));
}

function cliCommandRemove(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  if (config.providers[name] == null) throw new CliError("no provider named " + name);
  if (config.active === name) throw new CliError(name + " is the active provider; run `official` or `use <other>` first");
  delete config.providers[name];
  cliWriteConfig(config);
  cliPrint("removed provider " + name);
}

function cliCommandList(args) {
  var config = cliReadRawConfig();
  var names = Object.keys(config.providers);
  if (args.flags.json) {
    var out = {};
    for (var i = 0; i < names.length; i += 1) {
      var copy = JSON.parse(JSON.stringify(config.providers[names[i]]));
      if (copy.apiKey != null) copy.apiKey = "***";
      out[names[i]] = copy;
    }
    cliPrint(JSON.stringify({ active: config.active, providers: out }, null, 2));
    return;
  }
  if (names.length === 0) {
    cliPrint("no providers saved; add one with: use <name> --url <baseUrl> --model <id> --key <apiKey>");
    return;
  }
  for (var j = 0; j < names.length; j += 1) {
    var marker = config.active === names[j] ? "* " : "  ";
    var summary;
    try {
      summary = cliDescribeProvider(grokSwitchNormalizeProvider(names[j], config.providers[names[j]]));
    } catch (error) {
      summary = "INVALID: " + error.message;
    }
    cliPrint(marker + names[j] + "  " + summary);
  }
  cliPrint(config.active == null ? "active: official Grok" : "active: " + config.active);
}

function cliExplainRestart(result) {
  if (result.issued) {
    cliPrint("restart requested (" + result.command.id + "); the supervisor restarts the host as soon as no Bot is busy.");
  } else {
    cliPrint("a supervisor command is already pending (" + String(result.pending.id) + "); the host restarts when it is applied.");
  }
}

async function cliCommandUse(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  var changed = cliHasProviderFlags(args.flags);
  if (changed) {
    config.providers[name] = cliProviderFromFlags(name, args.flags, config.providers[name]);
  }
  if (config.providers[name] == null) {
    throw new CliError("no provider named " + name + "; pass --url/--model/--key to create it");
  }
  var provider;
  try {
    provider = grokSwitchNormalizeProvider(name, config.providers[name]);
  } catch (error) {
    throw new CliError(error.message);
  }
  // A new or edited provider is probed before anything is switched, so a bad
  // URL, key or model is reported here instead of in the next conversation.
  if (changed && !args.flags["no-test"]) {
    var probe = await cliProbeProvider(provider);
    if (!probe.ok) {
      throw new CliError("provider " + name + " did not answer a test request: " + probe.error + "\nnothing was switched; fix the flags and run again, or add --no-test to skip this check");
    }
    cliPrint("test request OK in " + probe.ms + "ms (reply " + JSON.stringify(probe.text.slice(0, 40)) + ")");
  }
  var outcome = cliEnsurePatched();
  config.active = name;
  cliWriteConfig(config);
  cliPrint("active provider: " + name + " (" + cliDescribeProvider(provider) + ")");
  if (outcome === "patched") cliPrint("host bundle patched; original saved to " + CLI_BACKUP_PATH);
  if (outcome === "updated") cliPrint("host bundle patch updated to " + CLI_VERSION);
  var state = cliHostState();
  if (outcome !== "unchanged" || state.runningCurrentBundle === false) {
    cliExplainRestart(cliRequestRestart("grok-switch use " + name));
    cliPrint("after the restart, new conversations use " + name + ".");
  } else if (state.process == null) {
    cliPrint("host process not found; it will use " + name + " when it starts.");
  } else {
    cliPrint("takes effect on the next conversation turn; no restart needed.");
  }
  cliPrint("in chat: /gs official switches back, /gs use <name> switches again, /gs status shows the route.");
}

// One-shot setup run by Grok Bot: patch now (transparent while no provider
// is active), request the single restart, start the panel. By the time the
// user opens the panel the host is already running the patched code.
async function cliCommandInstall(args) {
  var outcome = cliEnsurePatched();
  if (outcome === "patched") cliPrint("host bundle patched; original saved to " + CLI_BACKUP_PATH);
  else if (outcome === "updated") cliPrint("host bundle patch updated to " + CLI_VERSION);
  else cliPrint("host bundle already patched (" + CLI_VERSION + ")");
  var state = cliHostState();
  if (outcome !== "unchanged" || state.runningCurrentBundle === false) {
    cliExplainRestart(cliRequestRestart("grok-switch install"));
    cliPrint("this restart happens once, after the current Bot turn ends; switching providers later never restarts.");
  } else {
    cliPrint("host process already runs the patched code; no restart needed.");
  }
  cliPrint("route: " + (grokSwitchResolveRoute().kind === "official" ? "official Grok (unchanged until a provider is selected)" : "external provider selected"));
  if (!args.flags["no-ui"]) {
    await uiCommand({ positional: ["ui"], flags: { background: true, port: args.flags.port } });
  }
}

function cliCommandOfficial() {
  var config = cliReadRawConfig();
  config.active = null;
  cliWriteConfig(config);
  cliPrint("active provider: official Grok (saved providers kept)");
  cliPrint("takes effect on the next conversation turn.");
}

function cliCommandRestart() {
  cliExplainRestart(cliRequestRestart("grok-switch restart"));
}

function cliCommandRestore() {
  var config = cliReadRawConfig();
  if (config.active != null) {
    config.active = null;
    cliWriteConfig(config);
    cliPrint("active provider reset to official Grok");
  }
  if (cliUnpatch()) {
    cliPrint("patch removed from " + CLI_HOST_PATH);
    cliExplainRestart(cliRequestRestart("grok-switch restore"));
  } else {
    cliPrint("host bundle has no grok-switch patch; nothing to restore");
  }
}

function cliReadLog(limit) {
  var lines = [];
  try {
    lines = cliFs.readFileSync(CLI_LOG_PATH, "utf8").split("\n").filter(Boolean);
  } catch (_error) {}
  return lines.slice(-limit).map(function (line) {
    try {
      return JSON.parse(line);
    } catch (_error) {
      return { raw: line };
    }
  });
}

function cliFormatLogEntry(entry) {
  if (entry.raw != null) return entry.raw;
  var parts = [entry.ts, entry.provider || "-", entry.model || "-", entry.kind || "-", "HTTP " + entry.status, (entry.ms || 0) + "ms"];
  if (entry.usage) parts.push("tokens " + entry.usage.promptTokens + "+" + entry.usage.completionTokens);
  if (entry.error) parts.push("ERROR " + entry.error);
  return parts.join("  ");
}

function cliCommandLog(args) {
  var limit = args.positional[1] != null ? Number(args.positional[1]) : 20;
  if (!Number.isInteger(limit) || limit < 1) throw new CliError("log count must be a positive integer");
  var entries = cliReadLog(limit);
  if (entries.length === 0) {
    cliPrint("no upstream requests logged yet (" + CLI_LOG_PATH + ")");
    return;
  }
  for (var i = 0; i < entries.length; i += 1) cliPrint(cliFormatLogEntry(entries[i]));
}

function cliCommandStatus(args) {
  var host = cliHostState();
  var config = cliReadRawConfig();
  var route = grokSwitchResolveRoute();
  var recent = cliReadLog(5);
  var usage = cliUsageTotals();
  if (args.flags.json) {
    var activeProvider = route.kind === "external" ? cliDescribeProvider(route.provider) : null;
    cliPrint(JSON.stringify({
      version: CLI_VERSION,
      host: host,
      config: { path: CLI_CONFIG_PATH, active: config.active, providers: Object.keys(config.providers), route: route.kind, error: route.kind === "error" ? route.message : null, activeProvider: activeProvider },
      usage: usage,
      recentRequests: recent
    }, null, 2));
    return;
  }
  cliPrint("grok-switch " + CLI_VERSION);
  if (!host.exists) {
    cliPrint("host bundle : not found at " + host.path + " (not inside the Grok Bot cloud machine?)");
  } else {
    var patch = host.patched ? "patched (" + host.patchVersion + ")" : "not patched";
    cliPrint("host bundle : " + host.path + (host.version ? " version " + host.version : "") + "  " + patch);
  }
  if (host.process == null) {
    cliPrint("host process: not running");
  } else {
    var running = host.runningCurrentBundle === true ? "running current bundle" : host.runningCurrentBundle === false ? "RESTART PENDING (bundle changed after start)" : "start time unknown";
    cliPrint("host process: pid " + host.process.pid + (host.process.startedAtMs ? " started " + new Date(host.process.startedAtMs).toISOString() : "") + "  " + running);
  }
  var sup = host.supervisor;
  cliPrint("supervisor  : " + (sup.busy ? "agent busy" : "idle") + (sup.pending ? ", command pending (" + String(sup.pending.id) + ")" : ""));
  if (route.kind === "official") cliPrint("active      : official Grok");
  else if (route.kind === "external") cliPrint("active      : " + route.provider.name + " -> " + cliDescribeProvider(route.provider));
  else cliPrint("active      : MISCONFIGURED - " + route.message + " (requests fail until fixed; run `official` to recover)");
  var names = Object.keys(config.providers);
  cliPrint("providers   : " + (names.length ? names.join(", ") : "none"));
  if (route.kind === "external" && host.exists && !host.patched) {
    cliPrint("warning     : provider selected but host is not patched (Grok Bot update replaced the bundle?); run `use " + route.provider.name + "` to re-apply");
  }
  var usedNames = Object.keys(usage);
  if (usedNames.length > 0) {
    cliPrint("usage       :");
    for (var u = 0; u < usedNames.length; u += 1) {
      var t = usage[usedNames[u]];
      cliPrint("  " + usedNames[u] + "  " + t.requests + " requests" + (t.failed ? " (" + t.failed + " failed)" : "") + ", " + cliFormatTokens(t.promptTokens) + " in / " + cliFormatTokens(t.completionTokens) + " out tokens" + (t.lastUsedAt ? ", last " + t.lastUsedAt : ""));
    }
  }
  if (recent.length > 0) {
    cliPrint("recent      :");
    for (var i = 0; i < recent.length; i += 1) cliPrint("  " + cliFormatLogEntry(recent[i]));
  }
}

// Sends one tiny request through the same code path the host uses.
async function cliProbeProvider(provider) {
  var startedAt = Date.now();
  var result = grokSwitchStream(provider, {
    messages: [{ role: "user", content: "Reply with exactly the word OK and nothing else." }],
    tools: [],
    options: {},
    requestKind: "test"
  });
  var text = "";
  var failure = null;
  try {
    for await (var event of result.fullStream) {
      if (event.type === "text-delta") text += event.textDelta;
    }
  } catch (error) {
    failure = error;
  }
  var usage = null;
  try {
    usage = await result.usage;
  } catch (_error) {}
  return { ok: failure == null, ms: Date.now() - startedAt, text: text, usage: usage, error: failure ? failure.message : null };
}

async function cliCommandTest(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  if (config.providers[name] == null) throw new CliError("no provider named " + name);
  var provider;
  try {
    provider = grokSwitchNormalizeProvider(name, config.providers[name]);
  } catch (error) {
    throw new CliError(error.message);
  }
  var probe = await cliProbeProvider(provider);
  if (args.flags.json) {
    cliPrint(JSON.stringify(Object.assign({ provider: name }, probe)));
  } else if (!probe.ok) {
    cliPrint("FAILED after " + probe.ms + "ms: " + probe.error);
  } else {
    cliPrint("OK in " + probe.ms + "ms via " + cliDescribeProvider(provider));
    cliPrint("reply: " + JSON.stringify(probe.text));
    if (probe.usage) cliPrint("usage: " + probe.usage.promptTokens + " prompt + " + probe.usage.completionTokens + " completion tokens");
  }
  if (!probe.ok) process.exitCode = 1;
}

// Per-provider totals from the request log (current file plus one rotation).
function cliUsageTotals() {
  var totals = {};
  var files = [CLI_LOG_PATH + ".1", CLI_LOG_PATH];
  for (var f = 0; f < files.length; f += 1) {
    var lines;
    try {
      lines = cliFs.readFileSync(files[f], "utf8").split("\n");
    } catch (_error) {
      continue;
    }
    for (var i = 0; i < lines.length; i += 1) {
      if (!lines[i]) continue;
      var entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch (_parse) {
        continue;
      }
      if (typeof entry.provider !== "string") continue;
      var t = totals[entry.provider] || (totals[entry.provider] = { requests: 0, failed: 0, promptTokens: 0, completionTokens: 0, lastUsedAt: null });
      t.requests += 1;
      if (entry.error) t.failed += 1;
      if (entry.usage) {
        t.promptTokens += Number(entry.usage.promptTokens) || 0;
        t.completionTokens += Number(entry.usage.completionTokens) || 0;
      }
      if (entry.ts && (t.lastUsedAt == null || entry.ts > t.lastUsedAt)) t.lastUsedAt = entry.ts;
    }
  }
  return totals;
}

function cliFormatTokens(n) {
  return n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

async function cliMain(argv) {
  var args = cliParseArgs(argv);
  var command = args.positional[0];
  if (command == null || command === "help" || command === "--help" || command === "-h") {
    cliPrint(CLI_USAGE);
    return;
  }
  if (command === "version") return cliPrint(CLI_VERSION);
  if (command === "install") return cliCommandInstall(args);
  if (command === "add") return cliCommandAdd(args);
  if (command === "remove") return cliCommandRemove(args);
  if (command === "list") return cliCommandList(args);
  if (command === "use") return cliCommandUse(args);
  if (command === "official") return cliCommandOfficial(args);
  if (command === "status") return cliCommandStatus(args);
  if (command === "test") return cliCommandTest(args);
  if (command === "log") return cliCommandLog(args);
  if (command === "restart") return cliCommandRestart(args);
  if (command === "restore") return cliCommandRestore(args);
  if (command === "ui") return uiCommand(args);
  throw new CliError("unknown command " + command + "\n\n" + CLI_USAGE);
}

if (require.main === module) {
  cliMain(process.argv.slice(2)).catch(function (error) {
    process.stderr.write("error: " + (error instanceof CliError ? error.message : (error && error.stack) || String(error)) + "\n");
    process.exitCode = 1;
  });
}
