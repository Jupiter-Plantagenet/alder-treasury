// Real PostgreSQL proof for readiness invalidation. Set both connection URLs explicitly:
//   ALDER_ROUND7_ADMIN_URL=postgres://postgres@127.0.0.1:15545/alder_r7finish
//   ALDER_ROUND7_APP_URL=postgres://alder_app:...@127.0.0.1:15545/alder_r7finish
// The harness refuses every host/port/database except this task's loopback scratch clone.
// For local-socket-trust clones whose TCP port requires a superuser credential, the
// explicit ALDER_ROUND7_SET_ROLE=1 mode connects as postgres then SET LOCAL ROLE alder_app.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Pool, type PoolClient} from 'pg';
import {eventsCursor,readinessIndex,readinessCacheStats} from '../apps/api/eligibility.ts';

const port='15545',database=process.env.ALDER_ROUND7_EXPECTED_DB||'alder';
if(!['alder','alder_r7finish'].includes(database))throw new Error('ALDER_ROUND7_EXPECTED_DB is outside the approved scratch databases');
function requiredUrl(name:string,user:string):string{
 const raw=process.env[name];if(!raw)throw new Error(`${name} is required`);
 const u=new URL(raw);
 assert.equal(u.protocol,'postgres:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,port);assert.equal(u.pathname,`/${database}`);
 assert.equal(decodeURIComponent(u.username),user,`${name} must connect as ${user}`);
 return raw;
}
async function scopedRead<T>(pool:Pool,ws:string,sessionHash:string,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect();try{
  await db.query('BEGIN');if(process.env.ALDER_ROUND7_SET_ROLE==='1')await db.query('SET LOCAL ROLE alder_app');
  await db.query("SELECT set_config('alder.workspace_id',$1,true),set_config('alder.session_hash',$2,true)",[ws,sessionHash]);
  const out=await fn(db);await db.query('COMMIT');return out;
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
}

test('PostgreSQL: late lower-ID event invalidates scoped readiness at unchanged MAX(id)',{skip:!process.env.ALDER_ROUND7_ADMIN_URL||!process.env.ALDER_ROUND7_APP_URL},async()=>{
 const admin=new Pool({connectionString:requiredUrl('ALDER_ROUND7_ADMIN_URL','postgres'),max:3});
 const app=new Pool({connectionString:requiredUrl('ALDER_ROUND7_APP_URL',process.env.ALDER_ROUND7_SET_ROLE==='1'?'postgres':'alder_app'),max:2});
 const workspace=randomUUID(),unrelatedWorkspace=randomUUID(),incrementalWorkspace=randomUUID(),actor=randomUUID(),payable=randomUUID(),latePayable=randomUUID(),sessionHash=createHash('sha256').update(randomBytes(32)).digest('hex');
 let writer:PoolClient|undefined,unrelatedWriter:PoolClient|undefined,unrelatedAdvancer:PoolClient|undefined,lateWriter:PoolClient|undefined,lateAdvancer:PoolClient|undefined,setup=false;
 const evidence:any={test:'round7 readiness cache invalidation concurrency cases',database,port:15545,role:process.env.ALDER_ROUND7_SET_ROLE==='1'?'alder_app via SET LOCAL ROLE (superuser TCP login)':'alder_app',workspace,
  product_source_sha256:createHash('sha256').update(readFileSync(resolve('apps/api/eligibility.ts'))).digest('hex'),
  started_at:new Date().toISOString(),outcome:'failed'};
 try{
  setup=true;
  await admin.query('INSERT INTO users(id,email,password_hash,salt,name) VALUES($1,$2,$3,$4,$5)',[actor,`round7-${actor}@invalid.test`,'fixture','fixture','Round 7 fixture']);
  await admin.query('INSERT INTO memberships(workspace_id,user_id,roles) VALUES($1,$2,$3)',[workspace,actor,['preparer']]);
  await admin.query('INSERT INTO memberships(workspace_id,user_id,roles) VALUES($1,$2,$3),($4,$2,$3)',[unrelatedWorkspace,actor,['preparer'],incrementalWorkspace]);
  await admin.query('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')',[sessionHash,actor,'round7']);

  writer=await admin.connect();await writer.query('BEGIN');
  await writer.query(`INSERT INTO payables(workspace_id,id,display_reference,contact,service,recipient,amount_units,revision,prepared_by,reviewed_by,verified,payment_id)
   VALUES($1,$2,'R-ROUND7-LATE','Round 7 late commit','Manual payable','0x0000000000000000000000000000000000000001',123,1,$3,NULL,false,$4)`,[workspace,payable,actor,randomUUID()]);
  const xid=String((await writer.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
  const lower=String((await writer.query("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,'payable-create',$3) RETURNING id::text AS id",[workspace,actor,{id:payable}])).rows[0].id);
  evidence.lower_event_id=lower;evidence.writer_xid=xid;

  const upper=String((await admin.query("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,'round7-watermark',$3) RETURNING id::text AS id",[workspace,actor,{}])).rows[0].id);
  evidence.upper_event_id=upper;assert.ok(BigInt(upper)>BigInt(lower),'committed watermark must have the higher event ID');

  const before=await scopedRead(app,workspace,sessionHash,async db=>{
   const cursor=await eventsCursor(db,workspace);const ix=await readinessIndex(db,workspace,cursor);return {cursor,ix};
  });
  assert.equal(before.cursor,upper);assert.equal(before.ix.cursor,upper);assert.equal(before.ix.byId.has(payable),false);
  assert.ok(before.ix.pendingXids.includes(xid),`index snapshot must record active writer xid ${xid}`);

  await writer.query('COMMIT');writer.release();writer=undefined;
  const after=await scopedRead(app,workspace,sessionHash,async db=>{
   const cursor=await eventsCursor(db,workspace);const ix=await readinessIndex(db,workspace,cursor);return {cursor,ix};
  });
  assert.equal(after.cursor,upper,'late lower-ID commit must not advance MAX(id)');
  assert.equal(after.ix.cursor,upper);assert.equal(after.ix.mode,'full');
  assert.equal(after.ix.byId.get(payable)?.amount_units,'123','full rebuild must include newly committed payable');
  evidence.cursor_before=before.cursor;evidence.cursor_after=after.cursor;evidence.pending_xid_recorded=true;
  evidence.rebuilt_after_commit=after.ix.mode==='full';evidence.payable_visible_after_commit=after.ix.byId.has(payable);

  // A transaction with an event in another workspace must be pruned without rebuilding this workspace's index.
  unrelatedWriter=await admin.connect();await unrelatedWriter.query('BEGIN');
  await unrelatedWriter.query("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,'round7-unrelated',$3)",[workspace,actor,{fixture:true}]);
  const unrelatedXid=String((await unrelatedWriter.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
  // A committed marker advances the global xid horizon while the unrelated writer remains open.
  const unrelatedMarker=String((await admin.query("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,'round7-irrelevant-watermark',$3) RETURNING id::text AS id",[unrelatedWorkspace,actor,{}])).rows[0].id);
  const unrelatedBefore=await scopedRead(app,unrelatedWorkspace,sessionHash,async db=>{
   const cursor=await eventsCursor(db,unrelatedWorkspace);assert.equal(cursor,unrelatedMarker);return {cursor,ix:await readinessIndex(db,unrelatedWorkspace,cursor)};
  });
  assert.ok(unrelatedBefore.ix.pendingXids.includes(unrelatedXid),'unrelated active XID should be captured in the initial snapshot');
  await unrelatedWriter.query('COMMIT');unrelatedWriter.release();unrelatedWriter=undefined;
  const hitsBefore=readinessCacheStats.hits;
  const unrelatedAfter=await scopedRead(app,unrelatedWorkspace,sessionHash,async db=>{
   const cursor=await eventsCursor(db,unrelatedWorkspace);return {cursor,ix:await readinessIndex(db,unrelatedWorkspace,cursor)};
  });
  assert.equal(unrelatedAfter.ix,unrelatedBefore.ix,'unrelated commit must retain the cached index');
  assert.ok(readinessCacheStats.hits>hitsBefore,'unrelated commit should take the cache-hit path');
  assert.deepEqual(unrelatedAfter.ix.pendingXids,[],'resolved irrelevant XID must be pruned');
  evidence.unrelated_commit_cache_hit=true;evidence.unrelated_xid_pruned=true;

  // A lower-ID writer that starts after the initial build must be captured by an intervening incremental refresh.
  const watermark=String((await admin.query("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,'round7-watermark',$3) RETURNING id::text AS id",[incrementalWorkspace,actor,{}])).rows[0].id);
  const initialLate=await scopedRead(app,incrementalWorkspace,sessionHash,async db=>{
   const cursor=await eventsCursor(db,incrementalWorkspace);return {cursor,ix:await readinessIndex(db,incrementalWorkspace,cursor)};
  });
  assert.equal(initialLate.cursor,watermark);assert.deepEqual(initialLate.ix.pendingXids,[]);
  lateWriter=await admin.connect();await lateWriter.query('BEGIN');
  await lateWriter.query(`INSERT INTO payables(workspace_id,id,display_reference,contact,service,recipient,amount_units,revision,prepared_by,reviewed_by,verified,payment_id)
   VALUES($1,$2,'R-ROUND7-REFRESH','Round 7 refresh late','Manual payable','0x0000000000000000000000000000000000000002',456,1,$3,NULL,false,$4)`,[incrementalWorkspace,latePayable,actor,randomUUID()]);
  const lateXid=String((await lateWriter.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
  lateAdvancer=await admin.connect();await lateAdvancer.query('BEGIN');await lateAdvancer.query('SELECT pg_current_xact_id()');
  const lateEvent=String((await lateWriter.query("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,'payable-create',$3) RETURNING id::text AS id",[incrementalWorkspace,actor,{id:latePayable}])).rows[0].id);
  const middleEvent=String((await admin.query("INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,'contact-create',$3) RETURNING id::text AS id",[incrementalWorkspace,actor,{}])).rows[0].id);
  assert.ok(BigInt(watermark)<BigInt(lateEvent)&&BigInt(lateEvent)<BigInt(middleEvent),'writer event must be below the intermediate cursor');
  const middle=await scopedRead(app,incrementalWorkspace,sessionHash,async db=>{
   const cursor=await eventsCursor(db,incrementalWorkspace);return {cursor,ix:await readinessIndex(db,incrementalWorkspace,cursor)};
  });
  assert.equal(middle.ix.mode,'incremental');assert.ok(middle.ix.pendingXids.includes(lateXid),'incremental refresh must capture the newly started writer');
  await lateWriter.query('COMMIT');lateWriter.release();lateWriter=undefined;
  const lateAfter=await scopedRead(app,incrementalWorkspace,sessionHash,async db=>{
   const cursor=await eventsCursor(db,incrementalWorkspace);return {cursor,ix:await readinessIndex(db,incrementalWorkspace,cursor)};
  });
  assert.equal(lateAfter.cursor,middleEvent);assert.equal(lateAfter.ix.mode,'full');
  assert.equal(lateAfter.ix.byId.get(latePayable)?.amount_units,'456','captured lower-ID writer must appear after commit');
  evidence.intermediate_refresh_captured_late_xid=true;evidence.late_commit_rebuilt_full=true;evidence.late_payable_visible=true;evidence.outcome='passed';
  await lateAdvancer.query('ROLLBACK');lateAdvancer.release();lateAdvancer=undefined;
 }catch(e:any){evidence.outcome='failed';evidence.error=String(e?.stack||e);throw e;}
 finally{
  if(writer){await writer.query('ROLLBACK').catch(()=>{});writer.release();}
  if(unrelatedWriter){await unrelatedWriter.query('ROLLBACK').catch(()=>{});unrelatedWriter.release();}
  if(unrelatedAdvancer){await unrelatedAdvancer.query('ROLLBACK').catch(()=>{});unrelatedAdvancer.release();}
  if(lateWriter){await lateWriter.query('ROLLBACK').catch(()=>{});lateWriter.release();}
  if(lateAdvancer){await lateAdvancer.query('ROLLBACK').catch(()=>{});lateAdvancer.release();}
  if(setup){
   await admin.query('BEGIN');try{
    const workspaces=[workspace,unrelatedWorkspace,incrementalWorkspace];
    await admin.query('DELETE FROM events WHERE workspace_id=ANY($1::uuid[])',[workspaces]);
    await admin.query('DELETE FROM payable_intakes WHERE workspace_id=ANY($1::uuid[])',[workspaces]);
    await admin.query('DELETE FROM payables WHERE workspace_id=ANY($1::uuid[])',[workspaces]);
    await admin.query('DELETE FROM sessions WHERE token_hash=$1',[sessionHash]);
    await admin.query('DELETE FROM memberships WHERE workspace_id=ANY($1::uuid[]) AND user_id=$2',[workspaces,actor]);
    await admin.query('DELETE FROM users WHERE id=$1',[actor]);await admin.query('COMMIT');
   }catch(e){await admin.query('ROLLBACK').catch(()=>{});evidence.cleanup_error=String(e);}
  }
  evidence.finished_at=new Date().toISOString();const dir=resolve('.local');mkdirSync(dir,{recursive:true});
  writeFileSync(resolve(dir,`round7-readiness-pg-${Date.now()}.json`),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  await Promise.all([admin.end(),app.end()]);
 }
});
