// Review M5: "ready to batch" is computed server-side with the SAME predicates freeze enforces:
// current verified destination revision, review bound to the current policy revision + exact payable revision +
// recorded reviewer, a matching policy rule, not reserved and not already settled.
// Round 6 (TR-T-LOAD): the per-payable evaluation is kept as one compact, ordered index per workspace so that reads are
// bounded (pages, counts, totals) instead of shipping every payable to every client. The index is display-only: freeze
// re-checks every predicate under the workspace domain lock, so a stale index can never authorize anything.
import {currentPolicy,matchPolicy} from './policy.ts';
export type ReadyRow={id:string,ref:string,contact:string,amount_units:string,ready:boolean,reasons:string[],reviewed:boolean,verified:boolean,settled:boolean,reserved:boolean,created_at:number|null,search:string,
 revision:number,contact_id:string|null,token_identity:any,destination_current:boolean,review_current:boolean,matched:string[],service:string};
export type ReadyIndex={key:string,cursor:string,builtAt:number,rows:ReadyRow[],byId:Map<string,ReadyRow>,policy:{id:string,revision:number}|null,mode?:'full'|'incremental',recent:Set<string>,pendingXids:string[]};
// Byte-order comparison, independent of the database collation (keyset cursors depend on it).
export const refOrder=(a:{ref:string,id:string},b:{ref:string,id:string})=>a.ref<b.ref?-1:a.ref>b.ref?1:a.id<b.id?-1:a.id>b.id?1:0;
const ROWS_SQL=`SELECT p.id,p.display_reference,p.contact,p.service,p.amount_units::text AS amount_units,p.contact_id,p.reviewed_by,p.revision,p.verified,i.token_identity,extract(epoch FROM i.created_at)::float8 AS created_at,
   (p.verified AND p.contact_id IS NOT NULL AND c.revision IS NOT DISTINCT FROM p.destination_revision AND v.decision IS NOT DISTINCT FROM 'approve') AS destination_current,
   EXISTS(SELECT 1 FROM reservations x WHERE x.workspace_id=p.workspace_id AND x.payable_id=p.id) AS reserved,
   EXISTS(SELECT 1 FROM treasury_settlements s WHERE s.workspace_id=p.workspace_id AND s.payable_id=p.id AND s.state='verified') AS settled,
   EXISTS(SELECT 1 FROM business_reviews b WHERE b.workspace_id=p.workspace_id AND b.payable_id=p.id AND b.payable_revision=p.revision AND b.actor_id=p.reviewed_by AND b.decision='approve' AND b.policy_id=$2::uuid AND b.policy_revision=$3) AS review_current
  FROM payables p LEFT JOIN payable_intakes i ON i.workspace_id=p.workspace_id AND i.payable_id=p.id
  LEFT JOIN contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
  LEFT JOIN destination_verifications v ON v.workspace_id=c.workspace_id AND v.contact_id=c.id AND v.destination_revision=c.revision
  WHERE p.workspace_id=$1`;
function toRow(r:any,policy:any):ReadyRow{const reasons:string[]=[];
 const matched=policy?matchPolicy(policy.conditions,{amount_units:r.amount_units,contact_id:r.contact_id??null,token_identity:r.token_identity??null}):[];
 if(r.settled)reasons.push('settled');if(r.reserved)reasons.push('reserved');if(!r.destination_current)reasons.push('destination_hold');
 if(!policy)reasons.push('policy_missing');else if(!matched.length)reasons.push('policy_unmatched');
 if(!r.reviewed_by)reasons.push('review_required');else if(!r.review_current)reasons.push('rereview_required');
 const ref=String(r.display_reference),contact=String(r.contact);
 return {id:r.id,ref,contact,amount_units:r.amount_units,ready:reasons.length===0,reasons,reviewed:!!r.reviewed_by,verified:!!r.verified,settled:!!r.settled,reserved:!!r.reserved,created_at:r.created_at??null,search:(contact+' '+ref).toLowerCase(),
  revision:Number(r.revision),contact_id:r.contact_id??null,token_identity:r.token_identity??null,destination_current:!!r.destination_current,review_current:!!r.review_current,matched,service:String(r.service??'')};}
