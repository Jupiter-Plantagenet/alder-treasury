// O5 harness: advance the ISOLATED app Safe nonce past every nonce used by the live lineage (identical chainId 31337 and
// identical Safe address make SafeTx hashes collide across the two chain instances; see report). Off-app owner-quorum no-ops.
import * as L from './o5-lib.ts';const target=BigInt(process.env.O5_TARGET_NONCE||'120');let n=await L.safeNonce();const from=n;
while(n<target){const r=await L.safeExec(L.d.safe,'0x',{safeTxGas:0n});if(r.status!=='success')throw Error('noop failed');n=await L.safeNonce();}
console.log(JSON.stringify({from:String(from),to:String(n)}));await L.db.end();process.exit(0);
