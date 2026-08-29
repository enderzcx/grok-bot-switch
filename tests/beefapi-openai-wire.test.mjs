import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(ROOT, "..", "src", "beefapi-openai-wire.cjs");
const SOURCE = readFileSync(SOURCE_PATH, "utf8");

const VALID_CONFIG = {
  schemaVersion: 1,
  enabled: true,
  mode: "external-only",
  nativeFallback: false,
  provider: "beefapi",
  group: "grok",
  modelId: "grok-4.6",
  baseUrl: "http://127.0.0.1:18779/v1"
};

function loadWire() {
  return vm.runInThisContext(
    `${SOURCE}\n({ parseBeefApiDirectConfig, toBeefApiOpenAiMessages, toBeefApiOpenAiTools, createBeefApiSseDecoder, createBeefApiToolCallAccumulator, beefApiChunkToHostEvents })`,
    { filename: "beefapi-openai-wire.cjs" }
  );
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

function sseEvent(payload) {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function decodeStream(wire, text, sizes = 1) {
  const decoder = wire.createBeefApiSseDecoder();
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
  events.push(...decoder.end());
  return events;
}

function hostEventsFromSse(wire, text, sizes = 1) {
  const decoderEvents = decodeStream(wire, text, sizes);
  const accumulator = wire.createBeefApiToolCallAccumulator();
  const hostEvents = [];
  for (const event of decoderEvents) {
    hostEvents.push(...wire.beefApiChunkToHostEvents(event, accumulator));
  }
  return hostEvents;
}

test("injected source exposes globals without module.exports", () => {
  assert.equal(SOURCE.includes("module.exports"), false);
  assert.match(SOURCE, /function parseBeefApiDirectConfig\(/);
  assert.match(SOURCE, /function toBeefApiOpenAiMessages\(/);
  assert.match(SOURCE, /function toBeefApiOpenAiTools\(/);
  assert.match(SOURCE, /function createBeefApiSseDecoder\(/);
  assert.match(SOURCE, /function createBeefApiToolCallAccumulator\(/);
  assert.match(SOURCE, /function beefApiChunkToHostEvents\(/);
  assert.equal(/\brequire\s*\(/.test(SOURCE), false);
  assert.equal(/\bfetch\b/.test(SOURCE), false);
  assert.equal(/\bconsole\b/.test(SOURCE), false);
  const wire = loadWire();
  assert.equal(typeof wire.parseBeefApiDirectConfig, "function");
  assert.equal(typeof wire.toBeefApiOpenAiMessages, "function");
  assert.equal(typeof wire.toBeefApiOpenAiTools, "function");
  assert.equal(typeof wire.createBeefApiSseDecoder, "function");
  assert.equal(typeof wire.createBeefApiToolCallAccumulator, "function");
  assert.equal(typeof wire.beefApiChunkToHostEvents, "function");
});

test("parseBeefApiDirectConfig returns null when config is absent or disabled", () => {
  const wire = loadWire();
  assert.equal(wire.parseBeefApiDirectConfig(null), null);
  assert.equal(wire.parseBeefApiDirectConfig(undefined), null);
  assert.equal(wire.parseBeefApiDirectConfig(""), null);
  assert.equal(wire.parseBeefApiDirectConfig("   "), null);
  assert.equal(wire.parseBeefApiDirectConfig("null"), null);
  assert.equal(wire.parseBeefApiDirectConfig({ enabled: false, modelId: "grok-4.6" }), null);
  assert.equal(wire.parseBeefApiDirectConfig(JSON.stringify({ enabled: false })), null);
  assert.equal(wire.parseBeefApiDirectConfig({ schemaVersion: 1 }), null);
});

test("parseBeefApiDirectConfig accepts only the exact active contract", () => {
  const wire = loadWire();
  assert.deepEqual(wire.parseBeefApiDirectConfig(VALID_CONFIG), VALID_CONFIG);
  assert.deepEqual(wire.parseBeefApiDirectConfig(JSON.stringify(VALID_CONFIG, null, 2)), VALID_CONFIG);
});

test("parseBeefApiDirectConfig throws on enabled malformed config", () => {
  const wire = loadWire();
  assert.throws(() => wire.parseBeefApiDirectConfig("{"), /valid JSON/);
  assert.throws(() => wire.parseBeefApiDirectConfig([]), /object/);
  assert.throws(() => wire.parseBeefApiDirectConfig("true"), /object/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, baseUrl: "http://localhost:18779/v1" }), /baseUrl/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, baseUrl: "https://beefapi.com/v1" }), /baseUrl/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, modelId: "grok-4.5" }), /modelId/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, nativeFallback: true }), /nativeFallback/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, mode: "hybrid" }), /mode/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ enabled: true, modelId: "grok-4.6" }), /missing/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, keyFile: "/workspace/grok-home/secrets/x" }), /credentials/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, apiKey: "sk-test" }), /credentials/);
  assert.throws(() => wire.parseBeefApiDirectConfig({ ...VALID_CONFIG, extra: true }), /unexpected field extra/);
});

