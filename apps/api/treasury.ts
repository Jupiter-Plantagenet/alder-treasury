import {assertDestinationOperation,assertCurrentDestinations} from './destinations.ts';
import {assertCurrentPolicyReviews,requirePolicySchema} from './policy.ts';
import fs from 'node:fs';import {randomUUID} from 'node:crypto';import {freezeAllowance} from '../../packages/allowance.ts';
import {freezeInvalidation,invalidationCall} from '../../packages/invalidation.ts';
import {createHash} from 'node:crypto';
import {assertSignedGasSufficient} from '../../packages/gas.ts';
import {validateAttemptTransaction} from '../../services/attempt-evidence.ts';
import {rpc,safeAbi,tokenAbi,batchAbi} from '../../packages/intent.ts';
import {recoverTypedDataAddress,hashTypedData,keccak256,encodeFunctionData,concat,decodeFunctionData,type Hex} from 'viem';
const fail=(s:number,c:string)=>Object.assign(new Error(c),{statusCode:s});
export async function validateOperation(op:any){
 const m=op.manifest;if(!['frozen','signed','prepared'].includes(op.state))throw fail(409,'OPERATION_HELD');
 if(await rpc.getChainId()!==31337||(await rpc.getBlock({blockNumber:0n})).hash!==m.genesis)throw fail(409,'CHAIN_INSTANCE_MISMATCH');
 for(const k of ['safe','singleton','factory','executor','token'])if(keccak256((await rpc.getCode({address:m[k]}))||'0x')!==m.codeHashes[k])throw fail(409,'CODE_MISMATCH');
 if(hashTypedData(m.typedData)!==m.safeTxHash||m.message.data!==m.calldata)throw fail(409,'INTENT_MISMATCH');
 if(await rpc.readContract({address:m.safe,abi:safeAbi,functionName:'nonce'})!==BigInt(m.message.nonce))throw fail(409,'STALE_NONCE');
 const owners=await rpc.readContract({address:m.safe,abi:safeAbi,functionName:'getOwners'}),threshold=await rpc.readContract({address:m.safe,abi:safeAbi,functionName:'getThreshold'});
 if(threshold!==BigInt(m.threshold)||owners.map(a=>a.toLowerCase()).sort().join()!==m.owners.map((a:string)=>a.toLowerCase()).sort().join())throw fail(409,'AUTHORITY_CHANGED');
 if(op.kind==='allowance'){const x=decodeFunctionData({abi:tokenAbi,data:m.calldata});if(x.functionName!=='approve'||x.args[0].toLowerCase()!==m.executor.toLowerCase()||x.args[1]!==BigInt(m.cap)||BigInt(m.cap)>=2n**256n-1n||m.message.to.toLowerCase()!==m.token.toLowerCase())throw fail(409,'ALLOWANCE_INTENT_MISMATCH');const prior=await rpc.readContract({address:m.token,abi:tokenAbi,functionName:'allowance',args:[m.safe,m.executor]});if(BigInt(m.cap)!==0n&&prior!==0n)throw fail(409,'ZERO_RESET_REQUIRED');}
 if(op.kind==='payout'){const t=(await rpc.getBlock()).timestamp;if(t<BigInt(m.validAfter)||t>BigInt(m.validUntil))throw fail(409,'INTENT_TIME_WINDOW');if(await rpc.readContract({address:m.executor,abi:batchAbi,functionName:'authorityHash'})!==m.authorityHash)throw fail(409,'AUTHORITY_CHANGED');const total=m.items.reduce((n:bigint,p:any)=>n+BigInt(p.amount),0n);if(await rpc.readContract({address:m.token,abi:tokenAbi,functionName:'allowance',args:[m.safe,m.executor]})<total)throw fail(409,'SEPARATE_QUORUM_ALLOWANCE_REQUIRED');if(await rpc.readContract({address:m.token,abi:tokenAbi,functionName:'balanceOf',args:[m.safe]})<total)throw fail(409,'INSUFFICIENT_BALANCE');}
 if(op.kind==='invalidation'){const t=m.target;if(!t||!['executor_cancel','nonce_consumption'].includes(m.method))throw fail(409,'INVALIDATION_INTENT_MISMATCH');const call=invalidationCall(m,m.method,t.batchId??undefined);if(m.message.to.toLowerCase()!==call.to.toLowerCase()||m.calldata!==call.data||m.message.data!==call.data||String(m.message.value)!=='0'||Number(m.message.operation)!==0)throw fail(409,'INVALIDATION_INTENT_MISMATCH');
  if(m.method==='nonce_consumption'&&BigInt(m.message.nonce)!==BigInt(t.nonce))throw fail(409,'INVALIDATION_INTENT_MISMATCH');
  if(m.method==='executor_cancel'&&await rpc.readContract({address:m.executor,abi:batchAbi,functionName:'executedBatch',args:[t.batchId]}))throw fail(409,'TARGET_ALREADY_EXECUTED');}
 // Round 6 (ops finding 2): the signed safeTxGas must cover a fresh simulation of the exact inner call and stay within the
 // policy cap BEFORE any signature is stored or an attempt is prepared (409 SAFE_TX_GAS_INSUFFICIENT / GAS_CAP_EXCEEDED).
 const gas=await assertSignedGasSufficient(m);
 return {owners,threshold,gas};
}
// Target states from which an in-app invalidation may be proposed (never for paid/confirming/invalidated/voided).
export const INVALIDATABLE=['frozen','signed','prepared','pending','uncertain','unverified','retracted','inner_failed','outer_reverted','replaced','nonce_consumed','cancelled','expired','wallet_refused','broadcast_uncertain'];
// An invalidation is `open` (pending) until it is verified, or until its own Safe nonce was consumed by something else
// without its success (then it can never execute and a fresh one may be proposed).
export async function openInvalidations(db:any,ws:string,targetId:string){
 const rows=(await db.query("SELECT o.id,o.state,o.manifest FROM operation_invalidations i JOIN treasury_operations o ON o.workspace_id=i.workspace_id AND o.id=i.operation_id WHERE i.workspace_id=$1 AND i.target_operation_id=$2 ORDER BY o.created_at",[ws,targetId])).rows;
 if(!rows.length)return [];const safeNonce=await rpc.readContract({address:rows[0].manifest.safe,abi:safeAbi,functionName:'nonce'});
 return rows.filter((r:any)=>r.state==='verified'||!(BigInt(r.manifest.message.nonce)<safeNonce&&['nonce_consumed','inner_failed','cancelled','uncertain','outer_reverted','expired'].includes(r.state)));
}
export function registerTreasury(app:any,mutate:any,pool:any){
 const fail=(s:number,c:string)=>Object.assign(new Error(c),{statusCode:s});
 app.post('/api/v1/workspaces/:ws/allowances',async(req:any)=>mutate(req,['owner'],'allowance-freeze',async(db:any)=>{
  const ids=req.body.ids;if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw fail(422,'ITEM_COUNT');
  const rows=(await db.query('SELECT * FROM payables WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY display_reference FOR UPDATE',[req.params.ws,ids])).rows;
  if(rows.length!==ids.length)throw fail(404,'NOT_FOUND');await assertCurrentDestinations(db,req.params.ws,rows);if(rows.some((p:any)=>!p.verified||!p.reviewed_by))throw fail(422,'REVIEW_REQUIRED');await requirePolicySchema(db);await assertCurrentPolicyReviews(db,req.params.ws,rows);
  const deployment=JSON.parse(fs.readFileSync(process.env.ALDER_DEPLOYMENT_FILE||'evidence/app-deployment.json','utf8'));
  const manifest=await freezeAllowance(deployment,rows.reduce((n:bigint,p:any)=>n+BigInt(p.amount_units),0n),ids),id=randomUUID();
  // Round 5: an identical exact intent (same Safe hash: same calldata and nonce) already frozen in this workspace is a 409
  // conflict naming the existing operation, not a 500 (found by the round-5 E2E rerun).
  const existing=(await db.query("SELECT id FROM treasury_operations WHERE workspace_id=$1 AND manifest->>'safeTxHash'=$2",[req.params.ws,manifest.safeTxHash])).rows[0];if(existing)throw Object.assign(fail(409,'INTENT_ALREADY_FROZEN'),{details:{operation_id:existing.id}});
  await db.query('INSERT INTO treasury_operations(workspace_id,id,kind,manifest,created_by) VALUES($1,$2,$3,$4,$5)',[req.params.ws,id,'allowance',JSON.stringify(manifest,(_,v)=>typeof v==='bigint'?v.toString():v),req.identity.user_id]);return {id,kind:'allowance',manifest};
 }));
 // Review L5 / round 6 F-M3: a resync is only a REQUEST to the single active writer. The API holds no machine-role
 // credential and never takes a lease: alder_request_resync (SECURITY DEFINER, owner/admin of this workspace) enqueues
 // one coalesced request; the worker answers it in its next fenced pass. No live worker -> 202 queued (code WORKER_UNAVAILABLE)
 // (the request stays queued); the operator CLI (ops/reconcile-rebuild.ts) is the only ephemeral-lease path.
 // Blueprint: resync returns 202 with a durable job id when it is not answered synchronously.
 app.post('/api/v1/workspaces/:ws/resync',async(req:any,reply:any)=>mutate(req,['owner','admin'],'resync',async(db:any)=>{const ws=req.params.ws;
  const rid=(await db.query('SELECT public.alder_request_resync($1)::text AS id',[ws]).catch((e:any)=>{throw e?.message==='ROLE_DENIED'?fail(403,'ROLE_DENIED'):e;})).rows[0].id;
  const live=(await db.query("SELECT expires_at>now() AS live FROM worker_leases WHERE name='indexer'")).rows[0]?.live===true;
  return {request_id:rid,via:'worker',queued:true,worker_live:live};}).then(async(r:any)=>{
  if(!r.worker_live){reply.code(202);return {via:'worker',request_id:r.request_id,job_id:r.request_id,state:'queued',worker_live:false,code:'WORKER_UNAVAILABLE'};}
  const t=Date.now();while(Date.now()-t<60000){const st=(await pool.query('SELECT * FROM public.alder_resync_status($1)',[r.request_id])).rows[0];
   if(st?.done){if(st.error)throw Object.assign(fail(503,'RESYNC_FAILED'),{details:{request_id:r.request_id}});return {head:st.head,headHash:st.head_hash,paused:st.paused,depth:st.depth,via:'worker',request_id:r.request_id};}
   await new Promise(res=>setTimeout(res,250));}
  reply.code(202);return {via:'worker',request_id:r.request_id,job_id:r.request_id,state:'queued',worker_live:true};}));
 // TR-T-CANCEL: propose an invalidation of an outstanding authorization. Proposal never revokes anything; reservations
 // are released only by the indexer after the independent invalidation verifier reports the target cannot execute.
 app.post('/api/v1/workspaces/:ws/operations/:id/invalidations',async(req:any)=>mutate(req,['owner'],'invalidation-propose',async(db:any)=>{
  const reason=req.body?.reason;if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw fail(422,'REASON_REQUIRED');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(req.params.id))throw fail(404,'NOT_FOUND');
  const target=(await db.query('SELECT * FROM treasury_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[req.params.ws,req.params.id])).rows[0];if(!target)throw fail(404,'NOT_FOUND');
  if(!['payout','allowance'].includes(target.kind))throw fail(422,'TARGET_KIND_UNSUPPORTED');if(!INVALIDATABLE.includes(target.state))throw fail(409,'TARGET_NOT_INVALIDATABLE');
  if((await openInvalidations(db,req.params.ws,target.id)).length)throw fail(409,'INVALIDATION_ALREADY_OPEN');
  const deployment=JSON.parse(fs.readFileSync(process.env.ALDER_DEPLOYMENT_FILE||'evidence/app-deployment.json','utf8'));let manifest:any;
  try{manifest=await freezeInvalidation(deployment,{operationId:target.id,kind:target.kind,manifest:target.manifest});}catch(e:any){if(['TARGET_ALREADY_EXECUTED','TARGET_NONCE_ALREADY_CONSUMED','TARGET_NONCE_IN_FUTURE','CHAIN_INSTANCE_MISMATCH','CODE_MISMATCH','TARGET_SAFE_MISMATCH'].includes(e.message))throw fail(409,e.message);throw e;}
  const json=JSON.parse(JSON.stringify(manifest,(_,v)=>typeof v==='bigint'?v.toString():v)),id=randomUUID();
  try{await db.query('INSERT INTO treasury_operations(workspace_id,id,kind,manifest,created_by) VALUES($1,$2,$3,$4,$5)',[req.params.ws,id,'invalidation',json,req.identity.user_id]);}catch(e:any){if(e.code==='23505')throw fail(409,'INVALIDATION_ALREADY_OPEN');throw e;}
  await db.query('INSERT INTO operation_invalidations(workspace_id,operation_id,target_operation_id,method,target_safe_tx_hash,target_nonce,invalidation_nonce,target_batch_id,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[req.params.ws,id,target.id,json.method,String(target.manifest.safeTxHash).toLowerCase(),json.target.nonce,json.message.nonce,json.target.batchId?String(json.target.batchId).toLowerCase():null,reason,req.identity.user_id]);
  await db.query('INSERT INTO outbox(workspace_id,kind,dedupe_key,payload) VALUES($1,$2,$3,$4)',[req.params.ws,'invalidation.proposed','invalidation-proposed:'+id,{operation_id:id,target_operation_id:target.id,method:json.method,state:'frozen'}]);
  return {id,kind:'invalidation',method:json.method,target_operation_id:target.id,state:'frozen',revocation:'NOT_REVOKED_UNTIL_VERIFIED',manifest:json};
 }));
 // Held outbox deliveries: explicit, audited re-queue (attempt budget restarts); never automatic.
 app.post('/api/v1/workspaces/:ws/outbox/:id/retry',async(req:any)=>mutate(req,['owner','admin'],'outbox-retry',async(db:any)=>{if(!/^[1-9][0-9]{0,18}$/.test(req.params.id))throw fail(404,'NOT_FOUND');
  // Round 6 (F-L3): alder_app has no UPDATE on outbox; the held->pending re-queue is a SECURITY DEFINER function.
  try{const r=(await db.query('SELECT public.alder_outbox_requeue_held($1,$2::bigint) AS id',[req.params.ws,req.params.id])).rows[0];return {id:r.id,state:'pending'};}catch(e:any){if(e?.message==='OUTBOX_NOT_HELD')throw fail(409,'OUTBOX_NOT_HELD');if(e?.message==='ROLE_DENIED')throw fail(403,'ROLE_DENIED');throw e;}}));
 const operation=async(db:any,req:any)=>{const op=(await db.query('SELECT * FROM treasury_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[req.params.ws,req.params.id])).rows[0];if(!op)throw fail(404,'NOT_FOUND');if(!['frozen','signed','prepared'].includes(op.state))throw fail(409,'OPERATION_NOT_SIGNABLE');await assertDestinationOperation(db,req.params.ws,op.id);if(op.kind!=='invalidation'&&(await openInvalidations(db,req.params.ws,op.id)).length)throw fail(409,'INVALIDATION_PENDING');return op;};
 app.post('/api/v1/workspaces/:ws/operations/:id/signatures',async(req:any)=>mutate(req,['owner'],'operation-signature',async(db:any)=>{
  const op=await operation(db,req);await validateOperation(op);if(req.body.scheme!=='EIP712_EOA'||!/^0x[0-9a-fA-F]{130}$/.test(req.body.signature||''))throw fail(422,'UNSUPPORTED_SIGNATURE');let owner;try{owner=await recoverTypedDataAddress({...op.manifest.typedData,signature:req.body.signature});}catch{throw fail(422,'INVALID_SIGNATURE');}if(owner.toLowerCase()!==req.body.owner?.toLowerCase())throw fail(422,'SIGNER_MISMATCH');if(!op.manifest.owners.some((a:string)=>a.toLowerCase()===owner.toLowerCase()))throw fail(403,'NOT_OWNER');if(await rpc.getCode({address:owner}))throw fail(422,'CONTRACT_OWNER_UNSUPPORTED');
  await db.query('INSERT INTO treasury_signatures(workspace_id,operation_id,owner,signature) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[req.params.ws,op.id,owner.toLowerCase(),req.body.signature]);await db.query("UPDATE treasury_operations SET state='signed' WHERE workspace_id=$1 AND id=$2",[req.params.ws,op.id]);return {id:op.id,owner};
 }));
 app.post('/api/v1/workspaces/:ws/operations/:id/attempts',async(req:any)=>mutate(req,['owner'],'operation-prepare',async(db:any)=>{
  const op=await operation(db,req),{owners,threshold}=await validateOperation(op),m=op.manifest;
  if(!owners.some((a:string)=>a.toLowerCase()===req.body.sender?.toLowerCase()))throw fail(403,'BROADCASTER_NOT_OWNER');
  const sigs=(await db.query('SELECT * FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2 ORDER BY owner',[req.params.ws,op.id])).rows;
  for(const s of sigs){const recovered=await recoverTypedDataAddress({...m.typedData,signature:s.signature});if(!owners.some((a:string)=>a.toLowerCase()===recovered.toLowerCase())||recovered.toLowerCase()!==s.owner)throw fail(409,'SIGNATURE_AUTHORITY_CHANGED');}
  if(BigInt(sigs.length)<threshold)throw fail(409,'QUORUM_REQUIRED');if((await db.query('SELECT 1 FROM treasury_attempts WHERE workspace_id=$1 AND operation_id=$2',[req.params.ws,op.id])).rowCount)throw fail(409,'ATTEMPT_UNRESOLVED');
  const x=m.message,data=encodeFunctionData({abi:safeAbi,functionName:'execTransaction',args:[x.to,BigInt(x.value),x.data,x.operation,BigInt(x.safeTxGas),BigInt(x.baseGas),BigInt(x.gasPrice),x.gasToken,x.refundReceiver,concat(sigs.map((s:any)=>s.signature as Hex)) as Hex]}),id=randomUUID();
  const nonce=await rpc.getTransactionCount({address:req.body.sender,blockTag:'pending'});await db.query('INSERT INTO treasury_attempts(workspace_id,id,operation_id,sender,sender_nonce,transaction_data) VALUES($1,$2,$3,$4,$5,$6)',[req.params.ws,id,op.id,req.body.sender.toLowerCase(),String(nonce),data]);await db.query("UPDATE treasury_operations SET state='prepared' WHERE workspace_id=$1 AND id=$2",[req.params.ws,op.id]);return {id:op.id,attemptId:id,to:m.safe,data,value:'0x0',chainId:'0x7a69',senderNonce:String(nonce)};
 }));
 app.post('/api/v1/workspaces/:ws/attempts/:id/observations',async(req:any)=>mutate(req,['owner'],'wallet-observation',async(db:any)=>{
  const attempt=(await db.query('SELECT * FROM treasury_attempts WHERE workspace_id=$1 AND id=$2',[req.params.ws,req.params.id])).rows[0];if(!attempt)throw fail(404,'NOT_FOUND');if(!['wallet_hash','wallet_refused','response_unknown'].includes(req.body.kind))throw fail(422,'OBSERVATION_KIND');if(req.body.kind==='wallet_hash'&&!/^0x[0-9a-fA-F]{64}$/.test(req.body.transactionHash||''))throw fail(422,'HASH_FORMAT');
  // Round 6 (review F-M1): a hash the node already knows must be THIS attempt's transaction (sender, sender nonce, Safe,
  // exact signed fields, recomputed SafeTx hash); otherwise it is refused and nothing is stored. An unknown hash is kept
  // as an observation only; the indexer validates it again against the chain before it can affect any state.
  let validated:any='not_found';if(req.body.kind==='wallet_hash'){const op=(await db.query('SELECT manifest FROM treasury_operations WHERE workspace_id=$1 AND id=$2',[req.params.ws,attempt.operation_id])).rows[0];const tx=await rpc.getTransaction({hash:req.body.transactionHash}).catch(()=>null);
   if(tx){const v=validateAttemptTransaction(tx,attempt,op.manifest);if(!v.ok)throw Object.assign(fail(422,'OBSERVATION_MISMATCH'),{details:{reason:v.reason}});validated=true;}}await db.query('INSERT INTO treasury_observations(workspace_id,attempt_id,kind,transaction_hash) VALUES($1,$2,$3,$4)',[req.params.ws,attempt.id,req.body.kind,req.body.kind==='wallet_hash'?req.body.transactionHash:null]);return {id:attempt.id,state:'observation_only',paid:false,validated};
 }));
}