const finish=(ws:string,cursor:string,builtAt:number,rows:ReadyRow[],policy:any,mode:'full'|'incremental',recent:Set<string>,pendingXids:string[]):ReadyIndex=>({key:ws+':'+cursor,cursor,builtAt,rows,byId:new Map(rows.map(r=>[r.id,r])),policy:policy?{id:policy.id,revision:policy.revision}:null,mode,recent,pendingXids});
// Event ids in (cursor-LOOKBACK, cursor] that an index has incorporated. Sequence order is not commit order: an event whose
// id was allocated before, but committed after, an index was built shows up later BELOW that index's cursor; it is found
// by re-reading the lookback window and comparing with `recent` (never silently skipped).
const LOOKBACK=256n;
const recentEvents=async(db:any,ws:string,from:bigint,to:string)=>(await db.query('SELECT id::text,kind,data FROM events WHERE workspace_id=$1 AND id>$2 AND id<=$3 ORDER BY id LIMIT 1001',[ws,String(from<0n?0n:from),to])).rows;
// Snapshot active transactions before reading either events or payable rows. Any transaction that already
// allocated an event ID but has not committed is in this set. If it later commits, its event can appear below
// an unchanged MAX(id); detect that via pg_xact_status rather than relying on a bounded ID lookback.
async function activeXids(db:any):Promise<string[]>{
 const row=(await db.query('SELECT coalesce(array_agg(x::text),ARRAY[]::text[]) AS xids FROM pg_snapshot_xip(pg_current_snapshot()) AS x')).rows[0];
 return row?.xids||[];
}
async function committedSinceIndex(db:any,ws:string,ix:ReadyIndex):Promise<boolean>{
 if(!ix.pendingXids.length)return false;
 // Auth/session and indexer transactions also receive XIDs. Their commits must
 // not rebuild every payable. Match resolved writers to this workspace's events.
 // xmin is a 32-bit xid; a live xid8 snapshot supplies the corresponding epoch.
 const row=(await db.query(`WITH states AS MATERIALIZED (
  SELECT x::text AS xid,CASE WHEN NOT pg_visible_in_snapshot(x,pg_current_snapshot())
   AND pg_xact_status(x) IS DISTINCT FROM 'aborted' THEN 'in progress'
   ELSE pg_xact_status(x) END AS status FROM unnest($2::xid8[]) AS t(x)
 ) SELECT coalesce(array_agg(xid) FILTER(WHERE status='in progress'),ARRAY[]::text[]) AS xids,
 EXISTS(SELECT 1 FROM events e WHERE e.workspace_id=$1 AND e.xmin::text=ANY(
  ARRAY(SELECT mod(xid::numeric,4294967296)::text FROM states WHERE status IS DISTINCT FROM 'in progress' AND status IS DISTINCT FROM 'aborted')
 )) AS committed FROM states`,[ws,ix.pendingXids])).rows[0];
 if(row?.committed===true)return true;
 ix.pendingXids=row?.xids??ix.pendingXids;
 return false;
}
async function buildIndex(db:any,ws:string,cursor:string):Promise<ReadyIndex>{
 const pendingXids=await activeXids(db);
 // Events first, rows second: every event seen here is committed, so the (later) row statement already includes it.
 const recent=new Set<string>((await recentEvents(db,ws,BigInt(cursor)-LOOKBACK,cursor)).map((e:any)=>e.id));
 const policy=await currentPolicy(db,ws).catch(()=>null);
 const rows=(await db.query(ROWS_SQL,[ws,policy?.id??null,policy?.revision??0])).rows.map((r:any)=>toRow(r,policy));
 rows.sort(refOrder);return finish(ws,cursor,Date.now(),rows,policy,'full',recent,pendingXids);
}
// Incremental refresh: when every event not yet incorporated touches only identified single payables (intake, review) or
// no payable at all (contact creation), only those payables are re-read. Any other event kind (freeze, reconciliation,
// release, destination/policy change, import, membership, ...) or a large gap forces a full rebuild; a full rebuild also
// happens at least every TTL_MS as a safety net.
const SINGLE_PAYABLE:Record<string,(d:any)=>any[]>={'payable-create':d=>[d?.id],'review':d=>[d?.id],'TR-ReviewDecided':d=>[d?.payable_id],'contact-create':()=>[]};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function refreshIndex(db:any,ws:string,cursor:string,prev:ReadyIndex):Promise<ReadyIndex|null>{
 if(BigInt(cursor)<BigInt(prev.cursor))return null;
 const pendingXids=[...new Set([...prev.pendingXids,...await activeXids(db)])];
 const ev=await recentEvents(db,ws,BigInt(prev.cursor)-LOOKBACK,cursor);if(ev.length>1000)return null;
 const ids=new Set<string>();
 for(const e of ev){if(BigInt(e.id)<=BigInt(prev.cursor)&&prev.recent.has(e.id))continue;const f=SINGLE_PAYABLE[e.kind];if(!f)return null;for(const id of f(e.data)){if(typeof id!=='string'||!UUID.test(id))return null;ids.add(id);}}
 const recent=new Set<string>(ev.filter((e:any)=>BigInt(e.id)>BigInt(cursor)-LOOKBACK).map((e:any)=>e.id));
 const policy=await currentPolicy(db,ws).catch(()=>null);if((policy?.id??null)!==(prev.policy?.id??null)||(policy?.revision??null)!==(prev.policy?.revision??null))return null;
 if(!ids.size)return finish(ws,cursor,prev.builtAt,prev.rows,policy,'incremental',recent,pendingXids);
 const fresh=(await db.query(ROWS_SQL+' AND p.id=ANY($4::uuid[])',[ws,policy?.id??null,policy?.revision??0,[...ids]])).rows.map((r:any)=>toRow(r,policy));
 const rows=prev.rows.filter(r=>!ids.has(r.id));
 for(const r of fresh){let lo=0,hi=rows.length;while(lo<hi){const m=(lo+hi)>>1;if(refOrder(rows[m],r)<0)lo=m+1;else hi=m;}rows.splice(lo,0,r);}
 return finish(ws,cursor,prev.builtAt,rows,policy,'incremental',recent,pendingXids);
}
// One index per workspace (LRU, at most CACHE_MAX). Builds are SERIALIZED per workspace: a request whose events cursor is
// newer than the cached index waits for any build in flight and then refreshes on top of it, so concurrent requests never
// run parallel full rebuilds. An index at or beyond the request's cursor is returned as is (display data, never authority).
const CACHE_MAX=16,TTL_MS=Number(process.env.ALDER_READY_INDEX_TTL_MS||300000);
type State={index?:ReadyIndex,tail:Promise<unknown>};
const states=new Map<string,State>();
export const readinessCacheStats={hits:0,full:0,incremental:0,joins:0};
export async function eventsCursor(db:any,ws:string):Promise<string>{return (await db.query('SELECT coalesce(max(id),0)::text AS c FROM events WHERE workspace_id=$1',[ws])).rows[0].c;}
export async function readinessIndex(db:any,ws:string,cursor?:string):Promise<ReadyIndex>{
 const c=cursor??await eventsCursor(db,ws);const fresh=(ix?:ReadyIndex)=>!!ix&&Date.now()-ix.builtAt<TTL_MS;const covers=(ix?:ReadyIndex)=>!!ix&&fresh(ix)&&BigInt(ix.cursor)>=BigInt(c);
 let st=states.get(ws);if(st){states.delete(ws);states.set(ws,st);}else{st={tail:Promise.resolve()};states.set(ws,st);while(states.size>CACHE_MAX)states.delete(states.keys().next().value!);}
 if(covers(st.index)&&!(await committedSinceIndex(db,ws,st.index!))){readinessCacheStats.hits++;return st.index!;}
 const s=st;const run=s.tail.catch(()=>{}).then(async()=>{if(covers(s.index)&&!(await committedSinceIndex(db,ws,s.index!))){readinessCacheStats.joins++;return s.index!;}
  const prev=s.index;const lateCommit=prev?await committedSinceIndex(db,ws,prev):false;const inc=prev&&!lateCommit&&fresh(prev)?await refreshIndex(db,ws,c,prev):null;let ix:ReadyIndex;
  if(inc){readinessCacheStats.incremental++;ix=inc;}else{readinessCacheStats.full++;ix=await buildIndex(db,ws,c);}
  if(!s.index||BigInt(ix.cursor)>=BigInt(s.index.cursor)||!fresh(s.index))s.index=ix;return ix;});
 s.tail=run;return run;
}
const summaryCache=new WeakMap<ReadyRow[],any>();
export function readinessSummary(ix:ReadyIndex){
 const cached=summaryCache.get(ix.rows);if(cached)return cached;
 let unsettled=0,unsettledUnits=0n,ready=0,readyUnits=0n,review=0,held=0,settled=0;
 for(const r of ix.rows){if(r.settled){settled++;continue;}unsettled++;unsettledUnits+=BigInt(r.amount_units);if(r.ready){ready++;readyUnits+=BigInt(r.amount_units);}if(!r.reviewed)review++;if(!r.verified)held++;}
 const summary={payables_total:ix.rows.length,unsettled:{count:unsettled,total_units:unsettledUnits.toString()},ready:{count:ready,total_units:readyUnits.toString()},review_pending:{count:review},destination_held:{count:held},settled:{count:settled},policy:ix.policy};summaryCache.set(ix.rows,summary);return summary;
}
// Backwards-compatible map {payableId:{ready,reasons}} (all payables, or only `ids`).
export async function readiness(db:any,ws:string,ids?:string[]){
 const ix=await readinessIndex(db,ws);const out:any={};
 for(const r of ids?ids.map(id=>ix.byId.get(id)).filter(Boolean) as ReadyRow[]:ix.rows)out[r.id]={ready:r.ready,reasons:r.reasons};
 return out;
}
