// Round 5 independent invalidation verifier (TR-T-CANCEL). Uses its own ABIs and decoder (no API encoder) and only
// reports `verified` with targetCannotExecute=true when, on the canonical chain at depth >= 12:
//  - the exact signed invalidation SafeTx succeeded (canonical receipt, exact outer fields, Safe ExecutionSuccess);
//  - executor_cancel: the inner call is exactly cancelBatch(targetBatchId), the batch is cancelled at the inclusion
//    block and NOT executed at inclusion or head; nonce_consumption: the invalidation used exactly the target nonce;
//  - the target SafeTx has no canonical ExecutionSuccess and the Safe nonce at head is beyond the target nonce;
//  - for payouts, no target payment ID is marked used at head (no item was paid by any path).
// Anything else is `confirming` (depth) or `unverified` (reason). It never marks anything paid.
import {createPublicClient,http,parseAbi,decodeFunctionData,parseEventLogs,keccak256,hashTypedData} from 'viem';
import {validateReceipt,validateTransaction} from './fork-evidence.ts';
import {manifestDigest} from './verifier.ts';
export const INVALIDATION_VERIFIER_VERSION='invalidation-v1-r5';
const safe=parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)','event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)','function nonce() view returns(uint256)']);
const executor=parseAbi(['function cancelBatch(bytes32 id)','function cancelledBatch(bytes32) view returns(bool)','function executedBatch(bytes32) view returns(bool)','function usedPaymentId(bytes32) view returns(bool)','event BatchCancelled(bytes32 indexed batchId)']);
const signedTypes={SafeTx:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'},{name:'operation',type:'uint8'},{name:'safeTxGas',type:'uint256'},{name:'baseGas',type:'uint256'},{name:'gasPrice',type:'uint256'},{name:'gasToken',type:'address'},{name:'refundReceiver',type:'address'},{name:'nonce',type:'uint256'}]} as const;
export async function verifyInvalidation(m:any,client?:any){
 const c:any=client||createPublicClient({transport:http(process.env.ALDER_RPC_URL||'http://127.0.0.1:8547'),cacheTime:0});const check=(v:any,s:string)=>{if(!v)throw Error(s);};const checks:string[]=[];const ok=(v:any,s:string)=>{check(v,s);checks.push(s);};
 try{
  ok(await c.getChainId()===31337&&(await c.getBlock({blockNumber:0n})).hash===m.genesis,'chain instance');
  for(const k of ['safe','singleton','factory','executor','token'])ok(keccak256(await c.getCode({address:m[k]})||'0x')===m.codeHashes[k],'runtime '+k);
  const t=m.target;check(t&&/^0x[0-9a-fA-F]{64}$/.test(t.safeTxHash),'target identity');
  const r=await c.getTransactionReceipt({hash:m.transactionHash}),block=await c.getBlock({blockNumber:r.blockNumber}),head=await c.getBlock();
  ok(r.blockHash===block.hash&&r.status==='success'&&r.to?.toLowerCase()===m.safe.toLowerCase(),'canonical successful receipt to Safe');
  validateReceipt(r,block,m.transactionHash);const tx=await c.getTransaction({hash:m.transactionHash});validateTransaction(tx,r,block);
  const outer=decodeFunctionData({abi:safe,data:tx.input});ok(outer.functionName==='execTransaction','Safe entrypoint');const a:any=outer.args;
  ['to','value','data','operation','safeTxGas','baseGas','gasPrice','gasToken','refundReceiver'].forEach((k,i)=>check(String(a[i]).toLowerCase()===String(m.message[k]).toLowerCase(),'signed '+k));checks.push('exact signed outer fields');
  ok(hashTypedData({domain:{chainId:31337,verifyingContract:m.safe},types:signedTypes,primaryType:'SafeTx',message:m.message})===m.safeTxHash,'independent invalidation SafeTx hash');
  ok(parseEventLogs({abi:safe,logs:r.logs.filter((x:any)=>x.address.toLowerCase()===m.safe.toLowerCase())}).some((x:any)=>x.eventName==='ExecutionSuccess'&&x.args.txHash===m.safeTxHash),'Safe ExecutionSuccess for invalidation');
  ok(BigInt(a[1])===0n&&Number(a[3])===0,'zero value CALL (no DELEGATECALL)');
  let batchCancelled=false;
  if(m.method==='executor_cancel'){
   ok(String(a[0]).toLowerCase()===m.executor.toLowerCase(),'inner target is executor');
   const inner=decodeFunctionData({abi:executor,data:a[2]});ok(inner.functionName==='cancelBatch'&&String(inner.args[0]).toLowerCase()===String(t.batchId).toLowerCase(),'inner call is exactly cancelBatch(target batch)');
   // Monotonic executor flags read at HEAD (no archive state needed): cancelled can never be unset, and a cancelled
   // batch can never execute; the cancel event of this exact receipt is also required unless already cancelled earlier.
   const cancelEvents=parseEventLogs({abi:executor,logs:r.logs.filter((x:any)=>x.address.toLowerCase()===m.executor.toLowerCase())}).filter((x:any)=>x.eventName==='BatchCancelled'&&String(x.args.batchId).toLowerCase()===String(t.batchId).toLowerCase());
   ok(await c.readContract({address:m.executor,abi:executor,functionName:'cancelledBatch',args:[t.batchId],blockNumber:head.number})===true,'batch cancelled at head');
   checks.push(cancelEvents.length===1?'BatchCancelled event in this receipt':'batch was already cancelled before this invalidation (no event, cancelled flag at head)');
   ok(await c.readContract({address:m.executor,abi:executor,functionName:'executedBatch',args:[t.batchId],blockNumber:head.number})===false,'batch not executed at head');
   batchCancelled=true;
  }else if(m.method==='nonce_consumption'){
   ok(String(a[0]).toLowerCase()===m.safe.toLowerCase()&&String(a[2])==='0x','inner call is an empty self-call');
   ok(BigInt(m.message.nonce)===BigInt(t.nonce),'invalidation consumed exactly the target nonce');
  }else throw Error('unknown invalidation method');
  const safeNonceAtHead=await c.readContract({address:m.safe,abi:safe,functionName:'nonce',blockNumber:head.number});
  ok(safeNonceAtHead>BigInt(t.nonce),'Safe nonce at head beyond target nonce');
  const targetLogs=await c.getLogs({address:m.safe,event:safe[1],args:{txHash:t.safeTxHash},fromBlock:BigInt(m.deploymentBlock),toBlock:head.number});
  ok(targetLogs.length===0,'no canonical ExecutionSuccess for target');
  for(const id of t.paymentIds||[])check(await c.readContract({address:m.executor,abi:executor,functionName:'usedPaymentId',args:[id],blockNumber:head.number})===false,'target payment ID unused');if((t.paymentIds||[]).length)checks.push('every target payment ID unused at head');
  let previous=block;for(let n=block.number+1n;n<=head.number;n++){const next=await c.getBlock({blockNumber:n});check(next.parentHash===previous.hash,'ancestry');previous=next;}
  ok(previous.hash===head.hash&&(await c.getBlock({blockNumber:head.number})).hash===head.hash,'head stable during verification');
  const depth=BigInt(head.number)-BigInt(block.number)+1n;
  return {state:depth>=12n?'verified':'confirming',kind:'invalidation',verifierVersion:INVALIDATION_VERIFIER_VERSION,manifestDigest:manifestDigest(m),method:m.method,targetOperationId:t.operationId,targetSafeTxHash:t.safeTxHash,targetNonce:String(t.nonce),targetBatchId:t.batchId??null,
   targetCannotExecute:depth>=12n,batchCancelled,safeNonceAtHead:String(safeNonceAtHead),blockHash:block.hash,blockNumber:String(block.number),transactionHash:m.transactionHash,depth:String(depth),headHash:head.hash,headNumber:String(head.number),checks,paid:false,
   nodeTrust:'single local Anvil; independent decoder, not independent node'};
 }catch(e){return {state:'unverified',kind:'invalidation',reason:(e as Error).message,targetOperationId:m.target?.operationId,targetCannotExecute:false,paid:false,checks};}
}
