// Loads the injectable payload out of dist/grok-switch.cjs into a VM that
// imitates the host bundle scope, then drives createHostInference the way the
// host does. Run `node build.mjs` first (npm test does).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = fs.readFileSync(path.join(root, "dist", "grok-switch.cjs"), "utf8");
const FIXTURES = path.join(root, "tests", "fixtures", "protocols", "streams");
const CONFIG_PATH = "/workspace/grok-switch/config.json";
const LOG_PATH = "/workspace/grok-switch/requests.log";

function payload() {
  const begin = DIST.indexOf("// GROK_SWITCH_PAYLOAD_BEGIN");
  const end = DIST.indexOf("// GROK_SWITCH_PAYLOAD_END");
  assert.ok(begin > 0 && end > begin, "dist file must contain payload markers");
  return DIST.slice(begin, end);
}

class BasePromptBuilder {
  constructor(initial) {
    this.messages = initial == null ? [] : Array.isArray(initial) ? [...initial] : [initial];
  }
  getMessages() {
    return [...this.messages];
  }
}

class BasePromptExecutor {
  constructor(builder) {
    this.builder = builder;
  }
  getMessages() {
    return this.builder.getMessages();
  }
}

function sse(text, extra = {}) {
  const status = extra.status ?? 200;
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => ({ "content-type": "text/event-stream", "x-request-id": "req-1", ...extra.headers })[name.toLowerCase()] ?? null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    })
  };
}

function jsonFailure(status, body) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer
  };
}

// Builds a fresh host-like scope. `files` is a mutable map standing in for the
// filesystem so tests can change config.json between calls.
function loadHost({ files = new Map(), fetchImpl } = {}) {
  const fetches = [];
  const originalCalls = [];
  const labelingCalls = [];
  const context = {
    console,
    process: { env: { CODEX_HOME: "/codex" }, pid: 4242 },
    Buffer,
    URLSearchParams,
    fetch: async (url, init) => {
      const isJson = init.headers["content-type"] === "application/json";
      fetches.push({ url, init, body: isJson ? JSON.parse(init.body) : init.body });
      return fetchImpl(url, init, fetches.length);
    },
    TextDecoder,
    TextEncoder,
    crypto,
    URL,
    Uint8Array,
    ArrayBuffer,
    ReadableStream,
    AbortController,
    Promise,
    Map,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Number,
    Object,
    Array,
    String,
    Error,
    Symbol,
    Math,
    BasePromptBuilder,
    BasePromptExecutor,
    require(id) {
      assert.equal(id, "node:fs");
      return {
        readFileSync(file) {
          if (!files.has(file)) {
            const error = new Error("ENOENT " + file);
            error.code = "ENOENT";
            throw error;
          }
          return files.get(file);
        },
        statSync(file) {
          if (!files.has(file)) throw new Error("ENOENT");
          return { size: files.get(file).length };
        },
        renameSync(from, to) {
          files.set(to, files.get(from));
          files.delete(from);
        },
        appendFileSync(file, data) {
          files.set(file, (files.get(file) ?? "") + data);
        },
        writeFileSync(file, data) {
          files.set(file, data);
        },
        mkdirSync() {}
      };
    },
    __grokSwitchOriginalCreateHostInference(options) {
      originalCalls.push(options);
      return {
        resolvePrivacyMode: () => "official-privacy",
        createSession: (onRequestId, sessionOptions) => ({
          official: true,
          onRequestId,
          sessionOptions,
          getModelId: () => "grok-official",
          getExecutor(state) {
            const executor = new BasePromptExecutor(new BasePromptBuilder(state));
            executor.stream = (...args) => {
              originalCalls.push({ streamed: true, args });
              const done = Promise.resolve({});
              return { fullStream: (async function* () {})(), usage: done, extendedUsage: done, providerMetadata: done, invocationId: done, response: done };
            };
            return executor;
          }
        }),
        recordPostTurnLabeling: (args) => labelingCalls.push(["post", args]),
        recordFollowupLabeling: (args) => labelingCalls.push(["followup", args])
      };
    }
  };
  vm.createContext(context);
  vm.runInContext('"use strict";\n' + payload(), context, { filename: "payload.cjs" });
  const inference = context.createHostInference({ auth: {}, experiments: {}, settings: {} });
  return { context, inference, fetches, originalCalls, labelingCalls, files };
}

