// Integration against a task-owned restore clone on 127.0.0.1:15545 only.
// Exercises the production TR-T-REVIEW freeze guard with the actual alder_app role,
// workspace/session RLS context, and PostgreSQL policy/intake queries.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {databaseScope,scopedPool} from '../../apps/api/database.ts';
import {assertCurrentPolicyReviews,policyDigest,validatePolicyConditions} from '../../apps/api/policy.ts';

const adminUrl=process.env.ALDER_R7_FINISH_ADMIN_URL;
const appUrl=process.env.ALDER_R7_FINISH_APP_URL;
const expectedOwner=process.env.ALDER_R7_FINISH_OWNER;
if(!adminUrl||!appUrl||!expectedOwner)throw new Error('ROUND7_FINISH_ISOLATED_DATABASE_ENV_REQUIRED');
assert.match(expectedOwner,/^r7finish-20261103-policy-[0-9a-f]{12}$/,'task-owned fixture label required');
for(const value of [adminUrl,appUrl]){const u=new URL(value);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'15545');assert.equal(u.pathname,'/alder_r7finish');}

test('TR-T-REVIEW: unmatched policy aborts the real PostgreSQL freeze guard without review/event writes',async()=>{
 const admin=new Pool({connectionString:adminUrl,max:1});
 const appReal=new Pool({connectionString:appUrl,max:2,application_name:'alder-round7-finish-policy-test'});
 const appPool=scopedPool(appReal);
 try{
  const identity=(await admin.query('SELECT current_database() AS db,inet_server_port() AS port')).rows[0];
  assert.equal(identity.db,'alder_r7finish');
  assert.equal(Number(identity.port),5432,'container internal port; host mapping is attested by runner');

  const ws='00000000-0000-4000-8000-000000000001';
  const userRows=(await admin.query('SELECT id,email,roles FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=$1',[ws])).rows;
  assert(userRows.length>0,'restored workspace membership required');
  const reviewer=userRows.find((r:any)=>Array.isArray(r.roles)&&r.roles.includes('reviewer'));
  assert(reviewer,'a current reviewer membership is required');
  let policy=(await admin.query('SELECT id,revision FROM review_policies WHERE workspace_id=$1',[ws])).rows[0];
  if(!policy){
   const conditions=validatePolicyConditions({schema_version:1,mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,
    rules:[{id:'R7-FINISH',label:'Round 7 isolated fixture',asset:{chain_id:'31337',address:'0x5FbDB2315678afecb367f032d93F642f64180aa3',profile:'ALDER_FIXED_SUPPLY_6_DECIMALS'},min_units:'1',max_units:null,contact_ids:null}]});
   const id=randomUUID(),digest=policyDigest(conditions);
   await admin.query('INSERT INTO review_policies(workspace_id,id,revision) VALUES($1,$2,1)',[ws,id]);
   await admin.query('INSERT INTO review_policy_revisions(workspace_id,policy_id,revision,conditions,digest,actor_id,reason) VALUES($1,$2,1,$3,$4,$5,$6)',[ws,id,conditions,digest,reviewer.id,'Disposable round7 policy guard fixture']);
   policy={id,revision:1};
  }

  // Login through the production API so the app-role transaction gets a real session
  // hash and the same RLS actor/workspace context as a request.
  const {buildApp}=await import('../../apps/api/app.ts');
  const app=await buildApp({pool:appPool as any});
  let sessionHash='';
  try{
   const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'https://127.0.0.1:5103'},payload:{email:reviewer.email,password:process.env.ALDER_R7_FINISH_LOGIN_PASSWORD}});
   assert.equal(login.statusCode,200,'restored reviewer login');
   const cookie=String(login.headers['set-cookie']).split(';')[0];
   const token=cookie.match(/^alder=([0-9a-f]{64})$/)?.[1];assert(token,'session cookie shape');
   sessionHash=createHash('sha256').update(token).digest('hex');

   const before=(await admin.query(`SELECT
    (SELECT count(*)::text FROM business_reviews WHERE workspace_id=$1) AS reviews,
    (SELECT count(*)::text FROM events WHERE workspace_id=$1) AS events`,[ws])).rows[0];
   const fake={id:randomUUID(),amount_units:'250',contact_id:null,revision:1,reviewed_by:reviewer.id};
   let observed='';
   await databaseScope.run({workspace:ws,sessionHash},async()=>{
    const db=await appPool.connect();
    try{
     await db.query('BEGIN');
     const security=(await db.query("SELECT current_user AS role,current_setting('alder.workspace_id',true) AS workspace,current_setting('alder.session_hash',true) AS session_hash")).rows[0];
     assert.equal(security.role,'alder_app');assert.equal(security.workspace,ws);assert.equal(security.session_hash,sessionHash);
     await assert.rejects(()=>assertCurrentPolicyReviews(db,ws,[fake]),(e:any)=>{observed=e.message;return e.statusCode===422&&e.message==='POLICY_UNMATCHED';});
    }finally{await db.query('ROLLBACK');db.release();}
   });
   assert.equal(observed,'POLICY_UNMATCHED');
   const after=(await admin.query(`SELECT
    (SELECT count(*)::text FROM business_reviews WHERE workspace_id=$1) AS reviews,
    (SELECT count(*)::text FROM events WHERE workspace_id=$1) AS events`,[ws])).rows[0];
   assert.deepEqual(after,before,'rejected freeze guard has no review or event side effect');
   const absent=(await admin.query('SELECT count(*)::text AS n FROM payables WHERE workspace_id=$1 AND id=$2',[ws,fake.id])).rows[0].n;
   assert.equal(absent,'0','guard probe used no persisted payable');
  }finally{await app.close();}
 }finally{await admin.end();}
});
