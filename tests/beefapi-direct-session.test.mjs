import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SOURCE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "beefapi-direct-session.cjs");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");
const CONFIG_PATH = "/workspace/grok-home/config/direct-external-only.json";
const COMPLETIONS_URL = "http://127.0.0.1:18779/v1/chat/completions";

const ACTIVE_CONFIG = {
  schemaVersion: 1,
  enabled: true,
  mode: "external-only",
  nativeFallback: false,
  provider: "beefapi",
  group: "grok",
  modelId: "grok-4.6",
  baseUrl: "http://127.0.0.1:18779/v1"
};

const SESSION_OPTION_CASES = [
  ["main", {}],
  ["summary", { isSummarizationSession: true, skipLabeling: true, modelId: "summarizer" }],
  ["compaction", { requestSource: "compaction", skipLabeling: true, isSummarizationSession: true }],
  ["label", { requestSource: "label" }],
  ["review", { requestSource: "review" }],
  ["computer", { isComputerUseSubagent: true, skipLabeling: true }],
  ["browser", { isBrowserUseSubagent: true }],
  ["subagent", { modelId: "subagent-model", skipLabeling: true, lineage: { parentRequestId: "p1" } }]
];

class BasePromptBuilder {
  constructor(initialMessages) {
    this.messages = [];
    if (initialMessages) {
      this.messages = Array.isArray(initialMessages) ? [...initialMessages] : [initialMessages];
    }
  }
  appendMessages(newMessages) {
    const messagesToAdd = Array.isArray(newMessages) ? newMessages : [newMessages];
    this.messages.push(...messagesToAdd);
    return this;
  }
  getState() {
    return [...this.messages];
  }
  getMessages() {
    return [...this.messages];
  }
  clearMessages() {
    this.messages = [];
  }
}

class BasePromptExecutor {
  constructor(builder) {
    this.builder = builder;
  }
  appendMessages(messages) {
    this.builder.appendMessages(messages);
    return this;
  }
  getState() {
    return this.builder.getState();
  }
  getMessages() {
    return this.builder.getMessages();
  }
  clearMessages() {
    this.builder.clearMessages();
  }
}

function enoent() {
  const error = new Error(`ENOENT: ${CONFIG_PATH}`);
  error.code = "ENOENT";
  throw error;
}

function encodeSse(chunks) {
  const encoder = new TextEncoder();
  return chunks.map((chunk) => encoder.encode(typeof chunk === "string" ? chunk : `data: ${JSON.stringify(chunk)}\n\n`));
}

function readableFrom(byteChunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= byteChunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(byteChunks[index]);
      index += 1;
    }
  });
}

function headerBag(map) {
  const normalized = {};
  for (const [key, value] of Object.entries(map)) normalized[key.toLowerCase()] = value;
  return {
    get(name) {
      const value = normalized[String(name).toLowerCase()];
      return value == null ? null : String(value);
    }
  };
}

function sseResponse(chunks, extra = {}) {
  const status = extra.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerBag({
      "content-type": "text/event-stream",
      "x-request-id": extra.requestId ?? "req-test",
      ...extra.headers
    }),
    body: extra.body ?? readableFrom(encodeSse(chunks))
  };
}

function parseBeefApiDirectConfig(raw) {
  if (raw == null || raw === "") return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (parsed.enabled !== true) return null;
  if (parsed.mode !== "external-only" || parsed.nativeFallback !== false) {
    throw new Error("enabled BeefAPI direct config is invalid");
  }
  if (parsed.baseUrl !== ACTIVE_CONFIG.baseUrl || parsed.modelId !== "grok-4.6") {
    throw new Error("enabled BeefAPI direct config is invalid");
  }
  return parsed;
}

