"use strict";

// Native EnsureSandBoxResponse stays inside the official process. Callers own
// path/command allowlists; this transport must never become a public exec API.
// Wire contract: .30 host-main.cjs, agent.v1.ControlService (635413),
// ExecRequest/Response (550447), ReadTextFileRequest/Response (550720).
const DEFAULT_BYTES = 1024 * 1024;
const READ_CAP = 64 * DEFAULT_BYTES;
const EXEC_CAP = 8 * DEFAULT_BYTES;
const OVERHEAD = 64 * 1024;
const TIMEOUT_MS = 30000;
const MAX_FRAMES = 4096;
const utf8 = new TextDecoder("utf-8", { fatal: true });

class DaemonError extends Error {
  constructor(code) {
    super(`Control daemon: ${code}`);
    this.name = "ControlDaemonError";
    this.code = code;
  }
}
const fail = (code) => { throw new DaemonError(code); };
function limitFor(value, cap) {
  const limit = value ?? DEFAULT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap) fail("invalid-limit");
  return limit;
}
function string(value, max = OVERHEAD) {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || Buffer.byteLength(value) > max) fail("invalid-input");
  return value;
}
function credential(value, required) {
  if (!required && value === undefined) return "";
  if (typeof value !== "string" || value.length > 16384 || /[^\x21-\x7e]/.test(value) || (required && !value)) fail("invalid-connection");
  return value;
}
function connection(box, method) {
  try {
    if (!box || typeof box.execDaemonUrl !== "string" || box.execDaemonUrl.length > 8192) fail("invalid-connection");
    const url = new URL(box.execDaemonUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("invalid-connection");
    url.pathname = url.pathname.replace(/\/$/, "") + `/agent.v1.ControlService/${method}`;
    const token = credential(box.execDaemonAuthToken, true);
    const network = credential(box.networkToken, false);
    return { url, headers: { Authorization: `Bearer ${token}`, ...(network ? { "x-anyrun-network-token": network } : {}) } };
  } catch { fail("invalid-connection"); }
}
function varint(value) {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
}
function textField(number, value) {
  const data = Buffer.from(string(value));
  return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]);
}
function envelope(data) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}
function readVarint(data, state) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (state.at >= data.length) fail("invalid-protobuf");
    const byte = data[state.at++];
    if (i === 9 && byte > 1) fail("invalid-protobuf");
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) return value;
  }
  fail("invalid-protobuf");
}
function fields(data) {
  const result = [];
  const state = { at: 0 };
  while (state.at < data.length) {
    if (result.length >= MAX_FRAMES) fail("invalid-protobuf");
    const tag = readVarint(data, state);
    const number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (number < 1 || number > 0x1fffffff) fail("invalid-protobuf");
    let value;
    if (wire === 0) value = readVarint(data, state);
    else {
      let size;
      if (wire === 2) {
        const length = readVarint(data, state);
        if (length > BigInt(data.length)) fail("invalid-protobuf");
        size = Number(length);
      } else if (wire === 1) size = 8;
      else if (wire === 5) size = 4;
      else fail("invalid-protobuf");
      if (size > data.length - state.at) fail("invalid-protobuf");
      value = data.subarray(state.at, state.at + size);
      state.at += size;
    }
    result.push({ number, wire, value });
  }
  return result;
}
function uniqueField(data, number, wire, fallback) {
  const matches = fields(data).filter((field) => field.number === number);
  if (matches.length > 1 || (matches.length && matches[0].wire !== wire)) fail("invalid-protobuf");
  return matches.length ? matches[0].value : fallback;
}
function decodeText(data) {
  try { return utf8.decode(data); } catch { fail("invalid-protobuf"); }
}
async function request(box, method, body, streaming, signal, maxBytes) {
  const { url, headers } = connection(box, method);
  if (body.length > OVERHEAD) fail("request-too-large");
  if (signal?.aborted) fail("aborted");
  const controller = new AbortController();
  let reason = "transport-failed", reader;
  const abort = () => { reason = "aborted"; controller.abort(); };
  const timer = setTimeout(() => { reason = "timeout"; controller.abort(); }, TIMEOUT_MS);
  timer.unref?.();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      signal: controller.signal, body,
      headers: { ...headers, "Content-Type": streaming ? "application/connect+proto" : "application/proto", "Connect-Protocol-Version": "1", "Connect-Timeout-Ms": String(TIMEOUT_MS) },
    });
    if (controller.signal.aborted) fail(reason);
    if (response.status !== 200 || response.redirected) fail("http-failed");
    const expected = streaming ? "application/connect+proto" : "application/proto";
    if ((response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== expected) fail("invalid-content-type");
    for (const name of ["content-encoding", "connect-content-encoding"]) {
      const encoding = response.headers.get(name);
      if (encoding && encoding.toLowerCase() !== "identity") fail("unsupported-encoding");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) fail("response-too-large");
    if (!response.body) fail("missing-body");
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (controller.signal.aborted) fail(reason);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) fail("response-too-large");
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    throw error instanceof DaemonError ? error : new DaemonError(reason);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
}

