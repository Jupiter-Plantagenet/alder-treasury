// Round 6 (P6) chain-correctness runner on the ISOLATED stack (API 9103 -> scratch PG 15543 -> proxy 18547 -> Anvil 18548,
// isolated worker 9113). Records use the prefix P6. Test-controller sends go directly to Anvil 18548.
//  FM1  review F-M1: an owner-posted unrelated reverted transaction (same sender) never classifies the attempt; API 422 when
//       the node knows the tx, indexer `observation_mismatch` when it only appears later; positive control re-broadcast.
//  FL4  review F-L4: outer_reverted, then the Safe nonce is consumed -> nonce_consumed (attempt history kept); reservation
//       released only through the proper path: executor_cancel invalidation -> verified at depth 12 -> released.
import fs from 'node:fs';import {keccak256,type Hex} from 'viem';import * as L from '../round5-ops/o5-lib.ts';
const out='evidence/round6-perf/chain';fs.mkdirSync(out,{recursive:true});const R=new L.Report(out+'/report-chain-p6.json');
const s=await L.sessions();
const waitState=async(id:string,want:string[],ms=60000)=>{const t=Date.now();let st='';while(Date.now()-t<ms){st=await L.opState(id);if(want.includes(st))return st;await L.sleep(500);}return st;};
const reserved=async(opId:string)=>(await L.q('SELECT count(*)::int n FROM reservations r JOIN batches b ON b.workspace_id=r.workspace_id AND b.id=r.batch_id WHERE b.operation_id=$1',[opId]))[0].n;
const w0=L.walletFor(L.owners[0]);
const presign=async(req:any)=>{const p=await w0.prepareTransactionRequest({...req,chain:undefined} as any);const raw=await w0.signTransaction(p as any);return {raw,hash:keccak256(raw)};};
try{
// ---------------- FM1 ----------------
{const before=await w0.sendTransaction({to:L.d.safe,data:L.execData({to:L.d.safe,value:0n,data:'0x',operation:0,safeTxGas:0n,baseGas:0n,gasPrice:0n,gasToken:'0x0000000000000000000000000000000000000000',refundReceiver:'0x0000000000000000000000000000000000000000'},('0x'+'00'.repeat(65)) as Hex),gas:200000n});
 const rcB=await L.chain.waitForTransactionReceipt({hash:before});
 const x=await L.preparedPayout(s,'P6-FM1',['3100000']);const stPrepared=await waitState(x.opId,['prepared']);
 await R.check('TR-T-STATUS','F-M1 (API): posting the hash of an UNRELATED reverted Safe call from the same owner (earlier sender nonce, different SafeTx) is refused 422 OBSERVATION_MISMATCH; nothing stored',async()=>{
  const r=await s.O.post(`/attempts/${x.prepared.attemptId}/observations`,{kind:'wallet_hash',transactionHash:before});const n=(await L.q('SELECT count(*)::int n FROM treasury_observations WHERE attempt_id=$1',[x.prepared.attemptId]))[0].n;
  L.expect(rcB.status==='reverted'&&r.status===422&&r.body.error.code==='OBSERVATION_MISMATCH'&&n===0,'api',{rc:rcB.status,r:r.body,n});return {unrelated_tx:before,receipt:rcB.status,api:[r.status,r.body.error.code,r.body.error.details],stored:n};});
 // Indexer path: the hash is posted while the node does not know it yet (accepted as an observation only), then the
 // unrelated reverted call is mined at the attempt's OWN sender nonce.
 const un=await presign({to:L.d.safe,data:L.execData({to:L.d.safe,value:0n,data:'0x',operation:0,safeTxGas:0n,baseGas:0n,gasPrice:0n,gasToken:'0x0000000000000000000000000000000000000000',refundReceiver:'0x0000000000000000000000000000000000000000'},('0x'+'00'.repeat(65)) as Hex),gas:200000n,nonce:Number(x.prepared.senderNonce)});
 const ob=await s.O.post(`/attempts/${x.prepared.attemptId}/observations`,{kind:'wallet_hash',transactionHash:un.hash});
 const h2=await L.chain.request({method:'eth_sendRawTransaction' as any,params:[un.raw] as any}) as Hex;const rc2=await L.chain.waitForTransactionReceipt({hash:h2});await L.mine(2);await L.sleep(7000);
 await R.check('TR-T-STATUS','F-M1 (indexer): the unrelated reverted tx (same sender, SAME sender nonce as the attempt) is validated against the chain and recorded as observation_mismatch; the operation stays `prepared`, never outer_reverted',async()=>{
  const st=await L.opState(x.opId);const rep=await L.lastReport(x.opId);
  L.expect(ob.status===200&&ob.body.validated==='not_found'&&rc2.status==='reverted'&&st==='prepared'&&rep?.observationMismatch?.[0]?.hash===un.hash,'indexer',{ob:ob.body,rc:rc2.status,st,rep});
  return {posted_before_mined:ob.body,unrelated_tx:un.hash,receipt:rc2.status,state:st,state_before:stPrepared,report:{state:rep.state,reason:rep.reason,observationMismatch:rep.observationMismatch}};});
 // Positive control: the owner re-broadcasts the exact prepared bytes with a fresh sender nonce.
 const good=await w0.sendTransaction({to:x.prepared.to,data:x.prepared.data,value:0n,gas:3000000n});const og=await s.O.post(`/attempts/${x.prepared.attemptId}/observations`,{kind:'wallet_hash',transactionHash:good});
 const conf=await waitState(x.opId,['confirming','verified']);await L.mine(12);const v=await waitState(x.opId,['verified']);
 await R.check('TR-T-STATUS','F-M1 control: the genuine attempt bytes re-broadcast at a later sender nonce validate (rebroadcast) and converge confirming -> verified',async()=>{L.expect(og.status===200&&og.body.validated===true&&v==='verified','control',{og:og.body,conf,v});return {tx:good,api:og.body,states:[conf,v]};});}
// ---------------- FL4 + B5-style recovery ----------------
{const x=await L.preparedPayout(s,'P6-FL4',['3200000']);const hash=await w0.sendTransaction({to:x.prepared.to,data:x.prepared.data,value:0n,gas:60000n,nonce:Number(x.prepared.senderNonce)});const rc=await L.chain.waitForTransactionReceipt({hash});
 const ob=await s.O.post(`/attempts/${x.prepared.attemptId}/observations`,{kind:'wallet_hash',transactionHash:hash});const st1=await waitState(x.opId,['outer_reverted']);
 const n=await L.safeNonce();const noop=await L.safeExec(L.d.safe,'0x');await L.mine(13);const st2=await waitState(x.opId,['nonce_consumed']);const rep=await L.lastReport(x.opId);const held=await reserved(x.opId);
 await R.check('TR-T-STATUS','F-L4: a validated outer revert is outer_reverted; once the Safe nonce is consumed by another Safe tx the state is nonce_consumed (can never execute), with the prior attempt outcome and attempt history as evidence; reservation still held',async()=>{
  L.expect(rc.status==='reverted'&&ob.body.validated===true&&st1==='outer_reverted'&&noop.status==='success'&&st2==='nonce_consumed'&&rep.priorAttemptOutcome==='outer_reverted'&&rep.attemptHistory?.length===1&&held===1,'fl4',{rc:rc.status,ob:ob.body,st1,st2,rep,held});
  return {outer_revert_tx:hash,states:[st1,st2],consumed_nonce:String(n),noop_tx:noop.transactionHash??null,report:{state:rep.state,reason:rep.reason,priorAttemptOutcome:rep.priorAttemptOutcome,attemptHistory:rep.attemptHistory},reservations_held:held};});
 const inv=await s.O.post(`/operations/${x.opId}/invalidations`,{reason:'P6 F-L4: nonce consumed after an outer revert; release the reservation through a verified executor cancel'});L.expect(inv.status===200,'inv',inv.body);
 await L.signAll(s,inv.body.id);const pi=await L.prepare(s,inv.body.id);L.expect(pi.status===200,'prep inv',pi.body);await L.send(s,pi.body);
 const c=await waitState(inv.body.id,['confirming','verified']);const heldMid=await reserved(x.opId);await L.mine(12);const vi=await waitState(inv.body.id,['verified']);const tgt=await waitState(x.opId,['invalidated']);
 const rel=(await L.q('SELECT count(*)::int n FROM reservation_releases WHERE target_operation_id=$1',[x.opId]))[0].n;
 await R.check('TR-T-CANCEL','F-L4 recovery (proper path): executor_cancel invalidation frozen, quorum-signed, broadcast, verified at depth 12; only then is the target `invalidated` and its reservation released (held while confirming)',async()=>{
  L.expect(inv.body.method==='executor_cancel'&&heldMid===1&&vi==='verified'&&tgt==='invalidated'&&rel===1&&(await reserved(x.opId))===0,'recovery',{inv:inv.body.method,heldMid,vi,tgt,rel});return {invalidation:inv.body.id,method:inv.body.method,states:[c,vi],target:tgt,held_while_confirming:heldMid,released:rel};});}
}catch(e:any){R.bad('RUNNER','unexpected',{error:String(e?.stack||e).slice(0,3000)});}
R.save({run:'P6-CHAIN'});console.log(JSON.stringify({pass:R.steps.filter((x:any)=>x.result==='PASS').length,fail:R.steps.filter((x:any)=>x.result==='FAIL').length}));await L.db.end();process.exit(0);
