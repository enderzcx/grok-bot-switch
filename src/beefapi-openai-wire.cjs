function parseBeefApiDirectConfig(raw) {
  if (raw == null) {
    return null;
  }
  var parsed = raw;
  if (typeof raw === "string") {
    var trimmed = raw.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (_error) {
      throw new Error("BeefAPI direct config is not valid JSON");
    }
  }
  if (parsed == null) {
    return null;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BeefAPI direct config must be an object");
  }
  if (parsed.enabled !== true) {
    return null;
  }
  var extraKeys = Object.keys(parsed);
  for (var i = 0; i < extraKeys.length; i++) {
    var key = extraKeys[i];
    if (!BEEFAPI_DIRECT_CONFIG_KEYS[key]) {
      if (BEEFAPI_CREDENTIAL_KEY.test(key)) {
        throw new Error("BeefAPI direct config must not contain credentials");
      }
      throw new Error("BeefAPI direct config has unexpected field " + key);
    }
  }
  beefApiAssertExact(parsed, "schemaVersion", 1);
  beefApiAssertExact(parsed, "mode", "external-only");
  beefApiAssertExact(parsed, "nativeFallback", false);
  beefApiAssertExact(parsed, "provider", "beefapi");
  beefApiAssertExact(parsed, "group", "grok");
  beefApiAssertExact(parsed, "modelId", "grok-4.6");
  beefApiAssertExact(parsed, "baseUrl", "http://127.0.0.1:18779/v1");
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "external-only",
    nativeFallback: false,
    provider: "beefapi",
    group: "grok",
    modelId: "grok-4.6",
    baseUrl: "http://127.0.0.1:18779/v1"
  };
}

function toBeefApiOpenAiMessages(messages) {
  if (messages == null) {
    return [];
  }
  if (!Array.isArray(messages)) {
    throw new Error("BeefAPI OpenAI messages must be an array");
  }
  var out = [];
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    if (message == null || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("BeefAPI OpenAI message is unrepresentable");
    }
    var role = message.role;
    if (role === "system") {
      out.push({ role: "system", content: beefApiSystemContent(message.content) });
    } else if (role === "user") {
      out.push({ role: "user", content: beefApiUserContent(message.content) });
    } else if (role === "assistant") {
      out.push(beefApiAssistantMessage(message));
    } else if (role === "tool") {
      var toolMessages = beefApiToolMessages(message);
      for (var j = 0; j < toolMessages.length; j++) {
        out.push(toolMessages[j]);
      }
    } else {
      throw new Error("BeefAPI OpenAI message role is unrepresentable");
    }
  }
  return out;
}

function toBeefApiOpenAiTools(tools) {
  if (tools == null) {
    return [];
  }
  if (!Array.isArray(tools)) {
    throw new Error("BeefAPI OpenAI tools must be an array");
  }
  var out = [];
  for (var i = 0; i < tools.length; i++) {
    out.push(beefApiConvertTool(tools[i]));
  }
  return out;
}

