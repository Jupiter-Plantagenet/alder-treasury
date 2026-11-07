// Read-only guard immediately before resuming isolated P6 mining.
// It binds the preserved Anvil state and allowance without loading owner keys,
// opening PostgreSQL, sending a transaction, or changing chain state.
import fs from 'node:fs';
import {createPublicClient, http, parseAbi} from 'viem';
import {anvil} from 'viem/chains';

const deployment=JSON.parse(fs.readFileSync('evidence/round5-ops/isolated-deployment.json','utf8'));
for(const key of ['safe','token','executor'])if(typeof deployment[key]!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(deployment[key]))throw Error('P6_DEPLOYMENT_ADDRESS_INVALID_'+key.toUpperCase());
if(typeof deployment.genesis!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(deployment.genesis))throw Error('P6_DEPLOYMENT_GENESIS_INVALID');
const safe=deployment.safe as `0x${string}`,token=deployment.token as `0x${string}`,executor=deployment.executor as `0x${string}`;
const client=createPublicClient({chain:anvil,transport:http('http://127.0.0.1:18548',{timeout:8000,retryCount:0})});
const safeAbi=parseAbi(['function nonce() view returns(uint256)']);
const tokenAbi=parseAbi(['function allowance(address,address) view returns(uint256)']);
const [chainId,head,genesis,nonce,allowance]=await Promise.all([
  client.getChainId(),client.getBlockNumber(),client.getBlock({blockNumber:0n}),
  client.readContract({address:safe,abi:safeAbi,functionName:'nonce'}),
  client.readContract({address:token,abi:tokenAbi,functionName:'allowance',args:[safe,executor]}),
]);
const proof={chainId,head:String(head),genesis:genesis.hash,safeNonce:String(nonce),allowance:String(allowance)};
if(chainId!==31337||genesis.hash?.toLowerCase()!==String(deployment.genesis).toLowerCase()||
   head<69174n||nonce!==124n||allowance!==100004950n){
  console.error(JSON.stringify({status:'REFUSED',reason:'P6_PRESERVED_STATE_MISMATCH',proof}));
  process.exitCode=2;
}else console.log(JSON.stringify({status:'PASS',proof,transactionsSent:false,dbOpened:false,chainWrites:false}));
