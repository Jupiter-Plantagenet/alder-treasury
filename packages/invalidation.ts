// Round 5: in-app invalidation intent (TR-T-CANCEL). An invalidation is an ordinary Safe quorum operation:
//  - executor_cancel: Safe CALL executor.cancelBatch(targetBatchId) at the CURRENT Safe nonce. Permanently marks the
//    batch cancelled on chain (executeBatch then reverts Invalid) and, when the target was frozen at the current
//    nonce, also consumes that nonce. Used for every payout target.
//  - nonce_consumption: Safe CALL to itself with empty data and zero value at EXACTLY the target nonce. Used for
//    non-payout targets (e.g. an outstanding allowance) whose nonce is still current.
// Freezing an invalidation never revokes anything by itself: only the independent invalidation verifier, after the
// invalidation is canonical at depth 12, can establish that the original authorization can no longer execute.
import {encodeFunctionData,hashTypedData,zeroAddress,keccak256} from 'viem';
import {rpc,safeAbi,batchAbi,types} from './intent.ts';
export type InvalidationMethod='executor_cancel'|'nonce_consumption';
export function invalidationCall(d:any,method:InvalidationMethod,targetBatchId?:string){
 if(method==='executor_cancel'){if(!/^0x[0-9a-f]{64}$/i.test(targetBatchId||''))throw Error('TARGET_BATCH_REQUIRED');return {to:d.executor,data:encodeFunctionData({abi:batchAbi,functionName:'cancelBatch',args:[targetBatchId as `0x${string}`]})};}
 return {to:d.safe,data:'0x' as const};
}
export async function freezeInvalidation(d:any,target:{operationId:string,kind:string,manifest:any}){
 const tm=target.manifest;
 if(await rpc.getChainId()!==31337||(await rpc.getBlock({blockNumber:0n})).hash!==d.genesis||tm.genesis!==d.genesis)throw Error('CHAIN_INSTANCE_MISMATCH');
 for(const k of ['safe','singleton','factory','executor','token'])if(keccak256((await rpc.getCode({address:d[k]}))||'0x')!==d.codeHashes[k])throw Error('CODE_MISMATCH');
 if(tm.safe.toLowerCase()!==d.safe.toLowerCase())throw Error('TARGET_SAFE_MISMATCH');
 const at=await rpc.getBlock(),nonce=await rpc.readContract({address:d.safe,abi:safeAbi,functionName:'nonce'}),owners=await rpc.readContract({address:d.safe,abi:safeAbi,functionName:'getOwners'}),threshold=await rpc.readContract({address:d.safe,abi:safeAbi,functionName:'getThreshold'});
 const targetNonce=BigInt(tm.message.nonce);
 let method:InvalidationMethod;
 if(target.kind==='payout'){
  if(await rpc.readContract({address:d.executor,abi:batchAbi,functionName:'executedBatch',args:[tm.batchId]}))throw Error('TARGET_ALREADY_EXECUTED');
  method='executor_cancel';
 }else{
  if(targetNonce<nonce)throw Error('TARGET_NONCE_ALREADY_CONSUMED');
  if(targetNonce>nonce)throw Error('TARGET_NONCE_IN_FUTURE');
  method='nonce_consumption';
 }
 const call=invalidationCall(d,method,tm.batchId);
 const message={to:call.to,value:0n,data:call.data,operation:0,safeTxGas:300000n,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce};
 const typedData={domain:{chainId:31337,verifyingContract:d.safe},types,primaryType:'SafeTx' as const,message},safeTxHash=hashTypedData(typedData);
 if(safeTxHash!==await rpc.readContract({address:d.safe,abi:safeAbi,functionName:'getTransactionHash',args:[message.to,0n,message.data,0,message.safeTxGas,0n,0n,zeroAddress,zeroAddress,nonce]}))throw Error('HASH_MISMATCH');
 return {...d,method,calldata:call.data,message,typedData,safeTxHash,owners,threshold,observedBlock:at.hash,
  target:{operationId:target.operationId,kind:target.kind,safeTxHash:tm.safeTxHash,nonce:String(targetNonce),batchId:tm.batchId??null,paymentIds:(tm.items||[]).map((i:any)=>i.paymentId)}};
}
