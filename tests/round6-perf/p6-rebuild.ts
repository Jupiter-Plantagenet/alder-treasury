// P6 operator rebuild on the ISOLATED stack (scratch 15543, RPC 18547): queued to the live isolated worker, or run under an
// ephemeral lease when none is live. Same path as ops/reconcile-rebuild.ts, but bound to the scratch database.
import pg from 'pg';import {requestReconcile} from '../../services/treasury-indexer.ts';
if(process.env.ALDER_RPC_URL!=='http://127.0.0.1:18547')throw Error('ISOLATED_ONLY');
const pool=new pg.Pool({connectionString:'postgresql://alder_indexer@127.0.0.1:15543/alder',max:2});
const t=Date.now();const r=await requestReconcile(pool,'rebuild','operator:p6-rebuild',300000);console.log(JSON.stringify({ms:Date.now()-t,head:r.head,paused:r.paused,window:r.window,phase1_ms:r.phase1_ms,phase2_ms:r.phase2_ms,operations:r.operations,changed:r.changed,via:r.via}));await pool.end();
