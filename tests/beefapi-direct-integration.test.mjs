import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const wireSource = fs.readFileSync(path.join(root, "src", "beefapi-openai-wire.cjs"), "utf8");
const sessionSource = fs.readFileSync(path.join(root, "src", "beefapi-direct-session.cjs"), "utf8");
const activeConfig = JSON.stringify({
  schemaVersion: 1,
  enabled: true,
  mode: "external-only",
  nativeFallback: false,
  provider: "beefapi",
  group: "grok",
  modelId: "grok-4.6",
  baseUrl: "http://127.0.0.1:18779/v1"
});

class BasePromptBuilder {
  constructor(initialMessages) {
    this.messages = initialMessages == null ? [] : Array.isArray(initialMessages) ? [...initialMessages] : [initialMessages];
  }
  appendMessages(messages) {
    this.messages.push(...(Array.isArray(messages) ? messages : [messages]));
    return this;
  }
  getState() { return [...this.messages]; }
  getMessages() { return [...this.messages]; }
  clearMessages() { this.messages = []; }
}

class BasePromptExecutor {
  constructor(builder) { this.builder = builder; }
  appendMessages(messages) { this.builder.appendMessages(messages); return this; }
  getState() { return this.builder.getState(); }
  getMessages() { return this.builder.getMessages(); }
  clearMessages() { this.builder.clearMessages(); }
}

function sseBytes() {
  const frames = [
    {
      id: "beefapi-request-1",
      model: "grok-4.6",
      choices: [{ index: 0, delta: { content: "GROK_HOME_BOT_EXTERNAL_OK" }, finish_reason: null }]
    },
    {
      id: "beefapi-request-1",
      model: "grok-4.6",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 4,
        total_tokens: 11,
        prompt_tokens_details: { cached_tokens: 2 }
      }
    }
  ];
  return new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
}

async function settle(promise) {
  return promise;
}

test("real wire and session sources compose into an external-only streamed turn", async () => {
  const fetches = [];
  let stockSessionCalls = 0;
  let stockLabelCalls = 0;
  const context = {
    BasePromptBuilder,
    BasePromptExecutor,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    URL,
    crypto,
    fetch: async (url, init) => {
      fetches.push({ url, init });
      let sent = false;
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        body: {
          async *[Symbol.asyncIterator]() {
            if (!sent) {
              sent = true;
              yield sseBytes();
            }
          }
        }
      };
    },
    require(id) {
      assert.equal(id, "node:fs");
      return { readFileSync() { return activeConfig; } };
    }
  };
  vm.createContext(context);
  vm.runInContext(`${wireSource}\n${sessionSource}`, context, { filename: "grok-home-direct-integration.cjs" });

  const wrapped = context.wrapHostInferenceWithBeefApiDirect({
    createSession() { stockSessionCalls += 1; throw new Error("stock session must not run"); },
    recordPostTurnLabeling() { stockLabelCalls += 1; }
  }, {});
  const requestIds = [];
  const executor = wrapped.createSession((id) => requestIds.push(id), {}).getExecutor([
    { role: "user", content: "Return the marker" }
  ]);
  const result = executor.stream({}, "invocation-1", [], { maxTokens: 64 });
  const events = [];
  for await (const event of result.fullStream) events.push(event);

  assert.equal(stockSessionCalls, 0);
  wrapped.recordPostTurnLabeling({ requestId: "label-1" });
  assert.equal(stockLabelCalls, 0);
  assert.deepEqual(events.map((event) => event.type), ["text-delta", "finish"]);
  assert.equal(events[0].textDelta, "GROK_HOME_BOT_EXTERNAL_OK");
  assert.deepEqual(JSON.parse(JSON.stringify(await settle(result.usage))), {
    promptTokens: 7,
    completionTokens: 4,
    totalTokens: 11
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await settle(result.extendedUsage))), {
    inputTokens: 7,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    maxTokens: 64
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await settle(result.providerMetadata))), {
    beefapiRequestId: "beefapi-request-1"
  });
  assert.deepEqual(requestIds, ["beefapi-request-1"]);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "http://127.0.0.1:18779/v1/chat/completions");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
  assert.equal(fetches[0].init.headers.authorization, undefined);
  assert.equal(fetches[0].init.headers["x-grok-request-kind"], "main");
  const body = JSON.parse(fetches[0].init.body);
  assert.equal(body.model, "grok-4.6");
  assert.equal(body.max_tokens, 64);
  assert.deepEqual(body.messages, [{ role: "user", content: "Return the marker" }]);
});
