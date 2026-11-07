import { Pool } from 'pg';
import fs from 'node:fs';
import https from 'node:https';
import { buildApp } from '../../apps/api/app.ts';
import { scopedPool } from '../../apps/api/database.ts';
import { caPem, serverTls } from '../../apps/api/tls.ts';

const profile = JSON.parse(fs.readFileSync(process.env.ALDER_ROUND7_APP_PROFILE!, 'utf8'));
if (profile.user !== 'alder_app' || process.env.ALDER_RPC_URL !== 'http://127.0.0.1:18547')
  throw new Error('ROUND7_ISOLATED_PROFILE_OR_RPC_REQUIRED');
const dbPort = process.env.ALDER_ROUND7_DB_PORT || '15543';
if (dbPort !== '15543') throw new Error('ROUND7_ISOLATED_DB_PORT_REQUIRED');
const url = `postgresql://${profile.user}:${encodeURIComponent(profile.password)}@127.0.0.1:${dbPort}/alder`;
const app = await buildApp({ pool: scopedPool(new Pool({ connectionString: url, max: 2 })) }, { https: serverTls() });
try {
  await app.listen({ host: '127.0.0.1', port: 19553 });
  const response: any = await new Promise((resolve, reject) => {
    const req = https.get('https://127.0.0.1:19553/health', { ca: caPem(), rejectUnauthorized: true }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (part) => data += part);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('HEALTH_REQUEST_TIMEOUT')));
  });
  const body: any = response.body;
  const assertions = {
    strictTlsTrustedByBackupCa: true,
    http200: response.status === 200,
    ready: body.ready === true,
    restoredPostgresReady: body.persistence === 'PostgreSQL' && body.database === 'ready',
    chainHealthReady: body.chain?.status === 'ready',
    expectedChainId: body.chainId === 31337,
  };
  console.log(JSON.stringify({ assertions, pass: Object.values(assertions).every(Boolean),
    broadcastAttempted: false, workerStarted: false, signerStarted: false }));
  if (!Object.values(assertions).every(Boolean)) process.exitCode = 2;
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
} finally {
  await app.close();
}
