import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "..", "src", "provider_protocols");
const FIXTURES = join(ROOT, "fixtures", "provider_protocols");
const protocols = require("../src/provider_protocols/index.cjs");

const PROTOCOL_IDS = ["openai-chat", "openai-responses", "anthropic-messages"];

function utf8(text) {
  return new TextEncoder().encode(text);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixture(relative) {
  return readFileSync(join(FIXTURES, relative), "utf8");
}

function decode(adapter, text, sizes = 1, decoderOptions) {
  const decoder = adapter.createStreamDecoder(decoderOptions);
  const bytes = utf8(text);
  const events = [];
  let offset = 0;
  let step = 0;
  while (offset < bytes.length) {
    const size = Array.isArray(sizes) ? sizes[step % sizes.length] : sizes;
    step += 1;
    events.push(...decoder.push(bytes.subarray(offset, offset + size)));
    offset += size;
  }
  events.push(...decoder.close());
  return events;
}

function withCrlfAndComments(text) {
  return `\uFEFF: keep-alive\r\n\r\n${text.replace(/\n/g, "\r\n")}`;
}

function stripTerminator(protocolId, text) {
  if (protocolId === "openai-chat") {
    return text.replace(/\n?data: \[DONE\]\s*$/, "\n");
  }
  if (protocolId === "openai-responses") {
    return text.replace(/\nevent: response\.completed[\s\S]*$/, "\n");
  }
  return text.replace(/\nevent: message_stop[\s\S]*$/, "\n");
}

function semantics(events) {
  const finishes = events.filter((event) => event.type === "finish");
  assert.equal(finishes.length, 1, "expected exactly one finish event");
  return {
    text: events.filter((event) => event.type === "text-delta").map((event) => event.textDelta).join(""),
    reasoning: events.filter((event) => event.type === "reasoning").map((event) => event.textDelta).join(""),
    toolStarts: events.filter((event) => event.type === "tool-call-streaming-start").map((event) => ({
      id: event.toolCallId,
      name: event.toolName
    })),
    toolCalls: events.filter((event) => event.type === "tool-call").map((event) => ({
      id: event.toolCallId,
      name: event.toolName,
      args: event.args
    })),
    finishReason: finishes[0].finishReason,
    usage: finishes[0].usage
  };
}

function assertToolLifecycle(events) {
  const started = new Set();
  for (const event of events) {
    if (event.type === "tool-call-streaming-start") {
      started.add(event.toolCallId);
    }
    if (event.type === "tool-call-delta" || event.type === "tool-call") {
      assert.equal(started.has(event.toolCallId), true, `tool ${event.toolCallId} emitted before start`);
    }
  }
}

function assertNoCredentialHeaders(built) {
  const names = Object.keys(built.headers).map((name) => name.toLowerCase());
  assert.equal(names.includes("authorization"), false);
  assert.equal(names.includes("x-api-key"), false);
  assert.equal(names.includes("api-key"), false);
  assert.equal(names.includes("cookie"), false);
}

function assertCode(fn, code, protocolId) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, "ProtocolError");
    assert.equal(error.code, code);
    if (protocolId) {
      assert.equal(error.protocol, protocolId);
    }
    return true;
  });
}

test("registry is selected only by explicit protocol id", () => {
  assert.deepEqual(protocols.PROTOCOL_IDS, PROTOCOL_IDS);
  assert.deepEqual(protocols.DEFAULT_ENDPOINT_PATHS, {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages"
  });
  assert.deepEqual(protocols.DEFAULT_AUTH_TYPES, {
    "openai-chat": "bearer",
    "openai-responses": "bearer",
    "anthropic-messages": "x-api-key"
  });
  for (const id of PROTOCOL_IDS) {
    const adapter = protocols.getAdapter(id);
    assert.equal(adapter.id, id);
    assert.equal(protocols.createAdapter(id), adapter);
    assert.equal(adapter.defaultEndpointPath, protocols.DEFAULT_ENDPOINT_PATHS[id]);
    assert.equal(adapter.defaultAuthType, protocols.DEFAULT_AUTH_TYPES[id]);
  }
  assert.notEqual(protocols.getAdapter("openai-chat"), protocols.getAdapter("openai-responses"));
  assert.notEqual(protocols.getAdapter("openai-chat"), protocols.getAdapter("anthropic-messages"));
  assertCode(() => protocols.getAdapter("openai"), "unknown-protocol");
  assertCode(() => protocols.getAdapter("https://api.openai.com/v1/chat/completions"), "unknown-protocol");
  assertCode(() => protocols.getAdapter("/chat/completions"), "unknown-protocol");
  assertCode(() => protocols.getAdapter({ protocol: "openai-chat" }), "unknown-protocol");
});

