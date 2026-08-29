import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionSource = fs.readFileSync(path.join(root, "src", "provider-direct-session.cjs"), "utf8");
const fixtures = path.join(root, "tests", "fixtures", "provider_protocols");
const nodeRequire = createRequire(import.meta.url);
const protocols = nodeRequire("../src/provider_protocols/index.cjs");

const CONFIG_PATH = "/workspace/grok-home/config/external.json";
const DIGEST = "06b100f3190f0af653876625d97fbff1edc903662cc172e02d8eb62ce6789773";

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

function activeConfig(protocol, endpointPath) {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "external-only",
    nativeFallback: false,
    fallbackPolicy: "never",
    profileId: "custom-openai",
    protocol,
    model: "test-model",
    baseUrl: "http://127.0.0.1:18779",
    endpointPath,
    generation: 1,
    profileDigest: DIGEST
  };
}

function sseBody(relative) {
  return new TextEncoder().encode(fs.readFileSync(path.join(fixtures, relative), "utf8"));
}

function loadSession(config, fetchImpl) {
  const fetches = [];
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
      return fetchImpl(url, init, fetches);
    },
    require(id) {
      if (id === "./provider_protocols/index.cjs") return protocols;
      assert.equal(id, "node:fs");
      return { readFileSync(filePath) {
        assert.equal(filePath, CONFIG_PATH);
        return JSON.stringify(config);
      } };
    }
  };
  vm.createContext(context);
  vm.runInContext(sessionSource, context, { filename: "provider-direct-session.cjs" });
  return { context, fetches };
}

async function consume(result) {
  const events = [];
  for await (const event of result.fullStream) events.push(event);
  return {
    events,
    usage: JSON.parse(JSON.stringify(await result.usage)),
    extendedUsage: JSON.parse(JSON.stringify(await result.extendedUsage)),
    providerMetadata: JSON.parse(JSON.stringify(await result.providerMetadata)),
    invocationId: await result.invocationId,
    response: await result.response
  };
}

const PROTOCOLS = [
  {
    id: "openai-chat",
    path: "/chat/completions",
    stream: "streams/openai-chat/text.sse",
    text: "hello world",
    reasoning: "plan",
    maxTokens: undefined
  },
  {
    id: "openai-responses",
    path: "/responses",
    stream: "streams/openai-responses/text.sse",
    text: "hello world",
    reasoning: "plan",
    maxTokens: 128
  },
  {
    id: "anthropic-messages",
    path: "/messages",
    stream: "streams/anthropic-messages/text.sse",
    text: "hello world",
    reasoning: "plan",
    maxTokens: 128
  }
];

test("real protocol adapters and session compose a fake-loopback turn for all three protocols", async () => {
  for (const spec of PROTOCOLS) {
    const config = activeConfig(spec.id, spec.path);
    let stockSessionCalls = 0;
    let stockLabelCalls = 0;
    const { context, fetches } = loadSession(config, async () => {
      let sent = false;
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return String(name).toLowerCase() === "x-request-id" ? `${spec.id}-req` : null; } },
        body: {
          async *[Symbol.asyncIterator]() {
            if (!sent) {
              sent = true;
              yield sseBody(spec.stream);
            }
          }
        }
      };
    });

    const wrapped = context.wrapHostInferenceWithProviderSwitcher({
      createSession() { stockSessionCalls += 1; throw new Error("stock session must not run"); },
      recordPostTurnLabeling() { stockLabelCalls += 1; }
    }, {});
    const requestIds = [];
    const executor = wrapped.createSession((id) => requestIds.push(id), {}).getExecutor([
      { role: "system", content: "You are a helper." },
      { role: "user", content: "Say hello." }
    ]);
    const options = spec.maxTokens == null ? {} : { maxTokens: spec.maxTokens };
    const consumed = await consume(executor.stream({}, `${spec.id}-inv`, [], options));

    assert.equal(stockSessionCalls, 0, spec.id);
    wrapped.recordPostTurnLabeling({ requestId: "label-1" });
    assert.equal(stockLabelCalls, 0, spec.id);
    assert.equal(consumed.events.some((event) => event.type === "provider-state"), false, spec.id);
    assert.equal(consumed.events.filter((event) => event.type === "finish").length, 1, spec.id);
    assert.equal(
      consumed.events.filter((event) => event.type === "text-delta").map((event) => event.textDelta).join(""),
      spec.text,
      spec.id
    );
    assert.equal(
      consumed.events.filter((event) => event.type === "reasoning").map((event) => event.textDelta).join(""),
      spec.reasoning,
      spec.id
    );
    assert.equal(consumed.usage.promptTokens > 0, true, spec.id);
    assert.equal(consumed.usage.completionTokens > 0, true, spec.id);
    assert.equal(consumed.providerMetadata.requestId, `${spec.id}-req`, spec.id);
    assert.deepEqual(requestIds, [`${spec.id}-req`], spec.id);
    assert.equal(fetches.length, 1, spec.id);
    assert.equal(fetches[0].url, `http://127.0.0.1:18779${spec.path}`, spec.id);
    assert.equal(fetches[0].init.method, "POST", spec.id);
    assert.equal(fetches[0].init.headers.Authorization, undefined, spec.id);
    assert.equal(fetches[0].init.headers.authorization, undefined, spec.id);
    assert.equal(fetches[0].init.headers["x-api-key"], undefined, spec.id);
    assert.equal(fetches[0].init.headers["x-grok-request-kind"], "main", spec.id);
    const body = JSON.parse(fetches[0].init.body);
    assert.equal(body.model, "test-model", spec.id);
    assert.equal(body.stream, true, spec.id);
    if (spec.maxTokens != null && spec.id === "openai-chat") {
      assert.equal(body.max_tokens, spec.maxTokens, spec.id);
    }
    if (spec.id === "anthropic-messages") {
      assert.equal(body.max_tokens, 128, spec.id);
      assert.equal(fetches[0].init.headers["anthropic-version"], "2023-06-01", spec.id);
    }
    if (spec.id === "openai-responses") {
      assert.equal(body.store, false, spec.id);
      assert.deepEqual(body.include, ["reasoning.encrypted_content"], spec.id);
    }
  }
});
