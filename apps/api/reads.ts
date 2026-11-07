// Round 6 (TR-T-LOAD): bounded workspace reads.
// - GET /snapshot keeps every key the UI and runners use, but its size no longer grows with the number of payables,
//   operations, reports or settlements: lists are a bounded working set plus exact server-side counts/totals, and every
//   capped list is described in `limits` ({included,total?,truncated}). Full lists are read through cursor pages.
// - GET /reads/payables, /reads/payables/:id, /reads/operations, /reads/contacts: keyset pages (limit<=200) with opaque,
//   HMAC-bound cursors (workspace + filter digest); tampered/foreign cursors are 404 CURSOR_INVALID, malformed filters 422.
// All reads run in ONE read-only transaction per request (one pooled connection, RLS context set once by scopedPool) with
// a statement timeout, instead of ~25 auto-committed round trips.
import fs from 'node:fs';import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {rpc,tokenAbi} from '../../packages/intent.ts';
import {readinessIndex,readinessSummary,eventsCursor,refOrder,type ReadyRow} from './eligibility.ts';
import {policySummary} from './policy.ts';
import {projectDestinationHolds,readCurrentHoldLineage} from './destination-holds.ts';
const fail=(statusCode:number,code:string)=>Object.assign(new Error(code),{statusCode});
const json=(v:any)=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));
export const LIMITS={smallWorkspacePayables:500,workingSetPerView:25,recentPayables:25,openOperations:300,recentOperations:100,fullManifests:40,
 reservations:2000,releases:500,invalidations:500,holds:500,contacts:200,events:100,pageMax:200,pageDefault:50};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL=['verified','invalidated','voided_lineage_lost'];
// ---- cursor codec (exported for tests) ----
const SECRET=randomBytes(32);
export function encodeCursor(ws:string,filterDigest:string,key:any):string{const body=Buffer.from(JSON.stringify({v:1,k:key})).toString('base64url');return body+'.'+createHmac('sha256',SECRET).update(ws+'|'+filterDigest+'|'+body).digest('base64url');}
export function decodeCursor(ws:string,filterDigest:string,cursor:unknown):any{
 if(typeof cursor!=='string'||cursor.length>600||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor))throw fail(404,'CURSOR_INVALID');
 const [body,sig]=cursor.split('.');const want=createHmac('sha256',SECRET).update(ws+'|'+filterDigest+'|'+body).digest('base64url');
 if(!timingSafeEqual(Buffer.from(want),Buffer.from(sig)))throw fail(404,'CURSOR_INVALID');
 try{const v=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));if(v?.v!==1)throw 0;return v.k;}catch{throw fail(404,'CURSOR_INVALID');}
}
const digestOf=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const parseLimit=(v:any)=>{if(v===undefined)return LIMITS.pageDefault;if(typeof v!=='string'||!/^[1-9][0-9]{0,2}$/.test(v)||Number(v)>LIMITS.pageMax)throw fail(422,'INVALID_LIMIT');return Number(v);};
const onlyKeys=(q:any,keys:string[])=>{if(Object.keys(q||{}).some(k=>!keys.includes(k))||Object.values(q||{}).some(v=>typeof v!=='string'))throw fail(422,'INVALID_FILTER');};
// ---- deployment + chain reads (short-lived cache; display only) ----
let dep:{path:string,mtime:number,value:any}|null=null;
function deployment(){const path=process.env.ALDER_DEPLOYMENT_FILE||'evidence/app-deployment.json';const mtime=fs.statSync(path).mtimeMs;if(!dep||dep.path!==path||dep.mtime!==mtime)dep={path,mtime,value:JSON.parse(fs.readFileSync(path,'utf8'))};return dep.value;}
const CHAIN_TTL_MS=Number(process.env.ALDER_SNAPSHOT_CHAIN_TTL_MS||500);let chain:{at:number,key:string,p:Promise<any>}|null=null;
function chainView(d:any){const key=d.genesis+d.token+d.safe+d.executor;if(chain&&chain.key===key&&Date.now()-chain.at<CHAIN_TTL_MS)return chain.p;
 const p=(async()=>{try{const [balance,allowance,lineage]=await Promise.all([rpc.readContract({address:d.token,abi:tokenAbi,functionName:'balanceOf',args:[d.safe]}),rpc.readContract({address:d.token,abi:tokenAbi,functionName:'allowance',args:[d.safe,d.executor]}),readCurrentHoldLineage()]);return {balance,allowance,block:lineage.headHash,...lineage,chainError:null};}
  catch{return {balance:null,allowance:null,block:null,chainError:'CHAIN_UNAVAILABLE_OR_DEPLOYMENT_MISSING'};}})();// failures are cached for the same short TTL: an unavailable RPC must not add its retry latency to every snapshot
 chain={at:Date.now(),key,p};return p;}
