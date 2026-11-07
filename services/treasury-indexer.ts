import {rpc as liveRpc,localRpcUrl} from '../packages/intent.ts';import {parseAbiItem} from 'viem';import {verify,manifestDigest,PAYOUT_VERIFIER_VERSION} from './verifier.ts';import {verifyAllowance,ALLOWANCE_VERIFIER_VERSION} from './allowance-verifier.ts';
import {verifyInvalidation,INVALIDATION_VERIFIER_VERSION} from './invalidation-verifier.ts';import {batchAbi,safeAbi} from '../packages/intent.ts';
import {LEASE_TTL_SECONDS,withReadPhaseLeaseHeartbeat} from './lease.ts';
import {headerWindow,writeHeaders,type WindowResult} from './header-view.ts';import {validateAttemptTransaction,validateAttemptReceipt} from './attempt-evidence.ts';
import {assertLease,acquireLease,releaseLease,leaseStatus,newHolder,fenced,extendLeaseInTx,type Lease} from './lease.ts';
const success=parseAbiItem('event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)');const failure=parseAbiItem('event ExecutionFailure(bytes32 indexed txHash,uint256 payment)');
export const VERIFIER_VERSIONS:any={payout:PAYOUT_VERIFIER_VERSION,allowance:ALLOWANCE_VERIFIER_VERSION,invalidation:INVALIDATION_VERIFIER_VERSION};
const isLeaseLoss=(e:any)=>e?.code==='LEASE_LOST'||/LEASE_LOST|STALE_FENCE/.test(String(e?.message||e));
const safeReconcileError=(e:any)=>{const code=String(e?.code||'');if(/^[A-Za-z0-9_:-]{2,80}$/.test(code))return `RECONCILE_${code}`;const first=String(e?.message||'').match(/^[A-Z][A-Z0-9_]{2,80}/)?.[0];return first||'RECONCILE_FAILED';};
export function requireSingleSafeScope(operations:any[]){
 const safes=new Set(operations.map(op=>String(op.manifest?.safe||'').toLowerCase()).filter(Boolean));
 if(safes.size>1)throw Object.assign(Error('MULTIPLE_SAFE_ADDRESSES_UNSUPPORTED'),{code:'MULTIPLE_SAFE_ADDRESSES_UNSUPPORTED'});
 return safes.values().next().value||null;
}
export async function terminalizeEphemeralRequestFailure(pool:any,lease:Lease,id:string,kind:'resync'|'rebuild',error:any){
 if(isLeaseLoss(error))return {terminal:false,leaseLost:true,requestPending:true,errorCode:'LEASE_LOST'};
 const safeError=safeReconcileError(error);
 try{
  const result=await fenced(pool,lease,async db=>db.query('UPDATE indexer_requests SET claimed_fence=$2,done_at=now(),error=$3 WHERE kind=$4 AND id<=$1 AND done_at IS NULL RETURNING id::text',[id,lease.fence,safeError,kind]));
  if(!result.rowCount)return {terminal:false,requestPending:true,errorCode:'REQUEST_NOT_TERMINALIZED'};
  return {terminal:true,requestPending:false,errorCode:safeError,terminalizedCount:result.rowCount};
 }catch(markError:any){if(isLeaseLoss(markError))return {terminal:false,leaseLost:true,requestPending:true,errorCode:'LEASE_LOST'};return {terminal:false,requestPending:true,errorCode:'TERMINAL_ERROR_WRITE_FAILED'};}
}
export function requestReconcileFailure(error:any,id:string,terminal:any){
 const out=error instanceof Error?error:Error('INDEXER_RECONCILE_FAILED');
 Object.assign(out,{request_id:id,statusCode:terminal.terminal?500:503,request_terminal:!!terminal.terminal,request_pending:!!terminal.requestPending,request_error:terminal.errorCode});
 return out;
}
// Review H1: a stored `verified` row is reaffirmed ONLY if this indexer role produced it (DB-forced provenance), with the
// current verifier version, bound to exactly this manifest (digest) and this canonical Safe-success transaction/block.
export function trustedPrior(row:any,op:any,log:any){const r=row?.report;return !!(r&&row.produced_by==='alder_indexer'&&r.state==='verified'&&r.verifierVersion===VERIFIER_VERSIONS[op.kind]&&r.manifestDigest===manifestDigest(op.manifest)&&String(r.transactionHash).toLowerCase()===String(log.transactionHash).toLowerCase()&&r.blockHash===log.blockHash);}
// Review M2: chain-evidence classification of operations WITHOUT a canonical Safe success. Distinct durable states;
// none of them is paid, none releases a reservation, none triggers an automatic new attempt.
// Round 6 (review F-M1): an observation is used ONLY after the transaction read from the chain is bound to the attempt
// (sender, sender nonce, Safe, exact signed fields and recomputed SafeTx hash) and its receipt is that transaction's
// receipt in a canonical block; anything else is recorded as `observation_mismatch` evidence and changes nothing.
// Round 6 (review F-L4): "can never execute" (inner failure, executor cancel, consumed Safe nonce) is evaluated BEFORE
// attempt-level states, with the attempt history attached as evidence.
async function classify(c:any,op:any,ctx:any){const m=op.manifest,fail=ctx.failures.get(String(m.safeTxHash).toLowerCase())?.[0];const base={paid:false,safeNonceAtHead:String(ctx.safeNonce),opNonce:String(m.message.nonce)};
 if(fail)return {...base,state:'inner_failed',reason:'canonical Safe ExecutionFailure: inner call failed, Safe nonce consumed, no payment effect',failureTransactionHash:fail.transactionHash,failureBlockHash:fail.blockHash,failureBlockNumber:String(fail.blockNumber)};
 const attempts=ctx.attempts.filter((a:any)=>a.operation_id===op.id);const evidence:any[]=[],mismatches:any[]=[];let pending=false,reverted:any=null,replaced=false,refused=false,unknown=false,observed=false;
 for(const a of attempts){const obs=ctx.observations.filter((o:any)=>o.attempt_id===a.id);
  for(const o of obs){if(o.kind==='wallet_refused'){refused=true;observed=true;continue;}if(o.kind==='response_unknown'){unknown=true;observed=true;continue;}
   const tx=await c.getTransaction({hash:o.transaction_hash}).catch(()=>null);
   if(tx){const v=validateAttemptTransaction(tx,a,m);if(!v.ok){mismatches.push({hash:o.transaction_hash,observation_mismatch:v.reason});continue;}
    observed=true;if(tx.blockNumber==null){pending=true;evidence.push({hash:o.transaction_hash,mempool:true,senderNonce:String(tx.nonce),rebroadcast:v.rebroadcast});continue;}
    const receipt=await c.getTransactionReceipt({hash:o.transaction_hash}).catch(()=>null);if(!receipt){unknown=true;evidence.push({hash:o.transaction_hash,receipt:'unavailable'});continue;}
    await ctx.book.load([receipt.blockNumber]);const bad=validateAttemptReceipt(receipt,tx,ctx.book.get(receipt.blockNumber)?.hash);
    if(bad==='non-canonical'){evidence.push({hash:o.transaction_hash,receipt:'non-canonical'});continue;}if(bad){mismatches.push({hash:o.transaction_hash,observation_mismatch:bad});continue;}
    if(receipt.status==='reverted')reverted={hash:o.transaction_hash,blockHash:receipt.blockHash,blockNumber:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed),sender:tx.from,senderNonce:String(tx.nonce),validated:true};
    evidence.push({hash:o.transaction_hash,receipt:receipt.status,blockNumber:String(receipt.blockNumber),senderNonce:String(tx.nonce),validated:true});continue;}
   observed=true;const senderNonce=await c.getTransactionCount({address:a.sender,blockTag:'latest'}).catch(()=>null);if(senderNonce!==null&&BigInt(senderNonce)>BigInt(a.sender_nonce)){replaced=true;evidence.push({hash:o.transaction_hash,senderNonceConsumedByAnotherTransaction:true});}else{unknown=true;evidence.push({hash:o.transaction_hash,notFound:true});}}}
 const history=attempts.map((a:any)=>({attempt_id:a.id,sender:a.sender,sender_nonce:String(a.sender_nonce)}));const ev={evidence,...(mismatches.length?{observationMismatch:mismatches}:{}),...(history.length?{attemptHistory:history}:{})};
 if(op.kind==='payout'&&ctx.cancelled.get(String(m.batchId).toLowerCase()))return {...base,state:'cancelled',reason:'executor batch cancelled on chain (cancelledBatch=true at head); this batch can never execute',...ev};
 if(ctx.safeNonce>BigInt(m.message.nonce))return {...base,state:'nonce_consumed',reason:'Safe nonce consumed by a different Safe transaction; this exact authorization can never execute',...ev,...(reverted?{priorAttemptOutcome:'outer_reverted',attempt:reverted}:{})};
 // A newer validated re-broadcast still in the mempool outranks an older reverted attempt transaction.
 if(pending)return {...base,state:'pending',reason:'validated attempt transaction is in the node mempool, not included',...ev};
 if(reverted)return {...base,state:'outer_reverted',reason:'the validated app attempt transaction was mined and reverted (receipt status 0); no Safe execution',attempt:reverted,...ev};
 if(replaced)return {...base,state:'replaced',reason:'attempt hash not found and the sender nonce was consumed by another transaction (replaced or dropped); authorization still executable',...ev};
 if(op.kind==='payout'&&ctx.headTimestamp>BigInt(m.validUntil))return {...base,state:'expired',reason:'executor validUntil passed before inclusion; the batch can no longer execute',...ev};
 if(refused&&!unknown&&!evidence.length)return {...base,state:'wallet_refused',reason:'wallet refused the broadcast request; nothing observed on chain; authorization still executable',...ev};
 if(unknown||evidence.length)return {...base,state:'broadcast_uncertain',reason:'wallet response unknown or transaction not found; authorization may still execute',...ev};
 if(attempts.length&&!observed)return {...base,state:'prepared',reason:mismatches.length?'durable attempt prepared; posted transaction(s) do not match this attempt (observation_mismatch); state unchanged':'durable attempt prepared; no wallet observation yet',...(mismatches.length?ev:{})};
 if(['frozen','signed','prepared'].includes(op.state))return {...base,state:op.state,reason:'awaiting custody action; no chain activity for this authorization'};
 return {...base,state:'uncertain',reason:'no canonical matching Safe success'};}
