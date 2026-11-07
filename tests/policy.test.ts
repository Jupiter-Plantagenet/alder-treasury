// Pure route/unit tests for the review-policy engine, review recording, freeze re-check and settings.
// The database is an in-memory fake (no PostgreSQL, RLS, grants or triggers are exercised here);
// the real extracted mutate() runs against it so role/idempotency/rollback/event semantics are covered.
import {test} from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';
import {createMutate} from '../apps/api/mutate.ts';
import {registerPolicy,validatePolicyConditions,matchPolicy,assertCurrentPolicyReviews} from '../apps/api/policy.ts';

const WS='11111111-1111-4111-8111-111111111111';
const U={preparer:'22222222-2222-4222-8222-222222222222',reviewer:'33333333-3333-4333-8333-333333333333',reviewer2:'44444444-4444-4444-8444-444444444444',owner:'55555555-5555-4555-8555-555555555555',admin:'66666666-6666-4666-8666-666666666666',accountant:'77777777-7777-4777-8777-777777777777'};
const ROLES:any={preparer:['preparer'],reviewer:['reviewer'],reviewer2:['reviewer'],owner:['owner'],admin:['admin'],accountant:['accountant']};
const TOKEN='0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ASSET={chain_id:'31337',address:TOKEN,profile:'ALDER_FIXED_SUPPLY_6_DECIMALS'};
const CONTACT='88888888-8888-4888-8888-888888888888';
const P={small:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',large:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',legacy:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',reserved:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'};
const policyBody=(rules:any[]=[{id:'SMALL',label:'Contractor payouts up to 5,000 ALDR',asset:ASSET,min_units:'1',max_units:'5000000000'}])=>({mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,rules});
const clone=(v:any)=>structuredClone(v);

