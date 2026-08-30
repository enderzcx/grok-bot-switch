"use strict";
// Fixed operations only. Native connection credentials never leave this module's
// caller. Supplier keys travel in a private file RPC, never process arguments.
function createHostBridge({ packageManifest, daemon }) {
  const root = "/workspace/grok-home";
  if (!packageManifest || !/^[a-f0-9]{64}$/.test(packageManifest.sha256) ||
      typeof packageManifest.payload !== "string" || packageManifest.payload.length > 1024 * 1024 ||
      !/^[A-Za-z0-9+/=]+$/.test(packageManifest.payload)) throw new Error("invalid-host-package");
  const digest = packageManifest.sha256;
  const packagePath = root + "/product-packages/" + digest;
  const expectedFiles = packageManifest.files;
  if (!expectedFiles || Object.keys(expectedFiles).some(name => !/^(grokctl|ops|src)\/[A-Za-z0-9_./-]+$/.test(name) || name.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(expectedFiles[name])))
    throw new Error("invalid-host-package");
  const prelude = `
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const root=${JSON.stringify(root)},packagePath=${JSON.stringify(packagePath)};
    const expectedFiles=${JSON.stringify(expectedFiles)};
    function privateDir(target) {
      let cursor=target;
      while(cursor!=='/') { if(fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error('unsafe-path'); cursor=path.dirname(cursor); }
      fs.mkdirSync(target,{recursive:true,mode:0o700});
      const stat=fs.statSync(target);
      if(!stat.isDirectory() || (stat.mode&0o077) || stat.uid!==process.getuid()) throw Error('unsafe-directory');
    }
    function verifyPackage() {
      for(const [name,sha] of Object.entries(expectedFiles)) {
        const file=path.join(packagePath,name),stat=fs.lstatSync(file);
        if(!stat.isFile() || stat.isSymbolicLink() || stat.size>1024*1024 || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==sha) throw Error('package-changed');
      }
    }
  `;
  const prepareScript = prelude + `
    const gateway=JSON.parse(fs.readFileSync('/home/box/sand-data/gateway.json','utf8'));
    if(!Number.isInteger(gateway.pid) || gateway.pid<=0) throw Error('invalid-host');
    const owner=fs.statSync('/proc/'+gateway.pid).uid;
    if(owner!==process.getuid()) throw Error('host-user-mismatch');
    privateDir(root); privateDir(root+'/product-requests'); privateDir(root+'/product-packages');
    const directory=fs.mkdtempSync(root+'/product-requests/request-'); fs.chmodSync(directory,0o700);
    console.log(JSON.stringify({directory,uid:process.getuid()}));
  `;
  function safeDirectory(value) {
    if (typeof value !== "string" || !/^\/workspace\/grok-home\/product-requests\/request-[A-Za-z0-9]{6}$/.test(value)) throw new Error("invalid-request-directory");
    return value;
  }
  async function run(box, script, { signal, fence }) {
    fence();
    const result = await daemon.exec(box, { command: "node", args: ["-e", script] }, { signal, maxBytes: 1024 * 1024 });
    fence();
    if (result.exitCode !== 0 || result.stderr) throw new Error("native-operation-failed");
    let value;
    try { value = JSON.parse(result.stdout); } catch (_) { throw new Error("invalid-native-receipt"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-native-receipt");
    return value;
  }
  async function prepare(box, context) {
    return safeDirectory((await run(box, prepareScript, context)).directory);
  }
  async function bootstrap(box, context) {
    const directory = await prepare(box, context);
    const payloadPath = directory + "/package.txt";
    context.fence();
    await daemon.writeTextFile(box, payloadPath, packageManifest.payload, { signal: context.signal });
    context.fence();
    const result = await run(box, prelude + `
      const payloadPath=${JSON.stringify(payloadPath)};
      const encoded=fs.readFileSync(payloadPath,'utf8');
      if(encoded.length>1024*1024) throw Error('package-too-large');
      const raw=require('node:zlib').inflateSync(Buffer.from(encoded,'base64'),{maxOutputLength:4*1024*1024});
      if(crypto.createHash('sha256').update(raw).digest('hex')!==${JSON.stringify(digest)}) throw Error('package-hash');
      const manifest=JSON.parse(raw);
      if(manifest.schemaVersion!==1 || JSON.stringify(Object.keys(manifest.files).sort())!==JSON.stringify(Object.keys(expectedFiles).sort())) throw Error('package-files');
      privateDir(packagePath);
      for(const [name,sha] of Object.entries(expectedFiles)) {
        const file=path.join(packagePath,name),data=Buffer.from(manifest.files[name].content,'base64');
        if(data.length>1024*1024 || crypto.createHash('sha256').update(data).digest('hex')!==sha) throw Error('package-member');
        privateDir(path.dirname(file));
        if(!fs.existsSync(file)) fs.writeFileSync(file,data,{flag:'wx',mode:0o600});
      }
      verifyPackage(); fs.unlinkSync(payloadPath); fs.rmdirSync(${JSON.stringify(directory)});
      console.log(JSON.stringify({ok:true,packageSha256:${JSON.stringify(digest)},providerSwitchReady:false}));
    `, context);
    if (result.packageSha256 !== digest || result.ok !== true) throw new Error("invalid-bootstrap-receipt");
    return result;
  }
  async function operation(box, request, context) {
    if (!request || !["inspect", "setup", "plan", "begin", "progress"].includes(request.action)) throw new Error("unsupported-native-operation");
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error("request-too-large");
    const directory = await prepare(box, context);
    const requestPath = directory + "/request.json";
    context.fence();
    await daemon.writeTextFile(box, requestPath, body, { signal: context.signal, maxBytes: 64 * 1024 });
    context.fence();
    return run(box, prelude + `
      verifyPackage();
      const requestPath=${JSON.stringify(requestPath)};
      fs.chmodSync(requestPath,0o600);
      try {
        const output=require('node:child_process').execFileSync('python3',[path.join(packagePath,'ops/native_runner.py'),'--request',requestPath],
          {timeout:25000,maxBuffer:1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','ignore']});
        process.stdout.write(output);
      } finally {
        try { fs.unlinkSync(requestPath); } catch(_) {}
        try { fs.rmdirSync(${JSON.stringify(directory)}); } catch(_) {}
      }
    `, context);
  }
  return { bootstrap, operation };
}

module.exports = { createHostBridge };
