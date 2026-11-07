import pg from 'pg';

const requestId = '350';
const client = new pg.Client({
  connectionString: 'postgresql://alder_indexer@127.0.0.1:15543/alder',
  connectionTimeoutMillis: 3000,
  statement_timeout: 5000,
  query_timeout: 6000,
  application_name: 'p6-monitor-request-350',
});
function safeError(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'NONSTANDARD_ERROR';
}
async function workerStatus() {
  try {
    const response = await fetch('http://127.0.0.1:9113/status', { signal: AbortSignal.timeout(2500) });
    const s: any = await response.json();
    return { http: response.status, pid: s.pid, role: s.role, phase: s.phase, fence: s.fence,
      passes: s.passes, failures: s.consecutive_failures, retryExhausted: s.retry_exhausted };
  } catch (e: any) { return { http: null, error: e?.name || 'FETCH_FAILED' }; }
}
const deadline = Date.now() + 15 * 60_000;
try {
  await client.connect();
  for (;;) {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(`
      SELECT id::text, kind, requested_by, created_at, done_at, error, claimed_fence::text
        FROM indexer_requests WHERE id = $1::bigint
    `, [requestId]);
    if (result.rowCount !== 1) throw new Error('REQUEST_350_NOT_FOUND');
    const r = result.rows[0];
    await client.query('COMMIT');
    const event = { at: new Date().toISOString(), id: r.id, kind: r.kind, requestedBy: r.requested_by,
      createdAt: r.created_at, terminal: r.done_at !== null, doneAt: r.done_at,
      errorCode: safeError(r.error), claimedFence: r.claimed_fence, worker: await workerStatus() };
    console.log(JSON.stringify(event));
    if (event.terminal) process.exit(0);
    if (Date.now() >= deadline) { console.log(JSON.stringify({ at: new Date().toISOString(), terminal: false, waitTimedOut: true })); process.exitCode = 2; break; }
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
} catch (e: any) {
  try { await client.query('ROLLBACK'); } catch {}
  console.log(JSON.stringify({ diagnostic: 'FAILED', category: e?.code || e?.message || e?.name || 'UNKNOWN' }));
  process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