function fakeDatabase(){
 const payable=(id:string,ref:string,amount:string,extra:any={})=>({workspace_id:WS,id,display_reference:ref,contact:'Contractor '+ref,service:'Manual payable',recipient:'0x0000000000000000000000000000000000000901',amount_units:amount,revision:1,prepared_by:U.preparer,reviewed_by:null,verified:true,payment_id:'0x'+id.replace(/-/g,'').padEnd(64,'0'),contact_id:CONTACT,destination_revision:1,...extra});
 let state:any={
  payables:[payable(P.small,'INV-1','1000000'),payable(P.large,'INV-2','9000000000'),payable(P.legacy,'LEGACY-1','2000000',{contact_id:null,destination_revision:null}),payable(P.reserved,'INV-3','3000000',{reviewed_by:U.reviewer})],
  reservations:[{payable_id:P.reserved}],contacts:[{id:CONTACT,revision:1,decision:'approve'}],
  intakes:[{payable_id:P.small,token_identity:ASSET},{payable_id:P.large,token_identity:ASSET},{payable_id:P.reserved,token_identity:ASSET}],
  policies:[],revisions:[],reviews:[],history:[],idempotency:[],events:[],preferences:[],schemaReady:true};
 let saved:any=null;const log:string[]=[];
 const insertRow=(sql:string,args:any[])=>{const m=/^INSERT INTO \w+\(([^)]*)\) VALUES\((.*)\)/.exec(sql);if(!m)throw Error('UNPARSED_INSERT '+sql);const cols=m[1].split(',');const vals=m[2].split(',').map(t=>t.trim());const row:any={};cols.forEach((c,i)=>{const v=vals[i];row[c]=/^\$\d+/.test(v)?args[Number(v.slice(1).replace(/::.*/,''))-1]:/^'.*'$/.test(v)?v.slice(1,-1):v==='now()'?'2026-10-30T00:00:00Z':Number(v);});return row;};
 const query=async(raw:string,args:any[]=[])=>{const sql=raw.replace(/\s+/g,' ').trim();log.push(sql);const r=(rows:any[]=[])=>({rows:clone(rows),rowCount:rows.length});
  if(sql==='BEGIN'){saved=clone(state);return r();}
  if(sql==='COMMIT'){saved=null;return r();}
  if(sql==='ROLLBACK'){if(saved)state=saved;saved=null;return r();}
  if(sql.includes('pg_advisory_xact_lock'))return r();
  if(sql.includes("current_user='alder_app'"))return r([{ready:state.schemaReady}]);
  if(sql.endsWith('WHERE false')){if(!state.schemaReady)throw Object.assign(Error('relation does not exist'),{code:'42P01'});return r();}
  if(sql.startsWith('SELECT * FROM idempotency'))return r(state.idempotency.filter((x:any)=>x.workspace_id===args[0]&&x.actor_id===args[1]&&x.command===args[2]&&x.key===args[3]));
  if(sql.startsWith('INSERT INTO idempotency')){state.idempotency.push({workspace_id:args[0],actor_id:args[1],command:args[2],key:args[3],digest:args[4],result:args[5]});return r();}
  if(sql.startsWith('INSERT INTO events')){state.events.push({workspace_id:args[0],actor_id:args[1],kind:args[2],data:clone(args[3])});return r();}
  if(sql.includes('FROM review_policies p JOIN review_policy_revisions r')){if(!state.schemaReady)throw Object.assign(Error('relation does not exist'),{code:'42P01'});const p=state.policies.find((x:any)=>x.workspace_id===args[0]);if(!p)return r();const v=state.revisions.find((x:any)=>x.policy_id===p.id&&x.revision===p.revision);return r([{id:p.id,revision:p.revision,conditions:v.conditions,digest:v.digest,actor_id:v.actor_id,reason:v.reason,at:'2026-10-30T00:00:00Z'}]);}
  if(sql.startsWith('INSERT INTO review_policies(')){state.policies.push(insertRow(sql,args));return r();}
  if(sql.startsWith('INSERT INTO review_policy_revisions(')){const row=insertRow(sql,args);if(state.revisions.some((x:any)=>x.policy_id===row.policy_id&&x.revision===row.revision))throw Object.assign(Error('duplicate'),{code:'23505'});state.revisions.push(row);return r();}
  if(sql.startsWith('UPDATE review_policies SET revision=$3')){const p=state.policies.find((x:any)=>x.workspace_id===args[0]&&x.id===args[1]&&x.revision===args[3]);if(!p)return r();p.revision=args[2];return r([p]);}
  if(sql.includes('FROM review_policy_revisions WHERE workspace_id=$1 AND policy_id=$2 ORDER BY revision DESC'))return r(state.revisions.filter((x:any)=>x.policy_id===args[1]).sort((a:any,b:any)=>b.revision-a.revision).map((x:any)=>({revision:x.revision,digest:x.digest,actor_id:x.actor_id,reason:x.reason,at:'2026-10-30T00:00:00Z'})));
  if(sql.includes('approved_policy_revisions'))return r(state.payables.map((p:any)=>({id:p.id,display_reference:p.display_reference,contact:p.contact,amount_units:p.amount_units,revision:p.revision,contact_id:p.contact_id,reviewed_by:p.reviewed_by,prepared_by:p.prepared_by,verified:p.verified,destination_current:!!p.contact_id&&p.verified,token_identity:state.intakes.find((i:any)=>i.payable_id===p.id)?.token_identity??null,reserved:state.reservations.some((x:any)=>x.payable_id===p.id),approved_policy_revisions:state.reviews.filter((b:any)=>b.payable_id===p.id&&b.payable_revision===p.revision&&b.actor_id===p.reviewed_by&&b.decision==='approve'&&b.policy_id===args[1]).map((b:any)=>b.policy_revision)})));
  if(sql.startsWith('SELECT * FROM payables WHERE workspace_id=$1 AND id=$2 FOR UPDATE'))return r(state.payables.filter((p:any)=>p.id===args[1]));
  if(sql.startsWith('SELECT 1 FROM reservations WHERE workspace_id=$1 AND payable_id=$2'))return r(state.reservations.filter((x:any)=>x.payable_id===args[1]).map(()=>({'?column?':1})));
  if(sql.startsWith('SELECT payable_id,token_identity FROM payable_intakes'))return r(state.intakes.filter((i:any)=>args[1].includes(i.payable_id)));
  if(sql.startsWith('SELECT revision FROM contacts'))return r(state.contacts.filter((c:any)=>c.id===args[1]).map((c:any)=>({revision:c.revision})));
  if(sql.startsWith('INSERT INTO payable_revision_history')){if(!state.history.some((h:any)=>h.payable_id===args[1]&&h.revision===args[2]))state.history.push({payable_id:args[1],revision:args[2],snapshot:clone(args[3]),actor_id:args[4],reason:args[5]});return r();}
  if(sql.startsWith('INSERT INTO business_reviews(')){state.reviews.push({decision:'approve',policy_id:null,matched_rules:null,...insertRow(sql,args)});return r();}
  if(sql.startsWith('UPDATE payables SET reviewed_by=$3')){const p=state.payables.find((x:any)=>x.id===args[1]);p.reviewed_by=args[2];return r([p]);}
  if(sql.startsWith('SELECT 1 FROM business_reviews WHERE'))return r(state.reviews.filter((b:any)=>b.payable_id===args[1]&&b.payable_revision===args[2]&&b.actor_id===args[3]&&b.policy_id===args[4]&&b.policy_revision===args[5]&&b.decision==='approve'));
  if(sql.startsWith('SELECT revision,pending_reminders,default_redaction FROM workspace_preferences'))return r(state.preferences.filter((x:any)=>x.workspace_id===args[0]&&x.user_id===args[1]).map((x:any)=>({revision:x.revision,pending_reminders:x.pending_reminders,default_redaction:x.default_redaction})));
  if(sql.startsWith('INSERT INTO workspace_preferences(')){const row=insertRow(sql.replace(/ RETURNING .*/,''),args);if(state.preferences.some((x:any)=>x.workspace_id===row.workspace_id&&x.user_id===row.user_id))throw Object.assign(Error('duplicate'),{code:'23505'});state.preferences.push(row);return r([row]);}
  if(sql.startsWith('UPDATE workspace_preferences SET')){const x=state.preferences.find((x:any)=>x.workspace_id===args[0]&&x.user_id===args[1]&&x.revision===args[4]);if(!x)return r();x.revision++;x.pending_reminders=args[2];x.default_redaction=args[3];return r([x]);}
  throw Error('UNEXPECTED_SQL '+sql);
 };
 const db={query,release:()=>{}};
 return {pool:{connect:async()=>db,query,end:async()=>{}},get state(){return state;},log};
}

