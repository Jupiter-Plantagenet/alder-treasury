// Round 6 (P6) TR-T-CAPACITY on the isolated stack (API 9103, worker 9113, scratch 15543, proxy 18547 -> Anvil 18548).
// Parameterised from tests/round5-ops/capacity.ts. Differences: (1) the wallet sends the 100-item batch at EXACTLY the
// outer eth_estimateGas (the round-5 failure mode) and the app signed a simulated safeTxGas; (2) reconciliation goes
// through the live single writer (worker), measured both as API resync latency and as worker pass time; (3) replay and
// incremental reconciliation measured at >=10,000 and >=100,000 blocks.
// P6_CAP_PART=batch|scale (default: both).
import fs from 'node:fs';import os from 'node:os';import {execFileSync} from 'node:child_process';import * as L from '../round5-ops/o5-lib.ts';import pg from 'pg';import {requestReconcile} from '../../services/treasury-indexer.ts';
import {p6OutputPath} from './p6-output.ts';
import {createMiningControlClient, P6_MINE_CONTROL_TIMEOUT_MS} from './mining-control-p6.ts';
const miningControlClient=createMiningControlClient(L.TRUTH);
const OUT=p6OutputPath('capacity','evidence/round6-perf/capacity');fs.mkdirSync(OUT,{recursive:true});const part=process.env.P6_CAP_PART||'all';const reportPath=`${OUT}/report-${part}.json`;if(process.env.P6_RUN_ID&&fs.existsSync(reportPath))throw new Error('P6_CAPACITY_OUTPUT_ALREADY_EXISTS_USE_NEW_RUN_ID');const R=new L.Report(reportPath);let s:any;
const scaleStart=process.env.P6_SCALE_START||'10000';if(!['10000','100000'].includes(scaleStart))throw new Error('P6_SCALE_START_INVALID');
const pct=(a:number[],q:number)=>{const x=[...a].sort((p,r)=>p-r);return x[Math.min(x.length-1,Math.ceil(q*x.length)-1)];};
const worker=async()=>{const r=await fetch('http://127.0.0.1:9113/status',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('P6_WORKER_STATUS_HTTP_'+r.status);return r.json();};
let ip:any;
const hostGateSamples:any[]=[];
const hostGateWaits:any[]=[];
const miningControlCalls:any[]=[];
let hostGateFailureRecorded=false;
const operatorMemoryOverride=process.env.ALDER_OPERATOR_MEMORY_OVERRIDE==='20261102-user-directed';
const hostGate=()=>{
 const stat=fs.statfsSync('C:/'),freeCBytes=stat.bavail*stat.bsize,availableRamBytes=os.freemem();
 let sample:any={at:new Date().toISOString(),freeCBytes,availableRamBytes};
 try{
  const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object CommittedBytes,CommitLimit,PercentCommittedBytesInUse | ConvertTo-Json -Compress'],{encoding:'utf8',timeout:5000}).trim());
  const used=Number(value.CommittedBytes),limit=Number(value.CommitLimit),percent=Number(value.PercentCommittedBytesInUse);
  if(!Number.isFinite(used)||!Number.isFinite(limit)||!Number.isFinite(percent)||used<0||limit<=0||used>limit||percent<0||percent>100)throw Error('INVALID_COMMIT_COUNTER');
  sample={...sample,commitCounterAvailable:true,commitPercent:percent,commitUsedBytes:used,commitLimitBytes:limit};
 }catch(error:any){sample={...sample,commitCounterAvailable:false,commitPercent:null,commitUsedBytes:null,commitLimitBytes:null,counterError:error?.code==='ETIMEDOUT'?'HOST_COUNTER_TIMEOUT':'HOST_COUNTER_UNAVAILABLE'};}
 hostGateSamples.push(sample);
 const originalMemoryGatePasses=availableRamBytes>=6*1024**3&&sample.commitCounterAvailable&&sample.commitPercent<85&&sample.commitUsedBytes/sample.commitLimitBytes<.85;
 // The user-directed Alder host restriction is drive-specific (never use D:).
 // Keep C: space, RAM, and commit as telemetry; only the exact authorized
 // wrapper override bypasses their historical admission gate. Product SLOs
 // and mining/rebuild deadlines remain unchanged.
 return {...sample,operatorMemoryOverride,originalMemoryGatePasses,passes:operatorMemoryOverride||(freeCBytes>=50_000_000_000&&originalMemoryGatePasses)};
};
const requireHostGate=async(stage:string)=>{const started=performance.now(),deadline=started+170000;let failedPolls=0;for(;;){const sample=hostGate();if(sample.passes){hostGateWaits.push({stage,waitMs:Math.round(performance.now()-started),failedPolls,admittedAt:sample.at});return;}failedPolls++;const remaining=deadline-performance.now();if(remaining<=0){hostGateFailureRecorded=true;R.bad('TR-T-CAPACITY','resource gate did not recover within the bounded wait; no additional mining or rebuild request was issued, preserving the current advanced chain state',{stage,waitLimitMs:180000,waitedMs:Math.round(performance.now()-started),failedPolls,lastGate:sample});throw Error('P6_HOST_RESOURCE_GATE_WAIT_EXPIRED_'+stage);}await L.sleep(Math.min(10000,remaining));}};
const passSamples=async(n:number)=>{const out:any[]=[];let last=(await worker()).passes;const deadline=performance.now()+120000;while(out.length<n){if(performance.now()>=deadline)throw Error('P6_WORKER_PASS_SAMPLE_DEADLINE');await L.sleep(700);const w=await worker();if(w.passes!==last&&w.last_result){last=w.passes;out.push({ms:w.last_result.ms,phase1_ms:w.last_result.phase1_ms,phase2_ms:w.last_result.phase2_ms,rpc_headers:w.last_result.window?.rpc_headers,head:w.last_result.head});}}return out;};
const P6_RESYNC_REQUEST_TIMEOUT_MS=8000,P6_RESYNC_SAMPLE_DEADLINE_MS=120000;
  // Mining is setup/control work, not a measured capacity SLO. Give one non-retried
  // Anvil control request a bounded 60s transport window; leave global HTTP timeout,
  // retry behavior for all other requests, and all measured capacity deadlines intact.
  const P6_MINE_RPC_CHUNK=100n,P6_MAX_MINE_RPC_CHUNK=2000n;
const resyncLat=async(n:number)=>{const lat:number[]=[];const deadline=performance.now()+P6_RESYNC_SAMPLE_DEADLINE_MS;for(let i=0;i<n;i++){const remaining=deadline-performance.now();if(remaining<=0)throw Error('P6_RESYNC_SAMPLE_DEADLINE');const a=performance.now();let r:any;try{r=await s.O.post('/resync',{}, {timeoutMs:Math.max(1,Math.min(P6_RESYNC_REQUEST_TIMEOUT_MS,remaining))});}catch(error:any){throw Error(error?.name==='TimeoutError'||error?.name==='AbortError'?'P6_RESYNC_REQUEST_TIMEOUT':'P6_RESYNC_REQUEST_FAILED');}lat.push(performance.now()-a);if(r.status!==200)throw Error('P6_RESYNC_HTTP_'+r.status);}return lat;};
try {
s=await L.sessions(10000,30000);
ip=new pg.Pool({connectionString:'postgresql://alder_indexer@127.0.0.1:15543/alder',max:2});
if(part!=='scale'){
 const pr=(await L.q('SELECT max(revision)::int r FROM review_policy_revisions WHERE workspace_id=$1',[L.WS]))[0].r;
 const t0=Date.now();const ps:any[]=[];for(let i=0;i<100;i++){const c=await L.contact(s,`P6-CAP C${i}`);ps.push(await L.payable(s,c.id,`P6-CAP-P${i}`,String(10_000_000+i*1_000_003),true,pr));}
 const tSetup=Date.now();await L.allowanceCycle(s,ps.map(p=>p.id));const f0=performance.now();const f=await L.freeze(s,ps.map(p=>p.id));const freezeMs=performance.now()-f0;await L.signAll(s,f.operationId);const p=await L.prepare(s,f.operationId);L.expect(p.status===200,'prepare',p.body);
 const est=await L.chain.estimateGas({account:L.owners[0].address,to:p.body.to,data:p.body.data});const cold=await Promise.all(f.manifest.items.map((i:any)=>L.chain.getTransactionCount({address:i.recipient}).then(async n=>n===0&&(await L.balance(i.recipient))===0n)));
 const h=await L.walletFor(L.owners[0]).sendTransaction({to:p.body.to,data:p.body.data,value:0n,gas:est,nonce:Number(p.body.senderNonce)});await s.O.post(`/attempts/${p.body.attemptId}/observations`,{kind:'wallet_hash',transactionHash:h});
 const rc=await L.chain.waitForTransactionReceipt({hash:h});const blk=await L.chain.getBlock({blockNumber:rc.blockNumber});const ES='0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e',EF='0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23';
 const innerOk=rc.logs.some((l:any)=>l.address.toLowerCase()===L.d.safe.toLowerCase()&&l.topics[0]===ES),innerFail=rc.logs.some((l:any)=>l.address.toLowerCase()===L.d.safe.toLowerCase()&&l.topics[0]===EF);
 await R.check('TR-T-CAPACITY','100-item batch, worst path (100 cold recipients): the app signs safeTxGas from simulation + margin; a wallet sending at EXACTLY the outer eth_estimateGas gets ExecutionSuccess (round-5 failure: ExecutionFailure at the 1.2M estimate); used gas <= 15M of a 30M block',async()=>{
  L.expect(rc.status==='success'&&innerOk&&!innerFail&&rc.gasUsed<=15_000_000n&&blk.gasLimit>=30_000_000n&&cold.every(Boolean),'batch',{status:rc.status,innerOk,innerFail,est:String(est),used:String(rc.gasUsed)});
  return {innerExecutionSuccess:innerOk,innerExecutionFailure:innerFail,outerGasLimit:String(est),walletOuterEstimate:String(est),gasUsed:String(rc.gasUsed),perItemGas:Number(rc.gasUsed)/100,blockGasLimit:String(blk.gasLimit),shareOf30M:Number(rc.gasUsed)/30e6,signedSafeTxGas:f.manifest.message.safeTxGas,gasEvidence:f.manifest.gasEvidence,coldRecipients:cold.filter(Boolean).length,freezeMs,setupSeconds:(tSetup-t0)/1000};});
 await L.mine(12);const t1=performance.now();let st='';while(performance.now()-t1<30000){st=await L.opState(f.operationId);if(st==='verified')break;await L.sleep(200);}const firstVerifyMs=performance.now()-t1;
 const lat=await resyncLat(20);const passes=await passSamples(10);const head=await L.chain.getBlockNumber();
 await R.check('TR-T-CAPACITY',`reconciliation after the eligible checkpoint: all 100 items verified by the worker; p95 of 20 API resyncs and of 10 worker passes <= 5 s at head ${head}`,async()=>{const set=await L.settlementsFor(f.operationId);
  L.expect(st==='verified'&&set.length===100&&pct(lat,.95)<=5000&&pct(passes.map(x=>x.ms),.95)<=5000,'recon',{st,n:set.length,p95:pct(lat,.95)});
  return {opState:st,verifiedSettlements:set.length,eligibleToVerifiedMs:firstVerifyMs,resyncMs:{n:lat.length,p50:pct(lat,.5),p95:pct(lat,.95),max:Math.max(...lat)},workerPass:{n:passes.length,p50:pct(passes.map(x=>x.ms),.5),p95:pct(passes.map(x=>x.ms),.95),rpcHeadersPerPass:passes[0]?.rpc_headers},head:String(head)};});
}
if(part!=='batch'){
  if(scaleStart==='100000'){const currentHead=await L.chain.getBlockNumber();L.expect(currentHead>=100_000n,'resume at 100k requires the preserved chain already at or above 100,000',{head:String(currentHead)});}
  const targets=scaleStart==='100000'?[100_000n]:[10_000n,100_000n];
  for(const target of targets){const before=await L.chain.getBlockNumber();if(before<target){const need=target-before+10n;for(let left=need;left>0n;){const k=left>P6_MINE_RPC_CHUNK?P6_MINE_RPC_CHUNK:left;L.expect(k<=P6_MAX_MINE_RPC_CHUNK,'mine_chunk_max',{k,max:P6_MAX_MINE_RPC_CHUNK});await requireHostGate('mine-'+String(target));const mineBefore=await L.chain.getBlockNumber(),mineStarted=performance.now();let mineError:any=null;try{await (miningControlClient as any).request({method:'anvil_mine',params:['0x'+k.toString(16)]},{retryCount:0});}catch(error:any){mineError=error;}const mineAfter=await L.chain.getBlockNumber();const mineRecord={method:'anvil_mine',blocks:k.toString(),headBefore:mineBefore.toString(),headAfter:mineAfter.toString(),durationMs:Math.round(performance.now()-mineStarted),timeoutMs:P6_MINE_CONTROL_TIMEOUT_MS,retryCount:0,errorCategory:mineError?(mineError?.name==='TimeoutError'||mineError?.name==='AbortError'?'MINING_CONTROL_TIMEOUT':'MINING_CONTROL_ERROR'):null};miningControlCalls.push(mineRecord);if(mineError){throw Error('P6_'+mineRecord.errorCategory+'_HEAD_'+mineRecord.headBefore+'_TO_'+mineRecord.headAfter);}left-=k;}}
  const head=await L.chain.getBlockNumber();const w0=performance.now();let caught:any=null;while(performance.now()-w0<180000){const w=await worker();if(w.last_result&&BigInt(w.last_result.head)>=head){caught=w.last_result;break;}await L.sleep(500);}const catchUpMs=performance.now()-w0;
  const lat=await resyncLat(20);const passes=await passSamples(10);
  await fetch(L.PROXY+'/__o5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rules:[],resetCounts:true})});
  await requireHostGate('rebuild-'+String(target));const b0=performance.now();let rb:any;try{rb=await requestReconcile(ip,'rebuild','operator:p6-capacity-'+target,120000);}catch(error:any){if(error?.message!=='INDEXER_REQUEST_TIMEOUT'||!error?.request_id)throw error;
   const requestId=String(error.request_id),terminalDeadline=performance.now()+120000;let durable:any=null;
   while(performance.now()<terminalDeadline){durable=(await ip.query('SELECT done_at,result,error,claimed_fence FROM indexer_requests WHERE id=$1',[requestId])).rows[0]||null;if(durable?.done_at)break;await L.sleep(1000);}
   const outcome=durable?.done_at?(durable.error?{state:'failed',error:durable.error,claimedFence:durable.claimed_fence,result:durable.result}:{state:'completed',claimedFence:durable.claimed_fence,result:durable.result}):{state:'pending',claimedFence:durable?.claimed_fence??null};
   R.bad('TR-T-CAPACITY','operator rebuild exceeded its 120s gate; durable request was observed to a terminal outcome or explicitly left pending; no further capacity mutation may proceed',{requestId,requestTimeoutMs:120000,terminalObservationDeadlineMs:120000,outcome});
   throw Object.assign(Error('P6_REBUILD_TIMEOUT_DURABLE_'+outcome.state),{p6RebuildRequestId:requestId,p6RebuildOutcome:outcome});
  }const rebuildMs=performance.now()-b0;const rpc=await L.proxyStats();
  await R.check('TR-T-CAPACITY',`at ${head} blocks: incremental reconciliation p95 <= 5 s (API resync and worker pass, nothing new), and full deployment replay (operator rebuild, genesis..head) <= 120 s`,async()=>{
   L.expect(caught&&pct(lat,.95)<=5000&&pct(passes.map(x=>x.ms),.95)<=5000&&rebuildMs<=120000&&rb.paused===false,'scale',{p95:pct(lat,.95),rebuildMs,rb});
   return {blocks:String(head),newBlocksCatchUp:{ms:catchUpMs,pass:caught&&{ms:caught.ms,window:caught.window}},resyncMs:{n:lat.length,p50:pct(lat,.5),p95:pct(lat,.95),max:Math.max(...lat)},workerPass:{n:passes.length,p50:pct(passes.map(x=>x.ms),.5),p95:pct(passes.map(x=>x.ms),.95),rpcHeadersPerPass:pct(passes.map(x=>x.rpc_headers),.5)},operatorRebuild:{ms:rebuildMs,phase1_ms:rb.phase1_ms,phase2_ms:rb.phase2_ms,rpcHeaders:rb.window?.rpc_headers,rpcRequestsTotal:rpc.total,paused:rb.paused,operations:rb.operations}};});}
}
} catch(error:any) {
 if(!hostGateFailureRecorded&&!R.steps.some((x:any)=>x.result==='FAIL'&&x.clause.startsWith('operator rebuild exceeded its 120s gate')))await R.check('TR-T-CAPACITY','capacity runner completed without a transport/worker deadline failure',async()=>{throw error;});
} finally {
 if(ip)try{await ip.end();}catch(error:any){R.bad('TR-T-CAPACITY','capacity sample pool closed cleanly',{error:String(error?.message||error).slice(0,500)});}
 try{await L.db.end();}catch(error:any){R.bad('TR-T-CAPACITY','O5 sample pool closed cleanly',{error:String(error?.message||error).slice(0,500)});}
 const gates=hostGateSamples.length?{count:hostGateSamples.length,minFreeCBytes:Math.min(...hostGateSamples.map(x=>x.freeCBytes)),minAvailableRamBytes:Math.min(...hostGateSamples.map(x=>x.availableRamBytes)),maxCommitPercent:hostGateSamples.some(x=>x.commitCounterAvailable)?Math.max(...hostGateSamples.filter(x=>x.commitCounterAvailable).map(x=>x.commitPercent)):null,counterFailures:hostGateSamples.filter(x=>!x.commitCounterAvailable).length,waits:hostGateWaits,first:hostGateSamples[0],last:hostGateSamples.at(-1)}:null;R.save({run:'P6-CAPACITY-'+part,scaleStart,operatorMemoryOverride,hostResourceGate:gates,miningControl:{budgetType:'setup/control only; excluded from capacity SLO timing',timeoutMs:P6_MINE_CONTROL_TIMEOUT_MS,retryCount:0,maxBlocksPerRequest:P6_MAX_MINE_RPC_CHUNK.toString(),requestedChunkBlocks:P6_MINE_RPC_CHUNK.toString(),diagnosis:'Earlier non-retried mining requests timed out at 2000, 200, and 100 blocks while sampled host gates passed; those outcomes show the pinned default 10s HTTP timeout is an invalid mining-control budget assumption, not a capacity SLO result.',calls:miningControlCalls}});const fail=R.steps.filter((x:any)=>x.result==='FAIL').length;console.log(JSON.stringify({pass:R.steps.filter((x:any)=>x.result==='PASS').length,fail,hostResourceGate:gates}));process.exitCode=fail?1:0;
}
