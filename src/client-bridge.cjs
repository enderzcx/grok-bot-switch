"use strict";
// Runs inside the explicitly adapted Windows Grok Bot main process.
// Existing account credentials stay in its native client; never serialized here.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const controlDaemon = require("./control-daemon.cjs");
const { createHostBridge } = require("./host-bridge.cjs");

function protectDiscovery(home, file) {
  if (process.platform !== "win32") return;
  // Windows may assign Administrators as default owner even when the inherited
  // DACL is private. Explicitly use the same owner-only descriptor as our home.
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const script = "$ErrorActionPreference='Stop'; " +
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "$acl=Get-Acl -LiteralPath " + literal(home) + "; " +
    "if($acl.Owner -ne $sid.Translate([Security.Principal.NTAccount]).Value){throw 'unsafe-owner'}; " +
    "if(@($acl.Access).Count -eq 0){throw 'unsafe-acl'}; " +
    "foreach($rule in $acl.Access){if($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'unsafe-acl'}}; " +
    "$acl.SetOwner($sid); Set-Acl -LiteralPath " + literal(file) + " -AclObject $acl";
  require("node:child_process").execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 8000, windowsHide: true, stdio: "ignore" });
}

const MARKER = "grok-bot-switch-client-bridge-v1";
function safeVersion(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._+-]{1,100}$/.test(value) ? value : null;
}
async function deadline(operation, ms = 6000) {
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function probeExecutor(box, fetchImpl = fetch, signal) {
  if (!box || !box.execDaemonUrl || !box.execDaemonAuthToken) {
    return { available: false, reachable: false, reason: "not-provided" };
  }
  try {
    const base = new URL(box.execDaemonUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.hash || base.search)
      return { available: true, reachable: false, reason: "unsupported-address" };
    const headers = {
      "Content-Type": "application/proto", "Connect-Protocol-Version": "1",
      "Connect-Timeout-Ms": "5000", "Authorization": "Bearer " + box.execDaemonAuthToken,
    };
    if (box.networkToken) headers["x-anyrun-network-token"] = box.networkToken;
    const response = await fetchImpl(base.href.replace(/\/$/, "") + "/agent.v1.ControlService/Ping", {
      method: "POST", headers, body: Buffer.alloc(0), redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });
    // PingResponse is an empty protobuf message. Require exact empty response.
    const reader = response.body?.getReader();
    let bytes = 0;
    if (reader) {
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 0) break; } }
      finally { await reader.cancel().catch(() => {}); }
    }
    const protocolMatches = response.status === 200 && bytes === 0 &&
      response.headers.get("content-type")?.split(";")[0].trim() === "application/proto";
    return { available: true, reachable: protocolMatches,
      httpStatus: response.status, reason: protocolMatches ? null : "ping-rejected" };
  } catch (_) { return { available: true, reachable: false, reason: "ping-failed" }; }
}

