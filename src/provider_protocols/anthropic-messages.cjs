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

function assistantContent(payload) {
  var content = [];
  if (payload.reasoning.length > 0) {
    content.push({ type: "thinking", thinking: payload.reasoning });
  }
  if (payload.text.length > 0) {
    content.push({ type: "text", text: payload.text });
  }
  for (var i = 0; i < payload.toolCalls.length; i += 1) {
    content.push({
      type: "tool_use",
      id: payload.toolCalls[i].id,
      name: payload.toolCalls[i].name,
      input: tools.parseToolArgumentsObject(payload.toolCalls[i].arguments, PROTOCOL_ID)
    });
  }
  if (content.length === 0) {
    throw tools.unsupported(PROTOCOL_ID, "Anthropic assistant content is unrepresentable");
  }
  return content;
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
      out.push({
        role: "assistant",
        content: assistantContent(tools.extractAssistantPayload(message, PROTOCOL_ID))
      });
    } else if (role === "tool") {
      var results = tools.extractToolResults(message, PROTOCOL_ID);
      var toolParts = [];
      for (var r = 0; r < results.length; r += 1) {
        toolParts.push({
          type: "tool_result",
          tool_use_id: results[r].id,
          content: results[r].content
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
      args: tools.parseToolArgumentsObject(current.arguments, PROTOCOL_ID)
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
      events.push({ type: "reasoning", textDelta: block.thinking });
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
    if (delta.thinking.length > 0) {
      events.push({ type: "reasoning", textDelta: delta.thinking });
    }
    return;
  }
  if (delta.type === "signature_delta") {
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
  throw tools.unsupported(PROTOCOL_ID, "Anthropic event is unrepresentable");
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
