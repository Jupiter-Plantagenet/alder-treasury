// @ts-nocheck -- live-stack runner
// Round-5 cleanup on the PRIMARY workspace, restricted to the destination-held batch created by THIS builder's own
// round-4 adv-destination rerun (run id passed as argv[2]); never touches reviewer (RV) records. Uses the normal
// in-app path: owner proposes invalidation -> 2 owner signatures -> prepare -> broadcast -> depth 12 -> worker verifies
// -> verified release. Evidence: evidence/round5/w1-release-<run>/report.json
import fs from 'node:fs';import {Session,WS} from '../round4/api-client.ts';import {owners,walletFor,mine,q,db,Report,until,expect} from '../round4/flow-lib.ts';
// argv[2]: either an adv-destination run id of this builder (DMVV…), or op:<uuid> for an operation the parent explicitly
// assigned to this flow (round-5 wallet agent leftover b5cae91d…).
const tag=process.argv[2];if(!/^DMVV[0-9A-Z]+$/.test(tag||'')&&!/^op:[0-9a-f-]{36}$/.test(tag||''))throw Error('usage: w1-release-own-held.ts <DMVV run id | op:uuid>');
const R=new Report(`evidence/round5/w1-release-${tag.replace(':','-').slice(0,40)}/report.json`);const O=await Session.login('owner');
try{const ops=tag.startsWith('op:')?await q("SELECT o.id,o.state FROM treasury_operations o WHERE o.workspace_id=$1 AND o.id=$2::uuid",[WS,tag.slice(3)]):await q("SELECT DISTINCT o.id,o.state FROM treasury_operations o JOIN batches b ON b.workspace_id=o.workspace_id AND b.operation_id=o.id JOIN reservations r ON r.workspace_id=b.workspace_id AND r.batch_id=b.id JOIN payables p ON p.workspace_id=r.workspace_id AND p.id=r.payable_id WHERE o.workspace_id=$1 AND p.display_reference LIKE $2",[WS,tag+'%']);
 expect(ops.length===1,'exactly one own held batch',ops);const target=ops[0];
 await R.check('TR-T-CANCEL','primary workspace: the destination-held batch left by the builder\'s own adv-destination rerun is exited through the in-app invalidation path and its reservations are released only after verification',async()=>{const inv=await O.post(`/operations/${target.id}/invalidations`,{reason:`Round 5 verified-invalidation release of ${tag} (assigned leftover / own rerun record)`});expect(inv.status===200,'propose',inv);
  const m=inv.body.manifest;for(const i of [0,1]){const sig=await owners[i].signTypedData(m.typedData);const r=await O.post(`/operations/${inv.body.id}/signatures`,{owner:owners[i].address,scheme:'EIP712_EOA',signature:sig});expect(r.status===200,'sign',r);}
  const p=await O.post(`/operations/${inv.body.id}/attempts`,{sender:owners[0].address});expect(p.status===200,'prepare',p);const hash=await walletFor(owners[0]).sendTransaction({to:p.body.to,data:p.body.data,value:0n,gas:3000000n,nonce:Number(p.body.senderNonce)});await O.post(`/attempts/${p.body.attemptId}/observations`,{kind:'wallet_hash',transactionHash:hash});
  const before=(await q('SELECT count(*)::int n FROM reservation_releases WHERE target_operation_id=$1',[target.id]))[0].n;await mine(12);
  const st=await until(async()=>{const r=(await q('SELECT state FROM treasury_operations WHERE id=$1',[target.id]))[0];return r.state==='invalidated'?r.state:null;},'invalidated',90000);const rel=await q('SELECT payable_id,report_id::text,fence::text FROM reservation_releases WHERE target_operation_id=$1',[target.id]);
  expect(before===0&&rel.length>=1,'released',{before,rel});return {target:target.id,prior_state:target.state,invalidation:inv.body.id,method:inv.body.method,tx:hash,final:st,released:rel};});
}catch(e:any){R.bad('RUNNER','unexpected',{error:String(e?.stack||e).slice(0,2000)});}finally{R.save({tag,workspace:WS});await db.end();console.log('REPORT',R.file,R.steps.map((x:any)=>x.result).join(','));}