function toBeefApiOpenAiMessages(messages) {
  return (messages ?? []).map((message) => {
    if (message.role === "tool") {
      const part = Array.isArray(message.content) ? message.content.find((item) => item.type === "tool-result") : null;
      return {
        role: "tool",
        tool_call_id: part?.toolCallId ?? message.tool_call_id,
        content: typeof part?.result === "string" ? part.result : JSON.stringify(part?.result ?? message.content)
      };
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const toolCalls = message.content.filter((part) => part.type === "tool-call").map((part) => ({
        id: part.toolCallId,
        type: "function",
        function: { name: part.toolName, arguments: JSON.stringify(part.args ?? {}) }
      }));
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      return {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      };
    }
    return { role: message.role, content: message.content };
  });
}

function toBeefApiOpenAiTools(tools) {
  if (tools == null) return [];
  return tools.map((tool) => {
    if (tool?.type === "provider-defined") {
      throw new Error("unrepresentable provider-defined tool");
    }
    const name = tool.name ?? tool.function?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("unrepresentable host tool");
    }
    return {
      type: "function",
      function: {
        name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? tool.inputSchema ?? {}
      }
    };
  });
}

function createBeefApiSseDecoder() {
  const textDecoder = new TextDecoder();
  let pending = "";
  let completed = false;
  function takeFrames(raw) {
    const events = [];
    let rest = raw;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(rest);
      if (match == null) break;
      const frame = rest.slice(0, match.index);
      rest = rest.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") continue;
      if (data === "[DONE]") {
        completed = true;
        continue;
      }
      events.push(JSON.parse(data));
    }
    return { events, rest };
  }
  return {
    push(bytes) {
      pending += textDecoder.decode(bytes, { stream: true });
      const taken = takeFrames(pending);
      pending = taken.rest;
      return taken.events;
    },
    close() {
      pending += textDecoder.decode(new Uint8Array(), { stream: false });
      const taken = takeFrames(pending);
      pending = taken.rest;
      if (pending.trim() !== "") throw new Error("truncated BeefAPI SSE stream");
      if (!completed) throw new Error("missing BeefAPI SSE terminator");
      return taken.events;
    }
  };
}

function createBeefApiToolCallAccumulator() {
  const byIndex = new Map();
  return {
    ingest(toolCalls) {
      const events = [];
      for (const call of toolCalls ?? []) {
        const index = call.index ?? 0;
        let state = byIndex.get(index);
        if (state == null) {
          if (typeof call.id !== "string" || call.id.length === 0 || typeof call.function?.name !== "string") {
            throw new Error("tool call missing ID or name");
          }
          state = { id: call.id, name: call.function.name, args: "" };
          byIndex.set(index, state);
          events.push({ type: "tool-call-streaming-start", toolCallId: state.id, toolName: state.name });
        }
        if (typeof call.function?.arguments === "string" && call.function.arguments.length > 0) {
          state.args += call.function.arguments;
          events.push({
            type: "tool-call-delta",
            toolCallId: state.id,
            toolName: state.name,
            argsTextDelta: call.function.arguments
          });
        }
      }
      return events;
    },
    finalize() {
      return [...byIndex.values()].map((state) => {
        let args;
        try {
          args = JSON.parse(state.args || "{}");
        } catch {
          throw new Error("invalid final tool call arguments");
        }
        if (typeof state.id !== "string" || state.id.length === 0 || typeof state.name !== "string") {
          throw new Error("tool call missing ID or name");
        }
        return { type: "tool-call", toolCallId: state.id, toolName: state.name, args };
      });
    }
  };
}

function mapUsage(usage) {
  if (usage == null) return null;
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: usage.cache_read_tokens ?? 0,
    cacheWriteTokens: usage.cache_write_tokens ?? 0
  };
}

function beefApiChunkToHostEvents(chunk, accumulator) {
  const events = [];
  const choice = chunk?.choices?.[0] ?? {};
  const delta = choice.delta ?? {};
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    events.push({ type: "reasoning", textDelta: delta.reasoning_content });
  }
  if (typeof delta.content === "string" && delta.content.length > 0) {
    events.push({ type: "text-delta", textDelta: delta.content });
  }
  if (Array.isArray(delta.tool_calls)) {
    events.push(...accumulator.ingest(delta.tool_calls));
  }
  if (choice.finish_reason) {
    events.push(...accumulator.finalize());
    const usage = mapUsage(chunk.usage);
    events.push({
      type: "finish",
      finishReason: choice.finish_reason,
      usage,
      extendedUsage: usage == null ? null : {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        maxTokens: 0
      },
      requestId: chunk.id
    });
  }
  return events;
}