async function startBridge({ home, clientVersion, getHostStatus, getExecutorStatus = () => ({ available: false, reachable: false }), getDiagnostics, readHostBundle, getClientDiagnostics = () => [], bootstrapHost, runHostOperation, getNativeState }) {
  if (!path.isAbsolute(home)) throw new Error("bridge home must be absolute");
  const info = fs.lstatSync(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe bridge home");
  if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("unsafe bridge permissions");
  // Installer creates this home with the platform owner-only ACL before launch.
  const enabled = JSON.parse(fs.readFileSync(path.join(home, "bridge-enabled.json"), "utf8"));
  if (enabled.schemaVersion !== 1 || !["probe", "native-switch"].includes(enabled.mode)) throw new Error("bridge not enabled");
  const token = crypto.randomBytes(32).toString("hex");
  const instance = crypto.randomUUID();
  const discovery = path.join(home, "client-bridge.json");
  let inFlight = false;
  const pending = new Set();
  const bounded = (operation, ms) => deadline(signal => {
    const work = Promise.resolve().then(() => operation(signal));
    pending.add(work);
    work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }, ms);
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(body)); };
    if (req.headers.origin || req.headers.host !== "127.0.0.1:" + server.address().port)
      return send(403, { error: "forbidden" });
    const authorization = req.headers.authorization || "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!/^[a-f0-9]{64}$/.test(presented) || !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(token)))
      return send(403, { error: "forbidden" });
    const readRoute = req.method === "GET" && ["/v1/status", "/v1/inspect", "/v1/host-bundle"].includes(req.url);
    const writeRoute = req.method === "POST" && enabled.mode === "native-switch" && ["/v1/bootstrap", "/v1/operation"].includes(req.url);
    if (!readRoute && !writeRoute) return send(404, { error: "not-found" });
    if (inFlight) return send(409, { error: "busy" });
    inFlight = true;
    try {
      if (writeRoute) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) return send(413, { error: "request-too-large" });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (_) { return send(400, {error:"invalid-request"}); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, {error:"invalid-request"});
        if (req.url === "/v1/bootstrap" && bootstrapHost) return send(200, await bounded(bootstrapHost, 30000));
        if (req.url === "/v1/operation" && runHostOperation) return send(200, await bounded(signal => runHostOperation(body, signal), 30000));
        return send(404, {error:"not-found"});
      }
      if (req.url === "/v1/inspect") {
        if (!getDiagnostics) return send(404, { error: "not-found" });
        return send(200, await bounded(getDiagnostics, 30000));
      }
      if (req.url === "/v1/host-bundle") {
        if (!readHostBundle) return send(404, { error: "not-found" });
        const bundle = await bounded(readHostBundle, 30000);
        if (typeof bundle !== "string" || Buffer.byteLength(bundle) > 64 * 1024 * 1024) throw new Error("invalid-bundle");
        return send(200, { sha256: crypto.createHash("sha256").update(bundle).digest("hex"), bundle });
      }
      let status;
      try { status = await bounded(getHostStatus); } catch (_) { status = null; }
      const fields = status && typeof status === "object" ? Object.keys(status).filter(k => /^[a-zA-Z0-9_]{1,80}$/.test(k)).slice(0, 64) : [];
      const runtime = enabled.mode === "native-switch" && getNativeState ? await bounded(getNativeState, 30000) : null;
      send(200, { service: MARKER, schemaVersion: 1, instance, clientVersion: safeVersion(clientVersion),
        mode: enabled.mode,
        clientConnected: true, hostReachable: status !== null,
        hostBusy: typeof status?.isBusy === "boolean" ? status.isBusy : null,
        renderer: getClientDiagnostics(),
        hostVersion: safeVersion(status?.version || status?.currentVersion || status?.hostVersion),
        hostStatusFields: fields, executor: status === null ? { available: false, reachable: false, reason: "host-not-ready" } : await bounded(getExecutorStatus), runtime,
        providerSwitchReady: runtime?.providerSwitchReady === true });
    } catch (error) {
      const code = error?.name === "ControlDaemonError" && /^[a-z-]{1,40}$/.test(error.code) ? error.code : null;
      send(503, { error: "probe-failed", code });
    }
    finally {
      // Native auth RPCs may not implement cancellation; never pile up calls.
      Promise.allSettled([...pending]).then(() => { inFlight = false; });
    }
  });
  server.requestTimeout = 8000;
  server.headersTimeout = 8000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const temp = discovery + "." + instance + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, instance, mode: enabled.mode, pid: process.pid, port: server.address().port, token, clientVersion: safeVersion(clientVersion), executable: process.execPath }), { flag: "wx", mode: 0o600 });
    protectDiscovery(home, temp);
    fs.renameSync(temp, discovery);
  } catch (error) { server.close(); try { fs.unlinkSync(temp); } catch (_) {} throw error; }
  return {
    async close() {
      try { const saved = JSON.parse(fs.readFileSync(discovery, "utf8")); if (saved.instance === instance) fs.unlinkSync(discovery); } catch (_) {}
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { startBridge, probeExecutor, safeVersion, controlDaemon, createHostBridge };
