// O5 ISOLATED API: the real Alder Fastify app (buildApp from a frozen source snapshot, O5_SRC) bound to
//   - port 9103 (O5_PORT), loopback only;
//   - the scratch PostgreSQL 127.0.0.1:15543/alder as the non-superuser, non-BYPASSRLS roles alder_app / alder_indexer
//     (trusted constructor injection, the same path the unit tests use; production databaseUrl allowlist unchanged);
//   - RPC http://127.0.0.1:18547 = O5 lying/stale proxy -> isolated Anvil 18548 (the app's own allowlist accepts 18547);
//   - deployment manifest evidence/round5-ops/isolated-deployment.json.
// It never touches the live API 8103, live DB 5543/alder or live chain 8547.
import pg from 'pg';import path from 'node:path';import {pathToFileURL} from 'node:url';
process.env.ALDER_RPC_URL='http://127.0.0.1:18547';
process.env.ALDER_DEPLOYMENT_FILE=process.env.ALDER_DEPLOYMENT_FILE||'evidence/round5-ops/isolated-deployment.json';
const src=path.resolve(process.env.O5_SRC||'.');const port=Number(process.env.O5_PORT||9103);
const mod=(p:string)=>import(pathToFileURL(path.join(src,p)).href);
const {buildApp}=await mod('apps/api/app.ts');const {scopedPool}=await mod('apps/api/database.ts');
const dbHost=process.env.O5_DB||'127.0.0.1:15543/alder';
if(!/^127\.0\.0\.1:1554[3-9]\//.test(dbHost))throw Error('O5_SCRATCH_DB_ONLY');
const pool=scopedPool(new pg.Pool({connectionString:`postgresql://alder_app@${dbHost}`,max:Number(process.env.O5_POOL_MAX||8)}));
const indexerPool=new pg.Pool({connectionString:`postgresql://alder_indexer@${dbHost}`,max:2});
const app=await buildApp({pool,indexerPool});
await app.listen({host:'127.0.0.1',port});
console.log(JSON.stringify({o5IsolatedApi:true,port,src,db:dbHost,rpc:process.env.ALDER_RPC_URL,deployment:process.env.ALDER_DEPLOYMENT_FILE,pid:process.pid,started:new Date().toISOString()}));
