import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(root, "src", "provider-direct-session.cjs");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");
const FIXTURES = path.join(root, "tests", "fixtures", "provider_protocols");
const nodeRequire = createRequire(import.meta.url);
const protocols = nodeRequire("../src/provider_protocols/index.cjs");

const CONFIG_PATH = "/workspace/grok-home/config/external.json";
const CHAT_URL = "http://127.0.0.1:18779/chat/completions";

const ACTIVE_CONFIG = {
  schemaVersion: 1,
  enabled: true,
  mode: "external-only",
  nativeFallback: false,
  fallbackPolicy: "never",
  profileId: "custom-openai",
  protocol: "openai-chat",
  model: "model-name",
  baseUrl: "http://127.0.0.1:18779",
  endpointPath: "/chat/completions",
  generation: 1,
  profileDigest: "06b100f3190f0af653876625d97fbff1edc903662cc172e02d8eb62ce6789773"
};

const SESSION_OPTION_CASES = [
  ["main", {}],
  ["summary", { isSummarizationSession: true, skipLabeling: true, modelId: "summarizer" }],
  ["compaction", { requestSource: "compaction", skipLabeling: true, isSummarizationSession: true }],
  ["memory", { requestSource: "memory", skipLabeling: true, modelId: "memory" }],
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

function fixtureSseResponse(relative, extra = {}) {
  const text = fs.readFileSync(path.join(FIXTURES, relative), "utf8");
  return sseResponse([text.endsWith("\n") ? text : `${text}\n`], extra);
}

function configFor(protocol, extra = {}) {
  const paths = {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages"
  };
  return {
    ...ACTIVE_CONFIG,
    protocol,
    endpointPath: paths[protocol],
    ...extra
  };
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
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    BasePromptBuilder,
    BasePromptExecutor,
    require(id) {
      if (id === "./provider_protocols/index.cjs") return protocols;
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
  vm.runInContext(SOURCE, context, { filename: "provider-direct-session.cjs" });
  return {
    context,
    fetches,
    loadProviderDirectConfig: context.loadProviderDirectConfig,
    parseProviderDirectConfig: context.parseProviderDirectConfig,
    createProviderDirectPromptSession: context.createProviderDirectPromptSession,
    wrapHostInferenceWithProviderSwitcher: context.wrapHostInferenceWithProviderSwitcher
  };
}

function withActiveConfig(overrides = {}) {
  const config = overrides.config ?? ACTIVE_CONFIG;
  return loadModule({
    files: { [CONFIG_PATH]: JSON.stringify(config) },
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
    model: "model-name",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
  };
}

function simulateHostRedaction(message) {
  const next = { role: message.role, content: message.content };
  if (message.id !== undefined) next.id = message.id;
  if (message.providerOptions !== undefined) next.providerOptions = message.providerOptions;
  return next;
}

const LOOKUP_TOOL = [{ name: "lookup", parameters: { type: "object" } }];
const ALPHA_TOOL = [{ name: "alpha", parameters: { type: "object", properties: { a: { type: "number" } } } }];

test("loadProviderDirectConfig returns null when the config file is missing", () => {
  const mod = loadModule();
  assert.equal(mod.loadProviderDirectConfig(), null);
});

test("loadProviderDirectConfig returns null when the config is disabled", () => {
  const mod = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, enabled: false }) }
  });
  assert.equal(mod.loadProviderDirectConfig(), null);
});

test("present but malformed activation config never silently enables native inference", () => {
  for (const raw of ["", " ", "null", "{}", '{"enabled":"true"}', '{"enabled":null}', '{"enabled":0}']) {
    const mod = loadModule({ files: { [CONFIG_PATH]: raw } });
    assert.throws(() => mod.loadProviderDirectConfig(), /config is invalid/);
  }
});

test("loadProviderDirectConfig throws when an enabled config is invalid", () => {
  const mod = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, nativeFallback: true }) }
  });
  assert.throws(() => mod.loadProviderDirectConfig(), /invalid/);
});