test("toBeefApiOpenAiMessages preserves roles, tool calls, and exact tool_call_id", () => {
  const wire = loadWire();
  const converted = wire.toBeefApiOpenAiMessages([
    { role: "system", content: "You are Grok." },
    { role: "user", content: "Use the tools." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool-call", toolCallId: "call_abc", toolName: "lookup", args: { q: "weather" } }
      ]
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_abc", toolName: "lookup", result: { temp: 18 } }
      ]
    },
    { role: "assistant", content: "It is 18 degrees." }
  ]);
  assert.deepEqual(converted, [
    { role: "system", content: "You are Grok." },
    { role: "user", content: "Use the tools." },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "lookup", arguments: "{\"q\":\"weather\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_abc", content: "{\"temp\":18}" },
    { role: "assistant", content: "It is 18 degrees." }
  ]);
});

test("toBeefApiOpenAiMessages keeps already-shaped OpenAI tool results and raw argument strings", () => {
  const wire = loadWire();
  const converted = wire.toBeefApiOpenAiMessages([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_raw", type: "function", function: { name: "echo", arguments: "{\"ok\":true}" } }
      ]
    },
    { role: "tool", tool_call_id: "call_raw", content: "ok" }
  ]);
  assert.equal(converted[0].tool_calls[0].id, "call_raw");
  assert.equal(converted[0].tool_calls[0].function.arguments, "{\"ok\":true}");
  assert.equal(converted[1].tool_call_id, "call_raw");
  assert.equal(converted[1].content, "ok");
});

test("toBeefApiOpenAiMessages preserves cursor rawToolCallArgs and splits multiple tool results", () => {
  const wire = loadWire();
  const converted = wire.toBeefApiOpenAiMessages([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "one",
          args: { ignored: true },
          providerOptions: { cursor: { rawToolCallArgs: "{\"n\":1}" } }
        },
        { type: "tool-call", toolCallId: "call_2", toolName: "two", args: { n: 2 } }
      ]
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "one", result: "first" },
        { type: "tool-result", toolCallId: "call_2", toolName: "two", result: "second" }
      ]
    }
  ]);
  assert.equal(converted[0].tool_calls[0].function.arguments, "{\"n\":1}");
  assert.equal(converted[1].tool_call_id, "call_1");
  assert.equal(converted[1].content, "first");
  assert.equal(converted[2].tool_call_id, "call_2");
  assert.equal(converted[2].content, "second");
});

test("toBeefApiOpenAiMessages rejects unsupported content instead of flattening it", () => {
  const wire = loadWire();
  assert.throws(
    () => wire.toBeefApiOpenAiMessages([{ role: "user", content: [{ type: "file", data: "abc", mimeType: "text/plain" }] }]),
    /unrepresentable/
  );
  assert.throws(
    () => wire.toBeefApiOpenAiMessages([{ role: "assistant", content: [{ type: "redacted-reasoning", data: "secret" }] }]),
    /unrepresentable/
  );
  assert.throws(
    () => wire.toBeefApiOpenAiMessages([{ role: "developer", content: "nope" }]),
    /unrepresentable/
  );
  assert.throws(
    () => wire.toBeefApiOpenAiMessages([{ role: "tool", content: "lost id" }]),
    /unrepresentable/
  );
});

