import {test} from 'node:test';import {Pool} from 'pg';import assert from 'node:assert/strict';import fs from 'node:fs';import {randomUUID} from 'node:crypto';import {episode,login,headers} from './episode.ts';import {buildApp} from '../apps/api/app.ts';import {freezeIntent} from '../packages/intent.ts';import {testAccounts} from './chain-kit.ts';
test('destination revision contract: pending, distinct verification, fresh review, immutable reservation and private tenant history',async()=>{
 const f=await episode();if(fs.existsSync('db/005-destinations.sql'))await f.db.query(fs.readFileSync('db/005-destinations.sql','utf8'));const cfg=JSON.parse(fs.readFileSync('.local/database.json','utf8')).app,original=process.env.ALDER_DATABASE_URL;process.env.ALDER_DATABASE_URL=`postgresql://${cfg.user}:${encodeURIComponent(cfg.password)}@127.0.0.1:5543/alder_v2_test`;const app=await buildApp();process.env.ALDER_DATABASE_URL=original;try{
 const unscoped=new Pool({connectionString:`postgresql://${cfg.user}:${encodeURIComponent(cfg.password)}@127.0.0.1:5543/alder_v2_test`});try{assert.equal((await unscoped.query('SELECT count(*) FROM contact_revisions')).rows[0].count,'0');const guards=(await unscoped.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)",[['contacts','contact_revisions','destination_verifications','payable_revision_history','business_reviews','destination_operation_holds']])).rows;assert.equal(guards.length,6);assert(guards.every((g:any)=>g.relrowsecurity&&g.relforcerowsecurity));await assert.rejects(()=>unscoped.query("UPDATE contact_revisions SET reason='tamper'"),/permission denied/);}finally{await unscoped.end();}
 const p=await login(app,f,'preparer'),r=await login(app,f,'reviewer'),a=await login(app,f,'accountant'),o=await login(app,f,'owner');const root=`/api/v1/workspaces/${f.ws}`;
 const post=async(s:any,path:string,body:any,rev?:number,key?:ReturnType<typeof randomUUID>)=>app.inject({method:'POST',url:root+path,headers:{...headers(s,key),...(rev===undefined?{}:{'if-match':`"${rev}"`})},payload:body});
 const raw='0x0000000000000000000000000000000000000501';const create={display_name:'Independent contractor',address:raw,chain_id:'31337'};
 const createKey=randomUUID();const c=await post(p,'/contacts',create,undefined,createKey);assert.equal(c.statusCode,200,c.body);const id=c.json().id;assert.equal((await post(p,'/contacts',create,undefined,createKey)).json().id,id);assert.equal((await post(p,'/contacts',{...create,display_name:'Different'},undefined,createKey)).statusCode,409);assert.equal(c.json().verification_state,'pending');
 for(const bad of [raw+' ',raw.slice(0,-1),'0x52908400098527886E0F7030069857D2E4169Ee7'])assert.equal((await post(p,'/contacts',{...create,address:bad})).statusCode,422);
 assert.equal((await post(o,'/contacts',create)).statusCode,403);assert.equal((await post(a,'/contacts',create)).statusCode,403);
 await f.db.query('UPDATE memberships SET roles=$3 WHERE workspace_id=$1 AND user_id=$2',[f.ws,f.users.preparer.id,['preparer','reviewer']]);
 const verify={destination_revision:1,decision:'approve',second_channel_reference:'Private callback ticket 17'};
 assert.equal((await post(p,`/contacts/${id}/verifications`,verify,1)).json().error.code,'SAME_ACTOR');
 assert.equal((await post(r,`/contacts/${id}/verifications`,verify)).statusCode,428);
 assert.equal((await post(r,`/contacts/${id}/verifications`,verify,1)).statusCode,200);
 const bind={expected_revision:1,contact_id:id,destination_revision:1,reason:'Use independently checked destination'};
 assert.equal((await post(p,`/payables/${f.ids[0]}/revisions`,bind,1)).statusCode,200);
 let row=(await f.db.query('SELECT * FROM payables WHERE workspace_id=$1 AND id=$2',[f.ws,f.ids[0]])).rows[0];assert.equal(row.revision,2);assert.equal(row.reviewed_by,null);assert.equal(row.verified,true);
 assert.equal((await post(p,`/payables/${row.id}/review`,{revision:2,reason:'Self review forbidden'},2)).json().error.code,'SELF_APPROVAL');
 assert.equal((await post(r,`/payables/${row.id}/review`,{revision:2,reason:'Independent business check'},2)).statusCode,200);
 const edit={expected_revision:1,full_address:'0x0000000000000000000000000000000000000502',reason:'Callback requested new destination'};
 const changed=await post(p,`/contacts/${id}/destinations`,edit,1);assert.equal(changed.statusCode,200,changed.body);
 assert.equal((await post(p,`/contacts/${id}/destinations`,edit,1)).statusCode,412);
 row=(await f.db.query('SELECT * FROM payables WHERE workspace_id=$1 AND id=$2',[f.ws,row.id])).rows[0];assert.equal(row.revision,3);assert.equal(row.verified,false);assert.equal(row.reviewed_by,null);
 assert.equal((await post(r,`/payables/${row.id}/review`,{revision:3,reason:'Must hold'},3)).statusCode,422);
 assert.equal((await post(r,`/contacts/${id}/verifications`,{...verify,destination_revision:2},2)).statusCode,200);
 assert.equal((await f.db.query('SELECT reviewed_by FROM payables WHERE workspace_id=$1 AND id=$2',[f.ws,row.id])).rows[0].reviewed_by,null);
 assert.equal((await post(r,`/payables/${row.id}/review`,{revision:3,reason:'Fresh check of revised destination'},3)).statusCode,200);
 // Retained frozen/signed fixture: no chain send or fabricated canonical payment.
 const batch=randomUUID(),op=randomUUID(),manifest=JSON.parse(JSON.stringify(await freezeIntent(JSON.parse(fs.readFileSync(process.env.ALDER_DEPLOYMENT_FILE!,'utf8')),[{recipient:row.recipient,paymentId:row.payment_id,amount:BigInt(row.amount_units)}],('0x'+randomUUID().replaceAll('-','').repeat(2)) as any),(_,v)=>typeof v==='bigint'?v.toString():v));
 await f.db.query('INSERT INTO treasury_operations(workspace_id,id,kind,manifest,state,created_by) VALUES($1,$2,$3,$4,$5,$6)',[f.ws,op,'payout',manifest,'signed',f.users.owner.id]);await f.db.query('INSERT INTO batches(workspace_id,id,manifest,created_by,operation_id) VALUES($1,$2,$3,$4,$5)',[f.ws,batch,manifest,f.users.preparer.id,op]);await f.db.query('INSERT INTO reservations VALUES($1,$2,$3)',[f.ws,row.id,batch]);await f.db.query('INSERT INTO treasury_signatures(workspace_id,operation_id,owner,signature) VALUES($1,$2,$3,$4)',[f.ws,op,testAccounts[0].address.toLowerCase(),await testAccounts[0].signTypedData(manifest.typedData)]);const signedBefore=(await f.db.query('SELECT * FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[f.ws,op])).rows;
 const before=(await f.db.query('SELECT * FROM payables WHERE workspace_id=$1 AND id=$2',[f.ws,row.id])).rows[0];
 const frozenEdit=await post(p,`/contacts/${id}/destinations`,{...edit,expected_revision:2,full_address:raw},2);assert.equal(frozenEdit.statusCode,200,frozenEdit.body);assert.equal(frozenEdit.json().invalidation_required,true);
 assert.deepEqual((await f.db.query('SELECT * FROM payables WHERE workspace_id=$1 AND id=$2',[f.ws,row.id])).rows[0],before);
 assert.deepEqual((await f.db.query('SELECT * FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[f.ws,op])).rows,signedBefore);assert.deepEqual((await f.db.query('SELECT manifest FROM treasury_operations WHERE workspace_id=$1 AND id=$2',[f.ws,op])).rows[0].manifest,manifest);assert.equal((await f.db.query('SELECT count(*) FROM reservations WHERE workspace_id=$1 AND payable_id=$2',[f.ws,row.id])).rows[0].count,'1');
 assert.equal((await post(o,`/operations/${op}/signatures`,{})).json().error.code,'DESTINATION_INVALIDATION_REQUIRED');assert.equal((await post(o,`/operations/${op}/attempts`,{})).json().error.code,'DESTINATION_INVALIDATION_REQUIRED');
 await f.db.query("UPDATE treasury_operations SET state='invalidated' WHERE workspace_id=$1 AND id=$2",[f.ws,op]);assert.equal((await post(o,`/operations/${op}/signatures`,{})).json().error.code,'OPERATION_NOT_SIGNABLE');assert.equal((await post(o,`/operations/${op}/attempts`,{})).json().error.code,'OPERATION_NOT_SIGNABLE');
 assert.equal((await post(p,`/payables/${row.id}/revisions`,{...bind,expected_revision:3,destination_revision:3},3)).json().error.code,'SIGNED_INTENT_OUTSTANDING');
 const exported=await app.inject({url:root+'/evidence',headers:{cookie:a.cookie}});assert.equal(exported.statusCode,200);assert.equal(exported.json().businessReviews.length,2);assert.equal(exported.json().destinationRevisions.length,3);
 const history=await app.inject({url:root+`/contacts/${id}`,headers:{cookie:a.cookie}});assert.equal(history.statusCode,200);assert.equal(history.json().revisions.length,3);assert.equal(history.json().revisions[0].raw_address,raw);assert.equal(history.json().verifications.length,2);
 assert.equal((await app.inject({url:root.replace(f.ws,randomUUID())+`/contacts/${id}`,headers:{cookie:p.cookie}})).statusCode,404);
 assert.equal((await app.inject({url:root+`/contacts/${randomUUID()}`,headers:{cookie:p.cookie}})).statusCode,404);
 assert.equal((await f.db.query('SELECT count(*) FROM treasury_settlements WHERE workspace_id=$1',[f.ws])).rows[0].count,'0');
 const evidence=(await f.db.query('SELECT data FROM events WHERE workspace_id=$1',[f.ws])).rows;assert(!JSON.stringify(evidence).includes('Private callback'));
 await assert.rejects(()=>f.db.query('UPDATE contact_revisions SET reason=$1 WHERE workspace_id=$2',['tamper',f.ws]),/IMMUTABLE/);
 }finally{await app.close();await f.db.end();}
});
