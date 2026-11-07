// Round 5 transactional outbox dispatcher (TR-T-DURABLE / FAULT).
// Producers (API mutations and the fenced reconciliation pass) insert outbox rows in the SAME transaction as the
// domain change, with a unique dedupe_key. The single active worker claims rows under its fence, performs the side
// effect, then marks them delivered under the same fence. Semantics are at-least-once with an idempotent sink:
// the local notification sink writes <sink>/<workspace>/<outbox-id>.json atomically (temp file + rename), so a
// redelivery after a crash between "effect" and "mark delivered" rewrites the same file (deduped by id).
// After max_attempts failures an item becomes `held` (visible in the recovery screen; an admin/owner retry re-queues).
import fs from 'node:fs';import path from 'node:path';import {fenced,type Lease} from './lease.ts';
export const OUTBOX_SINK=()=>process.env.ALDER_OUTBOX_SINK||'runtime-logs/notifications';
const SYSTEM_ACTOR='00000000-0000-4000-8000-000000000000';
// Round 6 (review F-L3): the sink is fenced. It keeps a high-water fence (<sink>/.fence); a delivery carrying an older
// fence than the newest holder has announced is refused (STALE_FENCE), so a worker that lost its lease (e.g. suspended
// between claim and effect) cannot write a notification after a takeover. Each active holder announces its fence to the
// sink as part of every effect (deliverToSink -> sinkAdvanceFence, inside the per-item failure handling, so a broken sink
// still counts as a failed attempt), and the lease is re-asserted immediately before every effect.
const fenceFile=(sink:string)=>path.join(sink,'.fence');
export function sinkFence(sink=OUTBOX_SINK()){try{return BigInt(fs.readFileSync(fenceFile(sink),'utf8').trim()||'0');}catch{return 0n;}}
export function sinkAdvanceFence(fence:string|bigint,sink=OUTBOX_SINK()){const f=BigInt(fence);fs.mkdirSync(sink,{recursive:true});if(f<sinkFence(sink))throw Object.assign(Error('STALE_FENCE'),{code:'STALE_FENCE'});
 if(f>sinkFence(sink)){const tmp=`${fenceFile(sink)}.${process.pid}.tmp`;fs.writeFileSync(tmp,f.toString());fs.renameSync(tmp,fenceFile(sink));}}
export function deliverToSink(item:any,fence:string|bigint,sink=OUTBOX_SINK()){
 sinkAdvanceFence(fence,sink);
 const dir=path.join(sink,String(item.workspace_id));fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,`${item.id}.json`),tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(tmp,JSON.stringify({outbox_id:String(item.id),dedupe_key:item.dedupe_key,kind:item.kind,payload:item.payload,created_at:item.created_at,fence:String(fence)},null,1));
 if(BigInt(fence)<sinkFence(sink)){fs.rmSync(tmp,{force:true});throw Object.assign(Error('STALE_FENCE'),{code:'STALE_FENCE'});}
 fs.renameSync(tmp,file);return file;
}
const backoffMs=(attempts:number)=>Math.min(10000,500*2**Math.max(0,attempts-1));
export async function dispatchOutbox(pool:any,lease:Lease,worker:string,opts:{limit?:number,faultAfterDeliverMs?:number,onDelivered?:(id:string)=>void,onEffect?:(id:string)=>void}={}){
 const claimed=await fenced(pool,lease,async db=>(await db.query(`UPDATE outbox SET state='claimed',claimed_by=$1,claim_fence=$2,claimed_until=now()+interval '60 seconds',attempts=attempts+1
   WHERE id IN (SELECT id FROM outbox WHERE (state='pending' AND next_attempt_at<=now()) OR (state='claimed' AND (claimed_until<now() OR claim_fence<$2)) ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING *`,[worker,lease.fence,opts.limit??20])).rows);
 const out={claimed:claimed.length,delivered:0,failed:0,held:0};
 for(const item of claimed){
  try{await fenced(pool,lease,async()=>{});deliverToSink(item,lease.fence);opts.onEffect?.(String(item.id));if(opts.faultAfterDeliverMs)await new Promise(r=>setTimeout(r,opts.faultAfterDeliverMs));// fault-injection point (worker env only)
   await fenced(pool,lease,async db=>{const r=await db.query("UPDATE outbox SET state='delivered',delivered_at=now(),delivery_fence=$2,last_error=NULL,claimed_until=NULL WHERE id=$1 AND state='claimed' AND claim_fence=$2",[item.id,lease.fence]);
    await db.query("INSERT INTO outbox_attempts(workspace_id,outbox_id,fence,worker,outcome) VALUES($1,$2,$3,$4,$5)",[item.workspace_id,item.id,lease.fence,worker,r.rowCount?'delivered':'failed']);});
   out.delivered++;opts.onDelivered?.(String(item.id));
  }catch(e:any){if(['LEASE_LOST','STALE_FENCE'].some(k=>String(e?.message).includes(k)))throw e;
   const held=item.attempts>=item.max_attempts,msg=String(e?.code||e?.message||e).slice(0,300);
   await fenced(pool,lease,async db=>{await db.query("UPDATE outbox SET state=$3,next_attempt_at=now()+make_interval(secs=>$4),last_error=$5,claimed_until=NULL WHERE id=$1 AND claim_fence=$2",[item.id,lease.fence,held?'held':'pending',backoffMs(item.attempts)/1000,msg]);
    await db.query("INSERT INTO outbox_attempts(workspace_id,outbox_id,fence,worker,outcome,error) VALUES($1,$2,$3,$4,$5,$6)",[item.workspace_id,item.id,lease.fence,worker,held?'held':'failed',msg]);
    if(held)await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[item.workspace_id,SYSTEM_ACTOR,'outbox-held',{entity:'outbox',entity_id:String(item.id),state:'held'}]);});
   if(held)out.held++;else out.failed++;}
 }
 return out;
}
