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

function resolveEndpointPath(defaultPath, options, protocolId) {
  if (options == null || options.endpointPath == null || options.endpointPath === "") {
    return defaultPath;
  }
  var path = String(options.endpointPath);
  if (path.charAt(0) !== "/" || path.indexOf("://") !== -1 || path.indexOf("?") !== -1 || path.indexOf("#") !== -1 || path.indexOf(" ") !== -1) {
    throw protocolError("endpointPath must be an absolute path", { protocol: protocolId, code: "invalid-request" });
  }
  return path;
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
