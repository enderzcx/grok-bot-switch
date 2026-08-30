import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createHostBridge} from '../src/host-bridge.cjs';

function fixture() {
  const raw=Buffer.from(JSON.stringify({schemaVersion:1,files:{'ops/native_runner.py':{sha256:'a'.repeat(64),content:'eA=='}}}));
  const packageManifest={sha256:createHash('sha256').update(raw).digest('hex'),payload:deflateSync(raw).toString('base64'),files:{'ops/native_runner.py':'a'.repeat(64)}};
  const scripts=[],writes=[];
  const daemon={
    exec:async (_box,command)=>{
      assert.equal(command.command,'node');
      assert.equal(command.args[0],'-e');
      new vm.Script(command.args[1]);
      scripts.push(command.args[1]);
      const reply=scripts.length%2===1?{directory:'/workspace/grok-home/product-requests/request-Ab1234'}:{ok:true,packageSha256:packageManifest.sha256};
      return {exitCode:0,stderr:'',stdout:JSON.stringify(reply)};
    },
    writeTextFile:async (_box,path,content)=>{writes.push({path,content});return {written:true};},
  };
  return {packageManifest,daemon,scripts,writes,bridge:createHostBridge({packageManifest,daemon})};
}
test('bootstrap only provisions its hash-bound code package through native file RPC',async()=>{
  const {bridge,scripts,writes,packageManifest}=fixture();
  const result=await bridge.bootstrap({}, {fence(){},signal:undefined});
  assert.equal(result.packageSha256,packageManifest.sha256);
  assert.equal(writes.length,1);
  assert.equal(writes[0].content,packageManifest.payload);
  assert.ok(writes[0].path.endsWith('/package.txt'));
  assert.ok(!scripts.some(s=>s.includes(packageManifest.payload)));
});
test('supplier credential never enters exec arguments and operations stay allowlisted',async()=>{
  const {bridge,scripts,writes}=fixture();
  await bridge.operation({}, {action:'begin',profile:{id:'custom'},secret:'SENTINEL_SUPPLIER_CREDENTIAL'}, {fence(){}});
  assert.equal(JSON.parse(writes[0].content).secret,'SENTINEL_SUPPLIER_CREDENTIAL');
  assert.ok(scripts.every(s=>!s.includes('SENTINEL_SUPPLIER_CREDENTIAL')));
  await assert.rejects(bridge.operation({}, {action:'exec',command:'anything'}, {fence(){}}),/unsupported-native-operation/);
});
test('account fence failure prevents the next file or exec operation',async()=>{
  const {bridge,scripts,writes}=fixture();
  let n=0;
  await assert.rejects(bridge.operation({}, {action:'begin',secret:'SENTINEL'}, {fence(){if(++n===3)throw Error('ACCOUNT_CHANGED');}}),/ACCOUNT_CHANGED/);
  assert.equal(scripts.length,1);
  assert.equal(writes.length,0);
});
test('a spoofed request-directory receipt cannot redirect writes',async()=>{
  const {packageManifest,daemon,writes}=fixture();
  daemon.exec=async()=>({exitCode:0,stderr:'',stdout:'{"directory":"/tmp/foreign"}'});
  const bridge=createHostBridge({packageManifest,daemon});
  await assert.rejects(bridge.operation({}, {action:'inspect'}, {fence(){}}),/invalid-request-directory/);
  assert.equal(writes.length,0);
});