test("loadProviderDirectConfig throws on non-loopback baseUrl and extra credential fields", () => {
  const remote = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, baseUrl: "https://api.example.com" }) }
  });
  assert.throws(() => remote.loadProviderDirectConfig(), /invalid/);
  const secret = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, apiKey: "sk-test" }) }
  });
  assert.throws(() => secret.loadProviderDirectConfig(), /invalid/);
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
  const session = mod.createProviderDirectPromptSession({ config: ACTIVE_CONFIG });
  assert.equal(session.getModelId(), "model-name");
  const executor = session.getExecutor([{ role: "user", content: "hi" }]);
  const consumed = await consume(executor.stream({ signal: undefined }, "inv-text", []));
  assert.equal(consumed.streamError, null);
  assert.deepEqual(consumed.events.filter((event) => event.type === "text-delta").map((event) => event.textDelta), ["hello", " world"]);
  assert.equal(consumed.events.filter((event) => event.type === "finish").length, 1);
  assert.equal(consumed.events.some((event) => event.type === "provider-state"), false);
  assert.equal(consumed.usage.status, "fulfilled");
  assert.deepEqual(fromVm(consumed.usage.value), { promptTokens: 11, completionTokens: 5, totalTokens: 16 });
  assert.deepEqual(fromVm(consumed.extendedUsage.value), {
    inputTokens: 11,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 0
  });
  assert.equal(consumed.providerMetadata.value.requestId, "req-test");
  assert.equal(consumed.invocationId.value, "inv-text");
  assert.equal(consumed.response.value.id, "inv-text");
  assert.equal(consumed.response.value.modelId, "model-name");
  assert.equal(consumed.response.value.messages[0].id, "inv-text");
  assert.deepEqual(fromVm(consumed.response.value.messages[0].content), [{ type: "text", text: "hello world" }]);
  assert.equal(mod.fetches[0].url, CHAT_URL);
  assert.equal(mod.fetches[0].init.redirect, "error");
  assert.equal(JSON.parse(mod.fetches[0].init.body).stream, true);
  assert.equal(mod.fetches[0].init.headers.authorization, undefined);
  assert.equal(mod.fetches[0].init.headers.Authorization, undefined);
  assert.equal(mod.fetches[0].init.headers["x-api-key"], undefined);
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
  const executor = mod.createProviderDirectPromptSession({ config: ACTIVE_CONFIG }).getExecutor();
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
  const session = mod.createProviderDirectPromptSession({ config: ACTIVE_CONFIG });
  const executor = session.getExecutor([{ role: "user", content: "search" }]);
  const first = await consume(executor.stream({}, "inv-1", LOOKUP_TOOL));
  assert.equal(first.streamError, null);
  const toolCall = first.events.find((event) => event.type === "tool-call");
  assert.deepEqual(fromVm(toolCall), { type: "tool-call", toolCallId: "call_1", toolName: "lookup", args: { q: "x" } });
  executor.appendMessages([
    first.response.value.messages[0],
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", toolName: "lookup", result: { ok: true } }]
    }
  ]);
  const continued = session.getExecutor(executor.getState());
  assert.deepEqual(continued.getMessages(), executor.getMessages());
  const second = await consume(continued.stream({}, "inv-2", LOOKUP_TOOL));
  assert.equal(second.streamError, null);
  assert.equal(second.response.value.messages[0].content[0].text, "found");
  assert.equal(bodies[0].tools[0].function.name, "lookup");
  const toolResult = bodies[1].messages.find((message) => message.role === "tool");
  assert.equal(toolResult.tool_call_id, "call_1");
  assert.equal(JSON.parse(mod.fetches[0].init.body).max_tokens, undefined);
});

