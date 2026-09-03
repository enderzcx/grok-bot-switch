#!/usr/bin/env node
// grok-switch 0.7.1 - https://github.com/enderzcx/grok-bot-switch
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

function grokSwitchCurrentTurnStart(messages) {
  var start = 0;
  for (var i = 0; i < messages.length; i += 1) {
    if (messages[i] != null && messages[i].role === "user") start = i + 1;
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
      } else if (event.type === "tool-call") {
        pendingToolCalls.delete(event.toolCallId);
        toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
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
// grok-switch command line. build.mjs appends this after the injectable
// payload (adapters + runtime.cjs), so grokSwitch* functions are in scope.
// This part is never injected into the host bundle.

var cliFs = require("node:fs");
var cliPath = require("node:path");
var cliChildProcess = require("node:child_process");

var CLI_VERSION = "0.7.1";
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
  "  ui [--background] [--port N]    web panel on 127.0.0.1 for configuring providers (ui stop / ui status)",
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
    } else if (name === "json" || name === "force" || name === "no-test" || name === "background" || name === "no-ui") {
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
