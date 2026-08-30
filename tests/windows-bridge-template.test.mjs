// Execute the appended template against synthetic native globals only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = process.env.GROK_SWITCH_BRIDGE_TEMPLATE_PATH || path.join(root, "desktop", "windows_028_bridge.cjs");
const source = fs.readFileSync(sourcePath, "utf8");
const mockModule = `module.exports = {
  startBridge: options => __test.startBridge(options),
  probeExecutor: (...args) => __test.probeExecutor(...args),
};`;
assert.equal([...source.matchAll(/^\s*__BRIDGE_MODULE__\s*$/gm)].length, 1, "exactly one module insertion point is required");
const executable = source.replace(/^\s*__BRIDGE_MODULE__\s*$/m, mockModule);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

async function harness(options = {}) {
  const calls = { connect: [], host: [], ensure: [], probe: [], writes: [], start: 0, closed: 0 };
  const state = {
    epoch: 7, scope: "private-account-scope", team: "private-team-id", revoked: false,
    settled: { kind: "logged-in", authId: "private-auth-id" },
    status: { kind: "logged-in", authId: "private-auth-id", accessToken: "private-access-token" },
    hostResult: { available: true, connected: true },
    executorResult: { available: true, reachable: true, protocol: "synthetic" },
    box: { privateToken: "private-executor-token" },
  };
  let callbacks;
  class Connector {
    async connect(...args) {
      calls.connect.push({ receiver: this, args });
      if (this.failure) throw this.failure;
      return this.result;
    }
  }
  const originalConnect = Connector.prototype.connect;
  const auth = {
    get authOperationEpoch() { return state.epoch; },
    get credentialUseRevoked() { return state.revoked; },
    isCurrentAuthOperation: epoch => epoch === state.epoch,
    getStatus: async () => state.status,
  };
  const listeners = new Map();
  const context = vm.createContext({
    process: { platform: options.platform ?? "win32", argv: options.argv ?? ["Grok Bot.exe", "--grok-bot-switch-home=C:\\synthetic=home"] },
    require(name) {
      if (name === "node:path") return path.win32;
      if (name === "node:fs") return { writeFileSync: (...args) => calls.writes.push(args) };
      throw new Error(`Unexpected module request: ${name}`);
    },
    pe: { app: {
      getVersion: () => options.version ?? "0.28.0",
      whenReady: async () => undefined,
      on: (event, callback) => listeners.set(event, callback),
    } },
    pRt: Connector,
    jr: async () => auth,
    _A: { whenIdle: async () => state.settled },
    p3e: { whenIdle: async () => undefined, snapshot: () => ({ selectedTeamId: state.team }) },
    Et: { getActiveAccountScope: () => state.scope },
    Ii: { getHostStatus: async options => {
      calls.host.push(options);
      return state.hostGate ? state.hostGate.promise : state.hostResult;
    } },
    FDt: false,
    fetch: () => { throw new Error("Real fetch is forbidden in this test"); },
    __test: {
      async startBridge(value) {
        calls.start += 1;
        if (options.startFailure) throw options.startFailure;
        callbacks = value;
        return { close: async () => { calls.closed += 1; } };
      },
      async probeExecutor(...args) {
        calls.probe.push(args);
        return state.probeGate ? state.probeGate.promise : state.executorResult;
      },
    },
  });
  vm.runInContext(executable, context, { filename: sourcePath, timeout: 1000 });
  await tick();
  function connector(result = "connected") {
    const instance = new Connector();
    instance.result = result;
    instance.client = { ensureSandBox: async options => {
      calls.ensure.push({ instance, options });
      return state.ensureGate ? state.ensureGate.promise : state.box;
    } };
    return instance;
  }
  return { calls, state, context, callbacks, connector, Connector, originalConnect, listeners };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("Synthetic dispatch did not reach the expected stage");
}

test("only Windows 0.28.0 with an explicit absolute home opts in", async t => {
  for (const options of [
    { platform: "darwin" }, { platform: "linux" }, { version: "0.28.1" }, { version: "0.27.0" },
    { argv: ["Grok Bot.exe"] }, { argv: ["Grok Bot.exe", "--grok-bot-switch-home="] },
    { argv: ["Grok Bot.exe", "--grok-bot-switch-home=relative\\home"] },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const h = await harness(options);
      assert.equal(h.calls.start, 0);
      assert.equal(h.Connector.prototype.connect, h.originalConnect);
      assert.equal(h.listeners.size, 0);
    });
  }
  const h = await harness();
  assert.equal(h.calls.start, 1);
  assert.equal(h.callbacks.home, "C:\\synthetic=home");
  assert.equal(h.callbacks.clientVersion, "0.28.0");
});

test("connect wrapper preserves receiver, arguments, return identity and native error identity", async () => {
  const h = await harness();
  const result = { nativeResult: true };
  const instance = h.connector(result);
  const argument = { synthetic: true };
  assert.equal(await instance.connect(argument, 42), result);
  assert.equal(h.calls.connect[0].receiver, instance);
  assert.deepEqual(h.calls.connect[0].args, [argument, 42]);
  const failed = h.connector();
  const nativeError = new Error("synthetic native failure");
  failed.failure = nativeError;
  await assert.rejects(failed.connect(), error => error === nativeError);
  await h.callbacks.getExecutorStatus();
  assert.equal(h.calls.ensure[0].instance, instance, "failed connect must not replace the working connector");
});