function loadModule(overrides = {}) {
  const files = new Map(overrides.files instanceof Map ? overrides.files : Object.entries(overrides.files ?? {}));
  const fetches = [];
  const defaultFetch = async (url, init) => {
    fetches.push({ url, init });
    if (typeof overrides.fetchImpl === "function") return overrides.fetchImpl(url, init, fetches);
    throw new Error("fetch not stubbed");
  };
  const context = {
    fetch: overrides.fetch ?? defaultFetch,
    TextDecoder,
    TextEncoder,
    crypto,
    Uint8Array,
    ArrayBuffer,
    BasePromptBuilder,
    BasePromptExecutor,
    parseBeefApiDirectConfig: overrides.parseBeefApiDirectConfig ?? parseBeefApiDirectConfig,
    toBeefApiOpenAiMessages: overrides.toBeefApiOpenAiMessages ?? toBeefApiOpenAiMessages,
    toBeefApiOpenAiTools: overrides.toBeefApiOpenAiTools ?? toBeefApiOpenAiTools,
    createBeefApiSseDecoder: overrides.createBeefApiSseDecoder ?? createBeefApiSseDecoder,
    createBeefApiToolCallAccumulator: overrides.createBeefApiToolCallAccumulator ?? createBeefApiToolCallAccumulator,
    beefApiChunkToHostEvents: overrides.beefApiChunkToHostEvents ?? beefApiChunkToHostEvents,
    require(id) {
      if (id !== "node:fs" && id !== "fs") throw new Error(`unexpected require: ${id}`);
      return {
        readFileSync(filePath) {
          if (typeof overrides.readFileSync === "function") return overrides.readFileSync(filePath);
          if (filePath !== CONFIG_PATH) enoent();
          if (!files.has(CONFIG_PATH)) enoent();
          return files.get(CONFIG_PATH);
        }
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: "beefapi-direct-session.cjs" });
  return {
    context,
    fetches,
    loadBeefApiDirectConfig: context.loadBeefApiDirectConfig,
    createBeefApiDirectPromptSession: context.createBeefApiDirectPromptSession,
    wrapHostInferenceWithBeefApiDirect: context.wrapHostInferenceWithBeefApiDirect
  };
}

function withActiveConfig(overrides = {}) {
  return loadModule({
    files: { [CONFIG_PATH]: JSON.stringify(ACTIVE_CONFIG) },
    ...overrides
  });
}

async function settle(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function consume(result) {
  const events = [];
  let streamError = null;
  try {
    for await (const event of result.fullStream) events.push(event);
  } catch (error) {
    streamError = error;
  }
  return {
    events,
    streamError,
    usage: await settle(result.usage),
    extendedUsage: await settle(result.extendedUsage),
    providerMetadata: await settle(result.providerMetadata),
    invocationId: await settle(result.invocationId),
    response: await settle(result.response)
  };
}

function fromVm(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertAllRejected(consumed, message) {
  assert.equal(consumed.usage.status, "rejected", message);
  assert.equal(consumed.extendedUsage.status, "rejected", message);
  assert.equal(consumed.providerMetadata.status, "rejected", message);
  assert.equal(consumed.invocationId.status, "rejected", message);
  assert.equal(consumed.response.status, "rejected", message);
  assert.ok(consumed.streamError, message);
  assert.equal(consumed.events.at(-1)?.type, "error", message);
}

function usageChunk(id = "chatcmpl-1") {
  return {
    id,
    object: "chat.completion.chunk",
    model: "grok-4.6",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
  };
}

test("loadBeefApiDirectConfig returns null when the config file is missing", () => {
  const mod = loadModule();
  assert.equal(mod.loadBeefApiDirectConfig(), null);
});

test("loadBeefApiDirectConfig returns null when the config is disabled", () => {
  const mod = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, enabled: false }) }
  });
  assert.equal(mod.loadBeefApiDirectConfig(), null);
});

