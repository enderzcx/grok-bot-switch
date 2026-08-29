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
      out.push({ role: "user", content: userContent(message) });
    } else if (role === "assistant") {
      out.push(assistantMessage(message));
    } else if (role === "tool") {
      var toolMessages = tools.extractToolResults(message, PROTOCOL_ID);
      for (var j = 0; j < toolMessages.length; j += 1) {
        out.push({
          role: "tool",
          tool_call_id: toolMessages[j].id,
          content: toolMessages[j].content
        });
      }
    } else {
      throw tools.unsupported(PROTOCOL_ID, "OpenAI Chat message role is unrepresentable");
    }
  }
  return out;
}

function userContent(message) {
  var parts = tools.extractUserParts(message, PROTOCOL_ID);
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
  var result = {
    role: "assistant",
    content: payload.text.length === 0 ? null : payload.text
  };
  if (payload.reasoning.length > 0) {
    result.reasoning_content = payload.reasoning;
  }
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
          args: tools.parseToolArgumentsObject(current.arguments, PROTOCOL_ID)
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