test("OpenAI Responses continuation replays encrypted provider-state after host redaction", async () => {
  const bodies = [];
  const config = configFor("openai-responses");
  const mod = withActiveConfig({
    config,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return fixtureSseResponse("streams/openai-responses/reasoning-tools.sse");
      }
      return {
        ok: true,
        status: 200,
        headers: headerBag({ "content-type": "text/event-stream", "x-request-id": "req-2" }),
        body: readableFrom([new TextEncoder().encode(
          [
            "event: response.created",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_2\",\"model\":\"model-name\"}}",
            "",
            "event: response.output_text.delta",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"found\"}",
            "",
            "event: response.completed",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"model\":\"model-name\",\"usage\":{\"input_tokens\":11,\"output_tokens\":5,\"total_tokens\":16},\"status\":\"completed\"}}",
            ""
          ].join("\n")
        )])
      };
    }
  });
  const session = mod.createProviderDirectPromptSession({ config });
  const executor = session.getExecutor([{ role: "user", content: "Look up the weather." }]);
  const first = await consume(executor.stream({}, "inv-resp", ALPHA_TOOL, { maxTokens: 128 }));
  assert.equal(first.streamError, null);
  assert.equal(first.events.some((event) => event.type === "provider-state"), false);
  const assistant = first.response.value.messages[0];
  const state = fromVm(assistant.providerState);
  assert.deepEqual(state, {
    protocol: "openai-responses",
    items: [{
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "enc_abc",
      summary: [{ type: "summary_text", text: "plan" }]
    }]
  });
  assert.deepEqual(fromVm(assistant.providerOptions.grokHome.providerState), state);
  const redacted = simulateHostRedaction(assistant);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, "providerState"), false);
  executor.appendMessages([
    redacted,
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_a", toolName: "alpha", result: { ok: true } }]
    }
  ]);
  const second = await consume(session.getExecutor(executor.getState()).stream({}, "inv-resp-2", ALPHA_TOOL, { maxTokens: 128 }));
  assert.equal(second.streamError, null);
  assert.equal(mod.fetches[0].url, "http://127.0.0.1:18779/responses");
  assert.equal(bodies[0].store, false);
  assert.deepEqual(bodies[0].include, ["reasoning.encrypted_content"]);
  assert.deepEqual(bodies[1].input[1], state.items[0]);
  assert.equal(bodies[1].input[2].type, "function_call");
  assert.equal(bodies[1].input[2].call_id, "call_a");
  assert.deepEqual(bodies[1].input[3], {
    type: "function_call_output",
    call_id: "call_a",
    output: "{\"ok\":true}"
  });
});

test("Anthropic continuation replays signed thinking after host redaction", async () => {
  const bodies = [];
  const config = configFor("anthropic-messages");
  const mod = withActiveConfig({
    config,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return fixtureSseResponse("streams/anthropic-messages/reasoning-tools.sse");
      }
      return {
        ok: true,
        status: 200,
        headers: headerBag({ "content-type": "text/event-stream", "x-request-id": "req-2" }),
        body: readableFrom([new TextEncoder().encode(
          [
            "event: message_start",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_2\",\"model\":\"model-name\",\"usage\":{\"input_tokens\":11,\"output_tokens\":1}}}",
            "",
            "event: content_block_start",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}",
            "",
            "event: content_block_delta",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"ok\"}}",
            "",
            "event: content_block_delta",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_2\"}}",
            "",
            "event: content_block_stop",
            "data: {\"type\":\"content_block_stop\",\"index\":0}",
            "",
            "event: content_block_start",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
            "",
            "event: content_block_delta",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"found\"}}",
            "",
            "event: content_block_stop",
            "data: {\"type\":\"content_block_stop\",\"index\":1}",
            "",
            "event: message_delta",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}",
            "",
            "event: message_stop",
            "data: {\"type\":\"message_stop\"}",
            ""
          ].join("\n")
        )])
      };
    }
  });
  const session = mod.createProviderDirectPromptSession({ config });
  const executor = session.getExecutor([{ role: "user", content: "Look up the weather." }]);
  const first = await consume(executor.stream({}, "inv-ant", ALPHA_TOOL, { maxTokens: 128 }));
  assert.equal(first.streamError, null);
  const assistant = first.response.value.messages[0];
  const state = fromVm(assistant.providerState);
  assert.deepEqual(state, {
    protocol: "anthropic-messages",
    items: [{ type: "thinking", thinking: "plan", signature: "sig_abc" }]
  });
  executor.appendMessages([
    simulateHostRedaction(assistant),
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_a", toolName: "alpha", result: { ok: true } }]
    }
  ]);
  const second = await consume(session.getExecutor(executor.getState()).stream({}, "inv-ant-2", ALPHA_TOOL, { maxTokens: 128 }));
  assert.equal(second.streamError, null);
  assert.equal(mod.fetches[0].url, "http://127.0.0.1:18779/messages");
  assert.equal(mod.fetches[0].init.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(bodies[1].messages[1].content[0], state.items[0]);
  assert.deepEqual(bodies[1].messages[1].content[1], {
    type: "tool_use",
    id: "call_a",
    name: "alpha",
    input: { a: 1 }
  });
  assert.deepEqual(bodies[1].messages[2].content, [{
    type: "tool_result",
    tool_use_id: "call_a",
    content: "{\"ok\":true}"
  }]);
});

