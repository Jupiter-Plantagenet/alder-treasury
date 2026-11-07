// Validate live lineage against immutable offline state and private watchdog high-water receipts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {headerHash,lineageHistoryDigest,validateLineageFiles} from './alder-watchdog-guard.mjs';

const root=process.cwd();
const policy=JSON.parse(fs.readFileSync(path.join(root,'ops/alder-watchdog-policy.json'),'utf8'));
const deployment=JSON.parse(fs.readFileSync(path.join(root,'evidence/app-deployment.json'),'utf8'));
const lineage=policy.lineage;
const reloadPath=path.join(root,policy.paths.reloadPoints);
const checkpointPath=path.join(root,policy.paths.lineageCheckpoints);
const highWaterPath=path.join(root,policy.paths.lineageHighWater);
const ownerPath=path.join(root,policy.paths.lineageOwner);
if(path.resolve(reloadPath)!==path.resolve(root,'chain-state/reload-points.jsonl')||path.resolve(checkpointPath)!==path.resolve(root,'chain-state/watchdog-lineage-checkpoints.jsonl')||path.resolve(highWaterPath)!==path.resolve(root,'.local/alder-watchdog/lineage-high-water.jsonl')||path.resolve(ownerPath)!==path.resolve(root,'.local/alder-watchdog/lineage-owner.json'))throw Error('LINEAGE_PATH_NOT_APPROVED');
const preflight=validateLineageFiles(root,policy);
if(!preflight.pass){console.log(JSON.stringify({pass:false,failures:preflight.failures}));process.exit(2);}
if(deployment.genesis!==lineage.genesis){console.log(JSON.stringify({pass:false,failures:['DEPLOYMENT_GENESIS_MISMATCH']}));process.exit(2);}
const trustedHead=BigInt(preflight.highWater.trustedHead),trustedNonce=BigInt(preflight.highWater.trustedNonce);