async function harness(){
 const fake=fakeDatabase();const app=Fastify();
 app.setErrorHandler((e:any,_req,reply)=>reply.code(e.statusCode||500).send({error:{code:e.statusCode?e.message:'INTERNAL_ERROR'}}));
 // Stand-in for app.ts preHandler (session/CSRF/membership are NOT exercised here).
 app.addHook('preHandler',async(req:any)=>{const who=req.headers['x-test-actor'];if(!who)return;req.identity={user_id:U[who as keyof typeof U],name:who};req.roles=ROLES[who];});
 registerPolicy(app,createMutate(fake.pool),fake.pool,{impactIndex:false,deployment:()=>({chainId:31337,token:TOKEN,profile:'ALDER_FIXED_SUPPLY_6_DECIMALS',safe:'0x000000000000000000000000000000000000aAaA',executor:'0x000000000000000000000000000000000000bBbB'})});
 await app.ready();
 const call=async(method:string,path:string,who:string,body?:any,headers:any={})=>{const res=await app.inject({method:method as any,url:`/api/v1/workspaces/${WS}${path}`,headers:{'x-test-actor':who,'idempotency-key':headers.key||crypto.randomUUID(),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{payload:JSON.stringify(body)})});return {status:res.statusCode,body:res.json()};};
 return {app,fake,call};
}
const createPolicy=async(h:any,body=policyBody())=>{const res=await h.call('POST','/policies','reviewer',{conditions:body,reason:'Initial contractor payout policy'});assert.equal(res.status,200,JSON.stringify(res.body));return res.body;};
const review=(h:any,id:string,who:string,body:any,ifMatch=String(body.revision))=>h.call('POST',`/payables/${id}/review`,who,body,{'if-match':`"${ifMatch}"`});

