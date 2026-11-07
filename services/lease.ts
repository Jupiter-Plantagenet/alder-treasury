// Round 5 single-writer lease with fence tokens (TR-T-DURABLE); round 6 (review F-M3): lease changes go ONLY through
// SECURITY DEFINER functions (db/012), and every acquisition issues a per-lease SECRET token known only to the holder.
// - acquire(): only when the named lease is absent or expired (enforced in the database, not by the caller); every
//   acquisition increments the fence and returns {fence, token}. alder_indexer has no INSERT/UPDATE on worker_leases.
// - renew()/extend: only by the exact (fence, token) while unexpired; otherwise the lease is lost and the caller steps down.
// - fenced(): opens a transaction, alder_lease_assert() locks the lease row FOR SHARE and binds the transaction to
//   (fence, token); the trigger alder_assert_fence() rejects every machine-role projection write whose fence is not
//   the current unexpired one or whose token does not match (reading the fence from worker_leases is not enough).
import os from 'node:os';import {randomUUID} from 'node:crypto';
export type Lease={name:string,holder:string,fence:string,token:string};
export const LEASE_NAME='indexer';export const LEASE_TTL_SECONDS=30;
export const newHolder=(role:string)=>`${role}:${os.hostname()}:${process.pid}:${randomUUID().slice(0,8)}`;
export async function acquireLease(pool:any,holder:string,name=LEASE_NAME,ttl=LEASE_TTL_SECONDS):Promise<Lease|null>{
 const db=await pool.connect();try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='2s'");
  const r=(await db.query('SELECT fence,token FROM public.alder_lease_acquire($1,$2,$3)',[name,holder,ttl])).rows[0];
  if(!r){await db.query('ROLLBACK');return null;}
  await db.query('COMMIT');return {name,holder,fence:r.fence,token:r.token};
 }catch(e:any){await db.query('ROLLBACK').catch(()=>{});if(e?.code==='55P03')return null;throw e;}finally{db.release();}
}
export async function renewLease(pool:any,l:Lease,state='leased',detail:any={},ttl=LEASE_TTL_SECONDS){
 return (await pool.query('SELECT public.alder_lease_renew($1,$2,$3,$4,$5,$6) AS ok',[l.name,l.fence,l.token,ttl,state,JSON.stringify(detail)])).rows[0]?.ok===true;
}
/** Keep a lease alive during a long read-only reconciliation phase. The heartbeat
 * is stopped and joined before callers enter their fenced projection transaction. */
export async function withReadPhaseLeaseHeartbeat<T,R>(pool:any,lease:Lease,readPhase:()=>Promise<T>,writePhase:(value:T)=>Promise<R>,options:{intervalMs?:number,ttlSeconds?:number,state?:string,detail?:any}={}){
 const intervalMs=options.intervalMs??10_000,ttlSeconds=options.ttlSeconds??LEASE_TTL_SECONDS;
 if(!Number.isFinite(intervalMs)||intervalMs<1||!Number.isFinite(ttlSeconds)||ttlSeconds<1)throw Error('LEASE_HEARTBEAT_INTERVAL_INVALID');
 let stopped=false,running:Promise<void>|null=null,timer:ReturnType<typeof setTimeout>|null=null;
 let failureCode:string|null=null;
 const schedule=()=>{if(!stopped&&!failureCode)timer=setTimeout(tick,intervalMs);};
 const tick=()=>{
  if(stopped||failureCode||running)return;
  running=(async()=>{
   try{if(!await renewLease(pool,lease,options.state??'leased',options.detail??{},ttlSeconds))failureCode='LEASE_LOST';}
   catch{failureCode='LEASE_HEARTBEAT_FAILED';}
   finally{running=null;schedule();}
  })();
 };
 const stop=async()=>{stopped=true;if(timer){clearTimeout(timer);timer=null;}if(running)await running;};
 try{
  timer=setTimeout(tick,intervalMs);
  const value=await readPhase();
  await stop();
  if(failureCode)throw Object.assign(Error(failureCode),{code:failureCode});
  return await writePhase(value);
 }finally{await stop();}
}
// Inside an already fenced transaction (the pass extends its own lease before committing).
export async function extendLeaseInTx(db:any,l:Lease,ttl=LEASE_TTL_SECONDS){
 if((await db.query('SELECT public.alder_lease_renew($1,$2,$3,$4,NULL,NULL) AS ok',[l.name,l.fence,l.token,ttl])).rows[0]?.ok!==true)throw Object.assign(Error('LEASE_LOST'),{code:'LEASE_LOST'});
}
export async function releaseLease(pool:any,l:Lease){
 return (await pool.query('SELECT public.alder_lease_release($1,$2,$3) AS ok',[l.name,l.fence,l.token])).rows[0]?.ok===true;
}
// Called inside an open transaction on `db`.
export async function assertLease(db:any,l:Lease){
 try{await db.query('SELECT public.alder_lease_assert($1,$2,$3)',[l.name,l.fence,l.token]);}
 catch(e:any){if(/LEASE_LOST/.test(String(e?.message)))throw Object.assign(Error('LEASE_LOST'),{code:'LEASE_LOST'});throw e;}
}
export async function fenced<T>(pool:any,l:Lease,fn:(db:any)=>Promise<T>):Promise<T>{
 const db=await pool.connect();try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await assertLease(db,l);const out=await fn(db);await db.query('COMMIT');return out;}
 catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
}
export async function leaseStatus(pool:any,name=LEASE_NAME){
 return (await pool.query(`SELECT name,holder,fence::text,acquired_at,expires_at,heartbeat_at,state,detail,expires_at>now() AS live,extract(epoch FROM now()-heartbeat_at)::float AS heartbeat_age_s FROM worker_leases WHERE name=$1`,[name])).rows[0]||null;
}
