import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/api/app.ts';

test('original missing chain is a structured unavailable dependency, not an internal server error or false readiness', async () => {
  assert.equal(process.env.ALDER_RPC_URL, undefined, 'test must use preserved original product profile');
  const app = await buildApp();
  try {
    const response = await app.inject({method: 'GET', url: '/health'});
    assert.equal(response.statusCode, 503, response.body);
    const body = response.json();
    assert.equal(body.ready, false);
    assert.equal(body.database, 'ready');
    assert.equal(body.chain.status, 'unavailable');
    assert.equal(body.chain.code, 'CHAIN_UNAVAILABLE');
  } finally { await app.close(); }
});