// ---- pure policy model ----
test('policy conditions normalize deterministically and keep the mandatory floor explicit',()=>{
 const a=validatePolicyConditions(policyBody());
 const b=validatePolicyConditions({rules:[{max_units:'5000000000',min_units:'1',asset:{profile:ASSET.profile,address:TOKEN.toLowerCase(),chain_id:'31337'},label:'Contractor payouts up to 5,000 ALDR',id:'SMALL'}],mandatory_destination_check:true,required_reviewer_role:'reviewer',mandatory_review:true});
 assert.deepEqual(a,b);assert.equal(a.mandatory_review,true);assert.equal(a.required_reviewer_role,'reviewer');assert.equal(a.rules[0].asset.address,TOKEN);
});
test('no role can disable or reduce mandatory independent review through policy conditions',()=>{
 const code=(body:any)=>{try{validatePolicyConditions(body);return 'ACCEPTED';}catch(e:any){return e.statusCode+' '+e.message;}};
 assert.equal(code({...policyBody(),mandatory_review:false}),'422 MANDATORY_REVIEW');
 const {mandatory_review,...missing}=policyBody();assert.equal(code(missing),'422 MANDATORY_REVIEW');
 for(const role of ['preparer','owner','admin','accountant',''])assert.equal(code({...policyBody(),required_reviewer_role:role}),'422 MANDATORY_REVIEW',role);
 assert.equal(code({...policyBody(),mandatory_destination_check:false}),'422 MANDATORY_REVIEW');
 for(const key of ['auto_approve','skip_review','review_exempt','allow_self_approval'])assert.equal(code(policyBody([{id:'SMALL',label:'x',asset:ASSET,min_units:'1',max_units:null,[key]:true}])),'422 MANDATORY_REVIEW',key);
 assert.equal(code({...policyBody(),skip_review:true}),'422 MANDATORY_REVIEW');
});
test('custody owner/threshold fields are refused anywhere in a policy body',()=>{
 for(const body of [{...policyBody(),owners:['0x1']},{...policyBody(),safe_threshold:1},policyBody([{id:'SMALL',label:'x',asset:ASSET,min_units:'1',max_units:null,custody:{owners:[]}}])])
  assert.throws(()=>validatePolicyConditions(body),(e:any)=>e.statusCode===403&&e.message==='CUSTODY_CHANGE_OUTSIDE_APP');
});
test('malformed rules are validation errors, never silently repaired',()=>{
 for(const rules of [[],[{id:'A',label:'x',asset:ASSET,min_units:'1.5',max_units:null}],[{id:'A',label:'x',asset:ASSET,min_units:'10',max_units:'9'}],[{id:'A',label:'x',asset:ASSET,min_units:'1',max_units:(2n**256n).toString()}],[{id:'A',label:'x',asset:ASSET,min_units:'1',max_units:null},{id:'A',label:'y',asset:ASSET,min_units:'1',max_units:null}],[{id:'A',label:'x',asset:{...ASSET,chain_id:'1'},min_units:'1',max_units:null}],[{id:'A',label:'x',asset:ASSET,min_units:'1',max_units:null,surprise:1}],[{id:'A',label:'x',asset:ASSET,min_units:1,max_units:null}]])
  assert.throws(()=>validatePolicyConditions(policyBody(rules)),(e:any)=>e.statusCode===422&&e.message==='INVALID_POLICY',JSON.stringify(rules));
});
test('matching uses exact integer bounds, exact asset identity and optional contact scope; unknown asset never matches',()=>{
 const c=validatePolicyConditions(policyBody([{id:'BIG',label:'big',asset:ASSET,min_units:'9007199254740993',max_units:'9007199254740995'},{id:'SCOPED',label:'scoped',asset:ASSET,min_units:'1',max_units:null,contact_ids:[CONTACT]}]));
 const f=(amount:string,extra:any={})=>matchPolicy(c,{amount_units:amount,contact_id:null,token_identity:ASSET,...extra});
 assert.deepEqual(f('9007199254740992'),[]);assert.deepEqual(f('9007199254740993'),['BIG']);assert.deepEqual(f('9007199254740995'),['BIG']);assert.deepEqual(f('9007199254740996'),[]);
 assert.deepEqual(f('5',{contact_id:CONTACT}),['SCOPED']);assert.deepEqual(f('9007199254740994',{contact_id:CONTACT}),['BIG','SCOPED']);
 assert.deepEqual(f('9007199254740994',{token_identity:null}),[]);assert.deepEqual(f('9007199254740994',{token_identity:{...ASSET,profile:'OTHER'}}),[]);
});