test("visible-reasoning binding rejects a tampered continuation", async () => {
  const config = configFor("openai-responses");
  const mod = withActiveConfig({
    config,
    fetchImpl: async () => fixtureSseResponse("streams/openai-responses/reasoning-tools.sse")
  });
  const session = mod.createProviderDirectPromptSession({ config });
  const executor = session.getExecutor([{ role: "user", content: "Look up the weather." }]);
  const first = await consume(executor.stream({}, "inv-bind", ALPHA_TOOL, { maxTokens: 128 }));
  assert.equal(first.streamError, null);
  const assistant = fromVm(first.response.value.messages[0]);
  assistant.content = assistant.content.map((part) => (
    part.type === "reasoning" ? { ...part, text: "tampered" } : part
  ));
  executor.appendMessages([
    assistant,
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_a", toolName: "alpha", result: { ok: true } }]
    }
  ]);
  const second = await consume(session.getExecutor(executor.getState()).stream({}, "inv-bind-2", ALPHA_TOOL, { maxTokens: 128 }));
  assertAllRejected(second, "tampered visible reasoning must fail closed");
  assert.match(String(second.streamError), /providerState does not match visible reasoning|unrepresentable/i);
});

test("all session option categories select direct mode and never call stock", () => {
  const stockCalls = [];
  const labelingCalls = [];
  const mod = withActiveConfig();
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      return { getModelId: () => "stock-model", getExecutor() { throw new Error("stock executor"); } };
    },
    recordPostTurnLabeling(...args) {
      labelingCalls.push(args);
    },
    recordFollowupLabeling() {
      labelingCalls.push("native-followup");
      throw new Error("NATIVE_FOLLOWUP_SENTINEL must not run");
    }
  });
  for (const [name, sessionOptions] of SESSION_OPTION_CASES) {
    const session = wrapped.createSession(() => {}, sessionOptions);
    assert.equal(session.getModelId(), "model-name", name);
    assert.equal(typeof session.getExecutor().stream, "function", name);
  }
  assert.equal(stockCalls.length, 0);
  wrapped.recordPostTurnLabeling({ requestId: "r", conversationId: "c", modelName: "stock", messages: [{ role: "user", content: "secret" }] });
  wrapped.recordFollowupLabeling({ requestId: "r", conversationId: "c", turnSeq: 2, messages: [{ role: "user", content: "private" }] });
  assert.equal(labelingCalls.length, 0);
});

test("maps every session option category to an auditable request kind", () => {
  const mod = withActiveConfig();
  const expected = ["main", "summary", "compaction", "memory", "label", "review", "computer", "browser", "subagent"];
  assert.deepEqual(
    SESSION_OPTION_CASES.map(([, options]) => mod.context.providerDirectRequestKind(options)),
    expected
  );
});

test("inactive config preserves stock session and labeling", () => {
  const stockCalls = [];
  const labelingCalls = [];
  const stockSession = { getModelId: () => "stock-model", getExecutor: () => "stock-executor" };
  const mod = loadModule();
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
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

test("inactive wrapper preserves native followup identity, arguments and receiver", () => {
  for (const files of [{}, { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, enabled: false }) }]) {
    const calls = [];
    const native = {
      createSession() {},
      recordFollowupLabeling(...args) { calls.push({ receiver: this, args }); return "native-result"; }
    };
    const wrapped = loadModule({ files }).wrapHostInferenceWithProviderSwitcher(native);
    const payload = { requestId: "r", turnSeq: 2, messages: [{ role: "user", content: "text" }] };
    assert.equal(wrapped, native);
    assert.equal(wrapped.recordFollowupLabeling, native.recordFollowupLabeling);
    assert.equal(wrapped.recordFollowupLabeling(payload), "native-result");
    assert.deepEqual(calls, [{ receiver: native, args: [payload] }]);
  }
});

test("malformed active config throws and never calls stock", () => {
  const stockCalls = [];
  const mod = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, baseUrl: "https://example.com/v1" }) }
  });
  assert.throws(() => mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) { stockCalls.push(args); return {}; },
    recordPostTurnLabeling() { stockCalls.push("label"); }
  }), /invalid/);
  assert.equal(stockCalls.length, 0);
});

