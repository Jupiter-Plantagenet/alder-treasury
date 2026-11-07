// Lineage-2 product deployment onto the NEW persistent local Anvil 127.0.0.1:8547 (authorized 2026-10-30).
// Same contracts and initializer as tests/deploy-app.ts; writes evidence/app-deployment.json only after the
// lineage-1 manifest has been preserved as evidence/app-deployment-lineage1-original-8547-lost.json.
import fs from 'node:fs';import assert from 'node:assert/strict';import {encodeFunctionData,parseEventLogs,zeroAddress,toHex,keccak256} from 'viem';
process.env.ALDER_RPC_URL='http://127.0.0.1:8547';
const {client,wallet,testAccounts,artifact,safeArtifact,receipt,send,json}=await import('../tests/chain-kit.ts');
const target='evidence/app-deployment.json',lineage1='evidence/app-deployment-lineage1-original-8547-lost.json';
if(!fs.existsSync(lineage1))throw Error('LINEAGE1_MANIFEST_NOT_PRESERVED');
const old=JSON.parse(fs.readFileSync(target,'utf8'));const genesis=(await client.getBlock({blockNumber:0n})).hash;
if(old.genesis===genesis)throw Error('ALREADY_DEPLOYED_ON_THIS_CHAIN');
if(old.genesis!==JSON.parse(fs.readFileSync(lineage1,'utf8')).genesis)throw Error('TARGET_IS_NOT_LINEAGE1_REFUSING_OVERWRITE');
assert.equal(await client.getChainId(),31337);
await client.request({method:'anvil_setBalance' as any,params:[wallet.account.address,toHex(10n**21n)] as any});
for(const a of testAccounts.slice(0,3))await client.request({method:'anvil_setBalance' as any,params:[a.address,toHex(10n**21n)] as any});
async function deploy(name:string,args:any[]=[]){const a=artifact(name);const r=await receipt(await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,gas:10000000n}));assert.equal(r.status,'success');return r.contractAddress!;}
const singleton=await deploy('Safe'),factory=await deploy('SafeProxyFactory');
const initializer=encodeFunctionData({abi:safeArtifact().abi,functionName:'setup',args:[testAccounts.slice(0,3).map(a=>a.address),2,zeroAddress,'0x',zeroAddress,zeroAddress,0,zeroAddress]});
const creation=await send(factory,encodeFunctionData({abi:artifact('SafeProxyFactory').abi,functionName:'createProxyWithNonce',args:[singleton,initializer,BigInt(await client.getBlockNumber())]}));
const safe=(parseEventLogs({abi:artifact('SafeProxyFactory').abi,logs:creation.logs})[0] as any).args.proxy;
const token=await deploy('ReferenceToken',[safe,42000000000n]),executor=await deploy('BatchExecutor',[safe,token,31337n]);
assert.equal(await client.readContract({address:safe,abi:safeArtifact().abi,functionName:'getThreshold'}),2n);
assert.equal(await client.readContract({address:token,abi:artifact('ReferenceToken').abi,functionName:'balanceOf',args:[safe]}),42000000000n);
const manifest={chainId:31337,genesis,singleton,factory,safe,token,executor,deploymentBlock:creation.blockNumber,profile:'ALDER_FIXED_SUPPLY_6_DECIMALS',owners:testAccounts.slice(0,3).map(a=>a.address),threshold:'2',initializer,lineage:{id:2,created:new Date().toISOString(),predecessor:{file:lineage1,genesis:old.genesis,status:'LOST_NO_STATE_PERSISTENCE'},rpc:'http://127.0.0.1:8547',state_file:'chain-state/anvil-8547-state.json'},codeHashes:{safe:keccak256((await client.getCode({address:safe}))!),token:keccak256((await client.getCode({address:token}))!),executor:keccak256((await client.getCode({address:executor}))!),singleton:keccak256((await client.getCode({address:singleton}))!),factory:keccak256((await client.getCode({address:factory}))!)}};
fs.writeFileSync(target,json(manifest));console.log(json({deployed:true,genesis,safe,token,executor,singleton,factory,deploymentBlock:creation.blockNumber}));
