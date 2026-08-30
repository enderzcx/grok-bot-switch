import test from "node:test";
import assert from "node:assert/strict";
import daemon from "../src/control-daemon.cjs";

const box = { execDaemonUrl: "https://daemon.example/native/", execDaemonAuthToken: "PRIVATE_BEARER", networkToken: "PRIVATE_NETWORK" };
function vint(n) { n = BigInt(n); const b = []; do { b.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n); return Buffer.from(b); }
function bytes(n, value) { const b = Buffer.from(value); return Buffer.concat([vint(n * 8 + 2), vint(b.length), b]); }
function frame(data, flags = 0) { const b = Buffer.from(data), h = Buffer.alloc(5); h[0] = flags; h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); }
const output = (n, text) => frame(bytes(n, bytes(1, text)));
const exit = (code = 0) => frame(bytes(3, code ? Buffer.concat([Buffer.from([8]), vint(BigInt.asUintN(64, BigInt(code)))]) : Buffer.alloc(0)));
const end = (value = {}) => frame(JSON.stringify(value), 2);
function reply(body, streaming = false, headers = {}) { return new Response(body, { headers: { "content-type": streaming ? "application/connect+proto" : "application/proto", ...headers } }); }
function mock(t, fn) { t.mock.method(globalThis, "fetch", fn); }
async function rejects(promise, code) { await assert.rejects(promise, (e) => { assert.equal(e.code, code); assert.equal(e.message, `Control daemon: ${code}`); assert.ok(!String(e.stack).includes("PRIVATE_")); return true; }); }