test("adapters do not call each other, fetch, or log", () => {
  for (const id of PROTOCOL_IDS) {
    const source = readFileSync(join(SRC, `${id}.cjs`), "utf8");
    assert.equal(/\bconsole\b/.test(source), false, id);
    assert.equal(/\bfetch\b/.test(source), false, id);
    for (const other of PROTOCOL_IDS) {
      if (other === id) continue;
      assert.equal(source.includes(other), false, `${id} must not reference ${other}`);
    }
  }
  const files = readdirSync(SRC).filter((name) => name.endsWith(".cjs"));
  assert.deepEqual(files.sort(), [
    "anthropic-messages.cjs",
    "contract.cjs",
    "index.cjs",
    "openai-chat.cjs",
    "openai-responses.cjs",
    "sse.cjs",
    "tools.cjs"
  ]);
});

test("request mapping preserves text, tools, and exact tool_call_id", () => {
  const textRequest = readJson(join(FIXTURES, "requests", "text.json"));
  const toolRequest = readJson(join(FIXTURES, "requests", "tool-loop.json"));
  for (const id of PROTOCOL_IDS) {
    const adapter = protocols.getAdapter(id);
    const textBuilt = adapter.buildRequest(textRequest);
    const toolBuilt = adapter.buildRequest(toolRequest);
    assert.deepEqual(textBuilt, readJson(join(FIXTURES, "expected-requests", `${id}-text.json`)));
    assert.deepEqual(toolBuilt, readJson(join(FIXTURES, "expected-requests", `${id}-tool-loop.json`)));
    assertNoCredentialHeaders(textBuilt);
    assertNoCredentialHeaders(toolBuilt);
    const blob = JSON.stringify(toolBuilt.body);
    assert.match(blob, /call_abc/);
    assert.equal(blob.includes("Authorization"), false);
  }
});

test("endpointPath override stays visible and path-only", () => {
  const request = readJson(join(FIXTURES, "requests", "text.json"));
  const chat = protocols.getAdapter("openai-chat").buildRequest(request, { endpointPath: "/custom/chat" });
  assert.equal(chat.path, "/custom/chat");
  assertCode(
    () => protocols.getAdapter("openai-chat").buildRequest(request, { endpointPath: "https://example.test/v1/chat" }),
    "invalid-request",
    "openai-chat"
  );
});

test("equivalent text + reasoning + usage semantics survive fragmentation and CRLF", () => {
  const summaries = {};
  for (const id of PROTOCOL_IDS) {
    const adapter = protocols.getAdapter(id);
    const canonical = fixture(`streams/${id}/text.sse`);
    const variants = [canonical, withCrlfAndComments(canonical)];
    const sizes = [1, 3, [1, 2, 3]];
    let first = null;
    for (const stream of variants) {
      for (const size of sizes) {
        const events = decode(adapter, stream, size, { requestId: "req-header" });
        const summary = semantics(events);
        if (first == null) first = summary;
        assert.deepEqual(summary, first);
        const finish = events.find((event) => event.type === "finish");
        assert.equal(finish.requestId, "req-header");
        assert.ok(finish.response.id.length > 0);
      }
    }
    summaries[id] = first;
  }
  for (const id of PROTOCOL_IDS.slice(1)) {
    assert.deepEqual(summaries[id], summaries["openai-chat"]);
  }
  assert.equal(summaries["openai-chat"].text, "hello world");
  assert.equal(summaries["openai-chat"].reasoning, "plan");
  assert.equal(summaries["openai-chat"].finishReason, "stop");
  assert.deepEqual(summaries["openai-chat"].usage, { promptTokens: 9, completionTokens: 4, totalTokens: 13 });
});