function createBeefApiSseDecoder() {
  var utf8 = new TextDecoder("utf-8", { fatal: true });
  var textBuffer = "";
  var pendingData = [];
  var done = false;
  var ended = false;
  var strippedBom = false;

  function consume(isEnd) {
    if (done) {
      textBuffer = "";
      pendingData = [];
      return [];
    }
    var events = [];
    var lines = beefApiSplitSseLines(textBuffer, isEnd);
    textBuffer = lines.rest;
    for (var i = 0; i < lines.lines.length; i++) {
      var event = handleLine(lines.lines[i]);
      if (event) {
        events.push(event);
        if (event.type === "done") {
          done = true;
          textBuffer = "";
          pendingData = [];
          return events;
        }
      }
    }
    return events;
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
    }
    return null;
  }

  function dispatch() {
    if (pendingData.length === 0) {
      return null;
    }
    var data = pendingData.join("\n");
    pendingData = [];
    var trimmed = data.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed === "[DONE]") {
      return { type: "done" };
    }
    var parsed;
    try {
      parsed = JSON.parse(data);
    } catch (_error) {
      throw new Error("BeefAPI OpenAI SSE data is invalid JSON");
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("BeefAPI OpenAI SSE data is invalid JSON");
    }
    return { type: "chunk", chunk: parsed };
  }

  return {
    push: function (chunk) {
      if (ended) {
        throw new Error("BeefAPI OpenAI SSE decoder is already finished");
      }
      if (done) {
        return [];
      }
      var bytes = beefApiAsUtf8Bytes(chunk);
      var decoded;
      try {
        decoded = utf8.decode(bytes, { stream: true });
      } catch (_error) {
        throw new Error("BeefAPI OpenAI SSE stream is truncated");
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
    end: function () {
      if (ended) {
        throw new Error("BeefAPI OpenAI SSE decoder is already finished");
      }
      ended = true;
      var events = [];
      if (!done) {
        try {
          textBuffer += utf8.decode();
        } catch (_error) {
          throw new Error("BeefAPI OpenAI SSE stream is truncated");
        }
        events = consume(true);
      }
      if (!done && pendingData.length > 0) {
        var last = dispatch();
        if (last) {
          events.push(last);
          if (last.type === "done") {
            done = true;
          }
        }
      }
      if (!done) {
        throw new Error("BeefAPI OpenAI SSE stream is missing [DONE]");
      }
      return events;
    },
    isDone: function () {
      return done;
    }
  };
}

function createBeefApiToolCallAccumulator() {
  var slots = new Map();
  var finishReason = null;
  var usage = null;
  var responseId = "";
  var modelId = "";
  var callsFinalized = false;
  var finishEmitted = false;

  function slot(index) {
    var key = index;
    var current = slots.get(key);
    if (current == null) {
      current = {
        index: key,
        id: "",
        name: "",
        arguments: "",
        pendingDeltas: "",
        started: false
      };
      slots.set(key, current);
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
        throw new Error("BeefAPI OpenAI tool_calls must be an array");
      }
      var events = [];
      for (var i = 0; i < toolCalls.length; i++) {
        var toolCall = toolCalls[i];
        if (toolCall == null || typeof toolCall !== "object") {
          throw new Error("BeefAPI OpenAI tool call fragment is unrepresentable");
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
            throw new Error("BeefAPI OpenAI tool call arguments are unrepresentable");
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
      for (var i = 0; i < ordered.length; i++) {
        var current = ordered[i];
        if (current.id.length === 0 || current.name.length === 0) {
          throw new Error("BeefAPI OpenAI tool call is missing id or name");
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
        var parsedArgs = beefApiParseFinalToolArguments(current.arguments);
        events.push({
          type: "tool-call",
          toolCallId: current.id,
          toolName: current.name,
          args: parsedArgs
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
      var nextUsage = beefApiNormalizeUsage(chunk.usage);
      if (nextUsage != null) {
        usage = nextUsage;
      }
    },
    setFinishReason: function (reason) {
      var mapped = beefApiMapFinishReason(reason);
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

function beefApiChunkToHostEvents(chunk, accumulator) {
  if (accumulator == null || typeof accumulator !== "object") {
    throw new Error("BeefAPI tool call accumulator is required");
  }
  if (chunk == null || chunk.type === "done") {
    return beefApiTakeFinishEvents(accumulator, true);
  }
  if (typeof chunk !== "object" || Array.isArray(chunk)) {
    throw new Error("BeefAPI OpenAI chunk is invalid");
  }
  var payload = chunk.type === "chunk" && chunk.chunk != null ? chunk.chunk : chunk;
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("BeefAPI OpenAI chunk is invalid");
  }
  if (payload.error != null) {
    throw new Error(beefApiStreamErrorMessage(payload.error));
  }
  accumulator.observeChunk(payload);
  var events = [];
  var choice = beefApiPrimaryChoice(payload);
  var delta = choice != null ? choice.delta : null;
  if (delta != null && typeof delta === "object") {
    var reasoning = beefApiDeltaReasoning(delta);
    if (reasoning.length > 0) {
      events.push({ type: "reasoning", textDelta: reasoning });
    }
    var text = beefApiDeltaText(delta.content);
    if (text.length > 0) {
      events.push({ type: "text-delta", textDelta: text });
    }
    if (delta.tool_calls != null) {
      var toolEvents = accumulator.ingest(delta.tool_calls);
      for (var i = 0; i < toolEvents.length; i++) {
        events.push(toolEvents[i]);
      }
    }
  }
  if (choice != null && choice.finish_reason != null && choice.finish_reason !== "") {
    accumulator.setFinishReason(choice.finish_reason);
    var completed = accumulator.complete();
    for (var j = 0; j < completed.length; j++) {
      events.push(completed[j]);
    }
  }
  var finishEvents = beefApiTakeFinishEvents(accumulator, false);
  for (var k = 0; k < finishEvents.length; k++) {
    events.push(finishEvents[k]);
  }
  return events;
}

var BEEFAPI_DIRECT_CONFIG_KEYS = {
  schemaVersion: true,
  enabled: true,
  mode: true,
  nativeFallback: true,
  provider: true,
  group: true,
  modelId: true,
  baseUrl: true
};

var BEEFAPI_CREDENTIAL_KEY = /^(api[_-]?key|authorization|auth|token|access[_-]?token|refresh[_-]?token|oauth|cookie|cookies|credential|credentials|key[_-]?file|secret|password|bearer)$/i;

function beefApiAssertExact(parsed, key, expected) {
  if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
    throw new Error("BeefAPI direct config is missing " + key);
  }
  if (parsed[key] !== expected) {
    throw new Error("BeefAPI direct config field " + key + " is invalid");
  }
}

function beefApiSystemContent(content) {
  if (typeof content === "string") {
    return content;
  }
  throw new Error("BeefAPI OpenAI system content is unrepresentable");
}

function beefApiUserContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    throw new Error("BeefAPI OpenAI user content is unrepresentable");
  }
  if (content.length === 0) {
    return "";
  }
  var parts = [];
  var allText = true;
  for (var i = 0; i < content.length; i++) {
    var part = content[i];
    if (part == null || typeof part !== "object") {
      throw new Error("BeefAPI OpenAI user content is unrepresentable");
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new Error("BeefAPI OpenAI user content is unrepresentable");
      }
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image" || part.type === "image_url") {
      allText = false;
      parts.push(beefApiImagePart(part));
    } else {
      throw new Error("BeefAPI OpenAI user content is unrepresentable");
    }
  }
  if (allText && parts.length === 1) {
    return parts[0].text;
  }
  return parts;
}

function beefApiImagePart(part) {
  if (part.type === "image_url") {
    var imageUrl = part.image_url;
    var url = typeof imageUrl === "string" ? imageUrl : imageUrl != null ? imageUrl.url : null;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("BeefAPI OpenAI image content is unrepresentable");
    }
    return { type: "image_url", image_url: { url: url } };
  }
  var image = part.image;
  var mime = typeof part.mimeType === "string" && part.mimeType.length > 0 ? part.mimeType : "image/png";
  var encoded;
  if (typeof image === "string") {
    if (image.length === 0) {
      throw new Error("BeefAPI OpenAI image content is unrepresentable");
    }
    encoded = image;
  } else if (typeof URL !== "undefined" && image instanceof URL) {
    encoded = String(image);
  } else if (image instanceof Uint8Array) {
    encoded = "data:" + mime + ";base64," + beefApiBytesToBase64(image);
  } else if (typeof ArrayBuffer !== "undefined" && image instanceof ArrayBuffer) {
    encoded = "data:" + mime + ";base64," + beefApiBytesToBase64(new Uint8Array(image));
  } else {
    throw new Error("BeefAPI OpenAI image content is unrepresentable");
  }
  return { type: "image_url", image_url: { url: encoded } };
}

function beefApiAssistantMessage(message) {
  var toolCalls = [];
  var texts = [];
  var reasonings = [];
  if (Array.isArray(message.tool_calls)) {
    for (var i = 0; i < message.tool_calls.length; i++) {
      toolCalls.push(beefApiOpenAiShapedToolCall(message.tool_calls[i]));
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
    for (var j = 0; j < message.content.length; j++) {
      var part = message.content[j];
      if (part == null || typeof part !== "object") {
        throw new Error("BeefAPI OpenAI assistant content is unrepresentable");
      }
      if (part.type === "text") {
        if (typeof part.text !== "string") {
          throw new Error("BeefAPI OpenAI assistant content is unrepresentable");
        }
        texts.push(part.text);
      } else if (part.type === "reasoning") {
        if (typeof part.text !== "string") {
          throw new Error("BeefAPI OpenAI assistant content is unrepresentable");
        }
        reasonings.push(part.text);
      } else if (part.type === "tool-call" || part.type === "tool_call") {
        toolCalls.push(beefApiHostToolCall(part));
      } else {
        throw new Error("BeefAPI OpenAI assistant content is unrepresentable");
      }
    }
  } else {
    throw new Error("BeefAPI OpenAI assistant content is unrepresentable");
  }
  var content = texts.length === 0 ? null : texts.join("");
  var result = { role: "assistant", content: content };
  if (reasonings.length > 0) {
    result.reasoning_content = reasonings.join("");
  }
  if (toolCalls.length > 0) {
    result.tool_calls = toolCalls;
  }
  return result;
}

function beefApiToolMessages(message) {
  if (typeof message.tool_call_id === "string" && message.tool_call_id.length > 0 && (typeof message.content === "string" || message.content == null)) {
    return [{
      role: "tool",
      tool_call_id: message.tool_call_id,
      content: message.content == null ? "" : message.content
    }];
  }
  if (!Array.isArray(message.content)) {
    throw new Error("BeefAPI OpenAI tool content is unrepresentable");
  }
  var out = [];
  for (var i = 0; i < message.content.length; i++) {
    var part = message.content[i];
    if (part == null || typeof part !== "object" || (part.type !== "tool-result" && part.type !== "tool_result")) {
      throw new Error("BeefAPI OpenAI tool content is unrepresentable");
    }
    var id = typeof part.toolCallId === "string" ? part.toolCallId : part.tool_call_id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("BeefAPI OpenAI tool result is missing tool_call_id");
    }
    beefApiRejectUnrepresentableToolResultExtras(part);
    out.push({
      role: "tool",
      tool_call_id: id,
      content: beefApiToolResultContent(part)
    });
  }
  return out;
}

function beefApiRejectUnrepresentableToolResultExtras(part) {
  var extras = part.experimental_content || part.content;
  if (!Array.isArray(extras)) {
    return;
  }
  for (var i = 0; i < extras.length; i++) {
    var item = extras[i];
    if (item != null && typeof item === "object" && item.type != null && item.type !== "text") {
      throw new Error("BeefAPI OpenAI tool result content is unrepresentable");
    }
  }
}

function beefApiToolResultContent(part) {
  if (typeof part.result === "string") {
    return part.result;
  }
  if (part.result !== undefined) {
    try {
      return JSON.stringify(part.result);
    } catch (_error) {
      throw new Error("BeefAPI OpenAI tool result content is unrepresentable");
    }
  }
  if (typeof part.content === "string") {
    return part.content;
  }
  if (Array.isArray(part.content)) {
    var texts = [];
    for (var i = 0; i < part.content.length; i++) {
      var item = part.content[i];
      if (item == null || typeof item !== "object" || item.type !== "text" || typeof item.text !== "string") {
        throw new Error("BeefAPI OpenAI tool result content is unrepresentable");
      }
      texts.push(item.text);
    }
    return texts.join("");
  }
  return "";
}

function beefApiHostToolCall(part) {
  var id = part.toolCallId || part.tool_call_id || part.id;
  var name = part.toolName || part.tool_name;
  if ((name == null || name === "") && part.function != null && typeof part.function.name === "string") {
    name = part.function.name;
  }
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
    throw new Error("BeefAPI OpenAI tool call is missing id or name");
  }
  var args = part.args;
  if (part.providerOptions != null && part.providerOptions.cursor != null && typeof part.providerOptions.cursor.rawToolCallArgs === "string") {
    args = part.providerOptions.cursor.rawToolCallArgs;
  }
  return {
    id: id,
    type: "function",
    function: {
      name: name,
      arguments: beefApiJsonArgumentString(args)
    }
  };
}

function beefApiOpenAiShapedToolCall(toolCall) {
  if (toolCall == null || typeof toolCall !== "object") {
    throw new Error("BeefAPI OpenAI tool call is unrepresentable");
  }
  var fn = toolCall.function;
  var id = toolCall.id;
  var name = fn != null ? fn.name : null;
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
    throw new Error("BeefAPI OpenAI tool call is missing id or name");
  }
  var args = fn.arguments;
  return {
    id: id,
    type: "function",
    function: {
      name: name,
      arguments: beefApiJsonArgumentString(args)
    }
  };
}

function beefApiJsonArgumentString(args) {
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
    throw new Error("BeefAPI OpenAI tool call arguments are unrepresentable");
  }
}

