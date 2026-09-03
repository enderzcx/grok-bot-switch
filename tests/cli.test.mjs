// End-to-end tests of dist/grok-switch.cjs against a synthetic host layout:
// a small fake host-main.cjs, a fake /proc, a fake supervisor directory and a
// local HTTP server that speaks OpenAI Chat SSE.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(root, "dist", "grok-switch.cjs");
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const REAL_BUNDLE = process.env.GROK_SWITCH_REAL_BUNDLE || path.join(root, "..", "grok_home", "research", "current-0.30", "host-main.cjs");

// Mirrors the shape of the real bundle around the anchors we rely on.
const FAKE_BUNDLE = `"use strict";
var BasePromptBuilder, BasePromptExecutor;
BasePromptBuilder = class { constructor(m) { this.m = m || []; } getMessages() { return this.m; } };
BasePromptExecutor = class { constructor(b) { this.b = b; } getMessages() { return this.b.getMessages(); } };
function createCursorSandInference(options2) {
  return { createSession(onRequestId, sessionOptions) { return { official: true }; }, recordPostTurnLabeling(args) {} };
}
// src/host/extensions/inference/inference-service.ts
function createHostInference(options2) {
  const { auth: auth2, experiments, settings } = options2;
  return createCursorSandInference({ getAccessToken: auth2.getAccessToken });
}
module.exports = { createHostInference };
`;

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-switch-test-"));
  const hostDir = path.join(dir, "sand-host");
  const proc = path.join(dir, "proc");
  fs.mkdirSync(hostDir);
  fs.mkdirSync(path.join(proc, "4242"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sup"));
  const host = path.join(hostDir, "host-main.cjs");
  fs.writeFileSync(host, FAKE_BUNDLE);
  fs.writeFileSync(path.join(hostDir, "version"), "17184bb\n");
  const past = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(host, past, past);
  fs.writeFileSync(path.join(proc, "4242", "cmdline"), `node\0${host}\0`);
  fs.writeFileSync(path.join(proc, "4242", "stat"), "4242 (node) S 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 360000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
  fs.writeFileSync(path.join(proc, "stat"), `cpu 0 0 0 0\nbtime ${Math.floor(Date.now() / 1000) - 7200}\n`);
  return {
    dir,
    host,
    env: {
      ...process.env,
      GROK_SWITCH_HOST: host,
      GROK_SWITCH_SUPERVISOR_DIR: path.join(dir, "sup"),
      GROK_SWITCH_PROC: proc,
      GROK_SWITCH_DIR: path.join(dir, "cfg")
    }
  };
}

function run(env, ...args) {
  const result = spawnSync(process.execPath, [DIST, ...args], { env, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// Async variant for tests that host an HTTP server in this process; spawnSync
// would block the event loop the server needs.
function runAsync(env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST, ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function nodeCheck(file) {
  return spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }).status === 0;
}

function startFakeOpenAi(onRequest) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const reply = onRequest(req, JSON.parse(body));
        if (reply.status !== 200) {
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(JSON.stringify(reply.body));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "fake-req-9" });
        res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "OK" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("use patches the host, requests a restart, and status/list/official/restore round-trip", () => {
  const { dir, host, env } = makeEnv();
  const original = fs.readFileSync(host, "utf8");

  let r = run(env, "status");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /not patched/);
  assert.match(r.out, /pid 4242 .* running current bundle/);
  assert.match(r.out, /active {6}: official Grok/);

  r = run(env, "use", "beef", "--url", "https://api.example.com/v1", "--model", "gpt-5", "--key", "sk-1", "--no-test");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /active provider: beef/);
  assert.match(r.out, /host bundle patched/);
  assert.match(r.out, /restart requested/);
  const patched = fs.readFileSync(host, "utf8");
  assert.ok(patched.includes("// GROK_SWITCH_BEGIN"));
  assert.ok(patched.includes("function __grokSwitchOriginalCreateHostInference(options2)"));
  assert.equal(patched.split("function createHostInference(").length, 2, "exactly one createHostInference");
  assert.ok(nodeCheck(host));
  assert.equal(fs.readFileSync(host + ".grok-switch.orig", "utf8"), original);
  const command = JSON.parse(fs.readFileSync(path.join(dir, "sup", "command.json"), "utf8"));
  assert.equal(command.kind, "restart");
  const config = JSON.parse(fs.readFileSync(path.join(dir, "cfg", "config.json"), "utf8"));
  assert.equal(config.active, "beef");
  assert.equal(config.providers.beef.apiKey, "sk-1");
  assert.equal(fs.statSync(path.join(dir, "cfg", "config.json")).mode & 0o777, 0o600);

  // The patched fake bundle must still load and expose the wrapped factory.
  const loaded = spawnSync(process.execPath, ["-e", `
    const m = require(${JSON.stringify(host)});
    const inf = m.createHostInference({ auth: {}, experiments: {}, settings: {} });
    process.stdout.write(typeof inf.createSession + " " + typeof grokSwitchWrapHostInference);
  `], { encoding: "utf8" });
  assert.equal(loaded.stdout, "function undefined", loaded.stderr);

  r = run(env, "status");
  assert.match(r.out, /patched \(0\.\d+\.\d+\)/);
  assert.match(r.out, /RESTART PENDING/);
  assert.match(r.out, /command pending \(grok-switch-\d+\)/);
  assert.match(r.out, /active {6}: beef -> openai-chat https:\/\/api\.example\.com\/v1\/chat\/completions model=gpt-5/);

  // Second use is idempotent on the bundle and does not double-issue commands.
  r = run(env, "use", "beef");
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /host bundle patched/);
  assert.match(r.out, /already pending/);
  assert.equal(fs.readFileSync(host, "utf8"), patched);

  r = run(env, "add", "claude", "--protocol", "anthropic-messages", "--url", "https://c.example.com", "--model", "claude-x", "--key", "ak");
  assert.equal(r.code, 0, r.err);
  r = run(env, "list");
  assert.match(r.out, /^\* beef /m);
  assert.match(r.out, /^ {2}claude {2}anthropic-messages https:\/\/c\.example\.com\/messages model=claude-x/m);
  r = run(env, "list", "--json");
  assert.equal(JSON.parse(r.out).providers.beef.apiKey, "***");

  r = run(env, "remove", "beef");
  assert.equal(r.code, 1);
  assert.match(r.err, /is the active provider/);

  r = run(env, "official");
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "cfg", "config.json"), "utf8")).active, null);
  r = run(env, "remove", "beef");
  assert.equal(r.code, 0, r.err);

  r = run(env, "restore");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /patch removed/);
  assert.equal(fs.readFileSync(host, "utf8"), original);
  assert.equal(fs.existsSync(host + ".grok-switch.orig"), false);
  r = run(env, "restore");
  assert.match(r.out, /nothing to restore/);
});