// One read-only transaction per request on the scoped pool.
export async function readTx<T>(pool:any,fn:(db:any)=>Promise<T>,timeoutMs=Number(process.env.ALDER_READ_STATEMENT_TIMEOUT_MS||5000)):Promise<T>{
 const db=await pool.connect();try{await db.query('BEGIN');await db.query('SET TRANSACTION READ ONLY');await db.query(`SET LOCAL statement_timeout=${Math.max(100,Math.floor(timeoutMs))}`);const out=await fn(db);await db.query('COMMIT');return out;}
 catch(e:any){await db.query('ROLLBACK').catch(()=>{});if(e?.code==='57014')throw Object.assign(fail(503,'READ_TIMEOUT'),{retryable:true});throw e;}finally{db.release();}
}
const PAYABLE_COLUMNS='p.*';
async function payableRows(db:any,ws:string,ids:string[]){if(!ids.length)return [];return (await db.query(`SELECT ${PAYABLE_COLUMNS} FROM payables p WHERE p.workspace_id=$1 AND p.id=ANY($2::uuid[])`,[ws,ids])).rows;}
const snapshotPayableSelectionCache=new WeakMap<ReadyRow[],string[]>();
export function snapshotPayableIds(rows:ReadyRow[],latestBatchIds:string[]=[]):string[]{
 let base=snapshotPayableSelectionCache.get(rows);
 if(!base){
  if(rows.length<=LIMITS.smallWorkspacePayables)base=rows.map(r=>r.id);
  else{const ids=new Set<string>();const take=(pred:(r:ReadyRow)=>boolean,n:number)=>{let k=0;for(const r of rows){if(k>=n)break;if(pred(r)){ids.add(r.id);k++;}}};
   take(r=>r.ready,LIMITS.workingSetPerView);take(r=>!r.settled&&!r.reviewed,LIMITS.workingSetPerView);take(r=>!r.settled&&!r.verified,6);take(()=>true,LIMITS.workingSetPerView);
   for(const r of [...rows].filter(r=>r.created_at!==null).sort((a,b)=>(b.created_at as number)-(a.created_at as number)).slice(0,LIMITS.recentPayables))ids.add(r.id);
   base=[...ids];}
  snapshotPayableSelectionCache.set(rows,base);
 }
 return latestBatchIds.length?[...new Set([...base,...latestBatchIds])]:base;
}
export function snapshotContactPage(rows:any[],total:string|number){
 const contacts=rows.slice(0,LIMITS.contacts).map(({_snapshot_total,...c}:any)=>c);
 contacts.sort((a:any,b:any)=>a.display_name<b.display_name?-1:a.display_name>b.display_name?1:a.id<b.id?-1:a.id>b.id?1:0);
 const exactTotal=String(total);return {contacts,limits:{included:contacts.length,total:exactTotal,truncated:BigInt(exactTotal)>BigInt(contacts.length),page_route:'/reads/contacts'}};
}
// Slim manifest for operations outside the full-manifest set (history only; nothing signable).
const slim=(m:any)=>m&&{slim:true,safeTxHash:m.safeTxHash,genesis:m.genesis,batchId:m.batchId,threshold:m.threshold,safe:m.safe,method:m.method,target:m.target?{operationId:m.target.operationId,nonce:m.target.nonce,batchId:m.target.batchId}:undefined,message:m.message?{nonce:m.message.nonce}:undefined,reset:m.reset,itemCount:Array.isArray(m.items)?m.items.length:undefined};
export async function buildSnapshot(db:any,ws:string,identity:any,roles:any){
 const cursor=await eventsCursor(db,ws);const d=(()=>{try{return deployment();}catch{return null;}})();
 const chainP=d?chainView(d):Promise.resolve({balance:null,allowance:null,block:null,chainError:'CHAIN_UNAVAILABLE_OR_DEPLOYMENT_MISSING'});
 const ix=await readinessIndex(db,ws,cursor);const summary=readinessSummary(ix);
 // Operations: every open (non-terminal) operation up to a cap, plus the most recent ones of any state.
 const operations=(await db.query(`SELECT id,kind,manifest,state,created_at FROM treasury_operations WHERE workspace_id=$1 AND id IN (
   (SELECT id FROM treasury_operations WHERE workspace_id=$1 AND NOT (state=ANY($2::text[])) ORDER BY created_at DESC,id DESC LIMIT $3)
   UNION (SELECT id FROM treasury_operations WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $4)) ORDER BY created_at,id`,[ws,TERMINAL,LIMITS.openOperations,LIMITS.recentOperations])).rows;
 const opTotal=Number((await db.query('SELECT count(*)::int n FROM treasury_operations WHERE workspace_id=$1',[ws])).rows[0].n);
 const opIds=operations.map((o:any)=>o.id);
 const batches=(await db.query(`SELECT b.workspace_id,b.id,b.manifest,b.state,b.operation_id FROM batches b LEFT JOIN treasury_operations o ON o.workspace_id=b.workspace_id AND o.id=b.operation_id
   WHERE b.workspace_id=$1 AND (b.operation_id=ANY($2::uuid[]) OR b.id IN (SELECT batch_id FROM reservations WHERE workspace_id=$1) OR (b.operation_id IS NULL AND b.id IN (SELECT id FROM batches WHERE workspace_id=$1 AND operation_id IS NULL LIMIT 20)))
   ORDER BY o.created_at NULLS FIRST`,[ws,opIds])).rows;
 const latestBatch=batches.filter((b:any)=>b.state!=='voided_lineage_lost').at(-1);
 // Full manifests: open operations, the latest operation of each kind, the latest batch, and the newest few.
 const full=new Set<string>();for(const o of operations)if(!TERMINAL.includes(o.state))full.add(o.id);
 for(const k of ['payout','allowance','invalidation']){const last=operations.filter((o:any)=>o.kind===k).at(-1);if(last)full.add(last.id);}
 if(latestBatch?.operation_id)full.add(latestBatch.operation_id);for(const o of operations.slice(-LIMITS.fullManifests))full.add(o.id);
 for(const o of operations)if(!full.has(o.id))o.manifest=slim(o.manifest);
 for(const b of batches)if(b!==latestBatch&&!full.has(b.operation_id))b.manifest=slim(b.manifest);
 const batchIds=batches.map((b:any)=>b.id);
 const signatures=(await db.query('SELECT batch_id,owner FROM signatures WHERE workspace_id=$1 AND batch_id=ANY($2::uuid[])',[ws,batchIds])).rows;
 const operationSignatures=(await db.query('SELECT operation_id,owner FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=ANY($2::uuid[])',[ws,opIds])).rows;
 const attempts=(await db.query('SELECT id,operation_id,sender,sender_nonce,created_at FROM treasury_attempts WHERE workspace_id=$1 AND operation_id=ANY($2::uuid[]) ORDER BY created_at',[ws,opIds])).rows;
 // Latest report per included operation (history is available per operation, not in every snapshot).
 const reports=(await db.query('SELECT id,operation_id,report,at FROM (SELECT DISTINCT ON (operation_id) id,operation_id,report,at FROM treasury_reports WHERE workspace_id=$1 AND operation_id=ANY($2::uuid[]) ORDER BY operation_id,id DESC) r ORDER BY id',[ws,opIds])).rows;
 // Payables: the whole (small) workspace, or a bounded working set (first pages of each desk view, most recent,
 // and every item of the latest batch) with exact counts/totals in `summary`.
 const truncated=ix.rows.length>LIMITS.smallWorkspacePayables;
 const payIds=(latestBatch?.manifest?.items||[]).map((i:any)=>i.paymentId);
 const batchPayableIds=payIds.length?(await db.query('SELECT id FROM payables WHERE workspace_id=$1 AND payment_id=ANY($2::text[])',[ws,payIds])).rows.map((r:any)=>r.id):[];
 const ids=snapshotPayableIds(ix.rows,batchPayableIds);
 const payables=(await payableRows(db,ws,ids)).sort((a:any,b:any)=>refOrder({ref:a.display_reference,id:a.id},{ref:b.display_reference,id:b.id}));
 const readiness:any={};for(const p of payables){const r=ix.byId.get(p.id);if(r)readiness[p.id]={ready:r.ready,reasons:r.reasons};}
 const settlements=(await db.query('SELECT * FROM treasury_settlements WHERE workspace_id=$1 AND payable_id=ANY($2::uuid[])',[ws,payables.map((p:any)=>p.id)])).rows;
 const invalidations=(await db.query(`SELECT * FROM (SELECT i.operation_id,i.target_operation_id,i.method,i.target_nonce::text,i.invalidation_nonce::text,i.reason,i.requested_by,i.created_at,o.state,o.manifest->>'safeTxHash' AS safe_tx_hash FROM operation_invalidations i JOIN treasury_operations o ON o.workspace_id=i.workspace_id AND o.id=i.operation_id WHERE i.workspace_id=$1 ORDER BY i.created_at DESC LIMIT $2) x ORDER BY created_at`,[ws,LIMITS.invalidations])).rows;
 const releases=(await db.query('SELECT * FROM (SELECT payable_id,batch_id,target_operation_id,invalidation_operation_id,report_id::text,fence::text,released_at FROM reservation_releases WHERE workspace_id=$1 ORDER BY released_at DESC LIMIT $2) x ORDER BY released_at',[ws,LIMITS.releases])).rows;
 const reservations=(await db.query('SELECT payable_id,batch_id FROM reservations WHERE workspace_id=$1 ORDER BY batch_id,payable_id LIMIT $2',[ws,LIMITS.reservations+1])).rows;const reservationsTruncated=reservations.length>LIMITS.reservations;if(reservationsTruncated)reservations.pop();
 const worker=(await db.query("SELECT name,fence::text,state,heartbeat_at,expires_at,expires_at>now() AS live,extract(epoch FROM now()-heartbeat_at)::float AS heartbeat_age_s,detail FROM worker_leases WHERE name='indexer'")).rows[0]||null;
 const outbox={counts:Object.fromEntries((await db.query('SELECT state,count(*)::int n FROM outbox WHERE workspace_id=$1 GROUP BY state',[ws])).rows.map((x:any)=>[x.state,x.n])),held:(await db.query("SELECT id::text,kind,attempts,max_attempts,last_error,created_at FROM outbox WHERE workspace_id=$1 AND state='held' ORDER BY id LIMIT 20",[ws])).rows};
 const workspace=(await db.query('SELECT workspace_id,display_name FROM workspace_profiles WHERE workspace_id=$1',[ws])).rows[0]||{workspace_id:ws,display_name:null};
 const contactRows=(await db.query("SELECT c.*,r.address,r.raw_address,r.chain_id,r.changed_by,coalesce(v.decision,'pending') AS verification_state,count(*) OVER()::text AS _snapshot_total FROM contacts c JOIN contact_revisions r ON r.workspace_id=c.workspace_id AND r.contact_id=c.id AND r.revision=c.revision LEFT JOIN destination_verifications v ON v.workspace_id=c.workspace_id AND v.contact_id=c.id AND v.destination_revision=c.revision WHERE c.workspace_id=$1 ORDER BY (coalesce(v.decision,'pending')='approve'),c.display_name,c.id LIMIT $2",[ws,LIMITS.contacts+1])).rows;
 // Pending verifications come first; retain an exact total while limiting the embedded contact page.
 const contactsPage=snapshotContactPage(contactRows,contactRows[0]?._snapshot_total??'0');
 const events=(await db.query('SELECT * FROM events WHERE workspace_id=$1 ORDER BY id DESC LIMIT $2',[ws,LIMITS.events])).rows;
 const policy=await policySummary(db,ws);const c=await chainP;const destinationHolds=await projectDestinationHolds(db,ws,c.chainError?null:c,undefined,LIMITS.holds);const activeDestinationHolds=destinationHolds.filter((h:any)=>h.resolution!=='resolved'),resolvedDestinationHolds=destinationHolds.filter((h:any)=>h.resolution==='resolved');
 return json({events_cursor:cursor,workspace,readiness,summary,invalidations,releases,reservations,worker,outbox,policy,contacts:contactsPage.contacts,destinationHolds,activeDestinationHolds,resolvedDestinationHolds,operations,operationSignatures,attempts,reports,settlements,chainError:c.chainError,user:{id:identity.user_id,name:identity.name},roles,payables,batches,signatures,events,deployment:d,balance:c.balance,allowance:c.allowance,block:c.block,csrf:identity.csrf,
  limits:{payables:{included:payables.length,total:ix.rows.length,truncated,page_route:'/reads/payables'},operations:{included:operations.length,total:opTotal,truncated:operations.length<opTotal,page_route:'/reads/operations',manifests:'full for open/latest operations; slim otherwise'},reports:{scope:'latest per included operation'},settlements:{scope:'included payables',total_verified:summary.settled.count},reservations:{included:reservations.length,truncated:reservationsTruncated},contacts:contactsPage.limits,events:{included:events.length}}});
}
const VIEWS:Record<string,(r:ReadyRow)=>boolean>={all:()=>true,ready:r=>r.ready,review:r=>!r.settled&&!r.reviewed,held:r=>!r.settled&&!r.verified,unsettled:r=>!r.settled,settled:r=>r.settled,reserved:r=>r.reserved};
export function pagePayables(rows:ReadyRow[],q:{view:string,q:string},limit:number,after:{ref:string,id:string}|null){
 const needle=q.q.toLowerCase(),pred=VIEWS[q.view];const match=rows.filter(r=>pred(r)&&(!needle||r.search.includes(needle)));
 let start=0;if(after){let lo=0,hi=match.length;while(lo<hi){const mid=(lo+hi)>>1;if(refOrder(match[mid],after)<=0)lo=mid+1;else hi=mid;}start=lo;}
 const page=match.slice(start,start+limit);let units=0n;for(const r of match)units+=BigInt(r.amount_units);
 return {page,total:match.length,total_units:units.toString(),more:start+limit<match.length};
}
export function registerReads(app:any,pool:any){
 const member=(req:any)=>{if(!Array.isArray(req.roles)||!req.roles.length)throw fail(403,'ROLE_DENIED');};
 app.get('/api/v1/workspaces/:ws/snapshot',async(req:any)=>{member(req);return readTx(pool,db=>buildSnapshot(db,req.params.ws,req.identity,req.roles));});
 app.get('/api/v1/workspaces/:ws/reads/payables',async(req:any)=>{member(req);const q=req.query||{};onlyKeys(q,['view','q','limit','cursor']);
  const f={view:q.view??'all',q:q.q??''};if(!VIEWS[f.view]||f.q.length>200)throw fail(422,'INVALID_FILTER');const limit=parseLimit(q.limit);const fd=digestOf(f);
  let after:any=null;if(q.cursor!==undefined){const k=decodeCursor(req.params.ws,fd,q.cursor);if(!Array.isArray(k)||k.length!==2||typeof k[0]!=='string'||typeof k[1]!=='string')throw fail(404,'CURSOR_INVALID');after={ref:k[0],id:k[1]};}
  return readTx(pool,async db=>{const ix=await readinessIndex(db,req.params.ws);const r=pagePayables(ix.rows,f,limit,after);
   const rows=await payableRows(db,req.params.ws,r.page.map(x=>x.id));const byId=new Map<string,any>(rows.map((x:any)=>[x.id,x]));
   const settled=new Map((await db.query('SELECT payable_id,state FROM treasury_settlements WHERE workspace_id=$1 AND payable_id=ANY($2::uuid[])',[req.params.ws,r.page.map(x=>x.id)])).rows.map((x:any)=>[x.payable_id,x.state]));
   const items=r.page.map(x=>byId.get(x.id)?{...byId.get(x.id),readiness:{ready:x.ready,reasons:x.reasons},settlement_state:settled.get(x.id)??null}:null).filter(Boolean);
   const last=r.page.at(-1);
   return json({items,total_count:String(r.total),total_units:r.total_units,limit,filters:f,next_cursor:r.more&&last?encodeCursor(req.params.ws,fd,[last.ref,last.id]):null,index_key:ix.key,not_authorization:true});});});
 app.get('/api/v1/workspaces/:ws/reads/payables/:id',async(req:any)=>{member(req);if(!UUID.test(req.params.id))throw fail(404,'NOT_FOUND');
  return readTx(pool,async db=>{const row=(await payableRows(db,req.params.ws,[req.params.id]))[0];if(!row)throw fail(404,'NOT_FOUND');const ix=await readinessIndex(db,req.params.ws);const x=ix.byId.get(row.id);
   const st=(await db.query('SELECT * FROM treasury_settlements WHERE workspace_id=$1 AND payable_id=$2',[req.params.ws,row.id])).rows;return json({...row,readiness:x?{ready:x.ready,reasons:x.reasons}:null,settlements:st});});});
 app.get('/api/v1/workspaces/:ws/reads/operations',async(req:any)=>{member(req);const q=req.query||{};onlyKeys(q,['kind','limit','cursor']);
  const f={kind:q.kind??'all'};if(!['all','payout','allowance','invalidation'].includes(f.kind))throw fail(422,'INVALID_FILTER');const limit=parseLimit(q.limit);const fd=digestOf(f);
  let after:any=null;if(q.cursor!==undefined){const k=decodeCursor(req.params.ws,fd,q.cursor);if(!Array.isArray(k)||k.length!==2||typeof k[0]!=='string'||!UUID.test(String(k[1])))throw fail(404,'CURSOR_INVALID');after=k;}
  return readTx(pool,async db=>{const rows=(await db.query(`SELECT id,kind,state,created_at,manifest->>'safeTxHash' AS safe_tx_hash,manifest->'message'->>'nonce' AS safe_nonce,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS k
    FROM treasury_operations WHERE workspace_id=$1 AND ($2='all' OR kind=$2) AND ($3::text IS NULL OR (to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),id::text)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $5`,[req.params.ws,f.kind,after?.[0]??null,after?.[1]??null,limit+1])).rows;
   const more=rows.length>limit;if(more)rows.pop();const last=rows.at(-1);
   const latest=new Map((await db.query("SELECT DISTINCT ON (operation_id) operation_id,report->>'state' AS state,report->>'reason' AS reason FROM treasury_reports WHERE workspace_id=$1 AND operation_id=ANY($2::uuid[]) ORDER BY operation_id,id DESC",[req.params.ws,rows.map((r:any)=>r.id)])).rows.map((r:any)=>[r.operation_id,{state:r.state,reason:r.reason}]));
   return json({items:rows.map(({k,...r}:any)=>({...r,latest_report:latest.get(r.id)??null})),limit,filters:f,next_cursor:more&&last?encodeCursor(req.params.ws,fd,[last.k,last.id]):null});});});
 app.get('/api/v1/workspaces/:ws/reads/contacts',async(req:any)=>{member(req);const q=req.query||{};onlyKeys(q,['q','limit','cursor']);
  const f={q:q.q??''};if(f.q.length>200)throw fail(422,'INVALID_FILTER');const limit=parseLimit(q.limit);const fd=digestOf(f);
  let after:any=null;if(q.cursor!==undefined){const k=decodeCursor(req.params.ws,fd,q.cursor);if(!Array.isArray(k)||k.length!==2||typeof k[0]!=='string'||!UUID.test(String(k[1])))throw fail(404,'CURSOR_INVALID');after=k;}
  return readTx(pool,async db=>{const rows=(await db.query(`SELECT c.*,r.address,r.raw_address,r.chain_id,r.changed_by,coalesce(v.decision,'pending') AS verification_state FROM contacts c JOIN contact_revisions r ON r.workspace_id=c.workspace_id AND r.contact_id=c.id AND r.revision=c.revision LEFT JOIN destination_verifications v ON v.workspace_id=c.workspace_id AND v.contact_id=c.id AND v.destination_revision=c.revision
    WHERE c.workspace_id=$1 AND ($2='' OR strpos(lower(c.display_name),lower($2))>0) AND ($3::text IS NULL OR (c.display_name COLLATE "C",c.id)>($3::text COLLATE "C",$4::uuid)) ORDER BY c.display_name COLLATE "C",c.id LIMIT $5`,[req.params.ws,f.q,after?.[0]??null,after?.[1]??null,limit+1])).rows;
   const more=rows.length>limit;if(more)rows.pop();const last=rows.at(-1);return json({items:rows,limit,filters:f,next_cursor:more&&last?encodeCursor(req.params.ws,fd,[last.display_name,last.id]):null});});});
}