function beefApiConvertTool(tool) {
  if (tool == null || typeof tool !== "object" || Array.isArray(tool)) {
    throw new Error("BeefAPI OpenAI tool is unrepresentable");
  }
  if (tool.type === "provider-defined" || tool.type === "provider_defined") {
    throw new Error("BeefAPI OpenAI tool has an unrepresentable provider-defined shape");
  }
  if (tool.type != null && tool.type !== "function") {
    throw new Error("BeefAPI OpenAI tool has an unrepresentable provider-defined shape");
  }
  var fn = tool.type === "function" && tool.function != null && typeof tool.function === "object"
    ? tool.function
    : tool;
  var name = fn.name || tool.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("BeefAPI OpenAI tool is missing a function name");
  }
  var description = fn.description || tool.description;
  var parameters = beefApiToolParameters(fn.parameters || tool.parameters || fn.inputSchema || tool.inputSchema);
  var converted = {
    type: "function",
    function: {
      name: name,
      parameters: parameters
    }
  };
  if (typeof description === "string") {
    converted.function.description = description;
  }
  return converted;
}

function beefApiToolParameters(parameters) {
  if (parameters == null) {
    return { type: "object", properties: {} };
  }
  if (typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error("BeefAPI OpenAI tool parameters are unrepresentable");
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
  throw new Error("BeefAPI OpenAI tool parameters are unrepresentable");
}

function beefApiAsUtf8Bytes(chunk) {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (typeof ArrayBuffer !== "undefined" && chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  throw new Error("BeefAPI SSE decoder requires UTF-8 bytes");
}

function beefApiSplitSseLines(text, isEnd) {
  var lines = [];
  var start = 0;
  for (var i = 0; i < text.length; i++) {
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
  return { lines: lines, rest: text.slice(start) };
}

function beefApiBytesToBase64(bytes) {
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

function beefApiParseFinalToolArguments(raw) {
  var text = raw == null ? "" : String(raw);
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error("BeefAPI OpenAI tool call has invalid final JSON arguments");
  }
}

function beefApiMapFinishReason(reason) {
  if (reason == null || reason === "") {
    return null;
  }
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool-calls";
  }
  if (reason === "content_filter") {
    return "content-filter";
  }
  if (reason === "max_tokens") {
    return "length";
  }
  return String(reason);
}

function beefApiNormalizeUsage(usage) {
  if (usage == null || typeof usage !== "object") {
    return null;
  }
  var prompt = usage.prompt_tokens;
  if (prompt == null) prompt = usage.promptTokens;
  if (prompt == null) prompt = usage.input_tokens;
  if (prompt == null) prompt = usage.inputTokens;
  var completion = usage.completion_tokens;
  if (completion == null) completion = usage.completionTokens;
  if (completion == null) completion = usage.output_tokens;
  if (completion == null) completion = usage.outputTokens;
  var total = usage.total_tokens;
  if (total == null) total = usage.totalTokens;
  if (prompt == null && completion == null && total == null) {
    return null;
  }
  var promptTokens = Number(prompt);
  var completionTokens = Number(completion);
  var totalTokens = Number(total);
  if (!Number.isFinite(promptTokens)) promptTokens = 0;
  if (!Number.isFinite(completionTokens)) completionTokens = 0;
  if (!Number.isFinite(totalTokens)) totalTokens = promptTokens + completionTokens;
  var cacheRead = 0;
  if (usage.prompt_tokens_details != null && usage.prompt_tokens_details.cached_tokens != null) {
    cacheRead = Number(usage.prompt_tokens_details.cached_tokens) || 0;
  } else if (usage.cache_read_tokens != null) {
    cacheRead = Number(usage.cache_read_tokens) || 0;
  } else if (usage.cacheReadTokens != null) {
    cacheRead = Number(usage.cacheReadTokens) || 0;
  }
  var cacheWrite = 0;
  if (usage.cache_write_tokens != null) {
    cacheWrite = Number(usage.cache_write_tokens) || 0;
  } else if (usage.cacheWriteTokens != null) {
    cacheWrite = Number(usage.cacheWriteTokens) || 0;
  }
  return {
    promptTokens: promptTokens,
    completionTokens: completionTokens,
    totalTokens: totalTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite
  };
}

function beefApiPrimaryChoice(chunk) {
  var choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  for (var i = 0; i < choices.length; i++) {
    var choice = choices[i];
    if (choice != null && (choice.index === 0 || choice.index == null)) {
      return choice;
    }
  }
  return choices[0];
}

function beefApiDeltaText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  if (Array.isArray(content)) {
    var texts = [];
    for (var i = 0; i < content.length; i++) {
      var part = content[i];
      if (part == null || typeof part !== "object") {
        throw new Error("BeefAPI OpenAI content delta is unrepresentable");
      }
      if (part.type != null && part.type !== "text") {
        throw new Error("BeefAPI OpenAI content delta is unrepresentable");
      }
      if (typeof part.text !== "string") {
        throw new Error("BeefAPI OpenAI content delta is unrepresentable");
      }
      texts.push(part.text);
    }
    return texts.join("");
  }
  throw new Error("BeefAPI OpenAI content delta is unrepresentable");
}

function beefApiDeltaReasoning(delta) {
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

function beefApiStreamErrorMessage(errorValue) {
  if (typeof errorValue === "string" && errorValue.length > 0) {
    return errorValue;
  }
  if (errorValue != null && typeof errorValue === "object" && typeof errorValue.message === "string" && errorValue.message.length > 0) {
    return errorValue.message;
  }
  return "BeefAPI OpenAI stream error";
}

function beefApiTakeFinishEvents(accumulator, force) {
  var usage = accumulator.getUsage();
  var reason = accumulator.getFinishReason();
  if (!force && (reason == null || usage == null)) {
    return [];
  }
  if (accumulator.hasFinishEmitted()) {
    return [];
  }
  var events = [];
  if (reason != null || force) {
    var completed = accumulator.complete();
    for (var i = 0; i < completed.length; i++) {
      events.push(completed[i]);
    }
  }
  var finishUsage = usage != null
    ? {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens
    }
    : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  var meta = accumulator.getResponseMeta();
  var finish = {
    type: "finish",
    finishReason: reason == null ? "stop" : reason,
    usage: finishUsage
  };
  if (meta.id.length > 0 || meta.modelId.length > 0) {
    finish.response = {
      id: meta.id,
      modelId: meta.modelId
    };
  }
  events.push(finish);
  accumulator.markFinishEmitted();
  return events;
}