test("use refuses bundles without the anchors and leaves them untouched", () => {
  const { host, env } = makeEnv();
  fs.writeFileSync(host, FAKE_BUNDLE.replace("function createHostInference(", "function createHostInferenceRenamed("));
  const before = fs.readFileSync(host, "utf8");
  const r = run(env, "use", "x", "--url", "https://a.example.com", "--model", "m", "--key", "k", "--no-test");
  assert.equal(r.code, 1);
  assert.match(r.err, /createHostInference definitions \(expected 1\)/);
  assert.equal(fs.readFileSync(host, "utf8"), before);
  assert.equal(fs.existsSync(host + ".grok-switch.orig"), false);
});

test("a host update that replaces the patched bundle is detected and re-patched", () => {
  const { host, env } = makeEnv();
  let r = run(env, "use", "p", "--url", "https://a.example.com", "--model", "m", "--key", "k", "--no-test");
  assert.equal(r.code, 0, r.err);
  fs.writeFileSync(host, FAKE_BUNDLE.replace("17184bb", "newver"));
  r = run(env, "status");
  assert.match(r.out, /not patched/);
  assert.match(r.out, /warning .*run `use p` to re-apply/);
  fs.rmSync(path.join(env.GROK_SWITCH_SUPERVISOR_DIR, "command.json"));
  r = run(env, "use", "p");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /host bundle patched/);
  assert.match(r.out, /restart requested/);
});