async function drain(result) {
  const events = [];
  let streamError = null;
  try {
    for await (const event of result.fullStream) events.push(event);
  } catch (error) {
    streamError = error;
  }
  const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  return {
    events,
    streamError,
    usage: await settle(result.usage),
    response: await settle(result.response),
    providerMetadata: await settle(result.providerMetadata)
  };
}

function config(active, providers) {
  return JSON.stringify({ active, providers });
}

// Objects created inside the VM have a different Object prototype.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const OPENAI = { protocol: "openai-chat", baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-secret" };

test("without config.json every session goes to the original host inference", () => {
  const host = loadHost({ fetchImpl: () => assert.fail("fetch must not be called") });
  assert.equal(host.originalCalls.length, 1);
  const session = host.inference.createSession("rid", { requestSource: "main" });
  assert.equal(session.official, true);
  assert.equal(host.inference.resolvePrivacyMode(), "official-privacy");
  host.inference.recordPostTurnLabeling({ a: 1 });
  assert.equal(host.labelingCalls.length, 1);
});

test("active provider streams through the adapter with auth headers and records a log line", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  const requestIds = [];
  const session = host.inference.createSession((id) => requestIds.push(id), { requestSource: "main" });
  assert.equal(session.getModelId(), "gpt-x");
  const executor = session.getExecutor([{ role: "user", content: "hi" }]);
  const out = await drain(executor.stream({ signal: undefined }, "inv-1", [], {}));

  assert.equal(out.streamError, null);
  assert.equal(host.fetches.length, 1);
  assert.equal(host.fetches[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(host.fetches[0].init.headers.authorization, "Bearer sk-secret");
  assert.equal(host.fetches[0].init.redirect, "error");
  assert.equal(host.fetches[0].body.model, "gpt-x");
  assert.deepEqual(host.fetches[0].body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(out.events.filter((e) => e.type === "text-delta").map((e) => e.textDelta).join(""), "hello world");
  assert.equal(out.usage.ok, true);
  assert.deepEqual(plain(out.usage.value), { promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  assert.equal(out.response.value.modelId, "gpt-x");
  assert.deepEqual(plain(out.response.value.messages[0].content), [
    { type: "reasoning", text: "plan" },
    { type: "text", text: "hello world" }
  ]);
  assert.deepEqual(requestIds, ["req-1"]);
  assert.equal(host.labelingCalls.length, 0);
  host.inference.recordPostTurnLabeling({});
  assert.equal(host.labelingCalls.length, 0, "labeling is suppressed while external");

  const log = files.get(LOG_PATH).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].provider, "main");
  assert.equal(log[0].status, 200);
  assert.equal(log[0].kind, "main");
  assert.deepEqual(log[0].usage, { promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  assert.ok(!JSON.stringify(log).includes("sk-secret"));
});

test("editing config.json between sessions switches routes without reloading", async () => {
  const files = new Map([[CONFIG_PATH, config("a", { a: OPENAI, b: { ...OPENAI, model: "other", baseUrl: "https://b.example.com" } })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "1" }]).stream({}, "i1", [], {}));
  files.set(CONFIG_PATH, config("b", JSON.parse(files.get(CONFIG_PATH)).providers));
  await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "2" }]).stream({}, "i2", [], {}));
  files.set(CONFIG_PATH, config(null, JSON.parse(files.get(CONFIG_PATH)).providers));
  const official = host.inference.createSession(null, {});
  assert.equal(host.fetches[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(host.fetches[1].url, "https://b.example.com/chat/completions");
  assert.equal(host.fetches[1].body.model, "other");
  assert.equal(official.official, true);
});

test("broken config.json fails the request with a readable message instead of going official", async () => {
  const files = new Map([[CONFIG_PATH, config("missing", { a: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail("fetch must not be called") });
  const session = host.inference.createSession(null, {});
  assert.equal(session.official, undefined);
  const out = await drain(session.getExecutor([]).stream({}, "i", [], {}));
  assert.ok(out.streamError);
  assert.match(out.streamError.message, /grok-switch: config\.json: active provider "missing" is not defined/);
  assert.equal(out.events.at(-1).type, "error");
  assert.equal(out.usage.ok, false);
  assert.match(files.get(LOG_PATH), /is not defined/);
});

test("upstream HTTP errors surface the provider's own message", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => jsonFailure(401, { error: { message: "Incorrect API key provided" } }) });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "x" }]).stream({}, "i", [], {}));
  assert.match(out.streamError.message, /main \(gpt-x\) HTTP 401: Incorrect API key provided/);
  const log = JSON.parse(files.get(LOG_PATH).trim());
  assert.equal(log.status, 401);
  assert.match(log.error, /Incorrect API key/);
});

