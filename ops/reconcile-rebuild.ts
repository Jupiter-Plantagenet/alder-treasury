// Operator-only deep-reorg recovery: after reviewing a paused (>12-block) reorganization, replay the full canonical
// header view and clear the pause using the scoped alder_indexer role. Never exposed over HTTP.
// Round 5: the rebuild goes through the single active writer: it is queued for the live worker (fenced pass), or,
// when no worker holds the lease, run under an ephemeral lease. Reaffirmation is limited to trusted, version- and
// manifest-bound reports produced by the indexer (review H1); everything else is re-verified.
import pg from 'pg';import fs from 'node:fs';import {databaseUrl} from '../apps/api/database.ts';import {requestReconcile} from '../services/treasury-indexer.ts';
const pool=new pg.Pool({connectionString:databaseUrl('indexer'),max:2});
try{const before=(await pool.query('SELECT chain_key,number,hash,paused FROM treasury_checkpoints')).rows;const r=await requestReconcile(pool,'rebuild','operator:reconcile-rebuild',180000);const line=JSON.stringify({at:new Date().toISOString(),before,result:r});fs.mkdirSync('runtime-logs',{recursive:true});fs.appendFileSync('runtime-logs/reconcile-rebuild.jsonl',line+'\n');console.log(line);}
finally{await pool.end();}