test("loadBeefApiDirectConfig throws when an enabled config is invalid", () => {
  const mod = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, nativeFallback: true }) }
  });
  assert.throws(() => mod.loadBeefApiDirectConfig(), /invalid/);
});

test("streams text, usage, metadata, and a stable response", async () => {
  const mod = withActiveConfig({
    fetchImpl: async () => sseResponse([
      { id: "chatcmpl-text", choices: [{ index: 0, delta: { content: "hello" } }] },
      { id: "chatcmpl-text", choices: [{ index: 0, delta: { content: " world" } }] },
      usageChunk("chatcmpl-text"),
      "data: [DONE]\n\n"
    ])
  });
  const session = mod.createBeefApiDirectPromptSession({ config: ACTIVE_CONFIG });
  assert.equal(session.getModelId(), "grok-4.6");
  const executor = session.getExecutor([{ role: "user", content: "hi" }]);
  const consumed = await consume(executor.stream({ signal: undefined }, "inv-text", []));
  assert.equal(consumed.streamError, null);
  assert.deepEqual(consumed.events.filter((event) => event.type === "text-delta").map((event) => event.textDelta), ["hello", " world"]);
  assert.equal(consumed.events.filter((event) => event.type === "finish").length, 1);
  assert.equal(consumed.usage.status, "fulfilled");
  assert.deepEqual(fromVm(consumed.usage.value), { promptTokens: 11, completionTokens: 5, totalTokens: 16 });
  assert.deepEqual(fromVm(consumed.extendedUsage.value), {
    inputTokens: 11,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 0
  });
  assert.equal(consumed.providerMetadata.value.beefapiRequestId, "req-test");
  assert.equal(consumed.invocationId.value, "inv-text");
  assert.equal(consumed.response.value.id, "inv-text");
  assert.equal(consumed.response.value.modelId, "grok-4.6");
  assert.equal(consumed.response.value.messages[0].id, "inv-text");
  assert.deepEqual(fromVm(consumed.response.value.messages[0].content), [{ type: "text", text: "hello world" }]);
  assert.equal(mod.fetches[0].url, COMPLETIONS_URL);
  assert.equal(JSON.parse(mod.fetches[0].init.body).stream, true);
  assert.equal(mod.fetches[0].init.headers.authorization, undefined);
  assert.equal(mod.fetches[0].init.headers.Authorization, undefined);
});

test("streams reasoning then text", async () => {
  const mod = withActiveConfig({
    fetchImpl: async () => sseResponse([
      { id: "chatcmpl-r", choices: [{ index: 0, delta: { reasoning_content: "think" } }] },
      { id: "chatcmpl-r", choices: [{ index: 0, delta: { content: "done" } }] },
      usageChunk("chatcmpl-r"),
      "data: [DONE]\n\n"
    ])
  });
  const executor = mod.createBeefApiDirectPromptSession({ config: ACTIVE_CONFIG }).getExecutor();
  const consumed = await consume(executor.stream({}, "inv-r", []));
  assert.equal(consumed.streamError, null);
  assert.equal(consumed.events[0].type, "reasoning");
  assert.deepEqual(fromVm(consumed.response.value.messages[0].content), [
    { type: "reasoning", text: "think" },
    { type: "text", text: "done" }
  ]);
});

