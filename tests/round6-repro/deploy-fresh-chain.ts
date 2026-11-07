// Disposable local chain deployment. Runs only after the private Compose namespace has started a
// newly owned Anvil instance. Output contains public local fixture addresses and code hashes only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {encodeFunctionData,parseEventLogs,zeroAddress,toHex,keccak256} from 'viem';
if (process.env.ALDER_REPRO_NAMESPACE !== '1' || process.env.ALDER_REPRO_PROJECT?.startsWith('alder-repro-') !== true) throw Error('FRESH_REPRO_NAMESPACE_REQUIRED');
const target='evidence/app-deployment.json';
if (fs.existsSync(target)) throw Error('REFUSING_EXISTING_DEPLOYMENT_MANIFEST');
process.env.ALDER_RPC_URL='http://127.0.0.1:8547';
const {client,wallet,testAccounts,artifact,safeArtifact,receipt,send,json}=await import('../../tests/chain-kit.ts');
assert.equal(await client.getChainId(),31337);
const genesis=(await client.getBlock({blockNumber:0n})).hash;
await client.request({method:'anvil_setBalance' as any,params:[wallet.account.address,toHex(10n**21n)] as any});
for(const a of testAccounts.slice(0,3)) await client.request({method:'anvil_setBalance' as any,params:[a.address,toHex(10n**21n)] as any});
async function deploy(name:string,args:any[]=[]){const a=artifact(name);const r=await receipt(await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,gas:10000000n}));assert.equal(r.status,'success');return r.contractAddress!;}
const singleton=await deploy('Safe'),factory=await deploy('SafeProxyFactory');
const initializer=encodeFunctionData({abi:safeArtifact().abi,functionName:'setup',args:[testAccounts.slice(0,3).map(a=>a.address),2,zeroAddress,'0x',zeroAddress,zeroAddress,0,zeroAddress]});
const creation=await send(factory,encodeFunctionData({abi:artifact('SafeProxyFactory').abi,functionName:'createProxyWithNonce',args:[singleton,initializer,BigInt(await client.getBlockNumber())]}));
const safe=(parseEventLogs({abi:artifact('SafeProxyFactory').abi,logs:creation.logs})[0] as any).args.proxy;
const token=await deploy('ReferenceToken',[safe,42000000000n]),executor=await deploy('BatchExecutor',[safe,token,31337n]);
assert.equal(await client.readContract({address:safe,abi:safeArtifact().abi,functionName:'getThreshold'}),2n);
assert.equal(await client.readContract({address:token,abi:artifact('ReferenceToken').abi,functionName:'balanceOf',args:[safe]}),42000000000n);
const codeHashes:any={};
for(const [name,address] of Object.entries({safe,token,executor,singleton,factory})) codeHashes[name]=keccak256((await client.getCode({address:address as `0x${string}`}))!);
fs.mkdirSync('evidence',{recursive:true});
fs.writeFileSync(target,json({chainId:31337,genesis,singleton,factory,safe,token,executor,deploymentBlock:creation.blockNumber,profile:'ALDER_FIXED_SUPPLY_6_DECIMALS',owners:testAccounts.slice(0,3).map(a=>a.address),threshold:'2',initializer,lineage:{id:process.env.ALDER_REPRO_PROJECT,created:new Date().toISOString(),note:'fresh disposable TR-T-REPRO Anvil; no retained product lineage'},codeHashes}));
console.log(JSON.stringify({freshDeployment:true,genesis,safe,token,executor,threshold:'2',supply:'42000000000',manifestSha256:(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(target)).digest('hex')}));