test("locks direct mode for the host lifetime and never labels natively after config removal", () => {
  let configPresent = true;
  const stockCalls = [];
  const mod = loadModule({
    readFileSync() {
      if (!configPresent) enoent();
      return JSON.stringify(ACTIVE_CONFIG);
    }
  });
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) { stockCalls.push(args); throw new Error("stock session must not run"); },
    recordPostTurnLabeling(...args) { stockCalls.push(args); },
    recordFollowupLabeling(...args) {
      stockCalls.push(args);
      throw new Error("NATIVE_FOLLOWUP_SENTINEL must not run after activation");
    }
  });
  wrapped.recordFollowupLabeling({ requestId: "before-removal", turnSeq: 1 });
  configPresent = false;
  assert.equal(wrapped.createSession(() => {}, {}).getModelId(), "model-name");
  wrapped.recordPostTurnLabeling({ requestId: "r" });
  wrapped.recordFollowupLabeling({ requestId: "after-removal", turnSeq: 2 });
  assert.equal(stockCalls.length, 0);
});

test("non-2xx rejects every promise, yields error, and never calls stock", async () => {
  const stockCalls = [];
  const mod = withActiveConfig({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      headers: headerBag({}),
      text: async () => JSON.stringify({ error: { message: "bad gateway" } })
    })
  });
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const executor = wrapped.createSession(() => {}, { requestSource: "main" }).getExecutor([{ role: "user", content: "hi" }]);
  const consumed = await consume(executor.stream({}, "inv-502", []));
  assertAllRejected(consumed, "non-2xx must fail closed");
  assert.match(String(consumed.streamError), /502/);
  assert.equal(String(consumed.streamError).includes("bad gateway"), false);
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
        throw providerAbort(init.signal);
      }
      await new Promise(() => {});
    }
  });
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
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
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(
    wrapped.createSession(() => {}, { isComputerUseSubagent: true }).getExecutor().stream({}, "inv-trunc", [])
  );
  assertAllRejected(consumed, "truncated SSE must fail closed");
  assert.match(String(consumed.streamError), /terminator|truncated|missing \[DONE\]/i);
  assert.equal(stockCalls.length, 0);
});

test("invalid JSON SSE rejects every promise and never calls stock", async () => {
  const stockCalls = [];
  const mod = withActiveConfig({
    fetchImpl: async () => sseResponse(["data: {not-json}\n\n", "data: [DONE]\n\n"])
  });
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(wrapped.createSession(() => {}, {}).getExecutor().stream({}, "inv-json", []));
  assertAllRejected(consumed, "invalid JSON must fail closed");
  assert.equal(stockCalls.length, 0);
});

test("provider-defined tools reject every promise and never call stock", async () => {
  const stockCalls = [];
  const mod = withActiveConfig();
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(
    wrapped.createSession(() => {}, { isBrowserUseSubagent: true }).getExecutor().stream({}, "inv-tool", [{ type: "provider-defined", id: "computer" }])
  );
  assertAllRejected(consumed, "provider-defined tool must fail closed");
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
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
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
  const executor = mod.createProviderDirectPromptSession({ config: ACTIVE_CONFIG }).getExecutor();
  await consume(executor.stream({}, "inv-max", [], { maxTokens: 32 }));
  assert.equal(JSON.parse(mod.fetches[0].init.body).max_tokens, 32);
  assert.equal(mod.fetches[0].init.headers["x-grok-request-kind"], "main");
});

test("parses compiled host parameters and keeps the credential-free whitelist", () => {
  const withParams = {
    ...ACTIVE_CONFIG,
    parameters: { reasoningEffort: "high", maxTokens: 8192 }
  };
  const mod = loadModule({ files: { [CONFIG_PATH]: JSON.stringify(withParams) } });
  const parsed = mod.loadProviderDirectConfig();
  assert.deepEqual(fromVm(parsed.parameters), { reasoningEffort: "high", maxTokens: 8192 });
  const extra = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...withParams, temperature: 0.2 }) }
  });
  assert.throws(() => extra.loadProviderDirectConfig(), /invalid/);
  const nestedSecret = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, parameters: { apiKey: "sk-test" } }) }
  });
  assert.throws(() => nestedSecret.loadProviderDirectConfig(), /invalid/);
  const unknownParam = loadModule({
    files: { [CONFIG_PATH]: JSON.stringify({ ...ACTIVE_CONFIG, parameters: { temperature: 1 } }) }
  });
  assert.throws(() => unknownParam.loadProviderDirectConfig(), /invalid/);
});

