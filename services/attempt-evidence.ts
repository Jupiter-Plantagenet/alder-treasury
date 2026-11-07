// Round 6 (review F-M1): an owner-posted transaction hash is only an observation. Before outcome classification may use
// a transaction or its receipt, the transaction READ FROM THE CHAIN must be bound to the durable attempt and to the
// frozen authorization:
//   - tx.from === attempt.sender, tx.to === manifest.safe, chain id 31337 (when present);
//   - tx.nonce === attempt.sender_nonce (or a later sender nonce: an owner re-broadcast of the same SafeTx);
//   - tx.input decodes as Safe.execTransaction whose signed fields equal the manifest and whose recomputed SafeTx hash
//     (with the manifest's Safe nonce) equals manifest.safeTxHash;
//   - receipt (if mined) is the receipt of that exact tx (hash, from, to) and its block is the canonical one.
// Anything else is `observation_mismatch`: recorded as evidence, never used to change the outcome state.
import {decodeFunctionData,hashTypedData,parseAbi} from 'viem';
const safeAbi=parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)']);
const types={SafeTx:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'},{name:'operation',type:'uint8'},{name:'safeTxGas',type:'uint256'},{name:'baseGas',type:'uint256'},{name:'gasPrice',type:'uint256'},{name:'gasToken',type:'address'},{name:'refundReceiver',type:'address'},{name:'nonce',type:'uint256'}]} as const;
const lc=(x:any)=>String(x??'').toLowerCase();
export type AttemptCheck={ok:true,rebroadcast:boolean,exactPreparedInput:boolean}|{ok:false,reason:string};
export function validateAttemptTransaction(tx:any,attempt:any,m:any):AttemptCheck{
 if(!tx)return {ok:false,reason:'transaction not found'};
 if(lc(tx.from)!==lc(attempt.sender))return {ok:false,reason:'sender is not the attempt sender'};
 if(lc(tx.to)!==lc(m.safe))return {ok:false,reason:'transaction is not addressed to the expected Safe'};
 if(tx.chainId!=null&&Number(tx.chainId)!==Number(m.chainId??31337))return {ok:false,reason:'chain id'};
 const n=BigInt(tx.nonce),want=BigInt(attempt.sender_nonce);if(n<want)return {ok:false,reason:`sender nonce ${n} is below the attempt nonce ${want}`};
 let d:any;try{d=decodeFunctionData({abi:safeAbi,data:tx.input});}catch{return {ok:false,reason:'input is not Safe.execTransaction'};}
 if(d.functionName!=='execTransaction')return {ok:false,reason:'input is not Safe.execTransaction'};
 const a=d.args,f=['to','value','data','operation','safeTxGas','baseGas','gasPrice','gasToken','refundReceiver'];
 for(let i=0;i<f.length;i++)if(lc(a[i])!==lc(m.message[f[i]]))return {ok:false,reason:'signed field '+f[i]+' differs from the frozen authorization'};
 const h=hashTypedData({domain:{chainId:Number(m.chainId??31337),verifyingContract:m.safe},types,primaryType:'SafeTx',message:{to:a[0],value:a[1],data:a[2],operation:a[3],safeTxGas:a[4],baseGas:a[5],gasPrice:a[6],gasToken:a[7],refundReceiver:a[8],nonce:BigInt(m.message.nonce)}});
 if(lc(h)!==lc(m.safeTxHash))return {ok:false,reason:'recomputed SafeTx hash differs from the frozen authorization'};
 return {ok:true,rebroadcast:n>want,exactPreparedInput:!!attempt.transaction_data&&lc(attempt.transaction_data)===lc(tx.input)};
}
export function validateAttemptReceipt(receipt:any,tx:any,canonicalHash:string|undefined){
 if(lc(receipt.transactionHash)!==lc(tx.hash))return 'receipt is for a different transaction';
 if(lc(receipt.from)!==lc(tx.from)||lc(receipt.to)!==lc(tx.to))return 'receipt sender/recipient differ from the transaction';
 if(tx.blockHash&&lc(tx.blockHash)!==lc(receipt.blockHash))return 'transaction and receipt block differ';
 if(!canonicalHash||lc(canonicalHash)!==lc(receipt.blockHash))return 'non-canonical';
 return null;
}