test("validation errors are reported without touching the host or config", () => {
  const { host, env } = makeEnv();
  const before = fs.readFileSync(host, "utf8");
  let r = run(env, "use", "p", "--url", "https://a.example.com", "--model", "m");
  assert.equal(r.code, 1);
  assert.match(r.err, /apiKey is required/);
  r = run(env, "use", "p", "--url", "nope", "--model", "m", "--key", "k");
  assert.match(r.err, /baseUrl is not a valid URL/);
  r = run(env, "use", "bad name", "--url", "https://a.example.com", "--model", "m", "--key", "k");
  assert.match(r.err, /provider name must be/);
  r = run(env, "use", "p", "--url", "https://a.example.com", "--model", "m", "--key", "k", "--protocol", "grpc");
  assert.match(r.err, /protocol must be one of/);
  assert.equal(fs.readFileSync(host, "utf8"), before);
  assert.equal(fs.existsSync(path.join(env.GROK_SWITCH_DIR, "config.json")), false);
  r = run({ ...env, GROK_SWITCH_API_KEY: "from-env" }, "add", "p", "--url", "https://a.example.com", "--model", "m");
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.GROK_SWITCH_DIR, "config.json"), "utf8")).providers.p.apiKey, "from-env");
});

test("test command sends a real request and log shows it", async () => {
  const { env } = makeEnv();
  const seen = [];
  const { server, port } = await startFakeOpenAi((req, body) => {
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    return body.model === "bad" ? { status: 401, body: { error: { message: "bad key" } } } : { status: 200 };
  });
  try {
    let r = run(env, "add", "local", "--url", `http://127.0.0.1:${port}/v1`, "--model", "m1", "--key", "k1");
    assert.equal(r.code, 0, r.err);
    r = await runAsync(env, "test", "local");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^OK in \d+ms via openai-chat http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions model=m1/);
    assert.match(r.out, /reply: "OK"/);
    assert.match(r.out, /usage: 12 prompt \+ 1 completion tokens/);
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(seen[0].auth, "Bearer k1");
    assert.equal(seen[0].body.stream, true);

    r = run(env, "add", "broken", "--url", `http://127.0.0.1:${port}/v1`, "--model", "bad", "--key", "k1");
    r = await runAsync(env, "test", "broken", "--json");
    assert.equal(r.code, 1);
    const json = JSON.parse(r.out);
    assert.equal(json.ok, false);
    assert.match(json.error, /HTTP 401: bad key/);

    r = run(env, "log");
    const lines = r.out.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /local {2}m1 {2}test {2}HTTP 200 .*tokens 12\+1/);
    assert.match(lines[1], /broken {2}bad {2}test {2}HTTP 401 .*ERROR .*bad key/);
    assert.doesNotMatch(r.out, /k1/);

    // `use` with provider flags probes first: a bad provider switches nothing.
    r = await runAsync(env, "use", "nope", "--url", `http://127.0.0.1:${port}/v1`, "--model", "bad", "--key", "k1");
    assert.equal(r.code, 1);
    assert.match(r.err, /did not answer a test request: .*HTTP 401: bad key/);
    assert.match(r.err, /nothing was switched/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.GROK_SWITCH_DIR, "config.json"), "utf8")).active, null);
    assert.equal(fs.readFileSync(env.GROK_SWITCH_HOST, "utf8").includes("GROK_SWITCH_BEGIN"), false);

    r = await runAsync(env, "use", "local", "--model", "m1");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /test request OK in \d+ms \(reply "OK"\)/);
    assert.match(r.out, /host bundle patched/);
    assert.match(r.out, /in chat: \/gs official/);

    r = run(env, "status");
    assert.match(r.out, /usage {7}:/);
    assert.match(r.out, /local {2}2 requests, 24 in \/ 2 out tokens/);
    assert.match(r.out, /broken {2}1 requests \(1 failed\)/);
    assert.match(r.out, /nope {2}1 requests \(1 failed\)/);
  } finally {
    server.close();
  }
});

