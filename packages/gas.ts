// Round 6 (round-5 ops finding 2, blueprint §SafeTx): the signed safeTxGas is selected per batch from simulation plus
// a documented margin, never a fixed constant.
//
// Why it matters: with gasPrice=0 Safe v1.4.1 forwards (gasleft()-2500) to the inner call and only requires
// gasleft() >= max(safeTxGas*64/63, safeTxGas+2500)+500 before it. A wallet that estimates the OUTER transaction gets the
// minimum gas that passes that check, so a too-small signed safeTxGas lets the outer call succeed while the inner batch
// runs out of gas (ExecutionFailure: Safe nonce consumed, nothing paid). Signing safeTxGas >= the simulated inner cost
// forces any outer estimate to cover the inner execution.
//
// Simulation: eth_estimateGas of the exact inner CALL (from = Safe, to = executor/token, data = exact calldata) at the
// latest block. That figure includes the 21000 intrinsic and calldata cost a nested CALL does not pay, so it already
// over-covers; the margin is on top: safeTxGas = ceil(estimate * 1.25) + 25000.
// Policy cap: the register's batch budget (estimated execution <= 15M of a 30M block). A batch whose safeTxGas would
// exceed the cap is refused at freeze (422 GAS_CAP_EXCEEDED) and, for already frozen operations, before signing/prepare.
import {rpc} from './intent.ts';
export const SAFE_TX_GAS_MARGIN_PCT=25n,SAFE_TX_GAS_MARGIN_FIXED=25000n;
export const SAFE_TX_GAS_CAP=BigInt(typeof process==='undefined'?'15000000':process.env.ALDER_SAFE_TX_GAS_CAP||'15000000');
const fail=(status:number,code:string,details?:any)=>Object.assign(new Error(code),{statusCode:status,details});
export function withMargin(estimate:bigint){return (estimate*(100n+SAFE_TX_GAS_MARGIN_PCT)+99n)/100n+SAFE_TX_GAS_MARGIN_FIXED;}
export async function simulateInner(safe:string,to:string,data:string,client:any=rpc):Promise<bigint>{
 try{return await client.estimateGas({account:safe as any,to:to as any,data:data as any,value:0n});}
 catch(e:any){throw fail(422,'SIMULATION_FAILED',{reason:String(e?.shortMessage||e?.message||e).slice(0,200)});}
}
// For a new authorization: returns the safeTxGas to sign and the evidence stored in the manifest.
export async function selectSafeTxGas(safe:string,to:string,data:string,client:any=rpc){
 const estimate=await simulateInner(safe,to,data,client),safeTxGas=withMargin(estimate);
 if(safeTxGas>SAFE_TX_GAS_CAP)throw fail(422,'GAS_CAP_EXCEEDED',{estimate:String(estimate),safeTxGas:String(safeTxGas),cap:String(SAFE_TX_GAS_CAP)});
 return {safeTxGas,gasEvidence:{method:'eth_estimateGas inner call from Safe at latest',estimate:String(estimate),marginPct:String(SAFE_TX_GAS_MARGIN_PCT),marginFixed:String(SAFE_TX_GAS_MARGIN_FIXED),safeTxGas:String(safeTxGas),cap:String(SAFE_TX_GAS_CAP)}};
}
// Before a signature or a broadcast attempt: the signed safeTxGas must still cover a fresh simulation and stay within the
// cap. Re-estimating needs NEW owner signatures (a re-freeze), never a UI-only change.
export async function assertSignedGasSufficient(m:any,client:any=rpc){
 const signed=BigInt(m.message.safeTxGas);
 if(signed>SAFE_TX_GAS_CAP)throw fail(409,'GAS_CAP_EXCEEDED',{safeTxGas:String(signed),cap:String(SAFE_TX_GAS_CAP)});
 const estimate=await simulateInner(m.safe,m.message.to,m.message.data,client).catch((e:any)=>{throw fail(409,'SIMULATION_FAILED',e.details);});
 if(estimate>SAFE_TX_GAS_CAP)throw fail(409,'GAS_CAP_EXCEEDED',{estimate:String(estimate),cap:String(SAFE_TX_GAS_CAP)});
 if(signed<estimate)throw fail(409,'SAFE_TX_GAS_INSUFFICIENT',{estimate:String(estimate),safeTxGas:String(signed),remedy:'propose an invalidation and re-freeze; signed gas cannot be changed without new owner signatures'});
 return {estimate:String(estimate),safeTxGas:String(signed)};
}