test("preserves tool call IDs across a second-turn tool result continuation", async () => {
  const bodies = [];
  const mod = withActiveConfig({
    fetchImpl: async (_url, init) => {
      const parsed = JSON.parse(init.body);
      bodies.push(parsed);
      if (bodies.length === 1) {
        return sseResponse([
          {
            id: "chatcmpl-tool",
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"q\":" } }] }
            }]
          },
          {
            id: "chatcmpl-tool",
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] }
            }]
          },
          {
            id: "chatcmpl-tool",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
          },
          "data: [DONE]\n\n"
        ]);
      }
      return sseResponse([
        { id: "chatcmpl-tool2", choices: [{ index: 0, delta: { content: "found" } }] },
        usageChunk("chatcmpl-tool2"),
        "data: [DONE]\n\n"
      ]);
    }
  });
  const session = mod.createBeefApiDirectPromptSession({ config: ACTIVE_CONFIG });
  const executor = session.getExecutor([{ role: "user", content: "search" }]);
  const first = await consume(executor.stream({}, "inv-1", [{ name: "lookup", parameters: { type: "object" } }]));
  assert.equal(first.streamError, null);
  const toolCall = first.events.find((event) => event.type === "tool-call");
  assert.deepEqual(toolCall, { type: "tool-call", toolCallId: "call_1", toolName: "lookup", args: { q: "x" } });
  executor.appendMessages([
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "lookup", args: { q: "x" } }]
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", toolName: "lookup", result: { ok: true } }]
    }
  ]);
  const continued = session.getExecutor(executor.getState());
  assert.deepEqual(continued.getMessages(), executor.getMessages());
  const second = await consume(continued.stream({}, "inv-2", [{ name: "lookup", parameters: { type: "object" } }]));
  assert.equal(second.streamError, null);
  assert.equal(second.response.value.messages[0].content[0].text, "found");
  assert.equal(bodies[0].tools[0].function.name, "lookup");
  const toolResult = bodies[1].messages.find((message) => message.role === "tool");
  assert.equal(toolResult.tool_call_id, "call_1");
  assert.equal(JSON.parse(mod.fetches[0].init.body).max_tokens, undefined);
});

test("all session option categories select direct mode and never call stock", () => {
  const stockCalls = [];
  const labelingCalls = [];
  const mod = withActiveConfig();
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      return { getModelId: () => "stock-model", getExecutor() { throw new Error("stock executor"); } };
    },
    recordPostTurnLabeling(...args) {
      labelingCalls.push(args);
    }
  });
  for (const [name, sessionOptions] of SESSION_OPTION_CASES) {
    const session = wrapped.createSession(() => {}, sessionOptions);
    assert.equal(session.getModelId(), "grok-4.6", name);
    assert.equal(typeof session.getExecutor().stream, "function", name);
  }
  assert.equal(stockCalls.length, 0);
  wrapped.recordPostTurnLabeling({ requestId: "r", conversationId: "c", modelName: "stock", messages: [{ role: "user", content: "secret" }] });
  assert.equal(labelingCalls.length, 0);
});

test("inactive config preserves stock session and labeling", () => {
  const stockCalls = [];
  const labelingCalls = [];
  const stockSession = { getModelId: () => "stock-model", getExecutor: () => "stock-executor" };
  const mod = loadModule();
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      return stockSession;
    },
    recordPostTurnLabeling(...args) {
      labelingCalls.push(args);
    }
  });
  const sessionOptions = { isSummarizationSession: true };
  assert.equal(wrapped.createSession("cb", sessionOptions), stockSession);
  assert.deepEqual(stockCalls, [["cb", sessionOptions]]);
  wrapped.recordPostTurnLabeling({ requestId: "r" });
  assert.equal(labelingCalls.length, 1);
});

test("malformed active config throws and never calls stock", () => {
  const stockCalls = [];
  const mod = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, baseUrl: "https://example.com/v1" }) }
  });
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      return {};
    },
    recordPostTurnLabeling() {
      stockCalls.push("label");
    }
  });
  assert.throws(() => wrapped.createSession(() => {}, { requestSource: "review" }), /invalid/);
  assert.throws(() => wrapped.recordPostTurnLabeling({ requestId: "r" }), /invalid/);
  assert.equal(stockCalls.length, 0);
});