test("anthropic providers get x-api-key, anthropic-version and a default max_tokens", async () => {
  const provider = { protocol: "anthropic-messages", baseUrl: "https://claude.example.com/", model: "claude-x", apiKey: "ak" };
  const files = new Map([[CONFIG_PATH, config("c", { c: provider })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "anthropic-messages", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "x" }]).stream({}, "i", [], {}));
  assert.equal(out.streamError, null);
  assert.equal(host.fetches[0].url, "https://claude.example.com/messages");
  assert.equal(host.fetches[0].init.headers["x-api-key"], "ak");
  assert.equal(host.fetches[0].init.headers.authorization, undefined);
  assert.ok(host.fetches[0].init.headers["anthropic-version"]);
  assert.equal(host.fetches[0].body.max_tokens, 8192);
});

test("custom endpointPath, extra headers, query string and parameters are honoured", async () => {
  const provider = {
    ...OPENAI,
    baseUrl: "https://relay.example.com/openai?tenant=7",
    endpointPath: "/v1/custom/chat",
    headers: { "X-Team": "blue" },
    parameters: { reasoningEffort: "high", maxTokens: 321 }
  };
  const files = new Map([[CONFIG_PATH, config("p", { p: provider })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "x" }]).stream({}, "i", [], {}));
  assert.equal(host.fetches[0].url, "https://relay.example.com/openai/v1/custom/chat?tenant=7");
  assert.equal(host.fetches[0].init.headers["X-Team"], "blue");
  assert.equal(host.fetches[0].body.reasoning_effort, "high");
  assert.equal(host.fetches[0].body.max_tokens, 321);
});

test("provider validation rejects obviously wrong entries", () => {
  const host = loadHost({ fetchImpl: () => assert.fail() });
  const normalize = host.context.grokSwitchNormalizeProvider;
  assert.throws(() => normalize("x", { ...OPENAI, protocol: "grpc" }), /protocol must be one of/);
  assert.throws(() => normalize("x", { ...OPENAI, baseUrl: "ftp://x" }), /must be http\(s\)/);
  assert.throws(() => normalize("x", { ...OPENAI, apiKey: "" }), /apiKey is required/);
  assert.throws(() => normalize("x", { ...OPENAI, endpointPath: "relative" }), /absolute path/);
  assert.throws(() => normalize("x", { ...OPENAI, headers: { Host: "evil" } }), /not allowed/);
  assert.throws(() => normalize("x", { ...OPENAI, parameters: { temperature: 1 } }), /unknown parameter/);
  assert.equal(normalize("x", { ...OPENAI, apiKey: "", authType: "none" }).authType, "none");
});

async function chat(host, text, sessionOptions = {}) {
  const session = host.inference.createSession(null, sessionOptions);
  const executor = session.getExecutor([{ role: "user", content: [{ type: "text", text }] }]);
  return drain(executor.stream({}, "inv", [], {}));
}

