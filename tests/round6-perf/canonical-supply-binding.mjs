// Read-only canonical lineage/build binding; no wallet, credentials or SQL.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {keccak256,encodeFunctionData,decodeFunctionResult,parseAbi} from 'viem';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const deploymentPath=path.join(root,'evidence/app-deployment.json');
const deploymentBytes=fs.readFileSync(deploymentPath), d=JSON.parse(deploymentBytes);
const out=path.join(root,'.local/release-supply-20261102/canonical-binding-'+new Date().toISOString().replace(/[^0-9TZ]/g,''));
fs.mkdirSync(out,{recursive:false});
const report={schema:'alder.canonical-supply-binding/v1',started:new Date().toISOString(),
  method:'read-only RPC at one canonical block; artifact metadata source hashes and runtime bytes',
  rpc:'http://127.0.0.1:8547',deploymentSha256:sha(deploymentBytes),contracts:{},sourceFiles:{},
  noTransactionsSent:true,noDatabaseChanges:true,limitations:['Does not replace a clean-host rebuild or an independent security review.']};
const assert=(ok,code)=>{if(!ok)throw Error(code);};
let requestId=0;
const allowed=new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_call']);
async function rpc(method,params){
  assert(allowed.has(method),'READ_ONLY_RPC_METHOD_REQUIRED');
  let response;
  try {response=await fetch(report.rpc,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params}),signal:AbortSignal.timeout(10000)});}
  catch {throw Error('RPC_UNAVAILABLE');}
  assert(response.ok,'RPC_HTTP_ERROR');const raw=await response.text();assert(raw.length<=2000000,'RPC_RESPONSE_BOUND');
  const result=JSON.parse(raw);assert(!result.error&&'result'in result,'RPC_METHOD_ERROR');return result.result;
}
const artifacts={safe:'SafeProxy',singleton:'Safe',factory:'SafeProxyFactory',token:'ReferenceToken',executor:'BatchExecutor'};
try{
  const chain=await rpc('eth_chainId',[]),genesis=await rpc('eth_getBlockByNumber',['0x0',false]);
  const block=await rpc('eth_getBlockByNumber',['latest',false]);
  assert(Number(BigInt(chain))===d.chainId&&genesis.hash===d.genesis,'CANONICAL_LINEAGE_MISMATCH');
  assert(d.lineage.id===2&&BigInt(block.number)>=3442n,'CANONICAL_LINEAGE_REGRESSION');
  report.chainId=d.chainId;report.genesis=genesis.hash;report.block={number:String(BigInt(block.number)),hash:block.hash};
  const word=x=>BigInt(x).toString(16).padStart(64,'0');
  const expectedWords={safe:word(d.safe),token:word(d.token),expectedChainId:word(d.chainId)};
  for(const [key,name] of Object.entries(artifacts)){
    const relative=`contracts/out/${name}.sol/${name}.json`, bytes=fs.readFileSync(path.join(root,relative));
    const artifact=JSON.parse(bytes),metadata=typeof artifact.metadata==='string'?JSON.parse(artifact.metadata):artifact.metadata;
    assert(metadata.compiler.version.startsWith('0.8.24+'),'ARTIFACT_COMPILER_MISMATCH');
    assert(metadata.settings.evmVersion==='shanghai'&&metadata.settings.optimizer.enabled===true&&metadata.settings.optimizer.runs===200,'ARTIFACT_BUILD_SETTINGS_MISMATCH');
    for(const [source,entry] of Object.entries(metadata.sources)){
      const candidate=path.resolve(root,source);assert(candidate.startsWith(root+path.sep),'SOURCE_PATH_OUTSIDE_PRODUCT');
      const data=fs.readFileSync(candidate);assert(keccak256(data)===entry.keccak256,'ARTIFACT_SOURCE_HASH_MISMATCH');
      report.sourceFiles[source]=sha(data);
    }
    const runtime=await rpc('eth_getCode',[d[key],block.number]);
    assert(runtime!=='0x'&&keccak256(runtime)===d.codeHashes[key],'DEPLOYMENT_CODE_HASH_MISMATCH');
    const actual=Buffer.from(runtime.slice(2),'hex'),compiled=Buffer.from(artifact.deployedBytecode.object.replace(/^0x/,''),'hex');
    assert(actual.length===compiled.length,'RUNTIME_LENGTH_MISMATCH');
    const masked=Buffer.from(actual),immutableBindings={};
    for(const [id,refs] of Object.entries(artifact.deployedBytecode.immutableReferences||{})){
      assert(key==='executor'&&refs.length>0,'UNEXPECTED_IMMUTABLE_REFERENCES');
      let value;
      for(const ref of refs){
        assert(ref.length===32&&ref.start>=0&&ref.start+32<=actual.length,'IMMUTABLE_REFERENCE_BOUND');
        const current=actual.subarray(ref.start,ref.start+32).toString('hex');
        assert(value===undefined||value===current,'IMMUTABLE_REFERENCE_INCONSISTENT');value=current;
        masked.fill(0,ref.start,ref.start+32);compiled.fill(0,ref.start,ref.start+32);
      }
      const match=Object.entries(expectedWords).filter(([,v])=>v===value);
      assert(match.length===1,'IMMUTABLE_VALUE_MISMATCH');immutableBindings[id]={field:match[0][0],references:refs.length};
    }
    assert(masked.equals(compiled),'RUNTIME_ARTIFACT_MISMATCH');
    if(key==='executor')assert(new Set(Object.values(immutableBindings).map(v=>v.field)).size===3,'IMMUTABLE_BINDING_INCOMPLETE');
    report.contracts[key]={address:d[key],runtimeBytes:actual.length,runtimeKeccak256:keccak256(runtime),
      artifact:relative,artifactSha256:sha(bytes),compiler:metadata.compiler.version,evmVersion:metadata.settings.evmVersion,
      sourceCount:Object.keys(metadata.sources).length,immutableBindings,runtimeMatchesArtifact:true};
  }
  const abi=parseAbi(['function safe() view returns(address)','function token() view returns(address)',
    'function expectedChainId() view returns(uint256)','function nonce() view returns(uint256)',
    'function getOwners() view returns(address[])','function getThreshold() view returns(uint256)',
    'function decimals() view returns(uint8)']);
  async function call(address,name){return decodeFunctionResult({abi,functionName:name,data:await rpc('eth_call',[
    {to:address,data:encodeFunctionData({abi,functionName:name})},block.number])});}
  assert((await call(d.executor,'safe')).toLowerCase()===d.safe.toLowerCase(),'EXECUTOR_SAFE_MISMATCH');
  assert((await call(d.executor,'token')).toLowerCase()===d.token.toLowerCase(),'EXECUTOR_TOKEN_MISMATCH');
  assert(await call(d.executor,'expectedChainId')===BigInt(d.chainId),'EXECUTOR_CHAIN_MISMATCH');
  const owners=(await call(d.safe,'getOwners')).map(s=>s.toLowerCase()).sort();
  assert(JSON.stringify(owners)===JSON.stringify(d.owners.map(s=>s.toLowerCase()).sort()),'SAFE_OWNER_MISMATCH');
  assert(await call(d.safe,'getThreshold')===BigInt(d.threshold),'SAFE_THRESHOLD_MISMATCH');
  assert(await call(d.token,'decimals')===6,'TOKEN_DECIMALS_MISMATCH');
  const slot=await rpc('eth_getStorageAt',[d.safe,'0x0',block.number]);
  assert(slot.slice(-40).toLowerCase()===d.singleton.slice(2).toLowerCase(),'SAFE_SINGLETON_SLOT_MISMATCH');
  report.safeNonce=String(await call(d.safe,'nonce'));report.ownersThresholdAndTokenProfileMatch=true;
  assert((await rpc('eth_getBlockByNumber',[block.number,false])).hash===block.hash,'CANONICAL_BLOCK_CHANGED');
  assert(sha(fs.readFileSync(deploymentPath))===report.deploymentSha256,'DEPLOYMENT_FILE_CHANGED');
  report.status='PASS';
}catch(error){report.status='FAIL';report.errorCode=/^[A-Z_]+$/.test(error.message)?error.message:'UNEXPECTED_BINDING_ERROR';report.errorClass=error.constructor.name;}
report.finished=new Date().toISOString();
report.driverSha256=sha(fs.readFileSync(fileURLToPath(import.meta.url)));
const result=JSON.stringify(report,null,2)+'\n';fs.writeFileSync(path.join(out,'report.json'),result,{flag:'wx'});
console.log(JSON.stringify({status:report.status,errorCode:report.errorCode,report:path.relative(root,path.join(out,'report.json')),sha256:sha(result)}));
process.exitCode=report.status==='PASS'?0:1;