// ---- policy API ----
test('policy create/revise: role checks, idempotent replay, If-Match 428/412, TR-RecordChanged event',async()=>{
 const h=await harness();try{
  for(const who of ['preparer','owner','accountant'])assert.equal((await h.call('POST','/policies',who,{conditions:policyBody(),reason:'x'})).body.error.code,'ROLE_DENIED',who);
  const key=crypto.randomUUID();const first=await h.call('POST','/policies','reviewer',{conditions:policyBody(),reason:'Initial'},{key});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.policy_revision,1);assert.match(first.body.digest,/^[0-9a-f]{64}$/);
  const replay=await h.call('POST','/policies','reviewer',{conditions:policyBody(),reason:'Initial'},{key});assert.deepEqual(replay.body,first.body);assert.equal(h.fake.state.revisions.length,1);
  assert.equal((await h.call('POST','/policies','admin',{conditions:policyBody(),reason:'Second'})).body.error.code,'POLICY_EXISTS');
  const id=first.body.policy_id,next=policyBody([{id:'SMALL',label:'Tighter',asset:ASSET,min_units:'1',max_units:'2000000'}]);
  assert.equal((await h.call('POST',`/policies/${id}/revisions`,'admin',{expected_revision:1,conditions:next,reason:'Tighten'})).status,428);
  assert.equal((await h.call('POST',`/policies/${id}/revisions`,'admin',{expected_revision:7,conditions:next,reason:'Tighten'},{'if-match':'"7"'})).status,412);
  const revised=await h.call('POST',`/policies/${id}/revisions`,'admin',{expected_revision:1,conditions:next,reason:'Tighten'},{'if-match':'"1"'});assert.equal(revised.status,200,JSON.stringify(revised.body));assert.equal(revised.body.policy_revision,2);
  assert.equal((await h.call('POST',`/policies/${id}/revisions`,'reviewer',{expected_revision:1,conditions:policyBody(),reason:'Late'},{'if-match':'"1"'})).status,412,'stale writer');
  assert.equal(h.fake.state.revisions.find((r:any)=>r.revision===1).digest,first.body.digest,'prior revision never rewritten');
  const changed=h.fake.state.events.filter((e:any)=>e.kind==='TR-RecordChanged');assert.equal(changed.length,2);assert.deepEqual(changed.map((e:any)=>[e.data.entity,e.data.revision]),[['review_policy',1],['review_policy',2]]);assert.equal(changed[1].data.digest,revised.body.digest);assert.equal(changed[1].data.schema_version,1);
 }finally{await h.app.close();}
});
test('backend rejects review bypass and custody changes through the policy API with no effects',async()=>{
 const h=await harness();try{const created=await createPolicy(h);const before=clone(h.fake.state);
  for(const who of ['reviewer','admin']){
   const off=await h.call('POST',`/policies/${created.policy_id}/revisions`,who,{expected_revision:1,conditions:{...policyBody(),mandatory_review:false},reason:'Disable'},{'if-match':'"1"'});assert.deepEqual([off.status,off.body.error.code],[422,'MANDATORY_REVIEW']);
   const role=await h.call('POST',`/policies/${created.policy_id}/revisions`,who,{expected_revision:1,conditions:{...policyBody(),required_reviewer_role:'preparer'},reason:'Weaken'},{'if-match':'"1"'});assert.deepEqual([role.status,role.body.error.code],[422,'MANDATORY_REVIEW']);
   const owners=await h.call('POST',`/policies/${created.policy_id}/revisions`,who,{expected_revision:1,conditions:{...policyBody(),owners:['0x0000000000000000000000000000000000000001'],threshold:1},reason:'Owner swap'},{'if-match':'"1"'});assert.deepEqual([owners.status,owners.body.error.code],[403,'CUSTODY_CHANGE_OUTSIDE_APP']);
  }
  for(const k of ['policies','revisions','events','idempotency'])assert.deepEqual(h.fake.state[k],before[k],k);
 }finally{await h.app.close();}
});
test('custody owner/threshold change requests are refused for every role, including owner and admin',async()=>{
 const h=await harness();try{const before=clone(h.fake.state);
  for(const who of Object.keys(ROLES)){const res=await h.call('POST','/custody/owner-changes',who,{owners:['0x0000000000000000000000000000000000000001'],threshold:1});assert.deepEqual([res.status,res.body.error.code],[403,'CUSTODY_CHANGE_OUTSIDE_APP'],who);}
  assert.deepEqual(h.fake.state,before);
 }finally{await h.app.close();}
});
test('settings preferences are revisioned, self-scoped and cannot carry review or custody changes',async()=>{
 const h=await harness();try{
  const body={expected_revision:0,pending_reminders:false,default_redaction:true};
  assert.equal((await h.call('PUT','/preferences','accountant',body)).status,428);
  const saved=await h.call('PUT','/preferences','accountant',body,{'if-match':'"0"'});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.deepEqual(saved.body,{revision:1,saved_preferences:{pending_reminders:false,default_redaction:true},custody_owner_set_unchanged:true});
  assert.equal((await h.call('PUT','/preferences','accountant',body,{'if-match':'"0"'})).status,412);
  assert.deepEqual((await h.call('PUT','/preferences','admin',{...body,mandatory_review:false},{'if-match':'"0"'})).body.error.code,'MANDATORY_REVIEW');
  assert.deepEqual((await h.call('PUT','/preferences','owner',{...body,safe_owners:['0x1']},{'if-match':'"0"'})).body.error.code,'CUSTODY_CHANGE_OUTSIDE_APP');
  assert.deepEqual((await h.call('PUT','/preferences','owner',{...body,roles:['admin']},{'if-match':'"0"'})).body.error.code,'INVALID_PREFERENCES');
  const read=await h.call('GET','/settings','accountant');assert.equal(read.status,200);assert.deepEqual(read.body.roles,['accountant']);assert.equal(read.body.preferences.revision,1);assert.equal(read.body.custody.managed_in_app,false);assert.match(read.body.custody.change_route,/Safe/);assert.equal(read.body.policy,null);assert.equal(read.body.role_impersonation,false);
  assert.equal(h.fake.state.events.filter((e:any)=>e.kind==='TR-RecordChanged'&&e.data.entity==='workspace_preferences').length,1);
 }finally{await h.app.close();}
});