test("toBeefApiOpenAiMessages preserves assistant reasoning without flattening tool results", () => {
  const wire = loadWire();
  const converted = wire.toBeefApiOpenAiMessages([
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "plan" },
        { type: "text", text: "done" }
      ]
    }
  ]);
  assert.deepEqual(converted, [
    { role: "assistant", content: "done", reasoning_content: "plan" }
  ]);
});

test("toBeefApiOpenAiMessages converts representable user images without flattening", () => {
  const wire = loadWire();
  const converted = wire.toBeefApiOpenAiMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image", image: "https://example.test/a.png", mimeType: "image/png" }
      ]
    }
  ]);
  assert.deepEqual(converted[0].content, [
    { type: "text", text: "see" },
    { type: "image_url", image_url: { url: "https://example.test/a.png" } }
  ]);
});

test("toBeefApiOpenAiTools converts host function tools and jsonSchema wrappers", () => {
  const wire = loadWire();
  const converted = wire.toBeefApiOpenAiTools([
    {
      name: "lookup",
      description: "Look something up",
      parameters: {
        jsonSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "already",
        description: "passthrough",
        parameters: { type: "object", properties: {} }
      }
    }
  ]);
  assert.deepEqual(converted, [
    {
      type: "function",
      function: {
        name: "lookup",
        description: "Look something up",
        parameters: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "already",
        description: "passthrough",
        parameters: { type: "object", properties: {} }
      }
    }
  ]);
});

test("toBeefApiOpenAiTools rejects unknown provider-defined shapes", () => {
  const wire = loadWire();
  assert.throws(
    () => wire.toBeefApiOpenAiTools([{ type: "provider-defined", id: "anthropic.computer", name: "computer", args: {} }]),
    /provider-defined/
  );
  assert.throws(
    () => wire.toBeefApiOpenAiTools([{ type: "web_search" }]),
    /provider-defined/
  );
  assert.throws(
    () => wire.toBeefApiOpenAiTools([{ description: "no name", parameters: { type: "object" } }]),
    /function name/
  );
});

test("SSE decoder handles byte fragmentation, CRLF, comments, and multiple data lines", () => {
  const wire = loadWire();
  const payload = {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "grok-4.6",
    choices: [{ index: 0, delta: { content: "你好" } }]
  };
  const stream = [
    "\uFEFF",
    ": keep-alive\r\n",
    "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"grok-4.6\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你\"}}]}\r\n",
    "\r\n",
    "data: {\"id\":\n",
    "data: \"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\"}}]}\n",
    "\n",
    "data: [DONE]\n\n"
  ].join("");
  const euro = "€";
  const withEuro = sseEvent({
    id: "chatcmpl-2",
    choices: [{ index: 0, delta: { content: euro } }]
  }) + "data: [DONE]\n\n";

  const events = decodeStream(wire, stream, 1);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "chunk");
  assert.equal(events[0].chunk.choices[0].delta.content, "你");
  assert.equal(events[1].chunk.choices[0].delta.content, "好");
  assert.equal(events[2].type, "done");

  const euroEvents = decodeStream(wire, withEuro, [1, 2, 3]);
  assert.equal(euroEvents[0].chunk.choices[0].delta.content, "€");
  assert.equal(euroEvents[1].type, "done");

  const decoder = wire.createBeefApiSseDecoder();
  assert.deepEqual(decoder.push(utf8(sseEvent(payload))), [{ type: "chunk", chunk: payload }]);
});

