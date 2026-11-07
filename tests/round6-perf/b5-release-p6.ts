// @ts-nocheck -- live-stack runner (B5 verification workspace only; never W1).
// Round 6 (review F-L4 live residue): B5 payout 91921f34 (Safe nonce 83) showed `outer_reverted` forever although its
// nonce was consumed, and kept 1 reservation. With the F-L4 precedence fix the live worker now reports `nonce_consumed`.
// The reservation is released ONLY through the proper path: an owner proposes an executor_cancel invalidation, two owners
// sign it, it is prepared and broadcast, the independent invalidation verifier verifies it at depth 12, and only then does
// the indexer mark the target `invalidated` and release its reservation. Nothing is deleted or forced.
import fs from 'node:fs';import * as B from '../round5/b5-lib.ts';
const TARGET='91921f34-8d0c-4135-80b9-0351f45088ff';const out='evidence/round6-perf/chain';fs.mkdirSync(out,{recursive:true});
const R=new B.Report(out+'/report-b5-release.json');const s=await B.sessions5();
try{
 const before={state:await B.opState(TARGET),reservations:await B.reservedCount(TARGET),report:(await B.q("SELECT report->>'state' st,report->>'priorAttemptOutcome' prior,report->'attemptHistory' hist FROM treasury_reports WHERE operation_id=$1 ORDER BY id DESC LIMIT 1",[TARGET]))[0]};
 B.expect(before.state==='nonce_consumed'&&before.reservations===1,'precondition',before);
 const inv=await s.O.post(`/operations/${TARGET}/invalidations`,{reason:'P6 round 6: F-L4 residue. Target nonce 83 was consumed after an outer revert; release its kept reservation only through a verified executor cancel.'});B.expect(inv.status===200,'propose',inv);
 await B.signAll(s,inv.body.id);const p=await B.prepare(s,inv.body.id);B.expect(p.status===200,'prepare',p);const hash=await B.send(s,p.body);
 const c=await B.waitState(inv.body.id,['confirming','verified'],120000);const heldWhileConfirming=await B.reservedCount(TARGET);
 await B.mine(12);const v=await B.waitState(inv.body.id,['verified'],120000);const t=await B.waitState(TARGET,['invalidated'],120000);
 const rel=await B.q('SELECT payable_id,report_id::text,fence::text,released_at FROM reservation_releases WHERE target_operation_id=$1',[TARGET]);
 await R.check('TR-T-STATUS','B5 91921f34: nonce_consumed (F-L4) with the prior outer revert kept as evidence; reservation released only after the executor_cancel invalidation verified at depth 12',async()=>{
  B.expect(inv.body.method==='executor_cancel'&&heldWhileConfirming===1&&v==='verified'&&t==='invalidated'&&rel.length===1&&(await B.reservedCount(TARGET))===0,'release',{inv:inv.body.method,heldWhileConfirming,v,t,rel});
  return {before,invalidation:{id:inv.body.id,method:inv.body.method,revocation:inv.body.revocation,tx:hash},states:[c,v],target:t,held_while_confirming:heldWhileConfirming,releases:rel};});
}catch(e:any){R.bad('RUNNER','unexpected',{error:String(e?.stack||e).slice(0,2000)});}
await new Promise(r=>setTimeout(r,300));R.save({run:'P6-B5-RELEASE'});console.log(JSON.stringify({pass:R.steps.filter((x:any)=>x.result==='PASS').length,fail:R.steps.filter((x:any)=>x.result==='FAIL').length}));process.exit(0);
