// Injected into the 0.30 host bundle. Keep this file free of export assignments.
// Wire helpers are same-scope free variables from beefapi-openai-wire.cjs:
//   parseBeefApiDirectConfig(raw) -> config | null
//   toBeefApiOpenAiMessages(messages) -> OpenAI messages
//   toBeefApiOpenAiTools(tools) -> OpenAI tools
//   createBeefApiSseDecoder() -> { push(Uint8Array): chunks[], close(): chunks[] }
//     close() throws on truncated frames or missing [DONE]
//   createBeefApiToolCallAccumulator() -> opaque state for tool deltas
//   beefApiChunkToHostEvents(chunk, accumulator) -> host stream parts
//     finish carries usage, extendedUsage, and requestId when present

var BEEFAPI_DIRECT_CONFIG_PATH = "/workspace/grok-home/config/direct-external-only.json";
var BeefApiDirectPromptExecutorCtor;

function beefApiDirectIsErrorLike(value) {
  return value != null && typeof value === "object" && typeof value.message === "string";
}

function beefApiDirectAsError(value) {
  if (beefApiDirectIsErrorLike(value)) return value;
  return new Error(String(value));
}

function beefApiDirectAbortError(signal) {
  if (signal != null && beefApiDirectIsErrorLike(signal.reason)) return signal.reason;
  var error = new Error("BeefAPI direct request aborted");
  error.name = "AbortError";
  return error;
}

