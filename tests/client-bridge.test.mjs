import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import bridge from "../src/client-bridge.cjs";

test("bridge only exposes sanitized status to its paired local client", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "grok-bridge-"));
  await writeFile(path.join(home, "bridge-enabled.json"), JSON.stringify({ schemaVersion: 1, mode: "probe" }));
  const server = await bridge.startBridge({ home, clientVersion: "0.28.0", getHostStatus: () => ({ version: "v1", secret: "SENTINEL_CREDENTIAL", nested: { token: "SENTINEL" } }) });
  try {
    const manifest = JSON.parse(await readFile(path.join(home, "client-bridge.json")));
    const url = `http://127.0.0.1:${manifest.port}`;
    assert.equal((await fetch(url + "/v1/status")).status, 403);
    const headers = { Authorization: "Bearer " + manifest.token };
    assert.equal((await fetch(url + "/v1/status", { headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(url + "/v1/apply", { method: "POST", headers })).status, 404);
    const result = await (await fetch(url + "/v1/status", { headers })).json();
    assert.equal(result.hostReachable, true);
    assert.equal(result.providerSwitchReady, false);
    assert.equal(result.clientVersion, "0.28.0");
    assert.ok(!JSON.stringify(result).includes("SENTINEL"));
  } finally { await server.close(); await rm(home, { recursive: true }); }
});
test("executor ping keeps auth in request, refuses redirects and does not return secrets", async () => {
  let called;
  const result = await bridge.probeExecutor({ execDaemonUrl: "https://executor.example", execDaemonAuthToken: "secret", networkToken: "network-secret" }, async (url, options) => { called = { url, options }; return new Response(null, { headers: { "content-type": "application/proto" } }); });
  assert.equal(called.url, "https://executor.example/agent.v1.ControlService/Ping");
  assert.equal(called.options.redirect, "error");
  assert.equal(called.options.headers["x-anyrun-network-token"], "network-secret");
  assert.equal(result.reachable, true);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test('native readback failure does not claim ready or disconnect the desktop', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'grok-bridge-'));
  await writeFile(path.join(home, 'bridge-enabled.json'), JSON.stringify({schemaVersion:1,mode:'native-switch'}));
  const server = await bridge.startBridge({home,clientVersion:'0.28.0',getHostStatus:()=>({isBusy:false}),getNativeState:()=>{throw new Error('SENTINEL_PRIVATE');}});
  try {
    const manifest = JSON.parse(await readFile(path.join(home,'client-bridge.json')));
    const response = await fetch(`http://127.0.0.1:${manifest.port}/v1/status`, {headers:{Authorization:'Bearer '+manifest.token}});
    assert.equal(response.status,200);
    const result = await response.json();
    assert.equal(result.clientConnected,true);
    assert.equal(result.providerSwitchReady,false);
    assert.equal(result.runtime.ok,false);
    assert.ok(!JSON.stringify(result).includes('SENTINEL'));
  } finally { await server.close(); await rm(home,{recursive:true}); }
});
test("an empty proxy response is not an executor receipt", async () => {
  const box = { execDaemonUrl: "https://executor.example", execDaemonAuthToken: "secret" };
  for (const response of [new Response(null), new Response(null, { status: 204 }), new Response("x", { headers: { "content-type": "application/proto" } })]) {
    assert.equal((await bridge.probeExecutor(box, async () => response)).reachable, false);
  }
});
test("missing or insecure executors are not contacted", async () => {
  const no = () => { throw new Error("must not fetch"); };
  assert.equal((await bridge.probeExecutor({}, no)).available, false);
  assert.equal((await bridge.probeExecutor({ execDaemonUrl: "http://executor.example", execDaemonAuthToken: "secret" }, no)).reason, "unsupported-address");
});
