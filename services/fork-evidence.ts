import {encodeFunctionData,decodeFunctionResult} from 'viem';

const check=(v:unknown,reason:string)=>{if(!v)throw Error(reason);};
const equal=(a:any,b:any)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

// Deliberately use raw eth_call: readContract's blockNumber wrapper must not silently
// erase the EIP-1898 selector. Unsupported/pruned/noncanonical RPC errors propagate.
export async function readAtHash(c:any,blockHash:any,address:any,abi:any,functionName:string,args:any[]){
 const data=encodeFunctionData({abi,functionName,args});
 const result=await c.request({method:'eth_call',params:[{to:address,data},{blockHash,requireCanonical:true}]});
 return decodeFunctionResult({abi,functionName,data:result});
}

export function validateReceipt(r:any,b:any,transactionHash:any){
 check(equal(r.transactionHash,transactionHash)&&equal(r.blockHash,b.hash)&&r.blockNumber===b.number,'receipt provenance');
 check(Number.isSafeInteger(r.transactionIndex)&&r.transactionIndex>=0,'receipt transaction index');
 const indices=new Set();
 for(const l of r.logs){validateLog(l,r,b);check(!indices.has(l.logIndex),'duplicate receipt log');indices.add(l.logIndex);}
}
export function validateLog(l:any,r:any,b:any){
 check(l.removed===false&&equal(l.blockHash,b.hash)&&l.blockNumber===b.number,'log block provenance');
 check(equal(l.transactionHash,r.transactionHash)&&l.transactionIndex===r.transactionIndex,'log transaction provenance');
 check(Number.isSafeInteger(l.logIndex)&&l.logIndex>=0,'log index provenance');
}
export function validateTransaction(tx:any,r:any,b:any){
 check(equal(tx.hash,r.transactionHash)&&equal(tx.blockHash,b.hash)&&tx.blockNumber===b.number&&tx.transactionIndex===r.transactionIndex,'transaction provenance');
}
export function validateTokenLogs(logs:any[],r:any,b:any,token:any){
 const receipt=r.logs.filter((l:any)=>equal(l.address,token));
 check(logs.length===receipt.length,'token receipt log count');const indices=new Set();
 for(const l of logs){validateLog(l,r,b);check(equal(l.address,token)&&!indices.has(l.logIndex),'token log address/index');indices.add(l.logIndex);
  const original=receipt.find((x:any)=>x.logIndex===l.logIndex);
  check(original&&equal(l.data,original.data)&&l.topics.length===original.topics.length&&l.topics.every((t:any,i:number)=>equal(t,original.topics[i])),'token receipt log identity');
 }
}
