// @ts-nocheck -- operator drill script
// Round-4 coherent restore drill (TR-T-RESTORE): one manifest binding a pg_dump of the retained `alder` DB, a copy of
// the persistent lineage-2 Anvil state and the deployment manifest; restore into an ISOLATED database + isolated Anvil
// on 127.0.0.1:18547; verify digests/ACLs; rebuild chain-derived state from deployment + block hashes; prove that no
// broadcast happens after restore. Live services are not stopped. The isolated DB/Anvil are removed at the end.
import fs from 'node:fs';import path from 'node:path';import {execFileSync,spawn} from 'node:child_process';import {createHash} from 'node:crypto';import pg from 'pg';
process.env.ALDER_RPC_URL='http://127.0.0.1:18547';
const t0=Date.now();const stamp=new Date().toISOString().replace(/[-:.]/g,'').slice(0,15);const out=`evidence/round4/restore-drill-${stamp}`;fs.mkdirSync(out,{recursive:true});
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');const log=(...a:any[])=>{const l=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');console.log(l);fs.appendFileSync(out+'/drill.log',l+'\n');};
const tables=async(db:pg.Pool)=>{const names=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows.map(r=>r.tablename);const res:any={};for(const t of names){const r=(await db.query(`SELECT count(*)::text n, coalesce(md5(string_agg(md5(x::text),'' ORDER BY md5(x::text))),'') d FROM ${t} x`)).rows[0];const acl=(await db.query("SELECT array_to_string(coalesce(relacl,acldefault('r',relowner)),',') a, relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname=$1 AND relnamespace='public'::regnamespace",[t])).rows[0];res[t]={rows:r.n,digest:r.d,acl:acl.a,rls:acl.r,force:acl.f};}return res;};
const live=new pg.Pool({connectionString:'postgresql://postgres@127.0.0.1:5543/alder',max:1});
// ---- 1. capture (quiescent: drill is the only actor; state-interval 5 s elapses before the state copy) ----
const deployment=JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8'));
const liveCp=(await live.query('SELECT number,hash FROM treasury_checkpoints')).rows[0];
const liveBefore=await tables(live);
const dumpFile=`.local/backups/alder-restore-drill-${stamp}.dump`;fs.writeFileSync(dumpFile,execFileSync('docker',['exec','alder-postgres','pg_dump','-U','postgres','-d','alder','-Fc'],{maxBuffer:1<<30}));
await new Promise(r=>setTimeout(r,6500));const stateCopy=`chain-state/backups/restore-drill-${stamp}.json`;fs.mkdirSync('chain-state/backups',{recursive:true});fs.copyFileSync('chain-state/anvil-8547-state.json',stateCopy);
const liveHead=await (await fetch('http://127.0.0.1:8547',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['latest',false]})})).json();
const manifest={created:new Date().toISOString(),db:{file:dumpFile,sha256:sha(fs.readFileSync(dumpFile)),tables:Object.keys(liveBefore).length},chain:{state_copy:stateCopy,sha256:sha(fs.readFileSync(stateCopy)),genesis:deployment.genesis,head_at_capture:{number:parseInt(liveHead.result.number,16),hash:liveHead.result.hash}},deployment:{sha256:sha(fs.readFileSync('evidence/app-deployment.json')),safe:deployment.safe,executor:deployment.executor,token:deployment.token},checkpoint:liveCp,table_digests:liveBefore};
fs.writeFileSync(out+'/manifest.json',JSON.stringify(manifest,null,1));log('captured',{db_sha256:manifest.db.sha256,chain_sha256:manifest.chain.sha256,head:manifest.chain.head_at_capture,checkpoint:liveCp});
// ---- 2. restore into isolated instance ----
const rdb='alder_restore_r4_'+stamp.toLowerCase();let anvil:any;const result:any={manifest:out+'/manifest.json'};
try{
 if(sha(fs.readFileSync(dumpFile))!==manifest.db.sha256||sha(fs.readFileSync(stateCopy))!==manifest.chain.sha256)throw Error('MANIFEST_DIGEST_MISMATCH');
 execFileSync('docker',['exec','alder-postgres','createdb','-U','postgres',rdb]);execFileSync('docker',['exec','-i','alder-postgres','pg_restore','-U','postgres','-d',rdb],{input:fs.readFileSync(dumpFile)});
 const restoredState=`chain-state/backups/restore-drill-${stamp}-isolated.json`;fs.copyFileSync(stateCopy,restoredState);execFileSync(process.execPath,['ops/sanitize-anvil-state.mjs',restoredState,'0x6ae4a90c'],{stdio:'inherit'});
 anvil=spawn('C:/Users/user/.foundry/bin/anvil.exe',['--host','127.0.0.1','--port','18547','--chain-id','31337','--hardfork','shanghai','--silent','--state',restoredState],{stdio:'ignore'});
 for(let i=0;i<60;i++){try{await fetch('http://127.0.0.1:18547',{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'});break;}catch{await new Promise(r=>setTimeout(r,250));}}
 const rpc=async(method:string,params:any[]=[])=>(await (await fetch('http://127.0.0.1:18547',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json()).result;
 const g=await rpc('eth_getBlockByNumber',['0x0',false]);const h=await rpc('eth_getBlockByNumber',['0x'+manifest.chain.head_at_capture.number.toString(16),false]);
 const restored=new pg.Pool({connectionString:`postgresql://postgres@127.0.0.1:5543/${rdb}`,max:1});
 const after=await tables(restored);const diffs=Object.keys(liveBefore).filter(t=>JSON.stringify(liveBefore[t])!==JSON.stringify(after[t]));
 result.chain={genesis_ok:g.hash===deployment.genesis,head_ok:h?.hash===manifest.chain.head_at_capture.hash,code_present:(await rpc('eth_getCode',[deployment.safe,'latest'])).length>2};
 result.db={tables:Object.keys(after).length,digest_and_acl_mismatches:diffs,detail:diffs.map(t=>({t,live:liveBefore[t],restored:after[t]}))};
 // ---- 3. rebuild chain-derived state from deployment + block hashes on the isolated pair; no broadcast ----
 const attemptsBefore=(await restored.query('SELECT count(*)::int n FROM treasury_attempts')).rows[0].n;const settledBefore=(await restored.query("SELECT count(*)::int n FROM treasury_settlements WHERE state='verified'")).rows[0].n;
 await restored.query('DELETE FROM treasury_checkpoints');await restored.query('DELETE FROM treasury_headers'); // chain-derived cache only, rebuilt below from block hashes
 const {reconcileApplication}=await import('../services/treasury-indexer.ts');const rb=await reconcileApplication(restored,{rebuild:true});
 const attemptsAfter=(await restored.query('SELECT count(*)::int n FROM treasury_attempts')).rows[0].n;const settledAfter=(await restored.query("SELECT count(*)::int n FROM treasury_settlements WHERE state='verified'")).rows[0].n;
 const txcount=await rpc('eth_blockNumber');
 result.rebuild={result:rb,checkpoint_matches_capture:rb.headHash===manifest.chain.head_at_capture.hash,settled_before:settledBefore,settled_after:settledAfter,attempts_unchanged:attemptsBefore===attemptsAfter,isolated_chain_head_unchanged:parseInt(txcount,16)===manifest.chain.head_at_capture.number};
 await restored.end();
 result.rto_ms=Date.now()-t0;result.pass=result.chain.genesis_ok&&result.chain.head_ok&&diffs.length===0&&result.rebuild.checkpoint_matches_capture&&settledAfter===settledBefore&&result.rebuild.attempts_unchanged&&result.rebuild.isolated_chain_head_unchanged;
 result.gaps=['No continuous WAL archiving / PITR: RPO is the manual capture point, not <=60 s','Drill restores into the same PostgreSQL cluster (isolated database), not a separate host','Backup is not encrypted in this drill (stored under ignored .local/backups)'];
}catch(e:any){result.error=String(e?.stack||e);result.pass=false;}
finally{try{anvil?.kill();}catch{}try{execFileSync('docker',['exec','alder-postgres','dropdb','-U','postgres','--if-exists',rdb]);result.cleanup='isolated database dropped; isolated anvil stopped';}catch(e){result.cleanup='cleanup failed: '+e;}
 fs.writeFileSync(out+'/result.json',JSON.stringify(result,null,1));log('RESULT',result);await live.end();process.exit(result.pass?0:1);}
