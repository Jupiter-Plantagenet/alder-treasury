// Round 6 DB-boundary probe (F-M3 lease/fence/outbox, PUBLIC EXECUTE, F-L1 binding, attachment immutability).
// Every case runs inside BEGIN ... ROLLBACK as the local migration principal, switching to the scoped roles with
// SET LOCAL SESSION AUTHORIZATION (session_user changes, so the fence trigger applies). Nothing is committed.
// Usage: tsx tests/round6/db-probe.ts <database> <out.json>
import pg from 'pg';import fs from 'node:fs';
const dbName=process.argv[2]||'alder',out=process.argv[3];
const c=new pg.Client({connectionString:`postgresql://postgres@127.0.0.1:5543/${dbName}`});await c.connect();
const results:any[]=[];
async function probe(id:string,expect:(r:any)=>boolean,fn:()=>Promise<any>){let r:any;await c.query('BEGIN');try{r=await fn();}catch(e:any){r={error:String(e.message).slice(0,160)};}finally{await c.query('ROLLBACK');}
 const pass=!!expect(r);results.push({id,pass,result:r});console.log(pass?'PASS':'FAIL',id,JSON.stringify(r).slice(0,220));}
const as=async(role:string)=>c.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);
const err=async(sql:string,args:any[]=[])=>{await c.query('SAVEPOINT p');try{await c.query(sql,args);await c.query('RELEASE SAVEPOINT p');return 'OK';}catch(e:any){await c.query('ROLLBACK TO SAVEPOINT p');return String(e.message).slice(0,120);}};
const WS=(await c.query("SELECT workspace_id FROM memberships ORDER BY workspace_id LIMIT 1")).rows[0].workspace_id;
const ensureLease=async()=>{await c.query("INSERT INTO worker_leases(name,holder,fence,expires_at) VALUES('indexer','probe-seed',1,now()+interval '30 seconds') ON CONFLICT(name) DO NOTHING");};

await probe('F-M3 plain UPDATE seizure of a live lease is impossible (alder_indexer has no UPDATE/INSERT on worker_leases)',r=>/permission denied/.test(r.update)&&/permission denied/.test(r.insert),async()=>{await ensureLease();await as('alder_indexer');
 return {update:await err("UPDATE worker_leases SET holder='probe',fence=fence+1 WHERE name='indexer'"),insert:await err("INSERT INTO worker_leases(name,holder,fence,expires_at) VALUES('probe-x','p',1,now()+interval '1 minute')")};});
await probe('F-M3 acquire refuses a takeover while the lease is unexpired (DB-enforced)',r=>r.rows===0,async()=>{await c.query("UPDATE worker_leases SET expires_at=clock_timestamp()+interval '30 seconds' WHERE name='indexer'");await ensureLease();await as('alder_indexer');
 return {rows:(await c.query("SELECT * FROM alder_lease_acquire('indexer','probe-thief',30)")).rowCount};});
await probe('F-M3 a reader who knows the fence cannot write: FENCE_TOKEN_REQUIRED without token, STALE_FENCE with a wrong token',r=>/FENCE_TOKEN_REQUIRED/.test(r.no_token)&&/STALE_FENCE/.test(r.wrong_token),async()=>{await ensureLease();await c.query("UPDATE worker_leases SET expires_at=clock_timestamp()+interval '30 seconds' WHERE name='indexer'");await as('alder_indexer');
 const f=(await c.query("SELECT fence::text FROM worker_leases WHERE name='indexer'")).rows[0].fence;await c.query("SELECT set_config('alder.worker_fence',$1,true)",[f]);
 const no_token=await err("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,'00000000-0000-4000-8000-000000000000','r6-probe','{}')",[WS]);
 await c.query("SELECT set_config('alder.worker_token',$1,true)",['f'.repeat(96)]);
 const wrong_token=await err("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,'00000000-0000-4000-8000-000000000000','r6-probe','{}')",[WS]);
 const assert_wrong=await err("SELECT alder_lease_assert('indexer',$1::bigint,$2)",[f,'0'.repeat(96)]);return {fence:f,no_token,wrong_token,assert_wrong};});
