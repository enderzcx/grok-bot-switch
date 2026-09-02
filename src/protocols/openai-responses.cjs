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
      args: tools.parseToolArgumentsObject(current.arguments, PROTOCOL_ID)
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

function eventType(raw, payload) {
  if (payload != null && typeof payload.type === "string" && payload.type.length > 0) {
    if (raw.event !== "message" && raw.event !== payload.type) {
      throw contract.protocolError("OpenAI Responses SSE event type mismatch", {
        protocol: PROTOCOL_ID,
        code: "invalid-json"
      });
    }
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
    events.push(contract.providerStateEvent(PROTOCOL_ID, [validateResponsesReasoningItem(item)]));
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
  if (type === "ping" || type === "response.created" || type === "response.in_progress") {
    if (payload.response != null) {
      state.observeResponse(payload.response);
    }
    return events;
  }
  if (type === "response.failed") {
    state.markFailed();
    if (payload.response != null) {
      state.observeResponse(payload.response);
    }
    throw contract.protocolError(
      errorMessageFrom(payload, "OpenAI Responses stream failed"),
      { protocol: PROTOCOL_ID, code: "stream-error" }
    );
  }
  if (type === "error") {
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
  if (type === "response.completed") {
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