test("install patches, requests the one-time restart and starts the panel; later use needs no restart", async () => {
  const { dir, host, env } = makeEnv();
  try {
    let r = await runAsync(env, "install", "--port", "0");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /host bundle patched/);
    assert.match(r.out, /restart requested/);
    assert.match(r.out, /route: official Grok \(unchanged/);
    assert.match(r.out, /panel running: http:\/\/127\.0\.0\.1:\d+\/\s/);
    assert.ok(fs.readFileSync(host, "utf8").includes("GROK_SWITCH_BEGIN"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "sup", "command.json"), "utf8")).reason, "grok-switch install");
    assert.equal(fs.existsSync(path.join(dir, "cfg", "config.json")), false, "install selects no provider");

    // Simulate the supervisor applying the restart: command consumed, process restarted after the bundle change.
    fs.rmSync(path.join(dir, "sup", "command.json"));
    const future = new Date(Date.now() + 60 * 1000);
    fs.utimesSync(host, new Date(Date.now() - 60 * 1000), new Date(Date.now() - 60 * 1000));
    fs.writeFileSync(path.join(env.GROK_SWITCH_PROC, "stat"), `cpu 0 0 0 0\nbtime ${Math.floor(future.getTime() / 1000) - 3600}\n`);

    r = await runAsync(env, "install", "--no-ui");
    assert.match(r.out, /already patched/);
    assert.match(r.out, /no restart needed/);
    assert.equal(fs.existsSync(path.join(dir, "sup", "command.json")), false);

    r = run(env, "use", "p", "--url", "https://a.example.com", "--model", "m", "--key", "k", "--no-test");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /takes effect on the next conversation turn; no restart needed/);
    assert.equal(fs.existsSync(path.join(dir, "sup", "command.json")), false);
  } finally {
    run(env, "ui", "stop");
  }
});

