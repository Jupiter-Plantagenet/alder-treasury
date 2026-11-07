// Round 5 continuous indexer / reconciler / outbox worker (TR-T-DURABLE, FAULT, REORG).
// A separate process. Exactly one active writer: it must hold the `indexer` lease; every projection write carries the
// lease fence and is rejected by the database if stale. Standby instances only poll for the lease.
//  - each loop: renew lease -> answer queued resync/rebuild requests or run a periodic fenced pass -> dispatch outbox
//  - failures back off exponentially (cap 30 s); after 5 consecutive failures the lease state shows `degraded` with
//    retry_exhausted=true (visible in the recovery screen) while probing continues
//  - status endpoint: GET http://127.0.0.1:<ALDER_WORKER_PORT|8113>/status (loopback only, no secrets)
// Fault-injection points (only when explicitly set in the environment of a test-launched instance):
//  ALDER_WORKER_FAULT=before-commit|after-deliver and ALDER_WORKER_FAULT_MS=<ms>.
import http from 'node:http';import fs from 'node:fs';import pg from 'pg';
import {databaseUrl} from '../apps/api/database.ts';
import {acquireLease,renewLease,releaseLease,newHolder,fenced,type Lease} from './lease.ts';
import {reconcileApplication} from './treasury-indexer.ts';import {dispatchOutbox} from './outbox.ts';
const PORT=Number(process.env.ALDER_WORKER_PORT||8113),INTERVAL=Number(process.env.ALDER_WORKER_INTERVAL_MS||3000);
const FAULT=process.env.ALDER_WORKER_FAULT||'',FAULT_MS=Number(process.env.ALDER_WORKER_FAULT_MS||0);
const LOG=process.env.ALDER_WORKER_LOG||'runtime-logs/indexer-worker.jsonl';
// Round 6: an ISOLATED test worker (scratch PostgreSQL 1554x, alder_indexer role only, isolated RPC 18547) may be started
// with ALDER_ISOLATED_WORKER_DB; the production path keeps databaseUrl's strict 5543 allowlist.
const isolatedDb=process.env.ALDER_ISOLATED_WORKER_DB;if(isolatedDb&&(!/^postgresql:\/\/alder_indexer@127\.0\.0\.1:1554[3-9]\/[a-z0-9_]+$/.test(isolatedDb)||process.env.ALDER_RPC_URL!=='http://127.0.0.1:18547'))throw Error('ISOLATED_WORKER_SCRATCH_ONLY');
const pool=new pg.Pool({connectionString:isolatedDb||databaseUrl('indexer'),max:4,application_name:'alder-worker:'+process.pid,connectionTimeoutMillis:10000,options:'-c idle_in_transaction_session_timeout=20000 -c statement_timeout=120000'});
pool.on('error',()=>{});
const holder=newHolder(process.env.ALDER_WORKER_ROLE||'worker');let lease:Lease|null=null;let stopping=false;
const status:any={holder,pid:process.pid,role:'starting',phase:'starting',fence:null,passes:0,last_pass:null,last_result:null,last_error:null,consecutive_failures:0,retry_exhausted:false,outbox:{delivered:0,failed:0,held:0},started_at:new Date().toISOString(),fault:FAULT||null};
const log=(kind:string,data:any={})=>{const line=JSON.stringify({at:new Date().toISOString(),pid:process.pid,holder,fence:lease?.fence??null,kind,...data});try{fs.mkdirSync(LOG.replace(/[\\/][^\\/]+$/,''),{recursive:true});fs.appendFileSync(LOG,line+'\n');}catch{}console.log(line);};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer((req,res)=>{if(req.method==='GET'&&(req.url==='/status'||req.url==='/health')){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({...status,lease:lease?{name:lease.name,fence:lease.fence}:null}));return;}res.writeHead(404);res.end();});
server.on('error',(e:any)=>{log('status-port-error',{code:e.code});process.exit(3);});
server.listen(PORT,'127.0.0.1',()=>log('listening',{port:PORT}));
async function shutdown(sig:string){if(stopping)return;stopping=true;log('shutdown',{sig});if(lease)await releaseLease(pool,lease).catch(()=>{});await pool.end().catch(()=>{});process.exit(0);}
for(const s of ['SIGINT','SIGTERM','SIGBREAK'])process.on(s as any,()=>void shutdown(s));
let lastPass=0,backoff=0;
while(!stopping){
 try{
  if(!lease){lease=await acquireLease(pool,holder);if(!lease){status.role='standby';status.phase='standby';status.fence=null;await sleep(2000);continue;}status.role='active';status.fence=lease.fence;log('lease-acquired');}
  else{const state=status.retry_exhausted?'degraded':status.consecutive_failures?'retrying':'leased';
   if(!await renewLease(pool,lease,state,{consecutive_failures:status.consecutive_failures,retry_exhausted:status.retry_exhausted,last_error:status.last_error,last_pass:status.last_pass,pid:process.pid})){log('lease-lost');lease=null;status.role='standby';continue;}}
  const requests=(await pool.query('SELECT id::text,kind FROM indexer_requests WHERE done_at IS NULL ORDER BY id LIMIT 50')).rows;
  if(requests.length||(Date.now()-lastPass>=Math.max(INTERVAL,backoff))){
   const rebuild=requests.some((r:any)=>r.kind==='rebuild'),ids=requests.map((r:any)=>r.id);status.phase=rebuild?'rebuilding':'reconciling';const t=Date.now();
   try{const result=await reconcileApplication(pool,{lease,rebuild,faultBeforeCommitMs:FAULT==='before-commit'?FAULT_MS:0,beforeCommit:async(db,res)=>{status.phase='committing';if(ids.length)await db.query('UPDATE indexer_requests SET claimed_fence=$2,done_at=now(),result=$3 WHERE id=ANY($1::bigint[]) AND done_at IS NULL',[ids,lease!.fence,res]);}});
    status.passes++;status.last_pass=new Date().toISOString();status.last_result={...result,ms:Date.now()-t};status.consecutive_failures=0;status.retry_exhausted=false;status.last_error=null;backoff=0;
    if(result.changed||result.released||result.outbox||ids.length||result.paused||result.window?.mode==='full'||Date.now()-t>2000)log('pass',{ms:Date.now()-t,requests:ids.length,rebuild,changed:result.changed,released:result.released,outbox:result.outbox,head:result.head,paused:result.paused,dup:result.duplicate_logs_collapsed,window:result.window,phase1_ms:result.phase1_ms,phase2_ms:result.phase2_ms,skipped_concurrent:result.skipped_concurrent,disagreement:result.disagreement??null});}
   catch(e:any){const msg=String(e?.message||e).slice(0,300);status.consecutive_failures++;status.last_error=msg;status.retry_exhausted=status.consecutive_failures>=5;backoff=Math.min(30000,1000*2**(status.consecutive_failures-1));log('pass-failed',{error:msg,consecutive:status.consecutive_failures,backoff_ms:backoff});
    if(/LEASE_LOST|STALE_FENCE/.test(msg)){lease=null;status.role='standby';continue;}
    if(ids.length)await fenced(pool,lease,async db=>{await db.query('UPDATE indexer_requests SET claimed_fence=$2,done_at=now(),error=$3 WHERE id=ANY($1::bigint[]) AND done_at IS NULL',[ids,lease!.fence,msg]);}).catch(()=>{});}
   lastPass=Date.now();
  }
  status.phase='dispatching';
  const d=await dispatchOutbox(pool,lease,holder,{faultAfterDeliverMs:FAULT==='after-deliver'?FAULT_MS:0,onEffect:(id)=>{status.phase='effect-written:'+id;},onDelivered:(id)=>{status.phase='delivered:'+id;}});
  status.outbox.delivered+=d.delivered;status.outbox.failed+=d.failed;status.outbox.held+=d.held;if(d.claimed)log('outbox',d);
  status.phase='idle';await sleep(500);
 }catch(e:any){const msg=String(e?.message||e).slice(0,300);status.last_error=msg;log('loop-error',{error:msg});if(/LEASE_LOST|STALE_FENCE/.test(msg)){lease=null;status.role='standby';}await sleep(1000);}
}