function beefApiDirectDeferred() {
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

function beefApiDirectAsUint8Array(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("BeefAPI direct stream returned an invalid body chunk");
}

function beefApiDirectHeader(response, name) {
  if (response == null || response.headers == null) return null;
  var headers = response.headers;
  if (typeof headers.get === "function") {
    var value = headers.get(name);
    return value == null || value === "" ? null : String(value);
  }
  var direct = headers[name] || headers[name.toLowerCase()];
  return direct == null || direct === "" ? null : String(direct);
}

function beefApiDirectRequestKind(sessionOptions) {
  var options = sessionOptions || {};
  if (options.requestSource === "compaction") return "compaction";
  if (options.isSummarizationSession === true) return "summary";
  if (options.requestSource === "label") return "label";
  if (options.requestSource === "review") return "review";
  if (options.isComputerUseSubagent === true) return "computer";
  if (options.isBrowserUseSubagent === true) return "browser";
  if (options.modelId != null || options.lineage != null) return "subagent";
  return "main";
}

function beefApiDirectDecoderChunks(result, where) {
  if (result == null) return [];
  if (Array.isArray(result)) return result;
  throw new Error("BeefAPI SSE decoder " + where + " must return an array of chunks");
}

function beefApiDirectHostEvents(chunk, accumulator) {
  var events = beefApiChunkToHostEvents(chunk, accumulator);
  if (!Array.isArray(events)) {
    throw new Error("beefApiChunkToHostEvents must return an array of host stream parts");
  }
  return events;
}

function beefApiDirectUsageFromFinish(event) {
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

function beefApiDirectExtendedUsageFromFinish(event, usage) {
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

function beefApiDirectCreatePump() {
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

async function beefApiDirectForEachBodyChunk(response, signal, onChunk) {
  var body = response == null ? null : response.body;
  if (body == null) {
    if (response != null && typeof response.arrayBuffer === "function") {
      await onChunk(new Uint8Array(await response.arrayBuffer()));
      return;
    }
    if (response != null && typeof response.text === "function") {
      await onChunk(new TextEncoder().encode(await response.text()));
      return;
    }
    throw new Error("BeefAPI direct response body is not readable");
  }
  if (typeof body.getReader === "function") {
    var reader = body.getReader();
    try {
      for (;;) {
        if (signal != null && signal.aborted) throw beefApiDirectAbortError(signal);
        var read = await reader.read();
        if (read.done) break;
        if (read.value != null) await onChunk(beefApiDirectAsUint8Array(read.value));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_release) {}
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (var nodeChunk of body) {
      if (signal != null && signal.aborted) throw beefApiDirectAbortError(signal);
      await onChunk(beefApiDirectAsUint8Array(nodeChunk));
    }
    return;
  }
  throw new Error("BeefAPI direct response body is not readable");
}

function beefApiDirectReadConfigFile() {
  try {
    return require("node:fs").readFileSync(BEEFAPI_DIRECT_CONFIG_PATH, "utf8");
  } catch (error) {
    if (error != null && error.code === "ENOENT") return null;
    throw error;
  }
}

function loadBeefApiDirectConfig() {
  var raw = beefApiDirectReadConfigFile();
  if (raw == null) return null;
  return parseBeefApiDirectConfig(raw);
}

function getBeefApiDirectPromptExecutorCtor() {
  if (BeefApiDirectPromptExecutorCtor == null) {
    BeefApiDirectPromptExecutorCtor = class BeefApiDirectPromptExecutor extends BasePromptExecutor {
      constructor(config, initialMessages, sessionContext) {
        super(new BasePromptBuilder(initialMessages));
        this._beefApiDirectConfig = config;
        this._beefApiDirectSession = sessionContext || {};
      }
      stream(ctx, invocationId, tools, options) {
        return streamBeefApiDirect(this, ctx, invocationId, tools, options);
      }
    };
  }
  return BeefApiDirectPromptExecutorCtor;
}

function createBeefApiDirectPromptSession(options) {
  var sessionContext = options || {};
  var config = sessionContext.config != null ? sessionContext.config : loadBeefApiDirectConfig();
  if (config == null) {
    throw new Error("BeefAPI direct session requires an active direct config");
  }
  var Executor = getBeefApiDirectPromptExecutorCtor();
  return {
    getModelId: function () {
      return config.modelId;
    },
    getExecutor: function (state) {
      return new Executor(config, state, sessionContext);
    }
  };
}

function wrapHostInferenceWithBeefApiDirect(cursorInference, _options) {
  var directConfig = loadBeefApiDirectConfig();
  if (directConfig == null) {
    return cursorInference;
  }
  return {
    ...cursorInference,
    createSession: function (onRequestId, sessionOptions) {
      return createBeefApiDirectPromptSession({
        onRequestId: onRequestId,
        sessionOptions: sessionOptions,
        config: directConfig
      });
    },
    recordPostTurnLabeling: function (_args) {}
  };
}

function streamBeefApiDirect(executor, ctx, invocationId, tools, options) {
  var usageSlot = beefApiDirectDeferred();
  var extendedSlot = beefApiDirectDeferred();
  var metadataSlot = beefApiDirectDeferred();
  var invocationSlot = beefApiDirectDeferred();
  var responseSlot = beefApiDirectDeferred();
  var pump = beefApiDirectCreatePump();
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

    function onHostEvent(event) {
      if (event == null || typeof event !== "object") {
        throw new Error("BeefAPI direct helper emitted an invalid host event");
      }
      if (event.type === "finish") {
        if (sawFinish) throw new Error("BeefAPI direct stream emitted multiple finish events");
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
        throw beefApiDirectAsError(event.error);
      }
      pump.push(event);
    }

    function applyChunks(chunks, where) {
      var decoded = beefApiDirectDecoderChunks(chunks, where);
      for (var i = 0; i < decoded.length; i += 1) {
        var events = beefApiDirectHostEvents(decoded[i], accumulator);
        for (var j = 0; j < events.length; j += 1) {
          onHostEvent(events[j]);
        }
      }
    }

    var accumulator;
    try {
      if (signal != null && signal.aborted) throw beefApiDirectAbortError(signal);
      var messages = toBeefApiOpenAiMessages(executor.getMessages());
      var openaiTools = toBeefApiOpenAiTools(tools);
      var body = {
        model: executor._beefApiDirectConfig.modelId,
        messages: messages,
        stream: true,
        stream_options: { include_usage: true }
      };
      if (openaiTools != null && openaiTools.length > 0) {
        body.tools = openaiTools;
      }
      if (options != null && options.maxTokens != null) {
        body.max_tokens = options.maxTokens;
      }
      var response = await fetch(executor._beefApiDirectConfig.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-grok-request-kind": beefApiDirectRequestKind(executor._beefApiDirectSession.sessionOptions)
        },
        body: JSON.stringify(body),
        signal: signal
      });
      if (signal != null && signal.aborted) throw beefApiDirectAbortError(signal);
      headerRequestId = beefApiDirectHeader(response, "x-request-id")
        || beefApiDirectHeader(response, "x-oneapi-request-id");
      if (headerRequestId != null && typeof executor._beefApiDirectSession.onRequestId === "function") {
        executor._beefApiDirectSession.onRequestId(headerRequestId);
      }
      if (response == null || response.ok !== true || response.status < 200 || response.status > 299) {
        var status = response == null ? 0 : response.status;
        throw new Error("BeefAPI direct request failed with status " + status);
      }
      var decoder = createBeefApiSseDecoder();
      if (decoder == null || typeof decoder.push !== "function" || typeof decoder.close !== "function") {
        throw new Error("createBeefApiSseDecoder must return { push, close }");
      }
      accumulator = createBeefApiToolCallAccumulator();
      await beefApiDirectForEachBodyChunk(response, signal, function (bytes) {
        applyChunks(decoder.push(bytes), "push()");
      });
      applyChunks(decoder.close(), "close()");
      if (!sawFinish || finishEvent == null) {
        throw new Error("BeefAPI direct stream ended without a terminal finish event");
      }
      if (pendingToolCalls.size > 0) {
        throw new Error("BeefAPI direct stream ended with incomplete tool calls");
      }
      var usage = beefApiDirectUsageFromFinish(finishEvent);
      if (usage == null) {
        throw new Error("BeefAPI direct stream finished without usage");
      }
      var extendedUsage = beefApiDirectExtendedUsageFromFinish(finishEvent, usage);
      var requestId = headerRequestId
        || finishEvent.requestId
        || (finishEvent.response != null ? finishEvent.response.id : null);
      var providerMetadata = finishEvent.providerMetadata != null && typeof finishEvent.providerMetadata === "object"
        ? { ...finishEvent.providerMetadata }
        : {};
      if (requestId != null && requestId !== "") {
        providerMetadata.beefapiRequestId = requestId;
        if (headerRequestId == null && typeof executor._beefApiDirectSession.onRequestId === "function") {
          executor._beefApiDirectSession.onRequestId(requestId);
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
      usageSlot.resolve(usage);
      extendedSlot.resolve(extendedUsage);
      metadataSlot.resolve(providerMetadata);
      invocationSlot.resolve(resolvedInvocationId);
      responseSlot.resolve({
        id: resolvedInvocationId,
        modelId: executor._beefApiDirectConfig.modelId,
        timestamp: new Date(),
        messages: [{
          id: resolvedInvocationId,
          role: "assistant",
          content: content
        }]
      });
      pump.end();
    } catch (error) {
      var err = beefApiDirectAsError(error);
      pump.push({ type: "error", error: err });
      usageSlot.reject(err);
      extendedSlot.reject(err);
      metadataSlot.reject(err);
      invocationSlot.reject(err);
      responseSlot.reject(err);
      pump.fail(err);
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
