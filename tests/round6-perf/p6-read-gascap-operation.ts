import fs from 'node:fs';
import * as L from '../round5-ops/o5-lib.ts';
const file='.local/scratch-r6/runs/p6-20261102T131830Z-a2capfresh/gascap-state.json';
let row:any=null;
try {
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  const id=state?.A?.opId; if(typeof id!=='string') throw new Error('GASCAP_OPERATION_ID_MISSING');
  const q=await L.q(`SELECT o.state,o.kind,o.created_at,
      (SELECT count(*)::int FROM treasury_signatures s WHERE s.workspace_id=o.workspace_id AND s.operation_id=o.id) AS signatures,
      (SELECT count(*)::int FROM treasury_attempts a WHERE a.workspace_id=o.workspace_id AND a.operation_id=o.id) AS attempts,
      (SELECT count(*)::int FROM reservations r JOIN batches b ON b.workspace_id=r.workspace_id AND b.id=r.batch_id WHERE b.workspace_id=o.workspace_id AND b.operation_id=o.id) AS reservations,
      (SELECT state FROM batches b WHERE b.workspace_id=o.workspace_id AND b.operation_id=o.id LIMIT 1) AS batch_state
    FROM treasury_operations o WHERE o.workspace_id=$1 AND o.id=$2`,[L.WS,id]);
  row=q[0]??null;
  const nonce=await L.safeNonce();
  const out={found:!!row,operationId:id,...row,safeNonce:String(nonce)};
  console.log(JSON.stringify(out));
} catch(e:any) { console.log(JSON.stringify({diagnostic:'FAILED',category:e?.code||e?.message||e?.name||'UNKNOWN'})); process.exitCode=1; }
finally { await L.db.end().catch(()=>{}); }