const call=async(method,params=[])=>{
  const response=await fetch('http://127.0.0.1:8547',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('CHAIN_IDENTITY_HTTP_'+response.status);
  const json=await response.json();if(json.error)throw Error('CHAIN_IDENTITY_RPC_'+method);return json.result;
};
const [chainId,genesisBlock,headRaw,anchor,nonceRaw]=await Promise.all([
  call('eth_chainId'),call('eth_getBlockByNumber',['0x0',false]),call('eth_blockNumber'),
  call('eth_getBlockByNumber',[`0x${BigInt(lineage.anchorHeight).toString(16)}`,false]),
  call('eth_call',[{to:policy.safeAddress,data:'0xaffed0e0'},'latest'])
]);
const head=BigInt(headRaw),nonce=BigInt(nonceRaw),latestBlock=await call('eth_getBlockByNumber',[headRaw,false]);
const failures=[];
if(chainId!==policy.chainId)failures.push('CHAIN_ID_MISMATCH');
if(!genesisBlock||genesisBlock.hash!==lineage.genesis||genesisBlock.hash!==deployment.genesis)failures.push('GENESIS_MISMATCH');
if(!latestBlock||BigInt(latestBlock.number)!==head)failures.push('LATEST_HEAD_HEADER_UNAVAILABLE');
if(head<BigInt(lineage.minimumHead))failures.push('HEAD_BELOW_LINEAGE_FLOOR');
if(head<trustedHead)failures.push('HEAD_BELOW_LAST_PRIVATE_HIGH_WATER');
if(!anchor||anchor.hash!==lineage.anchorHash)failures.push('RELOAD_ANCHOR_HASH_MISMATCH');
if(nonce<BigInt(lineage.minimumSafeNonce))failures.push('SAFE_NONCE_BELOW_LINEAGE_FLOOR');
if(nonce<trustedNonce)failures.push('SAFE_NONCE_BELOW_LAST_PRIVATE_HIGH_WATER');
if(failures.length){console.log(JSON.stringify({pass:false,failures,chainId,head:String(head),genesis:genesisBlock?.hash??null,anchorHash:anchor?.hash??null,safeNonce:String(nonce),trustedHead:String(trustedHead),trustedNonce:String(trustedNonce)}));process.exit(2);}

// An accepted reload must also be durably present in the offline snapshot before its private receipt advances.
const statePath=path.join(root,policy.paths.chainState);let stateAtHead=false;
for(let i=0;i<30;i++){
  try{
    const st=fs.lstatSync(statePath);if(st.isSymbolicLink()||!st.isFile())throw Error();
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const entry=(state.blocks||[]).filter(b=>BigInt(b?.header?.number??'0x0')===head);
    if(BigInt(state.best_block_number)>=head&&entry.length===1&&headerHash(entry[0].header)===latestBlock?.hash){stateAtHead=true;break;}
  }catch{}
  await new Promise(r=>setTimeout(r,500));
}
if(!stateAtHead){console.log(JSON.stringify({pass:false,failures:['HIGH_WATER_HEAD_NOT_DURABLE_IN_OFFLINE_STATE'],head:String(head),trustedHead:String(trustedHead)}));process.exit(2);}

const point={genesis:genesisBlock.hash,height:String(head),at:new Date().toISOString(),source:'chain-start',anchorHeight:Number(lineage.anchorHeight),anchorHash:anchor.hash,safeNonce:String(nonce)};
const encoded=JSON.stringify(point)+'\n';
// Append reload, secondary checkpoint, then private high-water receipt. Any partial sequence is a fail-closed mismatch.
fs.appendFileSync(reloadPath,encoded,{encoding:'utf8',flag:'a'});
fs.appendFileSync(checkpointPath,encoded,{encoding:'utf8',flag:'a'});
const reloadText=fs.readFileSync(reloadPath,'utf8'),checkpointText=fs.readFileSync(checkpointPath,'utf8');
const owner=JSON.parse(fs.readFileSync(ownerPath,'utf8'));
const receipt={schema:'alder.watchdog.lineage-high-water/v1',instanceId:owner.instanceId,source:'validated-chain-start',acceptedAtUtc:new Date().toISOString(),genesis:genesisBlock.hash,anchorHeight:Number(lineage.anchorHeight),anchorHash:anchor.hash,head:String(head),headHash:latestBlock?.hash??null,safeNonce:String(nonce),historyDigest:lineageHistoryDigest(reloadText,checkpointText)};
const receiptLine=JSON.stringify(receipt)+'\n';
const appendDurable=(file,content)=>{const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())throw Error('HIGH_WATER_PATH_NOT_REGULAR');const fd=fs.openSync(file,'a');try{fs.writeSync(fd,content,null,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
appendDurable(highWaterPath,receiptLine);
const receiptDigest=crypto.createHash('sha256').update(receiptLine,'utf8').digest('hex');
owner.bootstrapState='seeded';owner.latestReceiptSha256=receiptDigest;owner.latestHead=receipt.head;owner.latestSafeNonce=receipt.safeNonce;owner.latestHistoryDigest=receipt.historyDigest;owner.latestAcceptedAtUtc=receipt.acceptedAtUtc;
const ownerText=JSON.stringify(owner,null,2)+'\n';
const ownerBackup=path.join(path.dirname(ownerPath),`lineage-owner-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.previous.json`);
fs.copyFileSync(ownerPath,ownerBackup,fs.constants.COPYFILE_EXCL);
const ownerTemp=ownerPath+'.pending-'+crypto.randomBytes(8).toString('hex');
const fd=fs.openSync(ownerTemp,'wx');try{fs.writeSync(fd,ownerText,null,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
fs.renameSync(ownerTemp,ownerPath);
console.log(JSON.stringify({pass:true,chainId,head:String(head),genesis:genesisBlock.hash,anchorHeight:lineage.anchorHeight,anchorHash:anchor.hash,safeNonce:String(nonce),trustedHead:String(trustedHead),trustedNonce:String(trustedNonce),reloadPointAppended:true,checkpointAppended:true,privateHighWaterAppended:true,historyDigest:receipt.historyDigest}));
