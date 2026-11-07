import {Pool} from 'pg';import {AsyncLocalStorage} from 'node:async_hooks';import fs from 'node:fs';
export const databaseScope=new AsyncLocalStorage<{workspace?:string,sessionHash?:string}>();
export function databaseUrl(role:'app'|'indexer'|'verifier'){
 const override=role==='app'?process.env.ALDER_DATABASE_URL:role==='indexer'?process.env.ALDER_INDEXER_DATABASE_URL:process.env.ALDER_VERIFIER_DATABASE_URL;
 if(override){const u=new URL(override);const isolated=u.pathname==='/alder_intake_proof_20261029a';if(isolated&&u.username!=='alder_'+role)throw Error('SCOPED_DATABASE_ROLE_REQUIRED');if(u.hostname!=='127.0.0.1'||u.port!=='5543'||!['/alder','/alder_v2_test','/alder_intake_proof_20261029a'].includes(u.pathname))throw Error('LOCAL_DATABASE_ONLY');if(u.username==='postgres'&&u.pathname!=='/alder_v2_test')throw Error('SUPERUSER_PRODUCT_PATH_FORBIDDEN');return override;}
 // The network API reads an app-only profile, never the combined machine credentials.
 // Provision once with ops/split-api-profile.ts; retain the combined file privately for operator/worker use.
 const cfg=role==='app'?JSON.parse(fs.readFileSync('.local/database-app.json','utf8')):JSON.parse(fs.readFileSync('.local/database.json','utf8'))[role];if(cfg.user!=='alder_'+role)throw Error('SCOPED_DATABASE_ROLE_REQUIRED');const database=process.env.ALDER_DATABASE_URL?.endsWith('/alder_v2_test')?'alder_v2_test':'alder';return `postgresql://${cfg.user}:${encodeURIComponent(cfg.password)}@127.0.0.1:5543/${database}`;
}
// Trusted constructor injection for isolated tests; production keeps databaseUrl's strict allowlist.
export function scopedPool(real=new Pool({connectionString:databaseUrl('app'),max:8,application_name:'alder-api:'+process.pid})){
 const connect=async()=>{const db=await real.connect();return {release:()=>db.release(),query:async(q:string,args?:any[])=>{const result=await db.query(q,args);if(q==='BEGIN'){const ctx=databaseScope.getStore();await db.query("SELECT set_config('alder.workspace_id',$1,true),set_config('alder.session_hash',$2,true)",[ctx?.workspace||'',ctx?.sessionHash||'']);}return result;}};};
 return {end:()=>real.end(),connect,query:async(q:string,args?:any[])=>{const db=await connect();try{await db.query('BEGIN');const result=await db.query(q,args);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}};
}