test("equivalent parallel tool-loop semantics preserve ids and arguments", () => {
  const summaries = {};
  for (const id of PROTOCOL_IDS) {
    const adapter = protocols.getAdapter(id);
    const stream = fixture(`streams/${id}/tools.sse`);
    const events = decode(adapter, stream, 1);
    assertToolLifecycle(events);
    summaries[id] = semantics(events);
    const fragmented = semantics(decode(adapter, withCrlfAndComments(stream), [1, 2, 4]));
    assert.deepEqual(fragmented, summaries[id]);
  }
  for (const id of PROTOCOL_IDS.slice(1)) {
    assert.deepEqual(summaries[id].toolCalls, summaries["openai-chat"].toolCalls);
    assert.deepEqual(summaries[id].usage, summaries["openai-chat"].usage);
    assert.equal(summaries[id].finishReason, summaries["openai-chat"].finishReason);
  }
  assert.deepEqual(summaries["openai-chat"].toolCalls, [
    { id: "call_a", name: "alpha", args: { a: 1 } },
    { id: "call_b", name: "beta", args: { b: 2 } }
  ]);
  assert.equal(summaries["openai-chat"].finishReason, "tool-calls");
  assert.deepEqual(summaries["openai-chat"].usage, { promptTokens: 11, completionTokens: 5, totalTokens: 16 });
});

test("malformed JSON, missing terminator, truncated UTF-8, and upstream errors fail closed", () => {
  for (const id of PROTOCOL_IDS) {
    const adapter = protocols.getAdapter(id);
    assertCode(() => decode(adapter, fixture(`streams/${id}/malformed.sse`)), "invalid-json", id);
    assertCode(() => decode(adapter, stripTerminator(id, fixture(`streams/${id}/text.sse`))), "missing-terminator", id);
    assertCode(() => decode(adapter, fixture(`streams/${id}/error.sse`)), "stream-error", id);

    const decoder = adapter.createStreamDecoder();
    decoder.push(new Uint8Array([0xe2, 0x82]));
    assertCode(() => decoder.close(), "truncated", id);

    assert.throws(
      () => adapter.interpretHttpFailure(429, '{"error":{"message":"rate limited"}}'),
      (error) => {
        assert.equal(error.code, "http-error");
        assert.equal(error.status, 429);
        assert.match(error.message, /rate limited/);
        return true;
      }
    );
    assert.throws(
      () => adapter.interpretHttpFailure(500, utf8('{"error":{"message":"upstream overloaded"}}')),
      (error) => {
        assert.equal(error.code, "http-error");
        assert.match(error.message, /upstream overloaded/);
        return true;
      }
    );
  }
});