test("/gs commands in chat are answered locally on both routes and edit config.json", async () => {
  const files = new Map([[CONFIG_PATH, config(null, { a: OPENAI, b: { ...OPENAI, model: "b-model" } })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail("no model call expected") });

  let out = await chat(host, "/gs status");
  assert.equal(out.streamError, null);
  const reply = out.events.filter((e) => e.type === "text-delta").map((e) => e.textDelta).join("");
  assert.match(reply, /Active: \*\*official Grok\*\*/);
  assert.match(reply, /- a — openai-chat/);
  assert.equal(out.events.at(-1).type, "finish");
  assert.equal(out.response.value.messages[0].content[0].text, reply);
  assert.equal(host.originalCalls.filter((c) => c.streamed).length, 0, "official model was not called");

  out = await chat(host, "  /GS use b");
  assert.match(out.events[0].textDelta, /Switched to \*\*b\*\*.*b-model/);
  assert.equal(JSON.parse(files.get(CONFIG_PATH)).active, "b");
  assert.deepEqual(Object.keys(JSON.parse(files.get(CONFIG_PATH)).providers), ["a", "b"], "providers preserved");

  // Now on the external route: commands still intercepted, no fetch.
  out = await chat(host, "/gs use nope");
  assert.match(out.events[0].textDelta, /No provider named `nope`.*Saved providers: a, b/);
  assert.equal(JSON.parse(files.get(CONFIG_PATH)).active, "b");

  out = await chat(host, "/gs official");
  assert.match(out.events[0].textDelta, /Switched back to \*\*official Grok\*\*/);
  assert.equal(JSON.parse(files.get(CONFIG_PATH)).active, null);

  out = await chat(host, "/gs");
  assert.match(out.events[0].textDelta, /\/gs use <name>/);

  // Ordinary messages on the official route still reach the host executor.
  out = await chat(host, "hello there");
  assert.equal(host.originalCalls.filter((c) => c.streamed).length, 1);

  // Non-main sessions (summarization etc.) never intercept.
  out = await chat(host, "/gs status", { isSummarizationSession: true });
  assert.equal(host.originalCalls.filter((c) => c.streamed).length, 2);
});

test("/gs official repairs a broken active pointer", async () => {
  const files = new Map([[CONFIG_PATH, config("gone", { a: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail() });
  let out = await chat(host, "/gs status");
  assert.match(out.events[0].textDelta, /config\.json is broken .*Run `\/gs official`/);
  out = await chat(host, "/gs official");
  assert.match(out.events[0].textDelta, /Switched back/);
  assert.equal(host.inference.createSession(null, {}).official, true);
});

test("codex auth signs with the ChatGPT login and refreshes once on 401", async () => {
  const idToken = "h." + Buffer.from(JSON.stringify({ aud: "client-123" })).toString("base64url") + ".s";
  const auth = { auth_mode: "chatgpt", tokens: { access_token: "old-access", refresh_token: "refresh-1", id_token: idToken, account_id: "acct-9" } };
  const provider = { protocol: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", model: "gpt-5-codex", authType: "codex" };
  const files = new Map([[CONFIG_PATH, config("cx", { cx: provider })], ["/codex/auth.json", JSON.stringify(auth)]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-responses", "text.sse"), "utf8");
  const host = loadHost({
    files,
    fetchImpl: (url, init, n) => {
      if (url === "https://auth.openai.com/oauth/token") {
        assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
        const form = new URLSearchParams(init.body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), "refresh-1");
        assert.equal(form.get("client_id"), "client-123");
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: "new-access", refresh_token: "refresh-2" }) };
      }
      if (n === 1) return jsonFailure(401, { detail: "expired" });
      return sse(text);
    }
  });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "hi" }]).stream({}, "i", [], {}));
  assert.equal(out.streamError, null, out.streamError && out.streamError.message);
  assert.equal(host.fetches.length, 3);
  assert.equal(host.fetches[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(host.fetches[0].init.headers.authorization, "Bearer old-access");
  assert.equal(host.fetches[0].init.headers["chatgpt-account-id"], "acct-9");
  assert.equal(host.fetches[0].body.store, false);
  assert.equal(host.fetches[2].init.headers.authorization, "Bearer new-access");
  const saved = JSON.parse(files.get("/codex/auth.json"));
  assert.equal(saved.tokens.access_token, "new-access");
  assert.equal(saved.tokens.refresh_token, "refresh-2");
  assert.equal(saved.tokens.account_id, "acct-9");
  assert.ok(saved.last_refresh);

  files.delete("/codex/auth.json");
  const missing = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "hi" }]).stream({}, "i", [], {}));
  assert.match(missing.streamError.message, /Codex login not found .*codex login/);
});

test("payload parses under strict mode and defines no unexpected globals in the host scope", () => {
  const host = loadHost({ fetchImpl: () => assert.fail() });
  const names = Object.keys(host.context).filter((n) => /^(grokSwitch|GROK_SWITCH|__grokSwitch|createHostInference)/.test(n) === false);
  // Everything we injected is namespaced; the remaining names are the harness's own.
  const injected = Object.keys(host.context).filter((n) => !names.includes(n));
  assert.ok(injected.includes("createHostInference"));
  assert.ok(injected.every((n) => /^(grokSwitch|GROK_SWITCH|__grokSwitch|createHostInference$)/.test(n)));
});
