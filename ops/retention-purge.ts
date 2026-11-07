// Round 6 (TR-T-EXPORT): operator retention job for ONE workspace (out-of-band migration principal, local only).
//   tsx ops/retention-purge.ts --workspace <uuid> [--attachment-days 180] [--attachment-seconds N] [--exports]
// - Attachment bytes older than the retention are deleted through alder_attachment_retention_purge (db/012): content
//   becomes NULL, metadata/SHA-256/links stay, and an immutable attachment_retention_purges row is written.
// - With --exports, expired evidence-export bytes are purged: the `evidence-export-purged` event commits first, then the
//   bytes are deleted. The locked scan also retries physical cleanup for expired IDs with an existing purge event.
// Policy guard: the blueprint retention is 180 days. A shorter retention is refused unless the workspace is a
// registered test workspace (display name starts with a test prefix) - never the primary workspace.
import pg from 'pg';import fs from 'node:fs';import path from 'node:path';
const arg=(k:string)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:undefined;};
const ws=arg('--workspace')||'';if(!/^[0-9a-f-]{36}$/.test(ws))throw Error('WORKSPACE_REQUIRED');
const seconds=arg('--attachment-seconds')?Number(arg('--attachment-seconds')):Number(arg('--attachment-days')||180)*86400;
const PRIMARY='00000000-0000-4000-8000-000000000001',TEST_PREFIX=/^(S6|B5|RV6|O5|W5)\b/;
const db=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:5543/alder'});await db.connect();
const out:any={workspace:ws,retention_seconds:seconds,attachments_purged:0,exports_purged:[] as string[]};
try{
 const name=(await db.query('SELECT display_name FROM workspace_profiles WHERE workspace_id=$1',[ws])).rows[0]?.display_name||'';
 if(!(seconds>0))throw Error('RETENTION_INVALID');
 if(seconds<180*86400&&(ws===PRIMARY||!TEST_PREFIX.test(name)))throw Error('RETENTION_BELOW_POLICY_REFUSED_FOR_NON_TEST_WORKSPACE');
 await db.query('BEGIN');out.attachments_purged=(await db.query("SELECT public.alder_attachment_retention_purge($1,make_interval(secs=>$2),'operator:retention-purge') AS n",[ws,seconds])).rows[0].n;await db.query('COMMIT');
 if(process.argv.includes('--exports')){
  const lockKey='evidence-export:'+ws;await db.query('SELECT pg_advisory_lock(hashtext($1))',[lockKey]);try{
  const ev=(await db.query("SELECT kind,data FROM events WHERE workspace_id=$1 AND kind IN ('evidence-export-created','evidence-export-purged')",[ws])).rows;
  const purged=new Set(ev.filter((e:any)=>e.kind==='evidence-export-purged').map((e:any)=>e.data.export_id));
  const due=ev.filter((e:any)=>e.kind==='evidence-export-created'&&Number.isFinite(Date.parse(e.data.retention_until))&&Date.parse(e.data.retention_until)<=Date.now());
  const root=path.resolve(process.env.ALDER_EXPORT_DIR||'.local/exports');
  for(const e of due){const id=e.data.export_id;if(!/^[0-9a-f-]{8}-[0-9a-f-]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))continue;const dir=path.join(root,ws,id);
   if(!purged.has(id))await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[ws,'00000000-0000-4000-8000-000000000000','evidence-export-purged',{id,export_id:id,manifest_digest:e.data.manifest_digest,bytes_deleted:fs.existsSync(dir),state:'expired',by:'operator:retention-purge'}]);
   fs.rmSync(dir,{recursive:true,force:true});out.exports_purged.push(id);}
  }finally{await db.query('SELECT pg_advisory_unlock(hashtext($1))',[lockKey]);}
 }
 console.log(JSON.stringify(out));
}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}
