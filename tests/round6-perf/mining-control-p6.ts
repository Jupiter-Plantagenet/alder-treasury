import {createPublicClient, http} from 'viem';

// This client is exclusively for synthetic chain preparation. The ordinary
// client and all measured reconciliation/rebuild deadlines remain unchanged.
export const P6_MINE_CONTROL_TIMEOUT_MS = 60_000;

export function createMiningControlClient(url: string) {
  return createPublicClient({
    transport: http(url, {timeout: P6_MINE_CONTROL_TIMEOUT_MS, retryCount: 0}),
    cacheTime: 0,
  });
}
