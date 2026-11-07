// Read-only integrity checks used before any automatic Alder service start.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {keccak256,toHex,toRlp} from 'viem';

export function sha256File(file){
  const h=crypto.createHash('sha256');
  const fd=fs.openSync(file,'r');
  try{const b=Buffer.allocUnsafe(1024*1024);for(;;){const n=fs.readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n));}}
  finally{fs.closeSync(fd);}
  return h.digest('hex');
}
const qty=(value)=>{const n=BigInt(value);return n===0n?'0x':toHex(n);};
export function headerHash(h){
  if(!h||typeof h!=='object')throw Error('STATE_HEADER_INVALID');
  const fields=[h.parentHash,h.sha3Uncles,h.miner,h.stateRoot,h.transactionsRoot,h.receiptsRoot,h.logsBloom,
    qty(h.difficulty),qty(h.number),qty(h.gasLimit),qty(h.gasUsed),qty(h.timestamp),h.extraData,h.mixHash,h.nonce,
    qty(h.baseFeePerGas),h.withdrawalsRoot];
  if(h.blobGasUsed!==undefined||h.excessBlobGas!==undefined||h.parentBeaconBlockRoot!==undefined){
    fields.push(qty(h.blobGasUsed),qty(h.excessBlobGas));
    if(h.parentBeaconBlockRoot!==undefined)fields.push(h.parentBeaconBlockRoot);
  }
  return keccak256(toRlp(fields));
}
export function validateStateSnapshot(state,policy){
  const e=policy.lineage,failures=[];
  const best=BigInt(state?.best_block_number??-1);
  if(best<BigInt(e.minimumHead))failures.push('STATE_HEAD_BELOW_LINEAGE_FLOOR');
  if(best<BigInt(e.trustedCheckpoint?.head??e.minimumHead))failures.push('STATE_HEAD_BELOW_TRUSTED_CHECKPOINT');
  if(!Array.isArray(state?.blocks))failures.push('STATE_BLOCKS_MISSING');
  const blocks=Array.isArray(state?.blocks)?state.blocks:[];
  const anchor=blocks.filter(b=>BigInt(b?.header?.number??'0x0')===BigInt(e.anchorHeight));
  if(anchor.length!==1)failures.push('STATE_ANCHOR_BLOCK_COUNT');
  const anchorHash=anchor.length===1?headerHash(anchor[0].header):null;
  if(anchorHash!==e.anchorHash)failures.push('STATE_ANCHOR_HASH_MISMATCH');
  const pinnedGenesis=blocks.filter(b=>BigInt(b?.header?.number??'0x0')===0n&&BigInt(b?.header?.timestamp??'0x0')===BigInt(e.genesisTimestamp));
  if(pinnedGenesis.length!==1)failures.push('STATE_PINNED_GENESIS_COUNT');
  const genesisHash=pinnedGenesis.length===1?headerHash(pinnedGenesis[0].header):null;
  if(genesisHash!==e.genesis)failures.push('STATE_GENESIS_HASH_MISMATCH');
  return {pass:failures.length===0,failures,bestHead:String(best),entryCount:blocks.length,anchorHeight:Number(e.anchorHeight),anchorHash,genesisHash,pinnedGenesisEntries:pinnedGenesis.length};
}
export function validateReloadPoints(text,policy){
  const failures=[],e=policy.lineage;
  const rawLines=String(text).split(/\r?\n/).filter(Boolean);
  let records=[];
  try{records=rawLines.map((line)=>JSON.parse(line));}catch{failures.push('RELOAD_POINT_JSONL_INVALID');}
  const migration=e.legacyReloadPrefix;
  if(!migration||records.length<Number(migration.count))failures.push('RELOAD_POINT_LEGACY_PREFIX_MISSING');
  if(migration&&records.length>=Number(migration.count)){
    const prefix=rawLines.slice(0,Number(migration.count)).join('\n')+'\n';
    if(crypto.createHash('sha256').update(prefix,'utf8').digest('hex')!==migration.sha256)failures.push('RELOAD_POINT_LEGACY_PREFIX_CHANGED');
  }
  let previousHeight=-1n,previousNonce=BigInt(e.trustedCheckpoint?.safeNonce??e.minimumSafeNonce);
  for(let i=0;i<records.length;i++){
    const r=records[i];
    try{
      const h=BigInt(r.height);
      if(r.genesis!==e.genesis)failures.push('RELOAD_POINT_GENESIS_MISMATCH');
      if(h<previousHeight)failures.push('RELOAD_POINT_HEIGHT_NONMONOTONIC');
      previousHeight=h;
      if(i>=Number(migration?.count??0)){
        if(r.anchorHeight===undefined||r.anchorHash===undefined||r.safeNonce===undefined)failures.push('RELOAD_POINT_TRUST_FIELDS_MISSING');
        if(Number(r.anchorHeight)!==Number(e.anchorHeight)||r.anchorHash!==e.anchorHash)failures.push('RELOAD_POINT_ANCHOR_MISMATCH');
        const n=BigInt(r.safeNonce);
        if(n<previousNonce)failures.push('RELOAD_POINT_NONCE_NONMONOTONIC');
        previousNonce=n;
      }
    }catch{failures.push('RELOAD_POINT_FIELDS_INVALID');}
  }
  const last=records.at(-1);
  if(!last)failures.push('RELOAD_POINT_MISSING');
  else{
    try{
      if(BigInt(last.height)<BigInt(e.minimumHead))failures.push('RELOAD_POINT_BELOW_LINEAGE_FLOOR');
      if(BigInt(last.height)<BigInt(e.trustedCheckpoint?.head??e.minimumHead))failures.push('RELOAD_POINT_BELOW_TRUSTED_CHECKPOINT');
    }catch{failures.push('RELOAD_POINT_FIELDS_INVALID');}
  }
  const trusted=records.length>Number(migration?.count??0)?last:e.trustedCheckpoint;
  return {pass:failures.length===0,failures,lineCount:rawLines.length,last:last?{genesis:last.genesis,height:String(last.height),source:last.source,anchorHeight:last.anchorHeight??null,anchorHash:last.anchorHash??null,safeNonce:last.safeNonce??null}:null,trusted:{height:String(trusted?.height??trusted?.head),safeNonce:String(trusted?.safeNonce??e.minimumSafeNonce)}};
}
export function validateLineageCheckpoints(checkpointText,reloadText,policy){
  const failures=[],e=policy.lineage,m=e.legacyReloadPrefix;
  const reloadLines=String(reloadText).split(/\r?\n/).filter(Boolean);
  const checkpointLines=checkpointText===null?[]:String(checkpointText).split(/\r?\n/).filter(Boolean);
  if(checkpointLines.length===0){
    if(reloadLines.length!==Number(m?.count))failures.push('LINEAGE_CHECKPOINT_MISSING_AFTER_NEW_RELOAD');
    return {pass:failures.length===0,failures,count:0,trustedHeight:String(e.trustedCheckpoint?.head??e.minimumHead),trustedNonce:String(e.trustedCheckpoint?.safeNonce??e.minimumSafeNonce)};
  }
  let checkpoints=[],reload=[];
  try{checkpoints=checkpointLines.map(JSON.parse);reload=reloadLines.map(JSON.parse);}catch{return {pass:false,failures:['LINEAGE_CHECKPOINT_JSONL_INVALID'],count:checkpointLines.length};}
  const appended=reload.slice(Number(m.count));
  if(checkpoints.length!==appended.length)failures.push('LINEAGE_CHECKPOINT_RELOAD_COUNT_MISMATCH');
  let previousHeight=BigInt(e.trustedCheckpoint?.head??e.minimumHead),previousNonce=BigInt(e.trustedCheckpoint?.safeNonce??e.minimumSafeNonce);
  for(let i=0;i<checkpoints.length;i++){
    const c=checkpoints[i],r=appended[i];
    try{
      const h=BigInt(c.height),n=BigInt(c.safeNonce);
      if(c.genesis!==e.genesis||c.anchorHeight!==Number(e.anchorHeight)||c.anchorHash!==e.anchorHash)failures.push('LINEAGE_CHECKPOINT_IDENTITY_MISMATCH');
      if(h<previousHeight||n<previousNonce)failures.push('LINEAGE_CHECKPOINT_NONMONOTONIC');
      if(!r||String(r.height)!==String(c.height)||r.genesis!==c.genesis||Number(r.anchorHeight)!==Number(c.anchorHeight)||r.anchorHash!==c.anchorHash||String(r.safeNonce)!==String(c.safeNonce))failures.push('LINEAGE_CHECKPOINT_RELOAD_MISMATCH');
      previousHeight=h;previousNonce=n;
    }catch{failures.push('LINEAGE_CHECKPOINT_FIELDS_INVALID');}
  }
  return {pass:failures.length===0,failures,count:checkpoints.length,trustedHeight:String(previousHeight),trustedNonce:String(previousNonce)};
}
export function lineageHistoryDigest(reloadText,checkpointText){
  return crypto.createHash('sha256').update(String(reloadText),'utf8').update('\n--CHECKPOINTS--\n','utf8').update(checkpointText===null?'<ABSENT>':String(checkpointText),'utf8').digest('hex');
}
export function validateHighWater(highWaterText,ownerText,state,reloadText,checkpointText,policy){
  const failures=[],e=policy.lineage,m=policy.lineage.trustedCheckpoint;
  let owner,rows=[];
  if(typeof ownerText!=='string'||ownerText.trim()==='')return {pass:false,failures:['LINEAGE_OWNER_MISSING']};
  try{owner=JSON.parse(String(ownerText));}catch{return {pass:false,failures:['LINEAGE_OWNER_INVALID']};}
  if(owner?.schema!=='alder.watchdog.lineage-owner/v1'||!owner.instanceId)failures.push('LINEAGE_OWNER_IDENTITY_INVALID');
  if(typeof highWaterText!=='string'||highWaterText.trim()==='')return {pass:false,failures:[...failures,'HIGH_WATER_MISSING']};
  try{rows=String(highWaterText).split(/\r?\n/).filter(Boolean).map(JSON.parse);}catch{failures.push('HIGH_WATER_JSONL_INVALID');}
  if(rows.length===0)failures.push('HIGH_WATER_MISSING');
  let prevHeight=BigInt(m?.head??e.minimumHead),prevNonce=BigInt(m?.safeNonce??e.minimumSafeNonce);
  for(const row of rows){
    try{
      const h=BigInt(row.head),n=BigInt(row.safeNonce);
      if(row.schema!=='alder.watchdog.lineage-high-water/v1'||row.instanceId!==owner?.instanceId)failures.push('HIGH_WATER_OWNER_MISMATCH');
      if(row.genesis!==e.genesis||Number(row.anchorHeight)!==Number(e.anchorHeight)||row.anchorHash!==e.anchorHash)failures.push('HIGH_WATER_LINEAGE_MISMATCH');
      if(h<prevHeight||n<prevNonce)failures.push('HIGH_WATER_NONMONOTONIC');
      if(typeof row.headHash!=='string'||!/^0x[0-9a-f]{64}$/i.test(row.headHash)||typeof row.historyDigest!=='string'||!/^([0-9a-f]{64})$/i.test(row.historyDigest))failures.push('HIGH_WATER_FIELDS_INVALID');
      prevHeight=h;prevNonce=n;
    }catch{failures.push('HIGH_WATER_FIELDS_INVALID');}
  }
  const last=rows.at(-1),digest=lineageHistoryDigest(reloadText,checkpointText);
  if(last&&last.historyDigest!==digest)failures.push('HIGH_WATER_HISTORY_DIGEST_MISMATCH');
  const rawLines=String(highWaterText??'').split(/\r?\n/).filter(Boolean),lastReceiptDigest=rawLines.length?crypto.createHash('sha256').update(rawLines.at(-1)+'\n','utf8').digest('hex'):null;
  if(owner?.bootstrapState!=='seeded'||owner?.latestReceiptSha256!==lastReceiptDigest||String(owner?.latestHead)!==String(last?.head)||String(owner?.latestSafeNonce)!==String(last?.safeNonce)||owner?.latestHistoryDigest!==last?.historyDigest)failures.push('HIGH_WATER_OWNER_ANCHOR_MISMATCH');
  const reload=validateReloadPoints(reloadText,policy),checkpoints=validateLineageCheckpoints(checkpointText,reloadText,policy);
  if(!reload.pass||!checkpoints.pass)failures.push('HIGH_WATER_RELOAD_HISTORY_INVALID');
  if(last&&String(last.head)!==String(checkpoints.trustedHeight))failures.push('HIGH_WATER_HEAD_NOT_LATEST_RELOAD');
  if(last&&String(last.safeNonce)!==String(checkpoints.trustedNonce))failures.push('HIGH_WATER_NONCE_NOT_LATEST_RELOAD');
  try{
    const h=BigInt(last.head);if(BigInt(state?.best_block_number??-1)<h)failures.push('STATE_BELOW_HIGH_WATER');
    const candidates=(state?.blocks||[]).filter(b=>BigInt(b?.header?.number??'0x0')===h);
    if(candidates.length!==1||headerHash(candidates[0].header)!==last.headHash)failures.push('STATE_HIGH_WATER_HEADER_MISMATCH');
  }catch{failures.push('HIGH_WATER_STATE_CHECK_INVALID');}
  return {pass:failures.length===0,failures,count:rows.length,trustedHead:String(last?.head??m?.head??e.minimumHead),trustedNonce:String(last?.safeNonce??m?.safeNonce??e.minimumSafeNonce),historyDigest:digest,last:last?{instanceId:last.instanceId,head:String(last.head),headHash:last.headHash,safeNonce:String(last.safeNonce),source:last.source??null}:null};
}
export function validateSourceDelta(root,policy,name,baseSha256,currentSha256){
  const pending=policy.pendingSourceDeltas?.[name];
  const approval=policy.approvedSourceDeltas?.[name];
  if(!approval){
    if(pending&&pending.baseSha256===baseSha256&&pending.candidateSha256===currentSha256)return {pass:false,reason:'SOURCE_DELTA_REVIEW_PENDING',baseSha256,currentSha256,deltaPath:pending.deltaPath??null};
    return {pass:false,reason:'SOURCE_DELTA_APPROVAL_MISSING',baseSha256,currentSha256};
  }
  if(approval.baseSha256!==baseSha256||approval.newSha256!==currentSha256||!approval.receiptPath||!/^([0-9a-f]{64})$/i.test(approval.receiptSha256||''))return {pass:false,reason:'SOURCE_DELTA_POLICY_MISMATCH',baseSha256,currentSha256};
  try{
    const receiptPath=path.resolve(root,approval.receiptPath),relative=path.relative(root,receiptPath);
    if(path.isAbsolute(approval.receiptPath)||relative==='..'||relative.startsWith(`..${path.sep}`))return {pass:false,reason:'SOURCE_DELTA_RECEIPT_OUTSIDE_PRODUCT',baseSha256,currentSha256};
    const st=fs.lstatSync(receiptPath);if(st.isSymbolicLink()||!st.isFile())return {pass:false,reason:'SOURCE_DELTA_RECEIPT_NOT_REGULAR',baseSha256,currentSha256};
    const actualReceiptSha=sha256File(receiptPath);if(actualReceiptSha!==approval.receiptSha256)return {pass:false,reason:'SOURCE_DELTA_RECEIPT_HASH_MISMATCH',baseSha256,currentSha256};
    const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
    const pass=receipt.schema==='alder.independent-source-delta-approval/v1'&&receipt.decision==='APPROVED'&&receipt.path===name&&receipt.baseSha256===baseSha256&&receipt.newSha256===currentSha256&&receipt.reviewedSourceSha256===currentSha256;
    return {pass,reason:pass?null:'SOURCE_DELTA_RECEIPT_CONTENT_MISMATCH',baseSha256,currentSha256,receiptSha256:actualReceiptSha};
  }catch{return {pass:false,reason:'SOURCE_DELTA_RECEIPT_UNAVAILABLE',baseSha256,currentSha256};}
}
export function validateSourcePins(root,policy){
  const mismatches=[],approvedDeltas=[];
  for(const [name,expected] of Object.entries(policy.sourcePins||{})){
    const file=path.isAbsolute(name)?name:path.resolve(root,name);
    try{
      const stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()||!stat.isFile()){mismatches.push({path:name,reason:'NOT_REGULAR_FILE'});continue;}
      const actual=sha256File(file);
      if(actual!==expected){const delta=validateSourceDelta(root,policy,name,expected,actual);if(delta.pass)approvedDeltas.push({path:name,baseSha256:expected,currentSha256:actual,receiptSha256:delta.receiptSha256});else mismatches.push({path:name,reason:delta.reason||'SHA256_MISMATCH',expected,actual,...delta});}
    }catch{mismatches.push({path:name,reason:'MISSING_OR_UNREADABLE'});}
  }
  const review=validateAppReview(root,policy);
  return {pass:mismatches.length===0&&review.pass,mismatches,approvedDeltas,review,pinnedFileCount:Object.keys(policy.sourcePins||{}).length};
}
export function validateAppReview(root,policy){
  const expected=policy.approvedAppReview,failures=[];
  try{
    const reviewPath=path.resolve(root,expected.independentReviewPath);
    const supplyPath=path.resolve(root,expected.supplyEvidencePath);
    const review=JSON.parse(fs.readFileSync(reviewPath,'utf8'));
    const supply=JSON.parse(fs.readFileSync(supplyPath,'utf8'));
    const reviewPins=review.current_source_sha256||{},supplyPins=supply.review_source_pins_verified||{},approvedPins=expected.reviewedSourcePins||{};
    const keyset=(o)=>Object.keys(o).sort();
    const reviewCount=keyset(reviewPins).length,supplyCount=keyset(supplyPins).length,approvedCount=keyset(approvedPins).length;
    if(reviewCount!==expected.reviewedSourcePinCount||supplyCount!==expected.reviewedSourcePinCount||approvedCount!==expected.reviewedSourcePinCount)failures.push('REVIEWED_SOURCE_PIN_COUNT_MISMATCH');
    if(JSON.stringify(keyset(reviewPins))!==JSON.stringify(keyset(supplyPins))||JSON.stringify(keyset(reviewPins))!==JSON.stringify(keyset(approvedPins)))failures.push('REVIEWED_SOURCE_PIN_KEYSET_MISMATCH');
    const mismatches=[],approvedDeltas=[];
    for(const name of keyset(approvedPins)){
      const expectedHash=approvedPins[name];
      const file=path.resolve(root,name),relative=path.relative(root,file);
      if(path.isAbsolute(name)||relative==='..'||relative.startsWith(`..${path.sep}`)){
        mismatches.push({path:name,reason:'REVIEWED_SOURCE_PATH_OUTSIDE_PRODUCT'});
        continue;
      }
      if(reviewPins[name]!==expectedHash||supplyPins[name]!==expectedHash)mismatches.push({path:name,reason:'REVIEW_EVIDENCE_MISMATCH'});
      if(policy.sourcePins?.[name]!==expectedHash)mismatches.push({path:name,reason:'POLICY_REVIEW_PIN_MISMATCH'});
      try{const actual=sha256File(file);if(actual!==expectedHash){const delta=validateSourceDelta(root,policy,name,expectedHash,actual);if(delta.pass)approvedDeltas.push({path:name,baseSha256:expectedHash,currentSha256:actual,receiptSha256:delta.receiptSha256});else mismatches.push({path:name,reason:delta.reason||'LIVE_REVIEWED_SOURCE_MISMATCH',expected:expectedHash,actual,...delta});}}catch{mismatches.push({path:name,reason:'LIVE_REVIEWED_SOURCE_UNAVAILABLE'});}
    }
    const reviewPin=reviewPins[expected.source]??null,supplyPin=supplyPins[expected.source]??null;
    return {pass:failures.length===0&&mismatches.length===0,failures,mismatches,approvedDeltas,reviewPin,supplyPin,reviewCount,supplyCount,approvedCount};
  }catch{return {pass:false,failures:['APP_REVIEW_EVIDENCE_UNAVAILABLE']};}
}
export function validateStateFiles(root,policy){
  const statePath=path.resolve(root,policy.paths.chainState),reloadPath=path.resolve(root,policy.paths.reloadPoints),deploymentPath=path.resolve(root,policy.paths.deployment);
  const failures=[];
  for(const [p,expected] of [[statePath,path.resolve(root,'chain-state/anvil-8547-state.json')],[reloadPath,path.resolve(root,'chain-state/reload-points.jsonl')],[deploymentPath,path.resolve(root,'evidence/app-deployment.json')]])if(p!==expected)failures.push('STATE_PATH_NOT_APPROVED');
  let stateCheck={pass:false,failures:['STATE_FILE_UNAVAILABLE']},reloadCheck={pass:false,failures:['RELOAD_FILE_UNAVAILABLE']},reloadText=null,checkpointText=null;
  try{const s=fs.lstatSync(statePath);if(s.isSymbolicLink()||!s.isFile())throw Error();const state=JSON.parse(fs.readFileSync(statePath,'utf8'));stateCheck=validateStateSnapshot(state,policy);}catch{}
  try{const s=fs.lstatSync(reloadPath);if(s.isSymbolicLink()||!s.isFile())throw Error();reloadText=fs.readFileSync(reloadPath,'utf8');reloadCheck=validateReloadPoints(reloadText,policy);}catch{}
  const cpPath=path.resolve(root,policy.paths.lineageCheckpoints);try{const s=fs.lstatSync(cpPath);if(s.isSymbolicLink()||!s.isFile())throw Error();checkpointText=fs.readFileSync(cpPath,'utf8');}catch{}
  const checkpointCheck=reloadText===null?{pass:false,failures:['RELOAD_POINT_UNAVAILABLE']}:validateLineageCheckpoints(checkpointText,reloadText,policy);
  const trustedHeight=BigInt(checkpointCheck.trustedHeight??reloadCheck.trusted?.height??policy.lineage.minimumHead);
  if(stateCheck.pass&&reloadCheck.pass&&BigInt(stateCheck.bestHead)<trustedHeight)stateCheck={...stateCheck,pass:false,failures:[...stateCheck.failures,'STATE_BELOW_LAST_TRUSTED_RELOAD_POINT']};
  let deploymentMatches=false;
  try{deploymentMatches=JSON.parse(fs.readFileSync(deploymentPath,'utf8')).genesis===policy.lineage.genesis;}catch{}
  if(!deploymentMatches)failures.push('DEPLOYMENT_GENESIS_MISMATCH');
  return {pass:failures.length===0&&stateCheck.pass&&reloadCheck.pass&&checkpointCheck.pass,failures:[...failures,...stateCheck.failures,...reloadCheck.failures,...checkpointCheck.failures],statePath,reloadPath,checkpointPath:cpPath,state:stateCheck,reload:reloadCheck,checkpoints:checkpointCheck,deploymentMatches};
}
export function validateLineageFiles(root,policy){
  const base=validateStateFiles(root,policy),highPath=path.resolve(root,policy.paths.lineageHighWater),ownerPath=path.resolve(root,policy.paths.lineageOwner);
  let highText=null,ownerText=null,stateObj=null,reloadText=null,checkpointText=null;
  try{const st=fs.lstatSync(highPath);if(st.isSymbolicLink()||!st.isFile())throw Error();highText=fs.readFileSync(highPath,'utf8');}catch{}
  try{const st=fs.lstatSync(ownerPath);if(st.isSymbolicLink()||!st.isFile())throw Error();ownerText=fs.readFileSync(ownerPath,'utf8');}catch{}
  try{stateObj=JSON.parse(fs.readFileSync(base.statePath,'utf8'));reloadText=fs.readFileSync(base.reloadPath,'utf8');checkpointText=fs.existsSync(base.checkpointPath)?fs.readFileSync(base.checkpointPath,'utf8'):null;}catch{}
  const highWater=stateObj&&reloadText!==null?validateHighWater(highText,ownerText,stateObj,reloadText,checkpointText,policy):{pass:false,failures:['LINEAGE_INPUT_UNAVAILABLE']};
  return {...base,pass:base.pass&&highWater.pass,failures:[...base.failures,...highWater.failures],highWaterPath:highPath,lineageOwnerPath:ownerPath,highWater};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const root=process.cwd(),policyPath=path.join(root,'ops/alder-watchdog-policy.json');
  let policy;
  try{policy=JSON.parse(fs.readFileSync(policyPath,'utf8'));}catch{console.log(JSON.stringify({pass:false,failures:['WATCHDOG_POLICY_UNAVAILABLE']}));process.exit(2);}
  const action=process.argv[2]||'all';let result;
  if(action==='source')result=validateSourcePins(root,policy);
  else if(action==='state')result=validateStateFiles(root,policy);
  else if(action==='lineage')result=validateLineageFiles(root,policy);
  else if(action==='all')result={source:validateSourcePins(root,policy),state:validateLineageFiles(root,policy)};
  else{console.log(JSON.stringify({pass:false,failures:['ACTION_INVALID']}));process.exit(2);}
  console.log(JSON.stringify(result));
  const pass=action==='all'?result.source.pass&&result.state.pass:result.pass;
  if(!pass)process.exitCode=2;
}
