// Round 6 (TR-T-LOAD) pure tests: cursor codec, keyset paging over the readiness index, bounded impact preview and the
// backpressure gate (unit + real Fastify instance). No database, chain or network beyond loopback Fastify inject.
import {test} from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';
import {encodeCursor,decodeCursor,pagePayables,LIMITS,snapshotPayableIds,snapshotContactPage} from '../apps/api/reads.ts';
import {refOrder,readinessSummary,type ReadyRow} from '../apps/api/eligibility.ts';
import {Gate,registerBackpressure,costClass} from '../apps/api/backpressure.ts';
import {boundedImpact,IMPACT_PREVIEW,classify,classifyIndexed} from '../apps/api/policy.ts';
const WS='11111111-1111-4111-8111-111111111111',WS2='22222222-2222-4222-8222-222222222222';
const row=(i:number,extra:Partial<ReadyRow>={}):ReadyRow=>{const ref='R-'+String(i).padStart(5,'0');return {id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,ref,contact:'C'+(i%7),amount_units:String(1000+i),ready:i%3===0,reasons:i%3===0?[]:['review_required'],reviewed:i%3===0,verified:i%11!==0,settled:i%13===0,reserved:false,created_at:i,search:('c'+(i%7)+' '+ref).toLowerCase(),revision:1,contact_id:null,token_identity:null,destination_current:i%11!==0,review_current:i%3===0,matched:[],service:'Manual payable',...extra};};
const rows=Array.from({length:2503},(_,i)=>row(i)).sort(refOrder);

