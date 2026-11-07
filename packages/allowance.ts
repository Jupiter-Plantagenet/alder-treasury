import {encodeFunctionData,hashTypedData,zeroAddress,keccak256,type Hex} from 'viem';
import {rpc,safeAbi,tokenAbi,types} from './intent.ts';
export async function freezeAllowance(d:any,requestedCap:bigint,ids:string[]){
 if(requestedCap<=0n||requestedCap>=2n**256n)throw Error('CAP_BOUNDS');
 if(await rpc.getChainId()!==31337||(await rpc.getBlock({blockNumber:0n})).hash!==d.genesis)throw Error('CHAIN_INSTANCE_MISMATCH');
 for(const k of ['safe','singleton','factory','token','executor'])if(keccak256((await rpc.getCode({address:d[k]}))||'0x')!==d.codeHashes[k])throw Error('CODE_MISMATCH');
 const at=await rpc.getBlock(),nonce=await rpc.readContract({address:d.safe,abi:safeAbi,functionName:'nonce'}),owners=await rpc.readContract({address:d.safe,abi:safeAbi,functionName:'getOwners'}),threshold=await rpc.readContract({address:d.safe,abi:safeAbi,functionName:'getThreshold'});
 const allowance=await rpc.readContract({address:d.token,abi:tokenAbi,functionName:'allowance',args:[d.safe,d.executor]});
 const cap=allowance===0n?requestedCap:0n;
 const calldata=encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[d.executor,cap]});
 const message={to:d.token,value:0n,data:calldata,operation:0,safeTxGas:1000000n,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce};
 const typedData={domain:{chainId:31337,verifyingContract:d.safe},types,primaryType:'SafeTx' as const,message},safeTxHash=hashTypedData(typedData);
 if(safeTxHash!==await rpc.readContract({address:d.safe,abi:safeAbi,functionName:'getTransactionHash',args:[message.to,0n,calldata,0,message.safeTxGas,0n,0n,zeroAddress,zeroAddress,nonce]}))throw Error('HASH_MISMATCH');
 return {...d,cap,requestedCap,reset:cap===0n,ids,calldata,message,typedData,safeTxHash,owners,threshold,observedBlock:at.hash};
}