test("missing usage fails closed even when a terminator is present", () => {
  const chat = protocols.getAdapter("openai-chat");
  assertCode(
    () => decode(chat, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"),
    "missing-usage",
    "openai-chat"
  );
  const responses = protocols.getAdapter("openai-responses");
  assertCode(
    () => decode(responses, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\"}}\n\n"),
    "missing-usage",
    "openai-responses"
  );
  const anthropic = protocols.getAdapter("anthropic-messages");
  assertCode(
    () => decode(anthropic, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"),
    "missing-usage",
    "anthropic-messages"
  );
});

test("unsupported request and stream shapes are rejected instead of flattened", () => {
  const request = readJson(join(FIXTURES, "requests", "text.json"));
  for (const id of PROTOCOL_IDS) {
    const adapter = protocols.getAdapter(id);
    assertCode(
      () => adapter.buildRequest({
        ...request,
        tools: [{ type: "provider-defined", id: "anthropic.computer", name: "computer", args: {} }]
      }),
      "unsupported-shape",
      id
    );
    assertCode(
      () => adapter.buildRequest({
        ...request,
        tools: [{ type: "web_search" }]
      }),
      "unsupported-shape",
      id
    );
    assertCode(
      () => adapter.buildRequest({
        ...request,
        messages: [{ role: "user", content: [{ type: "file", data: "abc", mimeType: "text/plain" }] }]
      }),
      "unsupported-shape",
      id
    );
    assertCode(
      () => adapter.buildRequest({
        ...request,
        messages: [{ role: "assistant", content: [{ type: "redacted-reasoning", data: "secret" }] }]
      }),
      "unsupported-shape",
      id
    );
    assertCode(
      () => adapter.buildRequest({
        ...request,
        messages: [{ role: "developer", content: "nope" }]
      }),
      "unsupported-shape",
      id
    );
    assertCode(
      () => adapter.buildRequest({ ...request, stream: false }),
      "unsupported-shape",
      id
    );
  }

  assertCode(
    () => decode(protocols.getAdapter("openai-responses"), fixture("streams/openai-responses/hosted-tool.sse")),
    "unsupported-shape",
    "openai-responses"
  );
  assertCode(
    () => decode(protocols.getAdapter("anthropic-messages"), fixture("streams/anthropic-messages/server-tool.sse")),
    "unsupported-shape",
    "anthropic-messages"
  );
  assertCode(
    () => protocols.getAdapter("anthropic-messages").buildRequest({
      ...request,
      parameters: { reasoningEffort: "high" }
    }),
    "unsupported-shape",
    "anthropic-messages"
  );
});

test("reasoningEffort maps losslessly for OpenAI protocols only", () => {
  const request = {
    ...readJson(join(FIXTURES, "requests", "text.json")),
    parameters: { reasoningEffort: "high" }
  };
  const chat = protocols.getAdapter("openai-chat").buildRequest(request);
  const responses = protocols.getAdapter("openai-responses").buildRequest(request);
  assert.equal(chat.body.reasoning_effort, "high");
  assert.deepEqual(responses.body.reasoning, { effort: "high" });
});

test("user images map without flattening, Anthropic version stays non-credential metadata", () => {
  const request = {
    model: "test-model",
    maxTokens: 32,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image", image: "https://example.test/a.png", mimeType: "image/png" }
        ]
      }
    ]
  };
  const chat = protocols.getAdapter("openai-chat").buildRequest(request);
  const responses = protocols.getAdapter("openai-responses").buildRequest(request);
  const anthropic = protocols.getAdapter("anthropic-messages").buildRequest({
    ...request,
    parameters: { anthropicVersion: "2024-10-22" }
  });
  assert.deepEqual(chat.body.messages[0].content, [
    { type: "text", text: "see" },
    { type: "image_url", image_url: { url: "https://example.test/a.png" } }
  ]);
  assert.deepEqual(responses.body.input[0].content, [
    { type: "input_text", text: "see" },
    { type: "input_image", image_url: "https://example.test/a.png" }
  ]);
  assert.deepEqual(anthropic.body.messages[0].content, [
    { type: "text", text: "see" },
    { type: "image", source: { type: "url", url: "https://example.test/a.png" } }
  ]);
  assert.equal(anthropic.headers["anthropic-version"], "2024-10-22");
  assertNoCredentialHeaders(anthropic);
});

test("OpenAI Chat SSE joins split data lines and ignores comments", () => {
  const stream = [
    ": keep-alive\n",
    "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你\"}}]}\n",
    "\n",
    "data: {\"id\":\n",
    "data: \"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\"}}]}\n",
    "\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n",
    "\n",
    "data: [DONE]\n\n"
  ].join("");
  const events = decode(protocols.getAdapter("openai-chat"), stream, 1);
  assert.equal(semantics(events).text, "你好");
});

test("fragmented multibyte text is reconstructed", () => {
  const chat = decode(
    protocols.getAdapter("openai-chat"),
    "data: {\"id\":\"chatcmpl-euro\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"€\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\ndata: [DONE]\n\n",
    1
  );
  const responses = decode(
    protocols.getAdapter("openai-responses"),
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"€\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_euro\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
    [1, 2]
  );
  const anthropic = decode(
    protocols.getAdapter("anthropic-messages"),
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_euro\",\"usage\":{\"input_tokens\":1}}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"€\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    1
  );
  assert.equal(semantics(chat).text, "€");
  assert.equal(semantics(responses).text, "€");
  assert.equal(semantics(anthropic).text, "€");
});
