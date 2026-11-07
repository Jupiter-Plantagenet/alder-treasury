// Administrator-authored drift in an exclusively owned PostgreSQL16 fixture.
// Transport bootstrap must authenticate a real nonowner member login for the API.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import fs from 'node:fs';
import {buildApp} from '../apps/api/app.ts';
import {schemaQuery,verifyPayableSchema} from '../apps/api/payable-schema.ts';
if(process.env.ALDER_INTAKE_PROOF!=='owned-disposable'||process.env.ALDER_PROOF_DATABASE!=='alder_a65_db')throw Error('OWNED_DISPOSABLE_ONLY');
const owner=new Pool({host:'127.0.0.1',port:5543,user:'postgres',database:'alder_a65_db',max:1});
const runtime=new Pool({connectionString:process.env.ALDER_DATABASE_URL,max:1});
const outside=new Pool({connectionString:process.env.ALDER_INDEXER_DATABASE_URL,max:1});
const records:any[]=[];let trusted:any;
const strip=(v:any)=>{const {actor_acl_safe,...old}=v;return old;};
const contract=async()=>(await runtime.query(schemaQuery)).rows[0].contract;
const acl=async()=>(await owner.query("SELECT p.proacl::text explicit_acl,p.proacl IS NULL acl_is_null,(SELECT count(*)::int FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute_rows FROM pg_catalog.pg_proc p WHERE p.oid='public.alder_actor()'::pg_catalog.regprocedure")).rows[0];
async function restore(){await owner.query('REVOKE ALL ON FUNCTION public.alder_actor() FROM PUBLIC,alder_indexer,alder_app');await owner.query('GRANT EXECUTE ON FUNCTION public.alder_actor() TO alder_app');}
async function check(label:string,allowed:boolean){
 const before=await contract(),beforeAcl=await acl();let app:any;let directError:any,startError:any;
 try{try{await verifyPayableSchema(runtime);}catch(e){directError=e;}app=await buildApp();try{await app.ready();}catch(e){startError=e;}}
 finally{if(app)await app.close();}
 const after=await contract();assert.deepEqual(after,before,'readiness must not repair any catalog fields');assert.deepEqual(await acl(),beforeAcl,'readiness must not repair ACL');
 const record={label,expected_ready:allowed,acl:beforeAcl,direct:directError?{message:directError.message}:{ready:true},startup:startError?{message:startError.message,statusCode:startError.statusCode}:{ready:true},nonrepair:true};records.push(record);
 if(allowed){assert.equal(directError,undefined,'valid effective ACL direct checker');assert.equal(startError,undefined,'valid effective ACL composed startup');}
 else{assert(directError?.message==='SCHEMA_CONTRACT','PRODUCT: direct check admitted forbidden effective actor ACL');assert(startError?.message==='PAYABLE_SCHEMA_REQUIRED'&&startError?.statusCode===503,'PRODUCT: composed startup admitted forbidden effective actor ACL');}
}
// Recreate the exact current helper with ordinary SQL, never direct catalog writes.
// Capture/rebind its exact dependent policies so proacl can truly be NULL.
async function recreateWithBuiltinDefaults(){
 const definition=(await owner.query("SELECT pg_catalog.pg_get_functiondef('public.alder_actor()'::pg_catalog.regprocedure) d")).rows[0].d;
 const policies=(await owner.query("SELECT DISTINCT n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,pg_catalog.pg_get_expr(p.polqual,p.polrelid,false) qual,pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,false) chk,ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r)) END FROM pg_catalog.unnest(p.polroles) r ORDER BY r) roles FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_policy p ON d.classid='pg_catalog.pg_policy'::pg_catalog.regclass AND d.objid=p.oid JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE d.refclassid='pg_catalog.pg_proc'::pg_catalog.regclass AND d.refobjid='public.alder_actor()'::pg_catalog.regprocedure ORDER BY n.nspname,c.relname,p.polname")).rows;
 assert(policies.length>0,'actual dependencies required');const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';const commands:any={'*':'ALL',r:'SELECT',a:'INSERT',w:'UPDATE',d:'DELETE'};
 await owner.query('BEGIN');try{
  await owner.query('ALTER FUNCTION public.alder_actor() RENAME TO alder_actor_a65_old');await owner.query(definition);
  for(const p of policies){const table=q(p.nspname)+'.'+q(p.relname);await owner.query('DROP POLICY '+q(p.polname)+' ON '+table);await owner.query('CREATE POLICY '+q(p.polname)+' ON '+table+' AS '+(p.polpermissive?'PERMISSIVE':'RESTRICTIVE')+' FOR '+commands[p.polcmd]+' TO '+p.roles.join(',')+(p.qual?' USING ('+p.qual+')':'')+(p.chk?' WITH CHECK ('+p.chk+')':''));}
  await owner.query('DROP FUNCTION public.alder_actor_a65_old()');await owner.query('COMMIT');
 }catch(e){await owner.query('ROLLBACK');throw e;}
 assert.deepEqual(strip(await contract()),strip(trusted),'NULL fixture must preserve every old expected catalog value/order');assert.equal((await acl()).acl_is_null,true);assert.equal((await acl()).public_execute_rows,1);
 records.push({label:'NULL-scaffold',admin_authored:true,exact_definition:definition,dependent_policies:policies,old_catalog_identical:true,direct_catalog_writes:false});
}
before(async()=>{await restore();trusted=await contract();const id=(await runtime.query('SELECT current_user principal,session_user login,r.rolsuper,r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname=current_user')).rows[0];assert.equal(id.principal,'alder_app');assert.equal(id.login,'alder_a65_login');assert.equal(id.rolsuper,false);assert.equal(id.rolbypassrls,false);records.push({label:'actual-nonowner-member-login',identity:id});});
after(async()=>{try{await restore();if(trusted)assert.deepEqual(strip(await contract()),strip(trusted));if(process.env.A65_MATRIX_OUTPUT)fs.writeFileSync(process.env.A65_MATRIX_OUTPUT,JSON.stringify(records,null,2),{flag:'wx'});}finally{await runtime.end();await outside.end();await owner.end();}});
test('A65-ACL-VALID: trusted intended role execution and ordinary member login remain ready',async()=>{await check('intended-only',true);await assert.rejects(()=>outside.query('SELECT public.alder_actor()'),(e:any)=>e.code==='42501');});
test('A65-ACL-PUBLIC: explicit PUBLIC execution rejects direct and composed readiness',async()=>{try{await owner.query('GRANT EXECUTE ON FUNCTION public.alder_actor() TO PUBLIC');const actual=(await outside.query("SELECT current_user principal,has_function_privilege(current_user,'public.alder_actor()','EXECUTE') effective_execute,public.alder_actor() actor")).rows[0];assert.equal(actual.effective_execute,true);assert.equal(actual.actor,null);records.push({label:'explicit-PUBLIC-actual-outside-execution',actual});await check('explicit-PUBLIC',false);}finally{await restore();}});
test('A65-ACL-NULL: builtin default PUBLIC execution on exact helper rejects readiness',async()=>{try{await recreateWithBuiltinDefaults();const actual=(await outside.query("SELECT current_user principal,has_function_privilege(current_user,'public.alder_actor()','EXECUTE') effective_execute,public.alder_actor() actor")).rows[0];assert.equal(actual.effective_execute,true);assert.equal(actual.actor,null);assert.equal((await runtime.query("SELECT has_function_privilege('public.alder_actor()','EXECUTE') x")).rows[0].x,true);records.push({label:'NULL-default-actual-outside-execution',actual});await check('NULL-default-PUBLIC',false);}finally{await restore();}});
test('A65-ACL-EMPTY: explicit empty ACL is not normalized to builtin PUBLIC default',async()=>{try{await owner.query('REVOKE ALL ON FUNCTION public.alder_actor() FROM PUBLIC,alder_app,alder_indexer,postgres');const a=await acl();assert.equal(a.explicit_acl,'{}');assert.equal(a.acl_is_null,false);assert.equal(a.public_execute_rows,0);assert.equal((await runtime.query("SELECT has_function_privilege('public.alder_actor()','EXECUTE') x")).rows[0].x,false);await assert.rejects(()=>outside.query('SELECT public.alder_actor()'),(e:any)=>e.code==='42501');await check('explicit-empty',false);}finally{await owner.query('GRANT EXECUTE ON FUNCTION public.alder_actor() TO postgres');await restore();}});
test('A65-ACL-REVOKE: separate intended EXECUTE invariant rejects revoked permission',async()=>{try{await owner.query('REVOKE EXECUTE ON FUNCTION public.alder_actor() FROM alder_app');await check('intended-revoked',false);}finally{await restore();}});
test('A65-ACL-REGRANT: intended execution restoration permits valid startup',async()=>{await check('intended-regranted',true);});
test('A65-ACL-THIRD: unexpected nonowner grantee execution rejects readiness',async()=>{try{await owner.query('GRANT EXECUTE ON FUNCTION public.alder_actor() TO alder_indexer');assert.equal((await outside.query('SELECT public.alder_actor() actor')).rows[0].actor,null);await check('unexpected-third-role',false);}finally{await restore();}});
test('A65-ACL-DELEGATION: nonowner API WITH GRANT OPTION rejects readiness',async()=>{try{await owner.query('GRANT EXECUTE ON FUNCTION public.alder_actor() TO alder_app WITH GRANT OPTION');assert.equal((await runtime.query("SELECT has_function_privilege('public.alder_actor()','EXECUTE WITH GRANT OPTION') x")).rows[0].x,true);await check('API-grant-option',false);}finally{await restore();}});