test("non-2xx rejects every promise, yields error, and never calls stock", async () => {
  const stockCalls = [];
  const mod = withActiveConfig({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      headers: headerBag({}),
      body: readableFrom([])
    })
  });
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const executor = wrapped.createSession(() => {}, { requestSource: "main" }).getExecutor([{ role: "user", content: "hi" }]);
  const consumed = await consume(executor.stream({}, "inv-502", []));
  assertAllRejected(consumed, "non-2xx must fail closed");
  assert.match(String(consumed.streamError), /502/);
  assert.equal(stockCalls.length, 0);
  assert.equal(mod.fetches.length, 1);
});

test("abort rejects every promise and never calls stock", async () => {
  const stockCalls = [];
  const controller = new AbortController();
  const mod = withActiveConfig({
    fetchImpl: async (_url, init) => {
      controller.abort();
      if (init.signal?.aborted) {
        throw beefAbort(init.signal);
      }
      await new Promise(() => {});
    }
  });
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  controller.abort();
  const executor = wrapped.createSession(() => {}, {}).getExecutor();
  const consumed = await consume(executor.stream({ signal: controller.signal }, "inv-abort", []));
  assertAllRejected(consumed, "abort must fail closed");
  assert.equal(consumed.streamError.name, "AbortError");
  assert.equal(stockCalls.length, 0);
});

test("truncated SSE rejects every promise and never calls stock", async () => {
  const stockCalls = [];
  const mod = withActiveConfig({
    fetchImpl: async () => sseResponse([
      { id: "chatcmpl-trunc", choices: [{ index: 0, delta: { content: "partial" } }] }
    ])
  });
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(
    wrapped.createSession(() => {}, { isComputerUseSubagent: true }).getExecutor().stream({}, "inv-trunc", [])
  );
  assertAllRejected(consumed, "truncated SSE must fail closed");
  assert.match(String(consumed.streamError), /terminator|truncated/i);
  assert.equal(stockCalls.length, 0);
});

test("invalid JSON SSE rejects every promise and never calls stock", async () => {
  const stockCalls = [];
  const mod = withActiveConfig({
    fetchImpl: async () => sseResponse(["data: {not-json}\n\n", "data: [DONE]\n\n"])
  });
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(wrapped.createSession(() => {}, {}).getExecutor().stream({}, "inv-json", []));
  assertAllRejected(consumed, "invalid JSON must fail closed");
  assert.equal(stockCalls.length, 0);
});

test("protocol helper error rejects every promise and never calls stock", async () => {
  const stockCalls = [];
  const mod = withActiveConfig({
    toBeefApiOpenAiTools() {
      throw new Error("unrepresentable provider-defined tool");
    }
  });
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(
    wrapped.createSession(() => {}, { isBrowserUseSubagent: true }).getExecutor().stream({}, "inv-tool", [{ type: "provider-defined", id: "computer" }])
  );
  assertAllRejected(consumed, "protocol helper error must fail closed");
  assert.match(String(consumed.streamError), /unrepresentable/);
  assert.equal(stockCalls.length, 0);
  assert.equal(mod.fetches.length, 0);
});

test("connection failure rejects every promise and never calls stock", async () => {
  const stockCalls = [];
  const mod = withActiveConfig({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    }
  });
  const wrapped = mod.wrapHostInferenceWithBeefApiDirect({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(wrapped.createSession(() => {}, {}).getExecutor().stream({}, "inv-net", []));
  assertAllRejected(consumed, "connection failure must fail closed");
  assert.equal(stockCalls.length, 0);
});

test("sets max_tokens only when the executor option is explicit", async () => {
  const mod = withActiveConfig({
    fetchImpl: async () => sseResponse([
      { id: "chatcmpl-max", choices: [{ index: 0, delta: { content: "ok" } }] },
      usageChunk("chatcmpl-max"),
      "data: [DONE]\n\n"
    ])
  });
  const executor = mod.createBeefApiDirectPromptSession({ config: ACTIVE_CONFIG }).getExecutor();
  await consume(executor.stream({}, "inv-max", [], { maxTokens: 32 }));
  assert.equal(JSON.parse(mod.fetches[0].init.body).max_tokens, 32);
});

function beefAbort(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("BeefAPI direct request aborted");
  error.name = "AbortError";
  return error;
}
