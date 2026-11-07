import pg from 'pg';
const client = new pg.Client({connectionString:'postgresql://alder_indexer@127.0.0.1:15543/alder',connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:6000,application_name:'p6-read-pending-requests'});
try {
  await client.connect(); await client.query('BEGIN READ ONLY');
  const q=await client.query(`SELECT id::text,kind,requested_by,created_at,done_at,error,claimed_fence::text FROM indexer_requests ORDER BY id DESC LIMIT 5`);
  await client.query('COMMIT');
  const rows=q.rows.map(r=>({id:r.id,kind:r.kind,requestedBy:r.requested_by,createdAt:r.created_at,terminal:r.done_at!==null,doneAt:r.done_at,errorCode:typeof r.error==='string'&&/^[A-Z0-9_]{1,80}$/.test(r.error)?r.error:(r.error?'NONSTANDARD_ERROR':null),claimedFence:r.claimed_fence}));
  console.log(JSON.stringify(rows));
} catch(e:any) { try{await client.query('ROLLBACK')}catch{}; console.log(JSON.stringify({diagnostic:'FAILED',category:e?.code||e?.message||e?.name||'UNKNOWN'})); process.exitCode=1; }
finally { await client.end().catch(()=>{}); }