test("profile maxTokens is the default and executor maxTokens overrides it", async () => {
  const config = { ...ACTIVE_CONFIG, parameters: { reasoningEffort: "high", maxTokens: 8192 } };
  function okFetch() {
    return sseResponse([
      { id: "chatcmpl-params", choices: [{ index: 0, delta: { content: "ok" } }] },
      usageChunk("chatcmpl-params"),
      "data: [DONE]\n\n"
    ]);
  }
  const defaults = withActiveConfig({ config, fetchImpl: async () => okFetch() });
  const parsed = defaults.loadProviderDirectConfig();
  await consume(defaults.createProviderDirectPromptSession({ config: parsed }).getExecutor().stream({}, "inv-default", []));
  assert.equal(JSON.parse(defaults.fetches[0].init.body).max_tokens, 8192);
  assert.equal(JSON.parse(defaults.fetches[0].init.body).reasoning_effort, "high");
  const overridden = withActiveConfig({ config, fetchImpl: async () => okFetch() });
  const parsedOverride = overridden.loadProviderDirectConfig();
  await consume(
    overridden.createProviderDirectPromptSession({ config: parsedOverride }).getExecutor().stream({}, "inv-override", [], { maxTokens: 32 })
  );
  assert.equal(JSON.parse(overridden.fetches[0].init.body).max_tokens, 32);
  assert.equal(JSON.parse(overridden.fetches[0].init.body).reasoning_effort, "high");
});

test("anthropic compiled reasoningEffort fails closed at host config parse", () => {
  const config = configFor("anthropic-messages", {
    parameters: { reasoningEffort: "high", maxTokens: 128 }
  });
  const mod = loadModule({ files: { [CONFIG_PATH]: JSON.stringify(config) } });
  assert.throws(() => mod.loadProviderDirectConfig(), /invalid/);
  const allowed = configFor("anthropic-messages", { parameters: { maxTokens: 128 } });
  const ok = loadModule({ files: { [CONFIG_PATH]: JSON.stringify(allowed) } });
  assert.deepEqual(fromVm(ok.loadProviderDirectConfig().parameters), { maxTokens: 128 });
});

test("POSTs at the exact configured endpointPath", async () => {
  const config = { ...ACTIVE_CONFIG, endpointPath: "/v1/custom/chat" };
  const mod = withActiveConfig({
    config,
    fetchImpl: async () => sseResponse([
      { id: "chatcmpl-path", choices: [{ index: 0, delta: { content: "ok" } }] },
      usageChunk("chatcmpl-path"),
      "data: [DONE]\n\n"
    ])
  });
  const executor = mod.createProviderDirectPromptSession({ config }).getExecutor([{ role: "user", content: "hi" }]);
  const consumed = await consume(executor.stream({}, "inv-path", []));
  assert.equal(consumed.streamError, null);
  assert.equal(mod.fetches[0].url, "http://127.0.0.1:18779/v1/custom/chat");
  assert.equal(mod.fetches[0].init.method, "POST");
});

test("documents finite host-to-hop byte and deadline constants", () => {
  const mod = withActiveConfig();
  assert.equal(mod.context.PROVIDER_DIRECT_MAX_RESPONSE_BYTES, 64 * 1024 * 1024);
  assert.equal(mod.context.PROVIDER_DIRECT_MAX_SSE_EVENT_BYTES, 1 * 1024 * 1024);
  assert.equal(mod.context.PROVIDER_DIRECT_MAX_FAILURE_BODY_BYTES, 8 * 1024);
  assert.equal(mod.context.PROVIDER_DIRECT_REQUEST_TIMEOUT_MS, 120000);
});