test("binary read sends native authentication and exact path field", async (t) => {
  mock(t, async (url, options) => {
    assert.equal(String(url), "https://daemon.example/native/agent.v1.ControlService/ReadTextFile");
    assert.deepEqual(options.body, bytes(1, "/fixed/host-main.cjs"));
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer PRIVATE_BEARER");
    assert.equal(options.headers["x-anyrun-network-token"], "PRIVATE_NETWORK");
    assert.equal(options.headers["Content-Type"], "application/proto");
    assert.equal(options.headers["Connect-Protocol-Version"], "1");
    return reply(bytes(1, "hello 世界"));
  });
  assert.equal(await daemon.readTextFile(box, "/fixed/host-main.cjs"), "hello 世界");
});
test("bounded native write keeps content in protobuf, not command arguments or receipt", async (t) => {
  mock(t, async (url, options) => {
    assert.equal(String(url), "https://daemon.example/native/agent.v1.ControlService/WriteTextFile");
    assert.equal(options.headers["Accept-Encoding"], "identity");
    assert.deepEqual(options.body, Buffer.concat([bytes(1, "/fixed/private/request.json"), bytes(2, "PRIVATE_KEY")]));
    return reply(null);
  });
  assert.deepEqual(await daemon.writeTextFile(box, "/fixed/private/request.json", "PRIVATE_KEY"), { written: true });
  await rejects(daemon.writeTextFile(box, "/fixed", "x".repeat(1024 * 1024 + 1)), "invalid-input");
  globalThis.fetch = async () => reply(bytes(1, "PRIVATE_KEY"));
  await rejects(daemon.writeTextFile(box, "/fixed", "value"), "invalid-protobuf");
});
test("exec encodes argv/cwd and requires exit plus successful terminal", async (t) => {
  mock(t, async (url, options) => {
    assert.equal(String(url), "https://daemon.example/native/agent.v1.ControlService/Exec");
    assert.equal(options.headers["Content-Type"], "application/connect+proto");
    assert.deepEqual(options.body, frame(Buffer.concat([bytes(1, "node"), bytes(2, "/workspace"), bytes(3, "--version")])));
    const stream = Buffer.concat([output(1, "one"), output(2, "warning"), output(1, "二"), exit(7), end({ metadata: { receipt: ["ok"] } })]);
    return reply(new ReadableStream({ start(c) { for (const byte of stream) c.enqueue(Uint8Array.of(byte)); c.close(); } }), true);
  });
  assert.deepEqual(await daemon.exec(box, { command: "node", args: ["--version"], cwd: "/workspace" }), { stdout: "one二", stderr: "warning", exitCode: 7 });
});
test("zero and negative exit codes decode correctly, empty file uses proto default", async (t) => {
  mock(t, async () => reply(Buffer.alloc(0)));
  assert.equal(await daemon.readTextFile(box, "/x"), "");
  for (const code of [0, -1, -2147483648]) {
    globalThis.fetch = async () => reply(Buffer.concat([exit(code), end()]), true);
    assert.equal((await daemon.exec(box, { command: "true" })).exitCode, code);
  }
});
test("invalid native connection, inputs and limits never contact network", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected"); });
  for (const address of ["http://daemon.example", "file:///x", "https://user:password@daemon.example", "https://daemon.example/?token=PRIVATE", "https://daemon.example/#x", "invalid"]) await rejects(daemon.readTextFile({ ...box, execDaemonUrl: address }, "/x"), "invalid-connection");
  await rejects(daemon.readTextFile({ ...box, execDaemonAuthToken: "PRIVATE\r\nX: y" }, "/x"), "invalid-connection");
  await rejects(daemon.exec(box, { command: "" }), "invalid-input");
  await rejects(daemon.readTextFile(box, "/x", { maxBytes: 64 * 1024 * 1024 + 1 }), "invalid-limit");
  await rejects(daemon.exec(box, { command: "true" }, { maxBytes: 8 * 1024 * 1024 + 1 }), "invalid-limit");
  await rejects(daemon.exec(box, { command: "true", args: Array(256).fill("x".repeat(1024)) }), "request-too-large");
  assert.equal(fetch.mock.callCount(), 0);
});
test("network token is optional and errors never echo transport data", async (t) => {
  mock(t, async (_, opts) => { assert.equal(opts.headers["x-anyrun-network-token"], undefined); throw new Error("PRIVATE_BEARER https://private.example"); });
  await rejects(daemon.readTextFile({ ...box, networkToken: undefined }, "/x"), "transport-failed");
});
test("rejects redirects, wrong content type, encodings, oversized advertised body", async (t) => {
  mock(t, async () => new Response("PRIVATE", { status: 302, headers: { location: "https://private.example" } }));
  await rejects(daemon.readTextFile(box, "/x"), "http-failed");
  globalThis.fetch = async () => new Response("PRIVATE");
  await rejects(daemon.readTextFile(box, "/x"), "invalid-content-type");
  globalThis.fetch = async () => reply(Buffer.alloc(0), false, { "content-encoding": "gzip" });
  await rejects(daemon.readTextFile(box, "/x"), "unsupported-encoding");
  globalThis.fetch = async () => reply(Buffer.alloc(0), false, { "content-length": "999999999" });
  await rejects(daemon.readTextFile(box, "/x"), "response-too-large");
});
test("read supports large static source within explicit 64MiB cap", async (t) => {
  const source = "x".repeat(2 * 1024 * 1024);
  mock(t, async () => reply(bytes(1, source)));
  assert.equal((await daemon.readTextFile(box, "/fixed/source", { maxBytes: source.length })).length, source.length);
});
test("wire, output and frame limits are enforced", async (t) => {
  mock(t, async () => reply(bytes(1, "too long")));
  await rejects(daemon.readTextFile(box, "/x", { maxBytes: 2 }), "output-too-large");
  globalThis.fetch = async () => reply(Buffer.alloc(65539));
  await rejects(daemon.readTextFile(box, "/x", { maxBytes: 2 }), "response-too-large");
  globalThis.fetch = async () => reply(Buffer.concat([output(1, "ab"), output(2, "cd"), exit(), end()]), true);
  await rejects(daemon.exec(box, { command: "true" }, { maxBytes: 3 }), "output-too-large");
  globalThis.fetch = async () => reply(Buffer.concat([...Array(4097).fill(output(1, "")), exit(), end()]), true);
  await rejects(daemon.exec(box, { command: "true" }), "invalid-stream");
});
test("truncated, invalid UTF8, duplicate or malformed protobuf rejects", async (t) => {
  mock(t, async () => reply(Buffer.alloc(0)));
  for (const data of [Buffer.from([10, 4, 1]), Buffer.from([10, 1, 255]), Buffer.from([8, 1]), Buffer.concat([bytes(1, "a"), bytes(1, "b")]), Buffer.alloc(11, 128), Buffer.from([0])]) {
    globalThis.fetch = async () => reply(data);
    await rejects(daemon.readTextFile(box, "/x"), "invalid-protobuf");
  }
});
test("stream completion rejects remote errors, truncation and false success", async (t) => {
  mock(t, async () => reply(Buffer.alloc(0), true));
  const cases = [
    [Buffer.concat([exit(), end({ error: { code: "internal", message: "PRIVATE_BEARER https://private.example" } })]), "remote-error"],
    [Buffer.concat([exit(), end(null)]), "invalid-terminal"],
    [Buffer.concat([exit(), frame("not-json", 2)]), "invalid-terminal"],
    [Buffer.concat([exit(), end({ unexpected: true })]), "invalid-terminal"],
    [Buffer.concat([exit(), end({ metadata: { x: "wrong" } })]), "invalid-terminal"],
    [exit(), "incomplete-stream"], [end(), "incomplete-stream"],
    [Buffer.concat([exit(), exit(), end()]), "invalid-stream"],
    [Buffer.concat([exit(), end(), output(1, "late")]), "invalid-stream"],
    [Buffer.from([0, 0]), "invalid-stream"],
    [Buffer.from([0, 0, 0, 0, 99]), "invalid-stream"],
    [frame(Buffer.alloc(0), 1), "invalid-stream"],
    [frame(Buffer.concat([bytes(1, bytes(1, "a")), bytes(2, bytes(1, "b"))])), "invalid-stream"],
  ];
  for (const [data, code] of cases) { globalThis.fetch = async () => reply(data, true); await rejects(daemon.exec(box, { command: "true" }), code); }
});
test("pre-abort and inflight abort are sanitized", async (t) => {
  mock(t, async (_, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("PRIVATE")), { once: true })));
  const before = new AbortController(); before.abort("PRIVATE");
  await rejects(daemon.readTextFile(box, "/x", { signal: before.signal }), "aborted");
  const during = new AbortController();
  const pending = daemon.readTextFile(box, "/x", { signal: during.signal });
  during.abort("PRIVATE");
  await rejects(pending, "aborted");
});
test("deadline covers stalled fetch, not only body reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  mock(t, async (_, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("PRIVATE")), { once: true })));
  const pending = daemon.exec(box, { command: "true" });
  t.mock.timers.tick(30000);
  await rejects(pending, "timeout");
});
test("abort and deadline remain active while response body stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let bodyStarted;
  mock(t, async (_, opts) => reply(new ReadableStream({
    start(controller) {
      opts.signal.addEventListener("abort", () => controller.error(new Error("PRIVATE_NETWORK")), { once: true });
      bodyStarted?.();
    },
  })));
  const during = new AbortController();
  const entered = new Promise((resolve) => { bodyStarted = resolve; });
  const interrupted = daemon.readTextFile(box, "/x", { signal: during.signal });
  await entered;
  during.abort();
  await rejects(interrupted, "aborted");
  const enteredAgain = new Promise((resolve) => { bodyStarted = resolve; });
  const timedOut = daemon.readTextFile(box, "/x");
  await enteredAgain;
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await rejects(timedOut, "timeout");
});
test("overflow cancels response body; invalid streaming UTF8 is rejected", async (t) => {
  let cancelled = false;
  mock(t, async () => reply(new ReadableStream({
    start(c) { c.enqueue(Buffer.alloc(65539)); },
    cancel() { cancelled = true; },
  })));
  await rejects(daemon.readTextFile(box, "/x", { maxBytes: 2 }), "response-too-large");
  assert.equal(cancelled, true);
  globalThis.fetch = async () => reply(Buffer.concat([frame(bytes(1, bytes(1, Buffer.from([255])))), exit(), end()]), true);
  await rejects(daemon.exec(box, { command: "true" }), "invalid-protobuf");
});
