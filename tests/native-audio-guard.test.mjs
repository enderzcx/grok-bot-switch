import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sessionSource = fs.readFileSync(new URL("../src/provider-direct-session.cjs", import.meta.url), "utf8");
// Test the patcher's actual replacement, not a manually reproduced guard seam.
// Import with -B is read-only and does not generate a Python cache artifact.
const audioSource = JSON.parse(execFileSync("python3", ["-B", "-c", "import runpy,json; p=runpy.run_path('ops/patch_grok_host_provider_switcher.py'); print(json.dumps(p['PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO']))"], { cwd: root, encoding: "utf8" }));
const CONFIG = {
  schemaVersion: 1, enabled: true, mode: "external-only", nativeFallback: false,
  fallbackPolicy: "never", profileId: "custom-openai", protocol: "openai-chat",
  model: "test-model", baseUrl: "http://127.0.0.1:18779", endpointPath: "/chat/completions",
  generation: 1, profileDigest: "a".repeat(64),
};
const UNSUPPORTED = "Native audio transcription is unsupported in external-only mode";
function harness(initialConfig) {
  let config = initialConfig;
  const calls = { reads: 0, client: 0, dispatch: 0, deadline: 0 };
  const nativeRequests = [];
  const nativeError = new Error("original-native-error");
  let throwNative = false;
  const context = {
    URL, Uint8Array,
    require(name) {
      assert.equal(name, "node:fs");
      return { readFileSync(path) {
        assert.equal(path, "/workspace/grok-home/config/external.json");
        calls.reads++;
        if (config === null) { const e = new Error("missing"); e.code = "ENOENT"; throw e; }
        return config;
      } };
    },
    AiService: { typeName: "sentinel-AiService" },
    TranscribeAudioRequest: class { constructor(data) { Object.assign(this, data); } },
    transcribeDeadline: { run(fn) { calls.deadline++; return fn(undefined); } },
    toWhisperLanguageHint: (tag) => tag.split("-")[0],
    stripMimeParameters: (value) => value.split(";")[0].trim(),
  };
  vm.createContext(context);
  vm.runInContext(sessionSource + "\n" + audioSource, context);
  const original = { createSession() { return "native-session"; } };
  const auth = { getAccessToken() {}, getTeamId() {}, getMachineId() {} };
  const transcribe = context.createSandTranscribeAudio(auth, undefined, () => {
    calls.client++;
    return { async transcribeAudio(request) {
      calls.dispatch++;
      nativeRequests.push(request);
      if (throwNative) throw nativeError;
      return { text: "native result", transcriptionTimeMs: 42n };
    } };
  });
  return { calls, original, nativeRequests, nativeError, transcribe,
    setConfig(value) { config = value; },
    rejectNative() { throwNative = true; },
    activate() { return context.wrapHostInferenceWithProviderSwitcher(original); },
  };
}
const request = { audio: new Uint8Array([1, 2]), mimeType: "audio/webm; codecs=opus", language: "en-US" };

test("external audio construction is harmless but dispatch never accesses native client", async () => {
  const h = harness(JSON.stringify(CONFIG));
  assert.deepEqual(h.calls, { reads: 0, client: 0, dispatch: 0, deadline: 0 });
  h.activate();
  await assert.rejects(h.transcribe({ get language() { throw new Error("NATIVE_INPUT_SENTINEL"); } }), { message: UNSUPPORTED });
  assert.deepEqual(h.calls, { reads: 1, client: 0, dispatch: 0, deadline: 0 });
});
test("host-lifetime activation prevents audio and native sessions after config removal or disable", async () => {
  const h = harness(JSON.stringify(CONFIG));
  h.activate();
  for (const config of [null, JSON.stringify({ ...CONFIG, enabled: false }), "{malformed"]) {
    h.setConfig(config);
    await assert.rejects(h.transcribe(request), { message: UNSUPPORTED });
    assert.notEqual(h.activate(), h.original);
  }
  assert.deepEqual(h.calls, { reads: 1, client: 0, dispatch: 0, deadline: 0 });
});
test("audio first-call activation shares the latch with subsequent host inference", async () => {
  const h = harness(JSON.stringify(CONFIG));
  await assert.rejects(h.transcribe(request), { message: UNSUPPORTED });
  h.setConfig(null);
  assert.notEqual(h.activate(), h.original);
  await assert.rejects(h.transcribe(request), { message: UNSUPPORTED });
  assert.equal(h.calls.client, 0);
});
test("inactive native audio preserves fields, cached client, return and error semantics", async () => {
  for (const config of [null, JSON.stringify({ ...CONFIG, enabled: false })]) {
    const h = harness(config);
    assert.equal(h.activate(), h.original);
    assert.deepEqual(JSON.parse(JSON.stringify(await h.transcribe(request))), { text: "native result", transcriptionTimeMs: 42 });
    await h.transcribe(request);
    assert.equal(h.calls.client, 1);
    assert.equal(h.calls.dispatch, 2);
    assert.deepEqual([...h.nativeRequests[0].audio], [1, 2]);
    assert.equal(h.nativeRequests[0].mimeType, "audio/webm");
    assert.equal(h.nativeRequests[0].language, "en");
    h.rejectNative();
    await assert.rejects(h.transcribe(request), (error) => error === h.nativeError);
  }
});
test("malformed config fails at dispatch without client or deadline access, not at construction", async () => {
  for (const config of ["{malformed", "{}", JSON.stringify({ ...CONFIG, nativeFallback: true })]) {
    const h = harness(config);
    assert.equal(h.calls.reads, 0);
    await assert.rejects(h.transcribe(request), /config is invalid/);
    assert.deepEqual(h.calls, { reads: 1, client: 0, dispatch: 0, deadline: 0 });
  }
});
