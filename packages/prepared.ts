import {decodeFunctionData,hashTypedData} from 'viem';
import {safeAbi,types} from './intent.ts';

const OUTER_GAS_CAP=15_000_000n;
const OUTER_GAS_MARGIN_PCT=25n;
const OUTER_GAS_MARGIN_FIXED=25_000n;
const OUTER_TX_OVERHEAD_FLOOR=50_000n;

// Decode the unsigned OUTER request independently. Inspecting/signing the right
// Safe intent does not make a later server-prepared wallet request trustworthy.
export function validatePreparedTransaction(m:any,tx:any){try{
 if(tx.to?.toLowerCase()!==m.safe.toLowerCase()||BigInt(tx.value)!==0n||BigInt(tx.chainId)!==31337n)throw Error();
 const decoded=decodeFunctionData({abi:safeAbi,data:tx.data});if(decoded.functionName!=='execTransaction')throw Error();const args=decoded.args,fields=['to','value','data','operation','safeTxGas','baseGas','gasPrice','gasToken','refundReceiver'];
 const message:any={nonce:BigInt(m.message.nonce)};for(let i=0;i<fields.length;i++){const name=fields[i];if(String(args[i]).toLowerCase()!==String(m.message[name]).toLowerCase())throw Error();message[name]=args[i];}
 if(hashTypedData({domain:{chainId:31337,verifyingContract:m.safe},types,primaryType:'SafeTx',message})!==m.safeTxHash)throw Error();
 const signatures=args[9] as string;if(!/^0x[0-9a-fA-F]+$/.test(signatures)||(signatures.length-2)%130!==0||BigInt((signatures.length-2)/130)<BigInt(m.threshold))throw Error();
 }catch{throw Error('PREPARED_OUTER_INTENT_MISMATCH');}}

function quantity(value:any,label:string):bigint{
 if(typeof value!=='string'||!/^0x[0-9a-fA-F]+$/.test(value))throw Error('PREPARED_OUTER_'+label+'_INVALID');
 try{return BigInt(value);}catch{throw Error('PREPARED_OUTER_'+label+'_INVALID');}
}
function unsigned(value:any,label:string):bigint{
 if(typeof value==='bigint'&&value>=0n)return value;
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);
 if(typeof value==='string'&&(/^(0|[1-9][0-9]*)$/.test(value)||/^0x[0-9a-fA-F]+$/.test(value))){try{return BigInt(value);}catch{}}
 throw Error('PREPARED_OUTER_'+label+'_INVALID');
}

/**
 * Estimate the exact prepared Safe transaction immediately before broadcast.
 * The signature and Safe intent remain frozen; this only selects the outer
 * sender gasLimit, with headroom and the Safe v1.4.1 EIP-150 requirement.
 */
export async function estimatePreparedOuterGas(provider:any,account:string,m:any,tx:any):Promise<{gasLimit:bigint;estimate:bigint;cap:bigint;safeFloor:bigint}>{
 validatePreparedTransaction(m,tx);
 const safeTxGas=unsigned(m.message.safeTxGas,'SIGNED_GAS');
 if(safeTxGas===0n||safeTxGas>OUTER_GAS_CAP)throw Error('PREPARED_OUTER_SIGNED_GAS_OUT_OF_RANGE');
 const senderNonce=unsigned(tx.senderNonce,'SENDER_NONCE');
 const pendingNonce=quantity(await provider.request({method:'eth_getTransactionCount',params:[account,'pending']}),'PENDING_NONCE');
 if(pendingNonce!==senderNonce)throw Error('PREPARED_SENDER_NONCE_MISMATCH');
 const latest=await provider.request({method:'eth_getBlockByNumber',params:['latest',false]});
 const blockGasLimit=quantity(latest?.gasLimit,'BLOCK_GAS_LIMIT');
 if(blockGasLimit===0n)throw Error('PREPARED_OUTER_BLOCK_GAS_LIMIT_INVALID');
 const cap=blockGasLimit<OUTER_GAS_CAP?blockGasLimit:OUTER_GAS_CAP;
 const estimate=quantity(await provider.request({method:'eth_estimateGas',params:[{
  from:account,to:tx.to,data:tx.data,value:'0x0',nonce:'0x'+senderNonce.toString(16)
 }]}),'GAS_ESTIMATE');
 if(estimate===0n||estimate>cap)throw Error('PREPARED_OUTER_GAS_ESTIMATE_OUT_OF_RANGE');
 const padded=estimate+(estimate*OUTER_GAS_MARGIN_PCT+99n)/100n+OUTER_GAS_MARGIN_FIXED;
 const eip150Floor=(safeTxGas*64n+62n)/63n;
 const safeFloor=(eip150Floor>safeTxGas+2_500n?eip150Floor:safeTxGas+2_500n)+500n+OUTER_TX_OVERHEAD_FLOOR;
 const gasLimit=padded>safeFloor?padded:safeFloor;
 if(gasLimit>cap)throw Error('PREPARED_OUTER_GAS_LIMIT_EXCEEDS_CAP');
 return {gasLimit,estimate,cap,safeFloor};
}