test("oversized successful SSE rejects, cancels the reader, and never calls stock", async () => {
  const stockCalls = [];
  const tracking = cancellableBody([
    new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}]}\n\n"),
    new TextEncoder().encode("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n"),
    new TextEncoder().encode("data: [DONE]\n\n")
  ]);
  const mod = withActiveConfig({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headerBag({ "content-type": "text/event-stream" }),
      body: tracking.body
    })
  });
  mod.context.PROVIDER_DIRECT_MAX_RESPONSE_BYTES = 80;
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(wrapped.createSession(() => {}, {}).getExecutor([{ role: "user", content: "hi" }]).stream({}, "inv-oversize", []));
  assertAllRejected(consumed, "oversized SSE must fail closed");
  assert.match(String(consumed.streamError), /exceeded 80 bytes/);
  assert.equal(tracking.cancelled, true);
  assert.equal(stockCalls.length, 0);
});

test("a single never-delimited SSE event rejects without leaking payload", async () => {
  const stockCalls = [];
  const payload = `data: ${"x".repeat(80)}`;
  const tracking = cancellableBody([new TextEncoder().encode(payload)]);
  const mod = withActiveConfig({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: headerBag({ "content-type": "text/event-stream" }),
      body: tracking.body
    })
  });
  mod.context.PROVIDER_DIRECT_MAX_SSE_EVENT_BYTES = 32;
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(wrapped.createSession(() => {}, {}).getExecutor().stream({}, "inv-event", []));
  assertAllRejected(consumed, "never-delimited SSE event must fail closed");
  assert.match(String(consumed.streamError), /SSE event exceeded 32 bytes/);
  assert.equal(String(consumed.streamError).includes("x".repeat(40)), false);
  assert.equal(JSON.stringify(fromVm(consumed.events)).includes("x".repeat(40)), false);
  assert.equal(tracking.cancelled, true);
  assert.equal(stockCalls.length, 0);
});

test("oversized failure body fails closed without leaking a sentinel secret", async () => {
  const stockCalls = [];
  const SENTINEL = "sk-sentinel-leak-test-9f3a";
  const tracking = cancellableBody([
    new TextEncoder().encode(`{"error":{"message":"${SENTINEL} ${"n".repeat(40)}"}}`)
  ]);
  const mod = withActiveConfig({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      headers: headerBag({ "content-type": "application/json" }),
      body: tracking.body
    })
  });
  mod.context.PROVIDER_DIRECT_MAX_FAILURE_BODY_BYTES = 16;
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(wrapped.createSession(() => {}, {}).getExecutor([{ role: "user", content: "hi" }]).stream({}, "inv-fail-body", []));
  assertAllRejected(consumed, "oversized failure body must fail closed");
  const rendered = `${consumed.streamError}\n${JSON.stringify(fromVm(consumed.events))}`;
  assert.equal(rendered.includes(SENTINEL), false);
  assert.match(String(consumed.streamError), /failure body exceeded 16 bytes/);
  assert.equal(tracking.cancelled, true);
  assert.equal(stockCalls.length, 0);
});

test("host-to-hop deadline fails closed when ctx.signal is absent", async () => {
  const stockCalls = [];
  let sawHopSignal = false;
  const mod = withActiveConfig({
    fetchImpl: async (_url, init) => {
      sawHopSignal = init.signal != null;
      await new Promise((_resolve, reject) => {
        if (init.signal == null) return;
        if (init.signal.aborted) {
          reject(providerAbort(init.signal));
          return;
        }
        init.signal.addEventListener("abort", () => reject(providerAbort(init.signal)));
      });
    }
  });
  mod.context.PROVIDER_DIRECT_REQUEST_TIMEOUT_MS = 20;
  const wrapped = mod.wrapHostInferenceWithProviderSwitcher({
    createSession(...args) {
      stockCalls.push(args);
      throw new Error("stock factory must not run");
    }
  });
  const consumed = await consume(wrapped.createSession(() => {}, {}).getExecutor().stream({}, "inv-timeout", []));
  assertAllRejected(consumed, "timeout must fail closed");
  assert.equal(sawHopSignal, true);
  assert.match(String(consumed.streamError), /timed out/i);
  assert.equal(consumed.streamError.name, "TimeoutError");
  assert.equal(stockCalls.length, 0);
});

function cancellableBody(chunks) {
  const state = { cancelled: false };
  return {
    get cancelled() {
      return state.cancelled;
    },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      }
    })
  };
}

function providerAbort(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Provider direct request aborted");
  error.name = "AbortError";
  return error;
}