test("ui panel: same-origin loopback API drives save, probe, use, official and stop", async () => {
  const { host, env } = makeEnv();
  const { server, port } = await startFakeOpenAi(() => ({ status: 200 }));
  const api = async (base, extraHeaders, path, body) => {
    const headers = { "x-gs-panel": "1", "content-type": "application/json", ...extraHeaders };
    if (extraHeaders && extraHeaders["x-gs-panel"] === null) delete headers["x-gs-panel"];
    const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null), text: null };
  };
  const tok = {};
  try {
    let r = await runAsync(env, "ui", "--background", "--port", "0");
    assert.equal(r.code, 0, r.err);
    const url = /panel running: (http:\/\/127\.0\.0\.1:\d+\/)\s/.exec(r.out)[1];
    const base = url.slice(0, -1);
    const state = JSON.parse(fs.readFileSync(path.join(env.GROK_SWITCH_DIR, "ui.json"), "utf8"));
    assert.equal(state.url, url);
    assert.equal(state.version, PKG_VERSION);

    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Grok Bot Switch/);
    // Access rules: page header required; foreign Origin and non-loopback Host rejected; own origin fine.
    assert.equal((await api(base, { "x-gs-panel": null }, "/api/state")).status, 403, "missing panel header");
    assert.equal((await api(base, { origin: "http://evil.example" }, "/api/state")).status, 403, "cross-site origin");
    // fetch() refuses to override Host, so the rebinding check uses node:http directly.
    const rebound = await new Promise((resolve, reject) => {
      const u = new URL(base);
      http.get({ host: u.hostname, port: u.port, path: "/api/state", headers: { host: "panel.attacker.example:1", "x-gs-panel": "1" } }, (res) => resolve(res.statusCode)).on("error", reject);
    });
    assert.equal(rebound, 403, "dns-rebinding host");
    assert.equal((await api(base, { origin: base }, "/api/state")).status, 200, "same origin");

    let s = await api(base, tok, "/api/state");
    assert.equal(s.status, 200);
    assert.equal(s.json.route, "official");
    assert.equal(s.json.host.patched, false);
    assert.deepEqual(s.json.providers, {});

    let saved = await api(base, tok, "/api/providers", { name: "local", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${port}/v1`, model: "m1", apiKey: "k1" });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.probe.ok, true);
    assert.equal(saved.json.state.providers.local.hasKey, true);
    assert.equal("apiKey" in saved.json.state.providers.local, false, "key never returned to the page");

    const bad = await api(base, tok, "/api/providers", { name: "bad name", baseUrl: "x", model: "m" });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /provider name/);

    const used = await api(base, tok, "/api/use", { name: "local" });
    assert.equal(used.status, 200, JSON.stringify(used.json));
    assert.match(used.json.lines.join(" "), /host bundle patched/);
    assert.equal(used.json.state.active, "local");
    assert.equal(used.json.state.host.patched, true);
    assert.ok(fs.readFileSync(host, "utf8").includes("GROK_SWITCH_BEGIN"));

    const official = await api(base, tok, "/api/official", {});
    assert.equal(official.json.state.active, null);
    s = await api(base, tok, "/api/state");
    assert.equal(s.json.usage.local.requests, 1);

    r = await runAsync(env, "ui", "status");
    assert.match(r.out, /panel running: http/);
    r = await runAsync(env, "ui", "--background");
    assert.match(r.out, /panel already running/);
    const stale = JSON.parse(fs.readFileSync(path.join(env.GROK_SWITCH_DIR, "ui.json"), "utf8"));
    stale.version = "0.6.1";
    fs.writeFileSync(path.join(env.GROK_SWITCH_DIR, "ui.json"), JSON.stringify(stale));
    r = await runAsync(env, "ui", "--background", "--port", String(stale.port));
    assert.match(r.out, new RegExp("replacing stale panel version 0\\.6\\.1 with " + PKG_VERSION.replace(/\./g, "\\.")));
    const replaced = JSON.parse(fs.readFileSync(path.join(env.GROK_SWITCH_DIR, "ui.json"), "utf8"));
    assert.equal(replaced.version, PKG_VERSION);
    assert.notEqual(replaced.pid, stale.pid);
    r = await runAsync(env, "ui", "stop");
    assert.match(r.out, /panel stopped/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(fetch(base + "/"));
    r = await runAsync(env, "ui", "status");
    assert.match(r.out, /not running/);

    // Restarting yields the same plain URL shape (no per-run secret in it).
    r = await runAsync(env, "ui", "--background", "--port", "0");
    assert.match(r.out, /panel running: http:\/\/127\.0\.0\.1:\d+\/\s/);
    await runAsync(env, "ui", "stop");
  } finally {
    server.close();
    try {
      const left = JSON.parse(fs.readFileSync(path.join(env.GROK_SWITCH_DIR, "ui.json"), "utf8"));
      process.kill(left.pid);
    } catch {}
  }
});

test("patches the real Grok Bot bundle when it is available locally", { skip: !fs.existsSync(REAL_BUNDLE) && "real bundle not present" }, () => {
  const { host, env } = makeEnv();
  fs.copyFileSync(REAL_BUNDLE, host);
  const original = fs.readFileSync(host);
  let r = run(env, "use", "p", "--url", "https://a.example.com", "--model", "m", "--key", "k", "--no-test");
  assert.equal(r.code, 0, r.err);
  assert.ok(nodeCheck(host));
  const patched = fs.readFileSync(host, "utf8");
  assert.equal(patched.split("\nfunction createHostInference(").length, 2);
  assert.equal(patched.split("\nfunction __grokSwitchOriginalCreateHostInference(").length, 2);
  r = run(env, "restore");
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.readFileSync(host).equals(original), "restore must be byte-exact");
});
