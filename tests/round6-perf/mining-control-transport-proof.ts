import assert from 'node:assert/strict';
import httpServer from 'node:http';
import {performance} from 'node:perf_hooks';
import {createPublicClient, http} from 'viem';
import {createMiningControlClient, P6_MINE_CONTROL_TIMEOUT_MS} from './mining-control-p6.ts';

// Actual local HTTP requests, with no Anvil or business state involved. An
// eleven-second response distinguishes the SDK default from our control client.
const server = httpServer.createServer((request, response) => {
  let text = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { text += chunk; });
  request.on('end', () => {
    const message = JSON.parse(text);
    assert.equal(message.method, 'anvil_mine');
    setTimeout(() => {
      if (!response.destroyed) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({jsonrpc: '2.0', id: message.id, result: '0x0'}));
      }
    }, 11_200);
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const ordinary = createPublicClient({transport: http(url, {retryCount: 0}), cacheTime: 0});
  const control = createMiningControlClient(url);
  const observe = async (client: any) => {
    const started = performance.now();
    try {
      const value = await client.request({method: 'anvil_mine', params: ['0x1']}, {retryCount: 0});
      return {status: 'fulfilled', value, elapsedMs: performance.now() - started};
    } catch (error: any) {
      return {status: 'rejected', errorName: error.name, elapsedMs: performance.now() - started};
    }
  };
  const [defaultResult, controlResult] = await Promise.all([observe(ordinary), observe(control)]);
  assert.equal(defaultResult.status, 'rejected');
  assert(defaultResult.elapsedMs >= 9_000 && defaultResult.elapsedMs < 11_200);
  assert.equal(controlResult.status, 'fulfilled');
  assert.equal(controlResult.value, '0x0');
  assert(controlResult.elapsedMs >= 11_200 && controlResult.elapsedMs < P6_MINE_CONTROL_TIMEOUT_MS);
  console.log(JSON.stringify({status: 'PASS', defaultResult, controlResult,
    configuredControlTimeoutMs: P6_MINE_CONTROL_TIMEOUT_MS, actualChainAccessed: false}));
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
