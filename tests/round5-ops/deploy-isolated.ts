// O5: deploy the product contracts onto the ISOLATED Anvil (127.0.0.1:18548, reached through the O5 proxy on 18547)
// using exactly the same contracts/initializer/sequence as ops/deploy-product-chain.ts. Writes ONLY
// evidence/round5-ops/isolated-deployment.json (never evidence/app-deployment.json; the live lineage is untouched).
import fs from 'node:fs';import assert from 'node:assert/strict';import {encodeFunctionData,parseEventLogs,zeroAddress,toHex,keccak256} from 'viem';
process.env.ALDER_RPC_URL='http://127.0.0.1:18547';
const {client,wallet,testAccounts,artifact,safeArtifact,receipt,send,json}=await import('../chain-kit.ts');
const target=process.env.O5_DEPLOY_TARGET||'evidence/round5-ops/isolated-deployment.json';
if(fs.existsSync(target))throw Error('ISOLATED_DEPLOYMENT_EXISTS_REFUSING_OVERWRITE');
const live=JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8'));const genesis=(await client.getBlock({blockNumber:0n})).hash;
if(live.genesis===genesis)throw Error('REFUSING_LIVE_CHAIN');
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
const manifest={chainId:31337,genesis,singleton,factory,safe,token,executor,deploymentBlock:creation.blockNumber,profile:'ALDER_FIXED_SUPPLY_6_DECIMALS',owners:testAccounts.slice(0,3).map(a=>a.address),threshold:'2',initializer,lineage:{id:'O5-isolated',created:new Date().toISOString(),note:'round-5 ops isolated chain; not the live lineage',rpc:'http://127.0.0.1:18547 (O5 proxy) -> 127.0.0.1:18548 anvil'},codeHashes:{safe:keccak256((await client.getCode({address:safe}))!),token:keccak256((await client.getCode({address:token}))!),executor:keccak256((await client.getCode({address:executor}))!),singleton:keccak256((await client.getCode({address:singleton}))!),factory:keccak256((await client.getCode({address:factory}))!)}};
fs.writeFileSync(target,json(manifest));
const same=Object.fromEntries(['safe','token','executor','singleton','factory'].map(k=>[k,(manifest as any)[k].toLowerCase()===String(live[k]).toLowerCase()]));
const sameCode=Object.fromEntries(Object.keys(manifest.codeHashes).map(k=>[k,(manifest.codeHashes as any)[k]===live.codeHashes[k]]));
console.log(json({deployed:true,genesis,liveGenesis:live.genesis,safe,token,executor,singleton,factory,deploymentBlock:creation.blockNumber,addressesEqualLive:same,codeHashesEqualLive:sameCode}));