test("SSE decoder rejects invalid JSON, missing [DONE], and truncated UTF-8", () => {
  const wire = loadWire();
  assert.throws(() => decodeStream(wire, "data: {not-json}\n\ndata: [DONE]\n\n"), /invalid JSON/);
  assert.throws(() => decodeStream(wire, sseEvent({ choices: [{ delta: { content: "x" } }] })), /missing \[DONE\]/);

  const decoder = wire.createBeefApiSseDecoder();
  decoder.push(new Uint8Array([0xe2, 0x82]));
  assert.throws(() => decoder.end(), /truncated/);
});

test("createBeefApiToolCallAccumulator merges interleaved parallel tool fragments", () => {
  const wire = loadWire();
  const accumulator = wire.createBeefApiToolCallAccumulator();
  const startA = accumulator.ingest([
    { index: 0, id: "call_a", type: "function", function: { name: "alpha", arguments: "" } }
  ]);
  const startB = accumulator.ingest([
    { index: 1, id: "call_b", type: "function", function: { name: "beta", arguments: "{" } }
  ]);
  const deltaA = accumulator.ingest([
    { index: 0, function: { arguments: "{\"x\":" } },
    { index: 1, function: { arguments: "\"y\":2}" } }
  ]);
  const deltaA2 = accumulator.ingest([{ index: 0, function: { arguments: "1}" } }]);
  const finals = accumulator.complete();

  assert.deepEqual(startA, [{ type: "tool-call-streaming-start", toolCallId: "call_a", toolName: "alpha" }]);
  assert.deepEqual(startB[0], { type: "tool-call-streaming-start", toolCallId: "call_b", toolName: "beta" });
  assert.equal(startB[1].type, "tool-call-delta");
  assert.equal(startB[1].argsTextDelta, "{");
  assert.equal(deltaA[0].toolCallId, "call_a");
  assert.equal(deltaA[1].toolCallId, "call_b");
  assert.equal(deltaA2[0].argsTextDelta, "1}");
  assert.deepEqual(finals, [
    { type: "tool-call", toolCallId: "call_a", toolName: "alpha", args: { x: 1 } },
    { type: "tool-call", toolCallId: "call_b", toolName: "beta", args: { y: 2 } }
  ]);
});

test("createBeefApiToolCallAccumulator buffers argument deltas until id and name exist", () => {
  const wire = loadWire();
  const accumulator = wire.createBeefApiToolCallAccumulator();
  assert.deepEqual(accumulator.ingest([{ index: 0, function: { arguments: "{\"a\":" } }]), []);
  const started = accumulator.ingest([
    { index: 0, id: "call_x", function: { name: "later", arguments: "1}" } }
  ]);
  assert.equal(started[0].type, "tool-call-streaming-start");
  assert.equal(started[0].toolCallId, "call_x");
  assert.equal(started[0].toolName, "later");
  assert.equal(started[1].type, "tool-call-delta");
  assert.equal(started[1].argsTextDelta, "{\"a\":1}");
  assert.deepEqual(accumulator.complete(), [
    { type: "tool-call", toolCallId: "call_x", toolName: "later", args: { a: 1 } }
  ]);
});

test("createBeefApiToolCallAccumulator rejects missing ids/names and invalid final JSON", () => {
  const wire = loadWire();
  const missing = wire.createBeefApiToolCallAccumulator();
  missing.ingest([{ index: 0, function: { arguments: "{}" } }]);
  assert.throws(() => missing.complete(), /missing id or name/);

  const unnamed = wire.createBeefApiToolCallAccumulator();
  unnamed.ingest([{ index: 0, id: "call_z", function: { arguments: "{}" } }]);
  assert.throws(() => unnamed.complete(), /missing id or name/);

  const invalid = wire.createBeefApiToolCallAccumulator();
  invalid.ingest([{ index: 0, id: "call_bad", function: { name: "broken", arguments: "{" } }]);
  assert.throws(() => invalid.complete(), /invalid final JSON arguments/);
});

