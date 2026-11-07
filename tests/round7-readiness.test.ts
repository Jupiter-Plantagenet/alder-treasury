// Focused cache invalidation regressions. These mocks model statement-snapshot
// visibility and workspace event xmin values; the companion PG test covers the
// same races against the real event table.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readinessIndex} from '../apps/api/eligibility.ts';

const WS='77777777-7777-4777-8777-777777777777';
const LATE_ID='00000000-0000-4000-8000-000000000007';
const INTERMEDIATE_ID='00000000-0000-4000-8000-000000000011';
type Ev={id:string,kind:string,data:any,xmin?:string,payable?:any};

function mockDb(){
 const tx=new Map<string,'in progress'|'committed'|'aborted'>();
 let active:string[]=[],events:Ev[]=[],pauseNextStatus:(()=>Promise<void>)|undefined;
 const db={query:async(sql:string,params:any[]=[]):Promise<any>=>{
  if(sql.includes('pg_snapshot_xip'))return {rows:[{xids:[...active]}]};
  if(sql.includes('WITH states AS MATERIALIZED')){
   // Freeze the simulated statement snapshot before a test releases a barrier.
   const snapshot=params[1] as string[];
   const statuses=snapshot.map(x=>({xid:x,status:tx.get(x)??'aborted'}));
   const relevant=events.some(e=>e.xmin&&statuses.some(s=>s.status==='committed'&&(BigInt(s.xid)%4294967296n).toString()===e.xmin));
   if(pauseNextStatus){const pause=pauseNextStatus;pauseNextStatus=undefined;await pause();}
   return {rows:[{xids:statuses.filter(s=>s.status==='in progress').map(s=>s.xid),committed:relevant}]};
  }
  if(sql.includes('SELECT id::text,kind,data FROM events')){
   const from=BigInt(params[1]),to=BigInt(params[2]);
   return {rows:events.filter(e=>BigInt(e.id)>from&&BigInt(e.id)<=to).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1).map(({id,kind,data})=>({id,kind,data}))};
  }
  if(sql.includes('FROM review_policies p JOIN review_policy_revisions'))return {rows:[]};
  if(sql.startsWith('SELECT p.id,p.display_reference')){
   const only=sql.includes('AND p.id=ANY($4::uuid[])')?new Set(params[3] as string[]):undefined;
   return {rows:events.filter(e=>e.payable&&(!only||only.has(e.payable.id))).map(e=>e.payable)};
  }
  throw new Error(`Unexpected query: ${sql}`);
 }};
 return {db,setActive:(xs:string[])=>{active=xs;for(const x of xs)if(!tx.has(x))tx.set(x,'in progress');},setStatus:(x:string,s:'committed'|'aborted')=>tx.set(x,s),setEvents:(xs:Ev[])=>{events=xs;},pauseStatus:(fn:()=>Promise<void>)=>{pauseNextStatus=fn;}};
}

function payable(id=LATE_ID){return {id,display_reference:'R-7',contact:'Late contractor',service:'Manual payable',amount_units:'123',contact_id:null,
 reviewed_by:null,revision:1,verified:false,token_identity:null,created_at:7,destination_current:false,reserved:false,settled:false,review_current:false};}

test('lower-ID workspace event committed after build invalidates unchanged cursor',async()=>{
 const m=mockDb(),ws='77777777-7777-4777-8777-777777777771',xid='900000123';m.setActive([xid]);
 m.setEvents([{id:'10',kind:'watermark',data:{}}]);
 const before=await readinessIndex(m.db,ws,'10');assert.equal(before.rows.length,0);assert.deepEqual(before.pendingXids,[xid]);
 m.setStatus(xid,'committed');m.setActive([]);
 m.setEvents([{id:'4',kind:'payable-create',data:{id:LATE_ID},xmin:(BigInt(xid)%4294967296n).toString(),payable:payable()},{id:'10',kind:'watermark',data:{}}]);
 const after=await readinessIndex(m.db,ws,'10');
 assert.equal(after.mode,'full');assert.equal(after.byId.has(LATE_ID),true);
});

test('committed unrelated transaction is pruned and remains a cache hit',async()=>{
 const m=mockDb(),ws='77777777-7777-4777-8777-777777777772',xid='900000124';m.setActive([xid]);m.setEvents([{id:'10',kind:'watermark',data:{}}]);
 const built=await readinessIndex(m.db,ws,'10');m.setStatus(xid,'committed');m.setActive([]);
 const hit=await readinessIndex(m.db,ws,'10');
 assert.equal(hit,built);assert.equal(hit.mode,'full');assert.deepEqual(hit.pendingXids,[]);
});

test('incremental refresh captures a lower-ID writer that began after the prior build',async()=>{
 const m=mockDb(),ws='77777777-7777-4777-8777-777777777773',xid='900000125';m.setActive([]);m.setEvents([{id:'10',kind:'watermark',data:{}}]);
 const initial=await readinessIndex(m.db,ws,'10');assert.deepEqual(initial.pendingXids,[]);
 m.setActive([xid]);m.setEvents([{id:'10',kind:'watermark',data:{}},{id:'11',kind:'contact-create',data:{}}]);
 const middle=await readinessIndex(m.db,ws,'11');
 assert.equal(middle.mode,'incremental');assert.ok(middle.pendingXids.includes(xid),'refresh must retain the newly active writer');
 m.setStatus(xid,'committed');m.setActive([]);
 m.setEvents([{id:'4',kind:'payable-create',data:{id:LATE_ID},xmin:(BigInt(xid)%4294967296n).toString(),payable:payable()},{id:'10',kind:'watermark',data:{}},{id:'11',kind:'contact-create',data:{}}]);
 const after=await readinessIndex(m.db,ws,'11');
 assert.equal(after.mode,'full');assert.equal(after.byId.has(LATE_ID),true);
});

test('concurrent statement snapshot cannot return stale index after a late-commit rebuild',async()=>{
 const m=mockDb(),ws='77777777-7777-4777-8777-777777777774',xid='900000126';m.setActive([xid]);m.setEvents([{id:'10',kind:'watermark',data:{}}]);
 await readinessIndex(m.db,ws,'10');
 // First invalidation query snapshots the writer as in progress, then pauses.
 let release!:()=>void,notify!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>notify=r);
 m.pauseStatus(async()=>{notify();await gate;});
 const a=readinessIndex(m.db,ws,'10');await entered;
 m.setStatus(xid,'committed');m.setActive([]);
 m.setEvents([{id:'4',kind:'payable-create',data:{id:LATE_ID},xmin:(BigInt(xid)%4294967296n).toString(),payable:payable()},{id:'10',kind:'watermark',data:{}}]);
 const late=await readinessIndex(m.db,ws,'10');
 assert.equal(late.mode,'full');assert.equal(late.byId.has(LATE_ID),true);
 release();
 const delayed=await a;
 assert.equal(delayed.byId.has(LATE_ID),true);
});