const serial=(x:any)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const SYSTEM_ACTOR='00000000-0000-4000-8000-000000000000';
// Round 5 (TR-T-REORG): duplicate / out-of-order log handling at the ingestion boundary. Logs are keyed by
// (blockHash,logIndex); an exact duplicate is collapsed, a conflicting duplicate or a log whose block is not in the
// verified canonical header view fails the pass closed, and the result is ordered by (blockNumber,logIndex)
// independently of provider arrival order. Two DISTINCT canonical successes for one Safe hash remain impossible.
export function normalizeLogs(logs:any[],headers:any[]){
 const seen=new Map<string,any>();let duplicates=0;
 for(const l of logs){
  if(l.removed===true)throw Error('REMOVED_LOG_FROM_PROVIDER');
  if(l.blockNumber===null||l.blockNumber===undefined||!l.blockHash)throw Error('PENDING_LOG');
  if(headers[Number(l.blockNumber)]?.hash!==l.blockHash)throw Error('LOG_HEADER_MISMATCH');
  const k=String(l.blockHash).toLowerCase()+':'+Number(l.logIndex),prior=seen.get(k);
  if(prior){if(prior.transactionHash!==l.transactionHash||prior.data!==l.data||serial(prior.topics)!==serial(l.topics)||prior.address?.toLowerCase()!==l.address?.toLowerCase())throw Error('CONFLICTING_DUPLICATE_LOG');duplicates++;continue;}
  seen.set(k,l);
 }
 const out=[...seen.values()].sort((a,b)=>a.blockNumber===b.blockNumber?Number(a.logIndex)-Number(b.logIndex):(BigInt(a.blockNumber)<BigInt(b.blockNumber)?-1:1));
 return {logs:out,duplicates};
}
// A report is re-recorded only when its meaning changes (state, anchor block, reason, confirming depth); unchanged
// reaffirmations reuse the prior report id so a continuous worker does not grow append-only evidence every pass.
const sameReport=(a:any,b:any)=>!!a&&(a.verifierVersion??null)===(b.verifierVersion??null)&&(a.manifestDigest??null)===(b.manifestDigest??null)&&a.state===b.state&&(a.blockHash??null)===(b.blockHash??null)&&(a.reason??null)===(b.reason??null)&&(a.state!=='confirming'||a.depth===b.depth)&&(a.invalidationOperationId??null)===(b.invalidationOperationId??null)&&(a.targetCannotExecute??null)===(b.targetCannotExecute??null);
export type ReconcileOptions={rebuild?:boolean,lease?:Lease,client?:any,dryRun?:boolean,beforeCommit?:(db:any,result:any)=>Promise<void>,faultBeforeCommitMs?:number};
// Public entry. Writes require the single-writer lease: either the caller's (worker) or an ephemeral lease taken only
// when no live worker holds it (explicit operator/API use while the worker is stopped). dryRun never writes.
export async function reconcileApplication(pool:any,opts:ReconcileOptions={}){
 if(opts.lease||opts.dryRun)return reconcileCore(pool,opts);
 const l=await acquireLease(pool,newHolder('inline'));if(!l)throw Object.assign(Error('LEASE_HELD_BY_ACTIVE_WORKER'),{code:'LEASE_HELD'});
 try{return {...await reconcileCore(pool,{...opts,lease:l}),via:'ephemeral-lease'};}finally{await releaseLease(pool,l).catch(()=>{});}
}
// Round 6 (TR-T-CAPACITY, review F-L6): two phases.
//  Phase 1 (no transaction, no lease row lock): chain reads (incremental header window from the stored checkpoint,
//   Safe logs, markers, attempt evidence) and independent verification; plain reads of the single writer's own rows.
//  Phase 2 (one short transaction): lease + checkpoint re-asserted (the checkpoint must be exactly the one phase 1 read,
//   else CHECKPOINT_MOVED), head re-checked canonical, then projections. Operation rows are locked FOR UPDATE SKIP LOCKED
//   and an operation whose state changed since phase 1 (e.g. an owner signature committed meanwhile) is skipped this pass
//   (compare-and-set: the worker never overwrites a concurrent API transition; round-5 ops finding S0).
//  Provider disagreement (an impossible historical header, a log whose block disagrees with the stored canonical chain)
//   or a reorg whose ancestor is outside the bounded search: only the checkpoint's paused flag is written (fail closed);
//   recovery is the operator rebuild (`rebuild:true`, full genesis-to-head walk; ops/reconcile-rebuild.ts / indexer CLI).
async function reconcileCore(pool:any,{rebuild=false,lease,client,dryRun=false,beforeCommit,faultBeforeCommitMs=0}:ReconcileOptions){
 const readPhase=async()=>{
 const c=client||liveRpc;const t0=Date.now();
 const head=await c.getBlock(),genesis=await c.getBlock({blockNumber:0n}),chainKey=localRpcUrl+':'+genesis.hash;
 const old=(await pool.query('SELECT number::text,hash,paused FROM treasury_checkpoints WHERE chain_key=$1',[chainKey])).rows[0]||null;
 const win:WindowResult=await headerWindow(c,pool,chainKey,head,old,{full:rebuild});const book=win.book,headers=book.view();
 let disagreement:any=win.disagreement;const halt=()=>!!disagreement||(win.deep&&win.ancestor<0n);
 if(disagreement&&!old)throw Error('PROVIDER_DISAGREEMENT_AT_BOOTSTRAP:'+disagreement.reason);
 const depth=win.depth,paused=!rebuild&&(!!old?.paused||win.deep||!!disagreement);
 const result:any={head:String(head.number),headHash:head.hash,paused,depth:String(depth),operations:0,duplicate_logs_collapsed:0,fence:lease?.fence??null,changed:0,released:0,outbox:0,skipped_concurrent:0,
  window:{mode:win.mode,from:win.windowFrom,rpc_headers:win.rpcHeaders,written:win.write.length,ancestor:String(win.ancestor)}};
 const observations:any[]=[];const invalidations=new Map<string,any>();
 if(!halt()){
 const operations=(await pool.query('SELECT * FROM treasury_operations ORDER BY created_at,id')).rows;
 // One log query per Safe; normalized (dedupe + canonical check + order) before any per-operation decision.
 const live=operations.filter((op:any)=>op.manifest?.genesis===genesis.hash);requireSingleSafeScope(live);const bySafe=new Map<string,bigint>();
 for(const op of live){const s=op.manifest.safe.toLowerCase(),from=BigInt(op.manifest.deploymentBlock);if(!bySafe.has(s)||from<bySafe.get(s)!)bySafe.set(s,from);}
 const successes=new Map<string,any[]>();let duplicateLogs=0;
 const failures=new Map<string,any[]>();const cancelled=new Map<string,boolean>();let safeNonce=0n;
 // A log whose block hash disagrees with the stored canonical header is provider disagreement (TR-T-VERIFY S3), not a retry.
 const norm=async(raw:any[])=>{await book.load(raw.map((l:any)=>l.blockNumber).filter((n:any)=>n!=null));try{return normalizeLogs(raw,headers);}catch(e:any){if(e?.message==='LOG_HEADER_MISMATCH'){const l=raw.find((l:any)=>book.get(l.blockNumber)?.hash!==l.blockHash);disagreement={reason:'LOG_BLOCK_DISAGREES_WITH_STORED_CANONICAL_HEADER',detail:{blockNumber:String(l?.blockNumber),provider:l?.blockHash,stored:book.get(l?.blockNumber)?.hash??null}};return null;}throw e;}};
 for(const [safe,fromBlock] of bySafe){const n=await norm(await c.getLogs({address:safe as any,event:success,fromBlock,toBlock:head.number}));if(!n)break;duplicateLogs+=n.duplicates;for(const l of n.logs){const k=String((l as any).args.txHash).toLowerCase();successes.set(k,[...(successes.get(k)||[]),l]);}
  const f=await norm(await c.getLogs({address:safe as any,event:failure,fromBlock,toBlock:head.number}));if(!f)break;duplicateLogs+=f.duplicates;for(const l of f.logs){const k=String((l as any).args.txHash).toLowerCase();failures.set(k,[...(failures.get(k)||[]),l]);}
  safeNonce=await c.readContract({address:safe as any,abi:safeAbi,functionName:'nonce',blockNumber:head.number});}
 result.duplicate_logs_collapsed=duplicateLogs;
 if(!disagreement){
 const attemptRows=(await pool.query('SELECT workspace_id,id,operation_id,sender,sender_nonce,transaction_data FROM treasury_attempts ORDER BY created_at')).rows,observationRows=(await pool.query('SELECT attempt_id,kind,transaction_hash FROM treasury_observations ORDER BY id')).rows;
 const priors=new Map<string,any>((await pool.query("SELECT DISTINCT ON (operation_id) operation_id,id,report,produced_by FROM treasury_reports WHERE report->>'state'='verified' ORDER BY operation_id,id DESC")).rows.map((r:any)=>[r.operation_id,r]));
 for(const op of live)if(op.kind==='payout'&&!successes.has(String(op.manifest.safeTxHash).toLowerCase())){const b=String(op.manifest.batchId).toLowerCase();if(!cancelled.has(b))cancelled.set(b,await c.readContract({address:op.manifest.executor,abi:batchAbi,functionName:'cancelledBatch',args:[op.manifest.batchId],blockNumber:head.number}));}
 const ctx={failures,cancelled,safeNonce,attempts:attemptRows,observations:observationRows,headers,book,headTimestamp:head.timestamp};
 for(const op of live){const m=op.manifest;const logs=successes.get(String(m.safeTxHash).toLowerCase())||[];if(logs.length>1)throw Error('DUPLICATE_SAFE_AUTHORIZATION');const log=logs[0];
 // Round 4: a completed depth>=12 independent verification anchored to a block that is STILL canonical (same Safe-success log block)
 // is final. Re-running the full verifier needs historical state at the inclusion block, which a restarted/pruned node may not serve;
 // that data unavailability is not evidence of a reorg and must never downgrade or retract a settlement. A deep-reorg pause stops NEW
 // verification only; settlements whose anchor block is untouched by the reorg stay reconciled, orphans are retracted.
 const priorRow=log?priors.get(op.id):null;const priorVerified=priorRow?.report;if(priorVerified?.blockNumber!=null)await book.load([priorVerified.blockNumber]);
 const reaffirm=priorRow&&trustedPrior(priorRow,op,log)&&headers[Number(priorVerified.blockNumber)]?.hash===priorVerified.blockHash&&head.number-BigInt(priorVerified.blockNumber)+1n>=12n;
 let report:any=reaffirm?{...priorVerified,state:'verified',reaffirmed:true,reaffirmedFromReportId:String(priorRow.id),headHash:head.hash,headNumber:String(head.number),depth:String(head.number-BigInt(priorVerified.blockNumber)+1n)}:log&&!paused?(op.kind==='payout'?await verify({...m,transactionHash:log.transactionHash}):op.kind==='allowance'?await verifyAllowance({...m,transactionHash:log.transactionHash}):op.kind==='invalidation'?await verifyInvalidation({...m,transactionHash:log.transactionHash},client):{state:'unverified',reason:'unknown operation kind'}):op.state==='verified'||op.state==='retracted'?{state:'retracted',reason:paused?'deep reorg pause':'no canonical matching Safe success',paid:false}:paused?{state:op.state,reason:'deep reorg pause: outcome classification frozen until the operator rebuild',paid:false}:await classify(c,op,ctx);
 if(report.blockHash)await book.load([report.blockNumber]);
 if(report.blockHash&&(headers[Number(report.blockNumber)]?.hash!==report.blockHash||report.blockHash!==log?.blockHash))throw Error('VERIFIER_HEADER_MISMATCH');if(report.state==='verified'&&head.number-BigInt(report.blockNumber)+1n<12n)throw Error('VERIFIER_DEPTH_MISMATCH');observations.push({op,report});}
 // Round 5: a target becomes `invalidated` ONLY through a verified invalidation whose independent report says the
 // target can no longer execute. A target with its own canonical success can never be invalidated (fail closed).
 for(const o of observations)if(o.op.kind==='invalidation'&&o.report.state==='verified'&&o.report.targetCannotExecute===true){const t=o.op.manifest.target?.operationId;if(t!==o.report.targetOperationId)throw Error('INVALIDATION_TARGET_MISMATCH');if(!invalidations.has(t))invalidations.set(t,o);}
 for(const o of observations){const inv=invalidations.get(o.op.id);if(!inv)continue;if(inv.op.workspace_id!==o.op.workspace_id)throw Error('INVALIDATION_WORKSPACE_MISMATCH');if(['verified','confirming'].includes(o.report.state))throw Error('INVALIDATION_CONFLICT_TARGET_HAS_SUCCESS');
  o.report={state:'invalidated',kind:o.op.kind,invalidationOperationId:inv.op.id,invalidationBlockHash:inv.report.blockHash,invalidationBlockNumber:inv.report.blockNumber,method:inv.report.method,targetCannotExecute:true,reason:'verified on-chain invalidation: the original authorization can no longer execute',paid:false};}
 }}
 if(disagreement){result.paused=true;result.disagreement=disagreement;observations.length=0;invalidations.clear();}
 if(win.deep&&win.ancestor<0n)result.deep_reorg_ancestor='not found within bounded search; operator rebuild required';
 result.operations=observations.length;result.phase1_ms=Date.now()-t0;
  if(dryRun){result.observations=observations.map(o=>({id:o.op.id,kind:o.op.kind,state:o.report.state,blockHash:o.report.blockHash??null}));return {dryRunResult:result};}
  return {c,head,chainKey,old,win,halt,paused,observations,invalidations,result};
 };
 const writePhase=async(state:any)=>{
   const {c,head,chainKey,old,win,halt,paused,observations,invalidations,result}=state;
 const db=await pool.connect();const t1=Date.now();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(8560)');await assertLease(db,lease!);
 const cur=(await db.query('SELECT number::text,hash,paused FROM treasury_checkpoints WHERE chain_key=$1 FOR UPDATE',[chainKey])).rows[0]||null;
 if(JSON.stringify(cur)!==JSON.stringify(old))throw Error('CHECKPOINT_MOVED');
 if((await c.getBlock({blockNumber:head.number})).hash!==head.hash)throw Error('CHAIN_VIEW_CHANGED_BEFORE_COMMIT');
 // Extend the lease inside this transaction (we hold its row FOR SHARE, so no newer fence can exist).
 await extendLeaseInTx(db,lease!,LEASE_TTL_SECONDS);/* round 6: DB function, (fence,token)-bound (db/012) */
 if(halt()){
  // Fail closed: nothing is projected from an inconsistent provider; the pause is sticky until the operator rebuild.
  if(old)await db.query('UPDATE treasury_checkpoints SET paused=true WHERE chain_key=$1 AND NOT paused',[chainKey]);
  result.paused=true;if(beforeCommit)await beforeCommit(db,result);await db.query('COMMIT');result.phase2_ms=Date.now()-t1;return result;}
 await db.query('UPDATE treasury_headers SET canonical=false WHERE chain_key=$1 AND canonical AND number>$2',[chainKey,String(win.ancestor)]);await writeHeaders(db,chainKey,win.write);
  const ids=observations.map((o:any)=>o.op.id);
 const locked=new Map<string,string>((await db.query('SELECT id,state FROM treasury_operations WHERE id=ANY($1::uuid[]) FOR UPDATE SKIP LOCKED',[ids])).rows.map((r:any)=>[r.id,r.state]));
 const reportIds=new Map<string,string>();
 const enqueue=async(ws:string,kind:string,key:string,payload:any)=>{const r=await db.query('INSERT INTO outbox(workspace_id,kind,dedupe_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[ws,kind,key,payload]);/* round 6: dedupe is UNIQUE(workspace_id,dedupe_key) (db/012) */result.outbox+=r.rowCount;};
 const lasts=new Map<string,any>((await db.query('SELECT DISTINCT ON (operation_id) operation_id,id,report,produced_by FROM treasury_reports WHERE operation_id=ANY($1::uuid[]) ORDER BY operation_id,id DESC',[ids])).rows.map((r:any)=>[r.operation_id,r]));
 for(const {op,report} of observations){if(locked.get(op.id)!==op.state){result.skipped_concurrent++;continue;}const last=lasts.get(op.id);
 const reportId=last&&last.produced_by==='alder_indexer'&&sameReport(last.report,report)?String(last.id):String((await db.query('INSERT INTO treasury_reports(workspace_id,operation_id,report) VALUES($1,$2,$3) RETURNING id',[op.workspace_id,op.id,serial(report)])).rows[0].id);reportIds.set(op.id,reportId);
 if(op.state!==report.state){result.changed++;await db.query('UPDATE treasury_operations SET state=$3 WHERE workspace_id=$1 AND id=$2',[op.workspace_id,op.id,report.state]);}
 await db.query('UPDATE batches SET state=$3 WHERE workspace_id=$1 AND operation_id=$2 AND state IS DISTINCT FROM $3',[op.workspace_id,op.id,report.state]);
 if(op.kind==='payout'){if(report.state==='verified'){const batch=(await db.query('SELECT * FROM batches WHERE workspace_id=$1 AND operation_id=$2',[op.workspace_id,op.id])).rows[0];if(!batch)throw Error('UNLINKED_BATCH');const payables=(await db.query('SELECT p.* FROM payables p JOIN reservations r ON r.workspace_id=p.workspace_id AND r.payable_id=p.id WHERE r.workspace_id=$1 AND r.batch_id=$2',[op.workspace_id,batch.id])).rows;if(payables.length!==op.manifest.items.length)throw Error('RESERVATION_MISMATCH');for(const item of op.manifest.items){const p=payables.find((p:any)=>p.payment_id===item.paymentId&&p.recipient.toLowerCase()===item.recipient.toLowerCase()&&BigInt(p.amount_units)===BigInt(item.amount));if(!p)throw Error('BUSINESS_LINK_MISMATCH');await db.query("INSERT INTO treasury_settlements VALUES($1,$2,$3,$4,'verified') ON CONFLICT(workspace_id,payable_id) DO UPDATE SET state='verified',report_id=EXCLUDED.report_id WHERE treasury_settlements.operation_id=EXCLUDED.operation_id AND (treasury_settlements.state<>'verified' OR treasury_settlements.report_id<>EXCLUDED.report_id)",[op.workspace_id,p.id,op.id,reportId]);}}
 else await db.query("UPDATE treasury_settlements SET state='retracted',report_id=$3 WHERE workspace_id=$1 AND operation_id=$2 AND state<>'retracted'",[op.workspace_id,op.id,reportId]);}
 if(op.state!==report.state){await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[op.workspace_id,SYSTEM_ACTOR,'canonical-reconciliation',{operation_id:op.id,state:report.state,report_id:reportId}]);
  await enqueue(op.workspace_id,'operation.state',`op-state:${op.id}:${reportId}`,{operation_id:op.id,kind:op.kind,state:report.state,report_id:reportId,paid:op.kind==='payout'&&report.state==='verified'});}}
 // Release reserved payables ONLY for targets whose verified invalidation was established above (DB trigger re-checks).
  for(const [targetId,inv] of invalidations){const target=observations.find((o:any)=>o.op.id===targetId);if(!target||target.op.kind!=='payout'||!reportIds.has(targetId))continue;const ws=target.op.workspace_id,invReport=reportIds.get(inv.op.id);if(!invReport)continue;
  const batch=(await db.query('SELECT id FROM batches WHERE workspace_id=$1 AND operation_id=$2',[ws,targetId])).rows[0];if(!batch)continue;
  const held=(await db.query('SELECT payable_id FROM reservations WHERE workspace_id=$1 AND batch_id=$2 ORDER BY payable_id',[ws,batch.id])).rows;
  for(const r of held){await db.query('INSERT INTO reservation_releases(workspace_id,payable_id,batch_id,target_operation_id,invalidation_operation_id,report_id,fence,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ws,r.payable_id,batch.id,targetId,inv.op.id,invReport,lease!.fence,'Verified invalidation: original authorization can no longer execute']);await db.query('DELETE FROM reservations WHERE workspace_id=$1 AND payable_id=$2 AND batch_id=$3',[ws,r.payable_id,batch.id]);}
  if(held.length){result.released+=held.length;await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[ws,SYSTEM_ACTOR,'reservations-released',{operation_id:targetId,batch_id:batch.id,state:'released',report_id:invReport}]);await enqueue(ws,'reservations.released',`release:${targetId}:${inv.op.id}`,{operation_id:targetId,invalidation_operation_id:inv.op.id,batch_id:batch.id,released:held.length,report_id:invReport});}}
 await db.query('INSERT INTO treasury_checkpoints VALUES($1,$2,$3,$4) ON CONFLICT(chain_key) DO UPDATE SET number=EXCLUDED.number,hash=EXCLUDED.hash,paused=EXCLUDED.paused WHERE (treasury_checkpoints.number,treasury_checkpoints.hash,treasury_checkpoints.paused) IS DISTINCT FROM (EXCLUDED.number,EXCLUDED.hash,EXCLUDED.paused)',[chainKey,String(head.number),head.hash,paused]);
 if(beforeCommit)await beforeCommit(db,result);
 if(faultBeforeCommitMs>0)await new Promise(r=>setTimeout(r,faultBeforeCommitMs));// fault-injection point (worker env only): kill -9 lands mid-transaction
 await db.query('COMMIT');result.phase2_ms=Date.now()-t1;return result;
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
 };
 if(lease&&!dryRun)return withReadPhaseLeaseHeartbeat(pool,lease,readPhase,writePhase);
 const snapshot=await readPhase();
 if(snapshot?.dryRunResult)return snapshot.dryRunResult;
 return writePhase(snapshot);
}
// API resync / operator rebuild: go through the single active writer. If a live worker holds the lease the request is
// queued and answered by the worker's next fenced pass; if no live writer exists, an ephemeral lease is taken.
export async function requestReconcile(pool:any,kind:'resync'|'rebuild',requestedBy:string,timeoutMs=90000){
 const id=(await pool.query('INSERT INTO indexer_requests(kind,requested_by) VALUES($1,$2) RETURNING id::text',[kind,requestedBy.slice(0,200)])).rows[0].id;const t=Date.now();
 while(Date.now()-t<timeoutMs){
  const r=(await pool.query('SELECT done_at,result,error FROM indexer_requests WHERE id=$1',[id])).rows[0];
  if(r.done_at){if(r.error)throw Object.assign(Error(r.error),{statusCode:r.error==='LEASE_LOST'?503:500,request_id:id});return {...r.result,via:'worker',request_id:id};}
  const st=await leaseStatus(pool);
  if(!st?.live){const l=await acquireLease(pool,newHolder(kind==='rebuild'?'operator':'api'));if(l){try{let out:any;try{await reconcileCore(pool,{rebuild:kind==='rebuild',lease:l,beforeCommit:async(db,res)=>{out=res;await db.query("UPDATE indexer_requests SET claimed_fence=$2,done_at=now(),result=$3 WHERE kind=$4 AND done_at IS NULL AND id<=$1",[id,l.fence,res,kind]);}});return {...out,via:'ephemeral-lease',request_id:id};}catch(error:any){const terminal=await terminalizeEphemeralRequestFailure(pool,l,id,kind,error);throw requestReconcileFailure(error,id,terminal);}}finally{await releaseLease(pool,l).catch(()=>{});}}}
  await new Promise(r=>setTimeout(r,200));
 }
 throw Object.assign(Error('INDEXER_REQUEST_TIMEOUT'),{statusCode:503,request_id:id});
}
export {fenced};
