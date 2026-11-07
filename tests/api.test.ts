import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {Pool} from 'pg';import {buildApp} from '../apps/api/app.ts';
const origin='https://127.0.0.1:5103';
test('TR auth server identity, CSRF, object isolation, self-review and integer persistence',async()=>{const app=await buildApp();const fixtures=JSON.parse(fs.readFileSync('.local/accounts.json','utf8'));const ws=fixtures.workspace;
assert.equal((await app.inject({method:'GET',url:`/api/v1/workspaces/${ws}/snapshot`})).statusCode,401);
async function login(email:string){const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email,password:fixtures.password}});assert.equal(r.statusCode,200);return {cookie:r.headers['set-cookie']!.toString().split(';')[0],csrf:r.json().csrf};}
const preparer=await login('jordan@alder.local');const reviewer=await login('priya@alder.local');const accountant=await login('accountant@alder.local');
const snap=(await app.inject({url:`/api/v1/workspaces/${ws}/snapshot`,headers:{cookie:preparer.cookie}})).json();assert.equal(snap.payables.length,4);
const noah=snap.payables.find((p:any)=>p.display_reference==='PAY-1043');const url=`/api/v1/workspaces/${ws}/payables/${noah.id}/review`;
const headers=(s:any)=>({origin,cookie:s.cookie,'x-csrf-token':s.csrf,'idempotency-key':crypto.randomUUID()});
assert.equal((await app.inject({method:'POST',url,headers:{cookie:preparer.cookie},payload:{revision:1}})).statusCode,403);
assert.equal((await app.inject({method:'POST',url,headers:headers(preparer),payload:{revision:1}})).statusCode,403);
const db=new Pool({connectionString:'postgresql://postgres@127.0.0.1:5543/alder'});try{await db.query('UPDATE memberships SET roles=$3 WHERE workspace_id=$1 AND user_id=$2',[ws,fixtures.users.jordan,['preparer','reviewer']]);const self=await app.inject({method:'POST',url,headers:headers(preparer),payload:{revision:1}});assert.equal(self.statusCode,403);assert.equal(self.json().error.code,'SELF_APPROVAL');}finally{await db.query('UPDATE memberships SET roles=$3 WHERE workspace_id=$1 AND user_id=$2',[ws,fixtures.users.jordan,['preparer']]);await db.end();}
assert.equal((await app.inject({method:'POST',url,headers:headers(accountant),payload:{revision:1}})).statusCode,403);
assert.equal((await app.inject({url:'/api/v1/workspaces/00000000-0000-4000-8000-000000000002/snapshot',headers:{cookie:preparer.cookie,'x-role':'admin'}})).statusCode,404);
assert.equal((await app.inject({method:'POST',url:url.replace(noah.id,crypto.randomUUID()),headers:headers(reviewer),payload:{revision:1}})).statusCode,404);
const approved=await app.inject({method:'POST',url,headers:headers(reviewer),payload:{revision:noah.revision}});assert.equal(approved.statusCode,200);
const after=(await app.inject({url:`/api/v1/workspaces/${ws}/snapshot`,headers:{cookie:preparer.cookie}})).json();assert.equal(after.payables.find((p:any)=>p.id===noah.id).amount_units,'3200000000');
await app.close();});