test("executor is unavailable before connection and never dispatches ensure or probe", async () => {
  const h = await harness();
  assert.deepEqual(plain(await h.callbacks.getExecutorStatus()), {
    available: false, reachable: false, reason: "connector-not-ready",
  });
  assert.equal(h.calls.ensure.length, 0);
  assert.equal(h.calls.probe.length, 0);
});

test("account readiness rejects without host, ensure or probe dispatch", async t => {
  const cases = {
    settledLoggedOut: h => { h.state.settled = { kind: "logged-out" }; },
    statusLoggedOut: h => { h.state.status = { kind: "logged-out" }; },
    authMismatch: h => { h.state.status.authId = "different-auth"; },
    missingScope: h => { h.state.scope = null; },
    revoked: h => { h.state.revoked = true; },
    switching: h => { h.context.FDt = true; },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, async () => {
      const h = await harness();
      await h.connector().connect();
      change(h);
      await assert.rejects(h.callbacks.getHostStatus(), /ACCOUNT_NOT_READY/);
      await assert.rejects(h.callbacks.getExecutorStatus(), /ACCOUNT_NOT_READY/);
      assert.equal(h.calls.host.length + h.calls.ensure.length + h.calls.probe.length, 0);
    });
  }
});

test("epoch, scope, team, revocation and switching fence every asynchronous result", async t => {
  const changes = {
    epoch: h => { h.state.epoch += 1; },
    scope: h => { h.state.scope = "replacement-scope"; },
    team: h => { h.state.team = "replacement-team"; },
    revoked: h => { h.state.revoked = true; },
    switching: h => { h.context.FDt = true; },
  };
  for (const stage of ["host", "ensure", "probe"]) {
    for (const [name, change] of Object.entries(changes)) {
      await t.test(`${stage}/${name}`, async () => {
        const h = await harness();
        await h.connector().connect();
        const gate = deferred();
        h.state[`${stage}Gate`] = gate;
        const pending = stage === "host" ? h.callbacks.getHostStatus() : h.callbacks.getExecutorStatus();
        const rejected = assert.rejects(pending, /ACCOUNT_CHANGED/);
        await waitFor(() => h.calls[stage].length === 1);
        change(h);
        gate.resolve(stage === "ensure" ? h.state.box : { stale: true });
        await rejected;
        if (stage === "ensure") assert.equal(h.calls.probe.length, 0, "stale sandbox must never be probed");
      });
    }
  }
});

test("pre-aborted signals suppress host, ensure and probe dispatch", async () => {
  const h = await harness();
  await h.connector().connect();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(h.callbacks.getHostStatus(abort.signal), /ACCOUNT_CHANGED/);
  await assert.rejects(h.callbacks.getExecutorStatus(abort.signal), /ACCOUNT_CHANGED/);
  assert.equal(h.calls.host.length + h.calls.ensure.length + h.calls.probe.length, 0);
});

test("abort during ensure suppresses probe; abort during host or probe suppresses stale status", async t => {
  for (const stage of ["host", "ensure", "probe"]) {
    await t.test(stage, async () => {
      const h = await harness();
      await h.connector().connect();
      const gate = deferred();
      h.state[`${stage}Gate`] = gate;
      const abort = new AbortController();
      const pending = stage === "host" ? h.callbacks.getHostStatus(abort.signal) : h.callbacks.getExecutorStatus(abort.signal);
      const rejected = assert.rejects(pending, /ACCOUNT_CHANGED/);
      await waitFor(() => h.calls[stage].length === 1);
      abort.abort();
      gate.resolve(stage === "ensure" ? h.state.box : { stale: true });
      await rejected;
      if (stage === "ensure") assert.equal(h.calls.probe.length, 0);
      if (stage === "probe") assert.equal(h.calls.probe[0][2], abort.signal);
    });
  }
});

test("bridge status adds no private account, scope, team, auth or sandbox credentials", async () => {
  const h = await harness();
  await h.connector().connect();
  const statuses = [await h.callbacks.getHostStatus(), await h.callbacks.getExecutorStatus()];
  assert.deepEqual(plain(statuses), [h.state.hostResult, h.state.executorResult]);
  const serialized = JSON.stringify(statuses);
  for (const sensitive of [h.state.scope, h.state.team, h.state.status.authId,
    h.state.status.accessToken, h.state.box.privateToken]) assert.equal(serialized.includes(sensitive), false);
  assert.deepEqual(plain(h.calls.host[0]), { includeManagedCapabilities: false });
  assert.equal(h.calls.probe[0][0], h.state.box);
  assert.equal(h.calls.probe[0][1], h.context.fetch);
  assert.deepEqual(plain(h.calls.ensure[0].options), {});
});

test("startup failure writes only a generic credential-free diagnostic and quit closes bridge", async () => {
  const failed = await harness({ startFailure: new Error("private-access-token private-account-scope") });
  assert.equal(failed.calls.writes.length, 1);
  assert.equal(failed.calls.writes[0][1], '{"error":"bridge-start-failed"}');
  assert.equal(failed.calls.writes[0][2].mode, 0o600);
  const h = await harness();
  h.listeners.get("before-quit")();
  await tick();
  assert.equal(h.calls.closed, 1);
});