test('cursor: roundtrip; tampered, foreign-workspace and foreign-filter cursors are 404 CURSOR_INVALID',()=>{
 const c=encodeCursor(WS,'f1',['R-00010','id-10']);assert.deepEqual(decodeCursor(WS,'f1',c),['R-00010','id-10']);
 const bad=[c.slice(0,-4)+'AAAA','x'+c,c.replace('.','..'),'',123,'a'.repeat(700)];
 for(const b of bad)assert.throws(()=>decodeCursor(WS,'f1',b),(e:any)=>e.statusCode===404&&e.message==='CURSOR_INVALID');
 assert.throws(()=>decodeCursor(WS2,'f1',c),(e:any)=>e.statusCode===404);assert.throws(()=>decodeCursor(WS,'f2',c),(e:any)=>e.statusCode===404);
 // body swap with a valid-looking signature from another cursor
 const c2=encodeCursor(WS,'f1',['R-99999','x']);assert.throws(()=>decodeCursor(WS,'f1',c.split('.')[0]+'.'+c2.split('.')[1]),(e:any)=>e.statusCode===404);
});
test('keyset paging visits every matching row exactly once, in order, with exact totals (all views, with search)',()=>{
 for(const view of ['all','ready','review','held','unsettled','settled']){for(const q of ['','c3','r-0012']){
  let after:any=null,seen:string[]=[],total=-1,units='';for(let n=0;n<100;n++){const r=pagePayables(rows,{view,q},LIMITS.pageMax,after);total=r.total;units=r.total_units;seen.push(...r.page.map(x=>x.id));if(!r.more)break;const l=r.page.at(-1)!;after={ref:l.ref,id:l.id};}
  const pred:any={all:()=>true,ready:(r:any)=>r.ready,review:(r:any)=>!r.settled&&!r.reviewed,held:(r:any)=>!r.settled&&!r.verified,unsettled:(r:any)=>!r.settled,settled:(r:any)=>r.settled}[view];
  const want=rows.filter(r=>pred(r)&&(!q||r.search.includes(q)));
  assert.deepEqual(seen,want.map(r=>r.id),view+'/'+q);assert.equal(total,want.length);assert.equal(units,want.reduce((n,r)=>n+BigInt(r.amount_units),0n).toString());}}
});
test('keyset paging is stable when rows are inserted before the cursor (no duplicates, no skips of later rows)',()=>{
 const p1=pagePayables(rows,{view:'all',q:''},50,null);const l=p1.page.at(-1)!;
 const grown=[...rows,row(-1,{ref:'A-first',id:'00000000-0000-4000-8000-ffffffffffff'})].sort(refOrder);
 const p2=pagePayables(grown,{view:'all',q:''},50,{ref:l.ref,id:l.id});assert.equal(p2.page[0].id,rows[50].id);assert(!p2.page.some(x=>p1.page.some(y=>y.id===x.id)));
});
test('readiness summary: exact counts and totals over the whole index',()=>{
 const s=readinessSummary({key:'k',cursor:'0',builtAt:0,rows,byId:new Map(),policy:null,recent:new Set(),pendingXids:[]});
 assert.equal(s.payables_total,2503);assert.equal(s.settled.count,rows.filter(r=>r.settled).length);
 assert.equal(s.ready.count,rows.filter(r=>r.ready&&!r.settled).length);
 assert.equal(s.unsettled.total_units,rows.filter(r=>!r.settled).reduce((n,r)=>n+BigInt(r.amount_units),0n).toString());
});
test('10k-payable snapshot page stays bounded while summary counts and sums remain exact',()=>{
 const large=Array.from({length:10000},(_,i)=>row(i)).sort(refOrder),ix={key:'large',cursor:'1',builtAt:1,rows:large,byId:new Map(large.map(r=>[r.id,r])),policy:null,recent:new Set<string>(),pendingXids:[]};
 const summary=readinessSummary(ix),unsettled=large.filter(r=>!r.settled),selected=snapshotPayableIds(large,[large[5000].id,large.at(-1)!.id]);
 assert.equal(summary.payables_total,10000);assert.equal(summary.unsettled.count,unsettled.length);
 assert.equal(summary.unsettled.total_units,unsettled.reduce((n,r)=>n+BigInt(r.amount_units),0n).toString());
 assert.equal(summary.ready.count,unsettled.filter(r=>r.ready).length);assert.equal(readinessSummary(ix),summary,'unchanged index rows reuse the exact aggregate');
 assert(selected.length<=LIMITS.workingSetPerView*4+LIMITS.recentPayables+6+2);assert(selected.length<large.length);
 assert(selected.includes(large[5000].id));assert(selected.includes(large.at(-1)!.id));
});
test('snapshot contact page retains screen fields and publishes exact total/truncation metadata',()=>{
 const all=Array.from({length:10000},(_,i)=>({_snapshot_total:'10000',id:String(i).padStart(5,'0'),display_name:'Contact '+String(i).padStart(5,'0'),revision:1,address:'checksummed',raw_address:'literal',chain_id:'31337',changed_by:'actor',verification_state:'pending'}));
 const page=snapshotContactPage(all,'10000');assert.equal(page.contacts.length,LIMITS.contacts);assert.deepEqual(page.limits,{included:LIMITS.contacts,total:'10000',truncated:true,page_route:'/reads/contacts'});
 assert(!('_snapshot_total' in page.contacts[0]));for(const key of ['id','display_name','revision','address','raw_address','chain_id','changed_by','verification_state'])assert(key in page.contacts[0]);
 const empty=snapshotContactPage([],'0');assert.deepEqual(empty.limits,{included:0,total:'0',truncated:false,page_route:'/reads/contacts'});
});
test('policy impact preview is bounded with exact per-status counts (no 422 at 10k)',()=>{
 const all=Array.from({length:10000},(_,i)=>({id:String(i),status:i%4===0?'unmatched_hold':'review_pending'}));const b=boundedImpact(all);
 assert.equal(b.impact.length,IMPACT_PREVIEW);assert.equal(b.impact_total,10000);assert.equal(b.impact_truncated,true);assert.deepEqual(b.impact_counts,{unmatched_hold:2500,review_pending:7500});
 const small=boundedImpact(all.slice(0,3));assert.equal(small.impact_truncated,false);assert.equal(small.impact.length,3);
});
test('gate: admits up to concurrency, queues up to queue, refuses beyond, times out waiters, hands slots over FIFO',async()=>{
 const g=new Gate({concurrency:2,queue:2,waitMs:80});assert.equal(g.acquire(),true);assert.equal(g.acquire(),true);
 const w1=g.acquire() as Promise<boolean>,w2=g.acquire() as Promise<boolean>;assert.equal(g.acquire(),false);assert.equal(g.stats.rejected_full,1);
 g.release();assert.equal(await w1,true);assert.equal(g.active,2);assert.equal(await w2,false);assert.equal(g.stats.rejected_timeout,1);
 g.release();g.release();assert.equal(g.active,0);
});
test('cost classes: health and SSE exempt; whole-workspace views heavy; mutations write',()=>{
 assert.equal(costClass('GET','/health'),null);assert.equal(costClass('GET',`/api/v1/workspaces/${WS}/events/stream?after=3`),null);
 assert.equal(costClass('GET',`/api/v1/workspaces/${WS}/snapshot`),'heavy');assert.equal(costClass('GET',`/api/v1/workspaces/${WS}/views/payables?q=`),'heavy');assert.equal(costClass('GET',`/api/v1/workspaces/${WS}/policy`),'heavy');
 assert.equal(costClass('GET',`/api/v1/workspaces/${WS}/reads/payables?view=ready`),'read');assert.equal(costClass('POST',`/api/v1/workspaces/${WS}/payables`),'write');
});
test('backpressure on a real Fastify instance: 503 OVERLOADED with Retry-After beyond capacity, no handler run; health exempt; slots released',async()=>{
 const app=Fastify();registerBackpressure(app,{classes:{heavy:{concurrency:1,queue:1,waitMs:2000}}});let ran=0;let open:()=>void=()=>{};const gate=new Promise<void>(r=>{open=r;});
 app.get('/api/v1/workspaces/:ws/snapshot',async()=>{ran++;await gate;return {ok:true};});app.get('/health',async()=>({ready:true}));
 await app.listen({port:0,host:'127.0.0.1'});const base=`http://127.0.0.1:${(app.server.address() as any).port}`;
 try{const a=fetch(base+`/api/v1/workspaces/${WS}/snapshot`),b=fetch(base+`/api/v1/workspaces/${WS}/snapshot`);await new Promise(r=>setTimeout(r,50));
  const c=await fetch(base+`/api/v1/workspaces/${WS}/snapshot`);assert.equal(c.status,503);assert.equal(c.headers.get('retry-after'),'1');const body=await c.json();assert.equal(body.error.code,'OVERLOADED');assert.equal(body.error.retryable,true);
  assert.equal((await fetch(base+'/health')).status,200);assert.equal(ran,1);open();assert.equal((await a).status,200);assert.equal((await b).status,200);assert.equal(ran,2);
  const st=(app as any).backpressure.stats();assert.equal(st.heavy.active,0);assert.equal(st.heavy.waiting,0);assert.equal(st.heavy.rejected_full,1);
  // client abort while admitted still frees the slot
  const ctl=new AbortController();const hang=fetch(base+`/api/v1/workspaces/${WS}/snapshot`,{signal:ctl.signal}).catch(()=>null);await new Promise(r=>setTimeout(r,30));ctl.abort();await hang;await new Promise(r=>setTimeout(r,30));
  assert.equal((app as any).backpressure.stats().heavy.active,0);
 }finally{await app.close();}
});