async function readTextFile(box, path, { signal, maxBytes } = {}) {
  const limit = limitFor(maxBytes, READ_CAP);
  const body = await request(box, "ReadTextFile", textField(1, path), false, signal, limit + OVERHEAD);
  const content = uniqueField(body, 1, 2, Buffer.alloc(0));
  if (content.length > limit) fail("output-too-large");
  return decodeText(content);
}
async function exec(box, { command, args = [], cwd } = {}, { signal, maxBytes } = {}) {
  const limit = limitFor(maxBytes, EXEC_CAP);
  if (!Array.isArray(args) || args.length > 256 || !string(command)) fail("invalid-input");
  const parts = [textField(1, command)];
  if (cwd !== undefined) parts.push(textField(2, cwd));
  for (const arg of args) parts.push(textField(3, arg));
  const data = await request(box, "Exec", envelope(Buffer.concat(parts)), true, signal, limit + OVERHEAD);
  let at = 0, frames = 0, terminal = false, exitCode, outputBytes = 0;
  const stdout = [], stderr = [];
  while (at < data.length) {
    if (terminal || ++frames > MAX_FRAMES || data.length - at < 5) fail("invalid-stream");
    const flags = data[at], size = data.readUInt32BE(at + 1);
    at += 5;
    if (size > limit + OVERHEAD || size > data.length - at) fail("invalid-stream");
    const payload = data.subarray(at, at + size);
    at += size;
    if (flags === 2) {
      let end;
      try { end = JSON.parse(decodeText(payload)); } catch { fail("invalid-terminal"); }
      if (!end || typeof end !== "object" || Array.isArray(end)) fail("invalid-terminal");
      if (Object.hasOwn(end, "error")) fail("remote-error");
      if (Object.keys(end).some((key) => key !== "metadata")) fail("invalid-terminal");
      if (end.metadata !== undefined && (!end.metadata || typeof end.metadata !== "object" || Array.isArray(end.metadata) || Object.values(end.metadata).some((v) => !Array.isArray(v) || v.some((s) => typeof s !== "string")))) fail("invalid-terminal");
      terminal = true;
    } else if (flags === 0) {
      if (exitCode !== undefined) fail("invalid-stream");
      const events = fields(payload).filter(({ number }) => number >= 1 && number <= 3);
      if (events.length !== 1 || events[0].wire !== 2) fail("invalid-stream");
      const event = events[0];
      if (event.number === 3) {
        const code = uniqueField(event.value, 1, 0, 0n);
        if (code > 0x7fffffffn && code < 0xffffffff80000000n) fail("invalid-protobuf");
        exitCode = Number(BigInt.asIntN(32, code));
      } else {
        const output = uniqueField(event.value, 1, 2, Buffer.alloc(0));
        outputBytes += output.length;
        if (outputBytes > limit) fail("output-too-large");
        (event.number === 1 ? stdout : stderr).push(decodeText(output));
      }
    } else fail("invalid-stream");
  }
  if (!terminal || exitCode === undefined) fail("incomplete-stream");
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}

module.exports = { readTextFile, exec };
