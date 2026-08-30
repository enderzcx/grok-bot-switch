// Appended only to the hash-pinned Windows 0.28.0 main bundle.
// This file is a template: __BRIDGE_MODULE__ is replaced at build time.
;(() => {
  if (process.platform !== "win32" || pe.app.getVersion() !== "0.28.0") return;
  const path = require("node:path");
  const fs = require("node:fs");
  const installedHome = null; // INSTALL_HOME_PLACEHOLDER
  const home = process.argv.find(arg => arg.startsWith("--grok-bot-switch-home="))?.split("=").slice(1).join("=") || installedHome;
  // Probe builds require an argument; explicit attachment embeds the home.
  if (!home || !path.isAbsolute(home)) return;
  const bridgeModule = { exports: {} };
  ((module, exports, require) => {
    __BRIDGE_MODULE__
  })(bridgeModule, bridgeModule.exports, require);
  const { startBridge, probeExecutor, controlDaemon, createHostBridge } = bridgeModule.exports;
  const hostPackage = null; // HOST_PACKAGE_PLACEHOLDER
  const hostBridge = hostPackage ? createHostBridge({packageManifest:hostPackage,daemon:controlDaemon}) : null;
  let nativeReady = false;
  try { nativeReady = !!hostPackage && JSON.parse(fs.readFileSync(path.join(home,'native-ready.json'),'utf8')).packageSha256 === hostPackage.sha256; } catch(_) {}
  const rendererEvents = new Map();
  pe.app.on('web-contents-created', (_event, contents) => {
    const record = {};
    rendererEvents.set(contents.id, record);
    contents.on('did-finish-load', () => { record.finished = true; });
    contents.on('did-fail-load', (_event, code) => { record.loadErrorCode = code; });
    contents.on('preload-error', (_event, _path, error) => {
      record.preloadError = true;
      record.moduleNotFound = error?.code === 'MODULE_NOT_FOUND';
    });
    contents.on('console-message', (_event, ...args) => {
      const details = typeof args[0] === 'object' ? args[0] : {level:args[0],message:args[1],lineNumber:args[2],sourceId:args[3]};
      if(details.level !== 3 && details.level !== 'error') return;
      const message = String(details.message || '');
      // Capture only diagnostic classifications and source locations, never
      // console payloads (which may contain account data or credentials).
      const kinds = ['ReferenceError','TypeError','SyntaxError','integrity','module','resource','denied','CSP']
        .filter(kind => message.toLowerCase().includes(kind.toLowerCase()));
      let source = null;
      try { source = path.basename(new URL(details.sourceId).pathname); } catch (_) {}
      const item = {kinds, line:details.lineNumber, source};
      record.consoleErrors ||= [];
      if(record.consoleErrors.length < 8) record.consoleErrors.push(item);
    });
    contents.on('destroyed', () => rendererEvents.delete(contents.id));
  });
  let connector, running;
  const originalConnect = pRt.prototype.connect;
  pRt.prototype.connect = async function (...args) {
    const result = await originalConnect.apply(this, args);
    connector = this;
    return result;
  };
  async function guarded(operation, signal) {
    const auth = await jr();
    const settled = await _A?.whenIdle();
    await p3e.whenIdle();
    const status = await auth.getStatus();
    const epoch = auth.authOperationEpoch;
    const scope = Et.getActiveAccountScope();
    const team = p3e.snapshot().selectedTeamId;
    if (settled?.kind !== "logged-in" || status.kind !== "logged-in" ||
        settled.authId !== status.authId || !scope || auth.credentialUseRevoked || FDt)
      throw new Error("ACCOUNT_NOT_READY");
    const fence = () => {
      if (signal?.aborted || !auth.isCurrentAuthOperation(epoch) || auth.credentialUseRevoked || FDt ||
          Et.getActiveAccountScope() !== scope || p3e.snapshot().selectedTeamId !== team)
        throw new Error("ACCOUNT_CHANGED");
    };
    fence();
    const result = await operation(fence);
    fence();
    return result;
  }
  function withBox(operation, signal) {
    return guarded(async fence => {
      if (!connector) throw new Error("CONNECTOR_NOT_READY");
      fence();
      const box = await connector.client.ensureSandBox({});
      fence();
      const result = await operation(box, fence);
      fence();
      return result;
    }, signal);
  }
  // Fixed diagnostic only. There is no user-supplied shell, path, or environment.
  const diagnosticScript = `
    const fs = require('node:fs'), crypto = require('node:crypto');
    const main = '/home/box/sand-host/host-main.cjs';
    const out = {schemaVersion:1, marker:'GROK_SWITCH_EXEC_OK', nodeVersion:process.version,
      hostBundlePresent:fs.existsSync(main), pendingRestart:fs.existsSync('/tmp/sand-supervisor/command.json')};
    if(out.hostBundlePresent) {const stat=fs.lstatSync(main); if(stat.isFile() && !stat.isSymbolicLink() && stat.size<64*1024*1024) {
      out.hostBundleSha256=crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex'); out.hostBundleSize=stat.size;}}
    const statusPath='/tmp/sand-supervisor/status.json';
    if(fs.existsSync(statusPath) && fs.statSync(statusPath).size<65536) {
      const status=JSON.parse(fs.readFileSync(statusPath,'utf8')); out.supervisorFields=Object.keys(status);
      for(const key of ['pid','hostPid','startedAt','status','lastCommandId','lastCommandKind','hostVersion','hostRunning']) {
        if(typeof status[key]==='number' || typeof status[key]==='string') out[key]=status[key];}}
    out.programFiles = fs.readdirSync('/home/box/sand-host').filter(name=>/\\.(cjs|mjs|js|py|sh)$/.test(name));
    out.processPrograms = [];
    const candidates = new Set();
    for(const name of fs.readdirSync('/proc').filter(name=>/^[0-9]+$/.test(name))) {
      try {
        const argv=fs.readFileSync('/proc/'+name+'/cmdline','utf8').split('\\0');
        const scripts=argv.filter(arg=>arg.startsWith('/') && /(?:host-main|supervisor)[^/]*\\.(?:cjs|mjs|js|py|sh)$/.test(arg));
        if(scripts.length) out.processPrograms.push({pid:Number(name),scripts});
        for(const file of scripts) if(/supervisor[^/]*\\.(?:cjs|mjs|js|py|sh)$/.test(file)) candidates.add(file);
      } catch(_) {}
    }
    for(const dir of ['/home/box/sand-host','/usr/local/bin']) {
      try { for(const name of fs.readdirSync(dir)) if(/supervisor[^/]*\\.(?:cjs|mjs|js|py|sh)$/.test(name)) candidates.add(dir+'/'+name); } catch(_) {}
    }
    out.programSources=[];
    for(const file of candidates) {
      const stat=fs.lstatSync(file); if(!stat.isFile() || stat.isSymbolicLink() || stat.size>512*1024) continue;
      const source=fs.readFileSync(file,'utf8'); out.programSources.push({path:file,sha256:crypto.createHash('sha256').update(source).digest('hex'),source});
    }
    console.log(JSON.stringify(out));
  `;
  pe.app.whenReady().then(async () => {
    running = await startBridge({ home, clientVersion: pe.app.getVersion(),
      bootstrapHost: hostBridge ? signal => withBox((box,fence) => hostBridge.bootstrap(box,{signal,fence}),signal) : undefined,
      runHostOperation: hostBridge ? (request,signal) => withBox(async(box,fence) => {
        const result = await hostBridge.operation(box,request,{signal,fence});
        if(result.ok===true || ['pending','verified'].includes(result.status)) {
          nativeReady=true;
          fs.writeFileSync(path.join(home,'native-ready.json'),JSON.stringify({packageSha256:hostPackage.sha256}),{mode:0o600});
        }
        return result;
      },signal) : undefined,
      getNativeState: hostBridge ? signal => nativeReady ? withBox((box,fence) => hostBridge.operation(box,{action:'inspect'},{signal,fence}),signal) : null : undefined,
      getClientDiagnostics: () => (pe.webContents?.getAllWebContents?.() || []).map(contents => ({
        id: contents.id, type: contents.getType(), loading: contents.isLoading(), crashed: contents.isCrashed(),
        fileUrl: contents.getURL().startsWith('file:'), ...rendererEvents.get(contents.id),
      })),
      getHostStatus: signal => guarded(() => Ii.getHostStatus({ includeManagedCapabilities: false }), signal),
      getExecutorStatus: signal => guarded(async fence => {
        if (!connector) return { available: false, reachable: false, reason: "connector-not-ready" };
        // Ask only the current native client; no credential files are accessed.
        fence();
        const box = await connector.client.ensureSandBox({});
        fence();
        const result = await probeExecutor(box, fetch, signal);
        fence();
        return result;
      }, signal),
      getDiagnostics: signal => withBox(async box => {
        const result = await controlDaemon.exec(box, {command:'node',args:['-e',diagnosticScript]}, {signal,maxBytes:1024*1024});
        if(result.exitCode!==0 || result.stderr) throw new Error('DIAGNOSTIC_FAILED');
        const value=JSON.parse(result.stdout);
        if(value.marker!=='GROK_SWITCH_EXEC_OK') throw new Error('INVALID_DIAGNOSTIC');
        return value;
      }, signal),
      readHostBundle: signal => withBox(box => controlDaemon.readTextFile(box, '/home/box/sand-host/host-main.cjs', {signal,maxBytes:64*1024*1024}), signal),
    });
  }).catch(() => {
    // Never serialize exception messages: native errors may contain credentials.
    try { fs.writeFileSync(path.join(home, "bridge-error.json"), '{"error":"bridge-start-failed"}', { mode: 0o600 }); } catch (_) {}
  });
  pe.app.on("before-quit", () => { running?.close().catch(() => {}); });
})();