test("beefApiChunkToHostEvents converts reasoning, text, usage, and delayed finish", () => {
  const wire = loadWire();
  const accumulator = wire.createBeefApiToolCallAccumulator();
  const reasoning = wire.beefApiChunkToHostEvents({
    id: "chatcmpl-r",
    model: "grok-4.6",
    choices: [{ index: 0, delta: { reasoning_content: "think" } }]
  }, accumulator);
  const text = wire.beefApiChunkToHostEvents({
    choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }]
  }, accumulator);
  const usage = wire.beefApiChunkToHostEvents({
    choices: [],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }
  }, accumulator);

  assert.deepEqual(reasoning, [{ type: "reasoning", textDelta: "think" }]);
  assert.deepEqual(text, [{ type: "text-delta", textDelta: "answer" }]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].type, "finish");
  assert.equal(usage[0].finishReason, "stop");
  assert.deepEqual(usage[0].usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  assert.deepEqual(usage[0].response, { id: "chatcmpl-r", modelId: "grok-4.6" });
  assert.deepEqual(wire.beefApiChunkToHostEvents(null, accumulator), []);
});

test("beefApiChunkToHostEvents maps parallel tool-call chunks onto host stream parts", () => {
  const wire = loadWire();
  const stream = [
    sseEvent({
      id: "chatcmpl-tools",
      model: "grok-4.6",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_a", type: "function", function: { name: "alpha", arguments: "{\"a\":" } }
          ]
        }
      }]
    }),
    sseEvent({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, id: "call_b", type: "function", function: { name: "beta", arguments: "{\"b\":2}" } },
            { index: 0, function: { arguments: "1}" } }
          ]
        }
      }]
    }),
    sseEvent({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
    }),
    "data: [DONE]\n\n"
  ].join("");

  const events = hostEventsFromSse(wire, stream, 3);
  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    "tool-call-streaming-start",
    "tool-call-delta",
    "tool-call-streaming-start",
    "tool-call-delta",
    "tool-call-delta",
    "tool-call",
    "tool-call",
    "finish"
  ]);
  assert.equal(events[0].toolCallId, "call_a");
  assert.equal(events[2].toolCallId, "call_b");
  assert.deepEqual(events[5], { type: "tool-call", toolCallId: "call_a", toolName: "alpha", args: { a: 1 } });
  assert.deepEqual(events[6], { type: "tool-call", toolCallId: "call_b", toolName: "beta", args: { b: 2 } });
  assert.equal(events[7].finishReason, "tool-calls");
  assert.deepEqual(events[7].usage, { promptTokens: 11, completionTokens: 5, totalTokens: 16 });
});

test("flushing a finished decoder emits a terminal finish when usage never arrived", () => {
  const wire = loadWire();
  const decoder = wire.createBeefApiSseDecoder();
  const accumulator = wire.createBeefApiToolCallAccumulator();
  const events = [];
  const bytes = utf8(sseEvent({
    choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }]
  }) + "data: [DONE]\n\n");
  events.push(...decoder.push(bytes));
  events.push(...decoder.end());
  const hostEvents = [];
  for (const event of events) {
    hostEvents.push(...wire.beefApiChunkToHostEvents(event, accumulator));
  }
  assert.equal(hostEvents[0].type, "text-delta");
  assert.equal(hostEvents[1].type, "finish");
  assert.equal(hostEvents[1].finishReason, "length");
  assert.deepEqual(hostEvents[1].usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
});

test("empty message and tool lists convert to empty OpenAI arrays", () => {
  const wire = loadWire();
  assert.deepEqual(wire.toBeefApiOpenAiMessages(null), []);
  assert.deepEqual(wire.toBeefApiOpenAiMessages([]), []);
  assert.deepEqual(wire.toBeefApiOpenAiTools(null), []);
  assert.deepEqual(wire.toBeefApiOpenAiTools([]), []);
});

test("stream error chunks fail closed without a synthetic finish", () => {
  const wire = loadWire();
  const accumulator = wire.createBeefApiToolCallAccumulator();
  assert.throws(
    () => wire.beefApiChunkToHostEvents({ error: { message: "upstream overloaded" } }, accumulator),
    /upstream overloaded/
  );
});