await probe('F-M3 after expiry the holder of the NEW token writes; the old token is STALE_FENCE; renew with the old token fails',r=>r.acquired&&r.new_write==='OK'&&/STALE_FENCE|LEASE_LOST/.test(r.old_write)&&r.old_renew===false,async()=>{await ensureLease();
 await c.query("UPDATE worker_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE name='indexer'");await as('alder_indexer');
 const a=(await c.query("SELECT * FROM alder_lease_acquire('indexer','probe-a',30)")).rows[0];
 await c.query('RESET SESSION AUTHORIZATION');await c.query("UPDATE worker_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE name='indexer'");await as('alder_indexer');
 const b=(await c.query("SELECT * FROM alder_lease_acquire('indexer','probe-b',30)")).rows[0];
 await c.query("SELECT alder_lease_assert('indexer',$1::bigint,$2)",[b.fence,b.token]);
 const new_write=await err("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,'00000000-0000-4000-8000-000000000000','r6-probe','{}')",[WS]);
 await c.query("SELECT set_config('alder.worker_fence',$1,true),set_config('alder.worker_token',$2,true)",[a.fence,a.token]);
 const old_write=await err("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,'00000000-0000-4000-8000-000000000000','r6-probe','{}')",[WS]);
 const old_renew=(await c.query("SELECT alder_lease_renew('indexer',$1::bigint,$2,30,NULL,NULL) AS ok",[a.fence,a.token])).rows[0].ok;
 return {acquired:!!a&&!!b&&BigInt(b.fence)===BigInt(a.fence)+1n,token_len:b?.token?.length,new_write,old_write,old_renew};});
await probe('F-M3/F-L3 alder_app cannot touch the lease or mark outbox items (no UPDATE on outbox; lease functions not executable)',r=>/permission denied/.test(r.outbox_update)&&/permission denied/.test(r.acquire)&&/permission denied/.test(r.lease_update),async()=>{await as('alder_app');
 return {outbox_update:await err("UPDATE outbox SET state='delivered'"),acquire:await err("SELECT * FROM alder_lease_acquire('indexer','app',30)"),lease_update:await err("UPDATE worker_leases SET fence=fence+1")};});
await probe('F-L3 dedupe keys are workspace-scoped: the same key in two workspaces both insert; a repeat in one workspace conflicts',r=>r.a==='OK'&&r.b==='OK'&&/duplicate key/.test(r.dup),async()=>{
 const k='r6-probe:'+Date.now();const w2=WS==='00000000-0000-4000-8000-0000000000e6'?'00000000-0000-4000-8000-0000000000b5':'00000000-0000-4000-8000-0000000000e6';
 return {a:await err("INSERT INTO outbox(workspace_id,kind,dedupe_key,payload) VALUES($1,'r6.probe',$2,'{}')",[WS,k]),b:await err("INSERT INTO outbox(workspace_id,kind,dedupe_key,payload) VALUES($1,'r6.probe',$2,'{}')",[w2,k]),dup:await err("INSERT INTO outbox(workspace_id,kind,dedupe_key,payload) VALUES($1,'r6.probe',$2,'{}')",[WS,k])};});
await probe('F-L3 alder_app may insert only its two exact, workspace-bound notices: an arbitrary outbox kind/key is refused (OUTBOX_APP_INSERT_DENIED)',r=>/OUTBOX_APP_INSERT_DENIED/.test(r.arbitrary)&&/OUTBOX_APP_INSERT_DENIED/.test(r.forged_import),async()=>{await as('alder_app');
 return {arbitrary:await err("INSERT INTO outbox(workspace_id,kind,dedupe_key,payload) VALUES($1,'op.state','op-state:x:1','{}')",[WS]),forged_import:await err("INSERT INTO outbox(workspace_id,kind,dedupe_key,payload) VALUES($1,'payables.imported','import:00000000-0000-4000-8000-000000000999','{\"entity_id\":\"00000000-0000-4000-8000-000000000999\"}')",[WS])};});
