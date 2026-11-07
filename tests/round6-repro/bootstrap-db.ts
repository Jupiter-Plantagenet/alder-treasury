// Runs only inside the fresh TR-T-REPRO namespace. Creates the disposable schema and three
// least-privilege database principals. Never opens the retained workstation database.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

if (process.env.ALDER_REPRO_NAMESPACE !== '1' || process.env.ALDER_REPRO_PROJECT?.startsWith('alder-repro-') !== true) {
  throw Error('FRESH_REPRO_NAMESPACE_REQUIRED');
}
const host = '127.0.0.1';
const port = Number(process.env.ALDER_DB_PORT || 5543);
if (port !== 5543) throw Error('INTERNAL_REPRO_DATABASE_PORT_REQUIRED');
const admin = new pg.Pool({connectionString:`postgresql://postgres@${host}:${port}/postgres`, max:1});
const exists=(await admin.query("SELECT 1 FROM pg_database WHERE datname='alder_v2_test'")).rows.length>0;
if(exists)throw Error('REFUSING_PREEXISTING_REPRO_VERIFIER_DATABASE');
await admin.query('CREATE DATABASE alder_v2_test');
const privateDir='.local'; fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
const profiles:any={};
for (const role of ['app','indexer','verifier']) {
  const user=`alder_${role}`;
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${user}') THEN CREATE ROLE ${user} LOGIN; END IF; END $$; ALTER ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`);
  profiles[role]={user,password:''};
}
const write=(file:string,data:unknown)=>fs.writeFileSync(path.join(privateDir,file),JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
write('database.json',profiles);
write('database-app.json',profiles.app);
const migrations=[
 '001.sql','002.sql','003-roles.sql','004-constraints.sql','005-destinations.sql',
 '006-payable-intake.sql','007-private-attachments.sql','008-review-policy.sql',
 '009-chain-lineage-2.sql','010-round5-durable-invalidation.sql','011-round5-indexer-attempt-read.sql',
 '012-round6-access-hardening.sql','013-round6-outbox-import-guard.sql',
 '014-validate-invite-owner.sql','015-persistent-login-throttles.sql','016-api-canonical-chain-reads.sql'
];
const sha=(data:Buffer)=>crypto.createHash('sha256').update(data).digest('hex');
for (const database of ['alder','alder_v2_test']) {
  const pool=new pg.Pool({connectionString:`postgresql://postgres@${host}:${port}/${database}`,max:1});
  const client=await pool.connect();
  try{
    for(let i=0;i<migrations.length;i++){
      const file=migrations[i],data=fs.readFileSync(path.join('db',file));
      await client.query('BEGIN');
      await client.query(data.toString('utf8'));
      if(i===8){
        for(let prior=0;prior<=i;prior++){
          const name=migrations[prior],bytes=fs.readFileSync(path.join('db',name));
          await client.query('INSERT INTO schema_migrations(id,sha256,note) VALUES($1,$2,$3)',
            [path.basename(name,'.sql'),sha(bytes),'fresh isolated bootstrap; applied in canonical order to '+database]);
        }
      }else if(i>8){
        await client.query('INSERT INTO schema_migrations(id,sha256,note) VALUES($1,$2,$3)',
          [path.basename(file,'.sql'),sha(data),'fresh isolated bootstrap; applied in canonical order to '+database]);
      }
      await client.query('COMMIT');
    }
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();await pool.end();}
}
console.log(JSON.stringify({schema:migrations.map(file=>'db/'+file),schemaMigrationCount:migrations.length,databases:['alder','alder_v2_test'],principals:['alder_app','alder_indexer','alder_verifier'],authentication:'trust is reachable only in the un-published isolated network namespace; profile files stay private'}));
await admin.end();
