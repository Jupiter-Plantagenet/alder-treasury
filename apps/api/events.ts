// TR-SSE (round 4): durable, redacted workspace event stream over Server-Sent Events.
// - Source of truth is the committed PostgreSQL `events` table (bigint sequence). The stream is a notification
//   channel only: clients must re-read the authoritative snapshot; nothing here ever implies chain settlement.
// - Resume with `Last-Event-ID` (or ?after=N). Cursors older than the 7-day replay horizon or beyond the newest
//   event get 410 EVENTS_GAP_RESNAPSHOT before any stream starts, forcing a full resnapshot.
// - Every poll re-checks the session and current membership under RLS; revocation ends the stream (<= ~1 s).
// - Payloads are redacted to an allowlist of identifiers/states; no names, addresses, amounts or references.
const fail=(status:number,code:string)=>Object.assign(new Error(code),{statusCode:status});
export const EVENT_RETENTION_DAYS=7;
const ALLOWED=['id','operation_id','report_id','state','entity','entity_id','revision','payable_id','payable_revision','policy_id','policy_revision','batch_id','decision','schema_version','event_id','correlation_id'];
export function redactEvent(e:any){const data:any={};const src=e.data&&typeof e.data==='object'?e.data:{};for(const k of ALLOWED)if(src[k]!==undefined&&(typeof src[k]==='string'||typeof src[k]==='number'||src[k]===null))data[k]=src[k];return {id:String(e.id),kind:String(e.kind),at:e.at instanceof Date?e.at.toISOString():String(e.at),data};}
// Round 5 (review M4/L2): per-session (3) and per-user (6) concurrent stream caps -> 429 SSE_LIMIT; one combined
// RLS-scoped query per tick (liveness + new events + a WORKSPACE-scoped late-commit window); delivered-id set dedupe;
// 7-day horizon enforced even when the workspace has no recent events. Ids are ordered NUMERICALLY (bigint), sent as text. Clients open at the snapshot's events_cursor.
export const SSE_PER_SESSION=3,SSE_PER_USER=6;
const NL='\n';
const frame=(lines:string[])=>lines.join(NL)+NL+NL;
export function registerEventStream(app:any,pool:any,opts:{pollMs?:number,maxMs?:number,lookback?:number}={}){
 const pollMs=opts.pollMs??1000,maxMs=opts.maxMs??600000,lookback=opts.lookback??100;
 const open=new Map<string,number>();const inc=(k:string,d:number)=>{const n=(open.get(k)||0)+d;if(n<=0)open.delete(k);else open.set(k,n);};
 app.get('/api/v1/workspaces/:ws/events/stream',async(req:any,reply:any)=>{
  const ws=req.params.ws,identity=req.identity;
  const raw=req.headers['last-event-id']??req.query?.after;
  if(raw!==undefined&&!/^(0|[1-9][0-9]{0,18})$/.test(String(raw)))throw fail(422,'INVALID_CURSOR');
  const sKey='s:'+identity.token_hash,uKey='u:'+identity.user_id;
  // Round 6 (review F-M5): reserve the slot SYNCHRONOUSLY (check + increment with no await in between), then release it
  // on every exit path, so N concurrent opens can never exceed the caps.
  if((open.get(sKey)||0)>=SSE_PER_SESSION||(open.get(uKey)||0)>=SSE_PER_USER){reply.header('Retry-After','5');throw fail(429,'SSE_LIMIT');}
  inc(sKey,1);inc(uKey,1);let counted=true;const release=()=>{if(counted){counted=false;inc(sKey,-1);inc(uKey,-1);}};
  let started_ok=false,newest=0n,cursor=0n;try{
  const bounds=(await pool.query(`SELECT coalesce(max(id),0)::text AS newest,coalesce(min(id) FILTER (WHERE at>now()-make_interval(days=>$2)),0)::text AS horizon FROM events WHERE workspace_id=$1`,[ws,EVENT_RETENTION_DAYS])).rows[0];
  newest=BigInt(bounds.newest);const horizon=BigInt(bounds.horizon)>0n?BigInt(bounds.horizon):newest+1n;
  cursor=raw===undefined?newest:BigInt(String(raw));
  if(cursor>newest||(raw!==undefined&&cursor<newest&&cursor<horizon-1n))throw fail(410,'EVENTS_GAP_RESNAPSHOT');
  started_ok=true;}finally{if(!started_ok)release();}
  reply.hijack();const res=reply.raw;
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});
  res.write(frame(['retry: 2000','event: ready','data: '+JSON.stringify({cursor:String(cursor),newest:String(newest),retention_days:EVENT_RETENTION_DAYS,authoritative:'snapshot',settlement_inference:false})]));
  const floor=cursor;const delivered=new Set<string>();let closed=false,busy=false,lastBeat=Date.now();const started=Date.now();
  const end=(kind?:string)=>{if(closed)return;closed=true;clearInterval(timer);release();try{if(kind)res.write(frame(['event: '+kind,'data: {}']));res.end();}catch{}};
  const tick=async()=>{if(closed||busy)return;busy=true;try{
   const r=(await pool.query(`SELECT (SELECT count(*) FROM sessions WHERE token_hash=$1 AND expires_at>now())::int AS s,(SELECT count(*) FROM memberships WHERE workspace_id=$2 AND user_id=$3)::int AS m,
     coalesce((SELECT json_agg(json_build_object('id',e.id::text,'kind',e.kind,'at',e.at,'data',e.data) ORDER BY e.id) FROM (SELECT events.id,kind,at,data FROM events WHERE workspace_id=$2 AND events.id>$4 ORDER BY events.id LIMIT 500) e),'[]'::json) AS fresh,
     coalesce((SELECT json_agg(json_build_object('id',e.id::text,'kind',e.kind,'at',e.at,'data',e.data) ORDER BY e.id) FROM (SELECT events.id,kind,at,data FROM events WHERE workspace_id=$2 AND events.id>$5 AND events.id<=$4 ORDER BY events.id DESC LIMIT $6) e),'[]'::json) AS late`,[identity.token_hash,ws,identity.user_id,cursor.toString(),floor.toString(),lookback])).rows[0];
   if(!r.s||!r.m)return end('revoked');
   for(const e of [...r.late,...r.fresh]){const id=String(e.id);if(delivered.has(id)||BigInt(id)<=floor)continue;delivered.add(id);if(BigInt(id)>cursor)cursor=BigInt(id);res.write(frame(['id: '+id,'event: tr-event','data: '+JSON.stringify(redactEvent(e))]));}
   if(delivered.size>4*lookback){const keep=[...delivered].map(x=>BigInt(x)).sort((a,b)=>a<b?-1:1).slice(-2*lookback);delivered.clear();for(const k of keep)delivered.add(String(k));}
   if(Date.now()-lastBeat>15000){res.write(': keep-alive'+NL+NL);lastBeat=Date.now();}
   if(Date.now()-started>maxMs)end('rotate');
  }catch{end('stream-error');}finally{busy=false;}};
  const timer=setInterval(()=>void tick(),pollMs);res.on('close',()=>{closed=true;clearInterval(timer);release();});void tick();
 });
}