await probe('DB hygiene: no SECURITY DEFINER function in public is EXECUTE-able by PUBLIC',r=>r.public_definers.length===0,async()=>({public_definers:(await c.query("SELECT p.oid::regprocedure::text f FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('public',p.oid,'EXECUTE')")).rows.map((x:any)=>x.f)}));
await probe('DB hygiene: an unrelated role (alder_verifier) cannot call the five formerly-PUBLIC definer functions',r=>Object.values(r).every((v:any)=>/permission denied/.test(v)),async()=>{await as('alder_verifier');
 return {actor_email:await err('SELECT alder_actor_email()'),is_admin:await err("SELECT alder_is_workspace_admin('00000000-0000-4000-8000-000000000001')"),assert_fence:await err('SELECT alder_assert_fence()'),release_guard:await err('SELECT alder_reservation_release_guard()'),unsettled:await err('SELECT alder_reservation_unsettled()')};});
await probe('Migration 010 narrowing kept (least privilege): alder_verifier has no INSERT on treasury_reports',r=>r.insert===false&&r.seq===false,async()=>({insert:(await c.query("SELECT has_table_privilege('alder_verifier','treasury_reports','INSERT') v")).rows[0].v,seq:(await c.query("SELECT has_sequence_privilege('alder_verifier','treasury_reports_id_seq','USAGE') v")).rows[0].v}));
await probe('F-L1 an invalidation whose target hash/nonce/batch differs from the target operation record is refused (INVALIDATION_BINDING)',r=>/INVALIDATION_BINDING/.test(r.forged),async()=>{
 const i=(await c.query('SELECT * FROM operation_invalidations ORDER BY created_at DESC LIMIT 1')).rows[0];if(!i)return {skipped:'no invalidations'};
 await c.query('ALTER TABLE operation_invalidations DISABLE TRIGGER USER');await c.query('ALTER TABLE operation_invalidations ENABLE TRIGGER invalidation_binding');
 const forged=await err('INSERT INTO operation_invalidations(workspace_id,operation_id,target_operation_id,method,target_safe_tx_hash,target_nonce,invalidation_nonce,target_batch_id,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[i.workspace_id,i.operation_id,i.target_operation_id,i.method,'0x'+'ab'.repeat(32),i.target_nonce,i.invalidation_nonce,i.target_batch_id,'r6 probe',i.requested_by]);
 return {forged};});
await probe('Membership SoD constraint: admin cannot be combined with owner/reviewer/preparer even by direct SQL',r=>/memberships_admin_not_treasury/.test(r.combo),async()=>{const m=(await c.query("SELECT workspace_id,user_id FROM memberships WHERE 'admin'=ANY(roles) LIMIT 1")).rows[0];
 return {combo:m?await err("UPDATE memberships SET roles=ARRAY['admin','owner'] WHERE workspace_id=$1 AND user_id=$2",[m.workspace_id,m.user_id]):'no admin'};});
await probe('Attachment bytes stay immutable except through the retention function (direct UPDATE content=NULL refused, even as owner)',r=>/immutable/.test(r.direct),async()=>{const a=(await c.query('SELECT workspace_id,id FROM private_attachments WHERE content IS NOT NULL LIMIT 1')).rows[0];if(!a)return {skipped:'none'};
 return {direct:await err('UPDATE private_attachments SET content=NULL,purged_at=now() WHERE workspace_id=$1 AND id=$2',[a.workspace_id,a.id])};});
await c.end();
const summary={database:dbName,at:new Date().toISOString(),passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results};
if(out)fs.writeFileSync(out,JSON.stringify(summary,null,1));console.log('SUMMARY',summary.passed,'/',results.length);process.exit(summary.failed?1:0);
