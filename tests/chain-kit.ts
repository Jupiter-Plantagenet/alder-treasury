import fs from 'node:fs';import {createPublicClient,http,createWalletClient,encodeFunctionData,zeroAddress,hashTypedData,concat,parseEventLogs,type Hex,type Address} from 'viem';import {anvil} from 'viem/chains';import {privateKeyToAccount} from 'viem/accounts';
export const rpc=process.env.ALDER_RPC_URL||'http://127.0.0.1:8547';if(!['http://127.0.0.1:8547','http://127.0.0.1:18547'].includes(rpc))throw Error('LOCAL_TEST_RPC_ONLY');export const client=createPublicClient({chain:anvil,transport:http(rpc),cacheTime:0});
export const artifact=(name:string)=>JSON.parse(fs.readFileSync(`contracts/out/${name}.sol/${name}.json`,'utf8'));
export const safeArtifact=()=>artifact('Safe');export const executorArtifact=()=>artifact('BatchExecutor');export const tokenArtifact=()=>JSON.parse(fs.readFileSync('contracts/out/BatchExecutor.t.sol/FailureToken.json','utf8'));
export const types={SafeTx:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'},{name:'operation',type:'uint8'},{name:'safeTxGas',type:'uint256'},{name:'baseGas',type:'uint256'},{name:'gasPrice',type:'uint256'},{name:'gasToken',type:'address'},{name:'refundReceiver',type:'address'},{name:'nonce',type:'uint256'}]} as const;
export const message=(to:Address,data:Hex,nonce:bigint)=>({to,value:0n,data,operation:0,safeTxGas:1000000n,baseGas:0n,gasPrice:0n,gasToken:zeroAddress as Address,refundReceiver:zeroAddress as Address,nonce});
export const typed=(safe:Address,m:ReturnType<typeof message>)=>({domain:{chainId:31337,verifyingContract:safe},types,primaryType:'SafeTx' as const,message:m});
export const execArgs=(m:ReturnType<typeof message>,signatures:Hex)=>[m.to,m.value,m.data,m.operation,m.safeTxGas,m.baseGas,m.gasPrice,m.gasToken,m.refundReceiver,signatures] as const;
export const safeHash=(safe:Address,m:ReturnType<typeof message>)=>hashTypedData(typed(safe,m));
export const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2);
// Isolated test harness only. No app imports this file; no production owner keys.
export const testAccounts=[101,202,303,404].map(n=>privateKeyToAccount(('0x'+n.toString(16).padStart(64,'0')) as Hex));
export const wallet=createWalletClient({account:testAccounts[3],chain:anvil,transport:http(rpc)});
export async function receipt(hash:Hex){return client.waitForTransactionReceipt({hash});}
export async function send(to:Address,data:Hex){return receipt(await wallet.sendTransaction({to,data,gas:3000000n}));}
export async function signed(safe:Address,m:ReturnType<typeof message>){const sigs=await Promise.all(testAccounts.slice(0,2).map(async a=>({address:a.address,sig:await a.signTypedData(typed(safe,m))})));sigs.sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()));return concat(sigs.map(x=>x.sig));}
export async function runSafe(safe:Address,to:Address,data:Hex){const nonce=await client.readContract({address:safe,abi:safeArtifact().abi,functionName:'nonce'}) as bigint;const m=message(to,data,nonce);const hash=safeHash(safe,m);const onchain=await client.readContract({address:safe,abi:safeArtifact().abi,functionName:'getTransactionHash',args:[...execArgs(m,'0x').slice(0,9),nonce]});if(hash!==onchain)throw Error('Safe hash mismatch');const signatures=await signed(safe,m);const r=await send(safe,encodeFunctionData({abi:safeArtifact().abi,functionName:'execTransaction',args:execArgs(m,signatures)}));return {m,hash,signatures,receipt:r};}
export function success(r:any){return parseEventLogs({abi:safeArtifact().abi,logs:r.logs}).some((x:any)=>x.eventName==='ExecutionSuccess');}