test('workspace outsider gets membership 404 before a saturated read gate; authorized caller gets 503',async()=>{
 const app=Fastify();let ran=0;let open:()=>void=()=>{};const gate=new Promise<void>(r=>{open=r;});
 app.addHook('preHandler',async(req:any)=>{if(req.url.startsWith('/api/v1/workspaces/')&&req.headers['x-member']!=='yes')throw Object.assign(new Error('NOT_FOUND'),{statusCode:404});});
 registerBackpressure(app,{classes:{heavy:{concurrency:1,queue:0,waitMs:2000}}});
 app.get('/api/v1/workspaces/:ws/snapshot',async()=>{ran++;await gate;return {ok:true};});
 await app.listen({port:0,host:'127.0.0.1'});const base=`http://127.0.0.1:${(app.server.address() as any).port}`;
 try{
  const held=fetch(base+`/api/v1/workspaces/${WS}/snapshot`,{headers:{'x-member':'yes'}});await new Promise(r=>setTimeout(r,30));
  const outsider=await fetch(base+`/api/v1/workspaces/${WS}/snapshot`);assert.equal(outsider.status,404);
  const member=await fetch(base+`/api/v1/workspaces/${WS}/snapshot`,{headers:{'x-member':'yes'}});assert.equal(member.status,503);assert.equal((await member.json()).error.code,'OVERLOADED');
  assert.equal(ran,1);open();assert.equal((await held).status,200);
 }finally{open();await app.close();}
});

test('index-derived policy impact equals the direct classification for every status branch',()=>{
 const asset={chain_id:'31337',address:'0x5FbDB2315678afecb367f032d93F642f64180aa3',profile:'ALDER_FIXED_SUPPLY_6_DECIMALS'};const C='88888888-8888-4888-8888-888888888888';
 const p={revision:3,conditions:{rules:[{id:'SMALL',asset,min_units:'1',max_units:'5000000'},{id:'C',asset,min_units:'1',max_units:null,contact_ids:[C]}]}};
 let n=0;for(const reserved of [false,true])for(const dest of [false,true])for(const reviewed of [false,true])for(const current of [false,true])for(const amount of ['1000','9000000'])for(const contact of [null,C])for(const policy of [p,null]){
  const direct={id:'x'+n,display_reference:'R'+n,contact:'c',amount_units:amount,revision:2,contact_id:contact,token_identity:asset,reserved,destination_current:dest,reviewed_by:reviewed?'u':null,approved_policy_revisions:reviewed&&current?[3]:[]};
  const indexed={id:'x'+n,ref:'R'+n,contact:'c',amount_units:amount,revision:2,contact_id:contact,token_identity:asset,reserved,destination_current:dest,reviewed,review_current:reviewed&&current};
  assert.deepEqual(classifyIndexed(indexed,policy),classify(direct,policy));n++;}
 assert.equal(n,128);
});
