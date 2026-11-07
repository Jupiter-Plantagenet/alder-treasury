// O5 smoke: one honest payout cycle on the isolated stack (positive control for the VERIFY campaign).
import * as L from './o5-lib.ts';
const s=await L.sessions();const t0=Date.now();
const x=await L.preparedPayout(s,'O5-SMOKE',['1000000','2500000']);
const hash=await L.send(s,x.prepared);await L.mine(1);await L.resyncOk(s);const early=await L.opState(x.opId);
await L.mine(11);const r=await L.resyncOk(s);
console.log(JSON.stringify({opId:x.opId,hash,early,final:await L.opState(x.opId),settlements:await L.settlementsFor(x.opId),resync:r,ms:Date.now()-t0}));
await L.db.end();