// ---- review under policy ----
test('review: self approval forbidden, missing policy holds, unmatched holds, stale payable/policy revisions 412',async()=>{
 const h=await harness();try{
  assert.equal((await review(h,P.small,'preparer',{revision:1,policy_revision:1,reason:'Self'})).body.error.code,'ROLE_DENIED');
  h.fake.state.payables.find((p:any)=>p.id===P.small).prepared_by=U.reviewer;
  assert.equal((await review(h,P.small,'reviewer',{revision:1,policy_revision:1,reason:'Self'})).body.error.code,'SELF_APPROVAL');
  h.fake.state.payables.find((p:any)=>p.id===P.small).prepared_by=U.preparer;
  const missing=await review(h,P.small,'reviewer',{revision:1,policy_revision:1,reason:'No policy'});assert.deepEqual([missing.status,missing.body.error.code],[422,'POLICY_HOLD_MISSING']);
  await createPolicy(h);
  const large=await review(h,P.large,'reviewer',{revision:1,policy_revision:1,reason:'Too large for any rule'});assert.deepEqual([large.status,large.body.error.code],[422,'POLICY_UNMATCHED']);
  assert.equal((await review(h,P.small,'reviewer',{revision:2,policy_revision:1,reason:'Stale'})).status,412);
  const stalePolicy=await review(h,P.small,'reviewer',{revision:1,policy_revision:9,reason:'Stale policy'});assert.deepEqual([stalePolicy.status,stalePolicy.body.error.code],[412,'STALE_POLICY_REVISION']);
  assert.equal((await review(h,P.legacy,'reviewer',{revision:1,policy_revision:1,reason:'Legacy'})).body.error.code,'DESTINATION_HOLD');
  assert.equal(h.fake.state.reviews.length,0);assert(h.fake.state.payables.every((p:any)=>p.id===P.reserved||p.reviewed_by===null));
 }finally{await h.app.close();}
});
test('review records the actual matched policy id/revision/rules, not a constant revision 1',async()=>{
 const h=await harness();try{const created=await createPolicy(h);
  await h.call('POST',`/policies/${created.policy_id}/revisions`,'admin',{expected_revision:1,conditions:policyBody([{id:'SMALL',label:'Small',asset:ASSET,min_units:'1',max_units:'5000000000'},{id:'ANY-CONTACT',label:'Known contact',asset:ASSET,min_units:'1',max_units:null,contact_ids:[CONTACT]}]),reason:'Add contact rule'},{'if-match':'"1"'});
  const ok=await review(h,P.small,'reviewer',{revision:1,policy_revision:2,reason:'Independent business check'});assert.equal(ok.status,200,JSON.stringify(ok.body));
  assert.equal(ok.body.policy_revision,2);assert.deepEqual(ok.body.matched_rules,['SMALL','ANY-CONTACT']);assert.equal(ok.body.eligibility,'approved');
  const row=h.fake.state.reviews.at(-1);assert.equal(row.policy_revision,2);assert.equal(row.policy_id,created.policy_id);assert.deepEqual(row.matched_rules,['SMALL','ANY-CONTACT']);assert.equal(row.decision,'approve');assert.equal(row.digest,ok.body.digest);
  assert.equal(h.fake.state.payables.find((p:any)=>p.id===P.small).reviewed_by,U.reviewer);
  const reviewed=h.fake.state.events.filter((e:any)=>e.kind==='TR-ReviewDecided');assert.equal(reviewed.length,1);assert.deepEqual([reviewed[0].data.policy_revision,reviewed[0].data.payable_revision,reviewed[0].data.decision],[2,1,'approve']);
 }finally{await h.app.close();}
});
test('reserved payable cannot be re-reviewed: old signed intent is never silently replaced',async()=>{
 const h=await harness();try{await createPolicy(h);
  const res=await review(h,P.reserved,'reviewer2',{revision:1,policy_revision:1,reason:'Re-review frozen'});assert.deepEqual([res.status,res.body.error.code],[409,'SIGNED_INTENT_OUTSTANDING']);
  assert.equal(h.fake.state.payables.find((p:any)=>p.id===P.reserved).reviewed_by,U.reviewer);assert.equal(h.fake.state.reviews.length,0);
 }finally{await h.app.close();}
});
test('policy revision requires re-review before freeze; reserved intents are reported unchanged, not replaced',async()=>{
 const h=await harness();try{const created=await createPolicy(h);
  assert.equal((await review(h,P.small,'reviewer',{revision:1,policy_revision:1,reason:'Approve under r1'})).status,200);
  const rows=()=>clone(h.fake.state.payables.filter((p:any)=>p.id===P.small));
  await assertCurrentPolicyReviews(h.fake.pool,WS,rows());
  const revised=await h.call('POST',`/policies/${created.policy_id}/revisions`,'admin',{expected_revision:1,conditions:policyBody([{id:'SMALL',label:'Small r2',asset:ASSET,min_units:'1',max_units:'5000000000'}]),reason:'Relabel'},{'if-match':'"1"'});
  assert.deepEqual(revised.body.affected_draft_ids,[P.small]);assert.deepEqual(revised.body.outstanding_reserved_ids,[P.reserved]);assert.equal(revised.body.reserved_intents_replaced,false);
  assert.equal(h.fake.state.payables.find((p:any)=>p.id===P.reserved).reviewed_by,U.reviewer,'reserved row untouched');
  await assert.rejects(assertCurrentPolicyReviews(h.fake.pool,WS,rows()),(e:any)=>e.statusCode===422&&e.message==='POLICY_REREVIEW_REQUIRED');
  assert.equal((await review(h,P.small,'reviewer2',{revision:1,policy_revision:2,reason:'Re-review under r2'})).status,200);
  await assertCurrentPolicyReviews(h.fake.pool,WS,rows());
  h.fake.state.policies=[];await assert.rejects(assertCurrentPolicyReviews(h.fake.pool,WS,rows()),(e:any)=>e.message==='POLICY_HOLD_MISSING');
 }finally{await h.app.close();}
});
test('policy read shows version, unmatched holds, re-review need and impact preview without mutating',async()=>{
 const h=await harness();try{
  const empty=await h.call('GET','/policy','accountant');assert.equal(empty.status,200);assert.equal(empty.body.policy,null);assert(empty.body.impact.every((x:any)=>x.status==='policy_missing_hold'||x.status==='reserved_unchanged'));
  const created=await createPolicy(h);
  const read=await h.call('GET','/policy','accountant');assert.equal(read.body.policy.revision,1);assert.equal(read.body.policy.digest,created.digest);
  const status=Object.fromEntries(read.body.impact.map((x:any)=>[x.id,x.status]));assert.deepEqual(status,{[P.small]:'review_pending',[P.large]:'unmatched_hold',[P.legacy]:'unmatched_hold',[P.reserved]:'reserved_unchanged'});
  assert.equal(read.body.workspace_asset.address,TOKEN);assert.equal(read.body.custody.managed_in_app,false);
  const before=clone(h.fake.state);const preview=await h.call('POST','/policies/preview','accountant',{conditions:policyBody([{id:'ALL',label:'All',asset:ASSET,min_units:'1',max_units:null}])});assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(Object.fromEntries(preview.body.impact.map((x:any)=>[x.id,x.status]))[P.large],'review_pending');assert.deepEqual(h.fake.state,before,'preview never mutates');
  assert.equal((await h.call('POST','/policies/preview','accountant',{conditions:{...policyBody(),mandatory_review:false}})).body.error.code,'MANDATORY_REVIEW');
  h.fake.state.schemaReady=false;assert.deepEqual((await h.call('GET','/policy','accountant')).body.error.code,'POLICY_SCHEMA_REQUIRED');
 }finally{await h.app.close();}
});
