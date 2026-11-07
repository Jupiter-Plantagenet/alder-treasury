// Round 5 operator script: LOCAL test-asset top-up for the lineage-2 Safe WITHOUT changing the token, Safe, executor
// or any address/code, and WITHOUT minting (ALDR is fixed-supply, no owner mint).
// Decision: recycle ALDR that earlier automated test payouts sent to disposable recipients back to the Safe through
// REAL ERC-20 transfer() calls (Transfer events; totalSupply unchanged; the fixed-supply invariant holds). Anvil
// impersonation is used because the disposable recipients' keys were never kept. Local Anvil 127.0.0.1:8547 only;
// ALDR has no real value. Each recycle transfer is mined in its own block (automine), so it can never share a block
// with a payout (the verifier's isolated-token-block rule would fail closed if it did).
// Past settlements are historical facts and are not changed. Journal: runtime-logs/token-recycle.jsonl.
// Usage: node --import tsx ops/recycle-test-tokens.ts <targetSafeBalanceAldr> [--include-primary]
// Round 6: test workspaces only by default; each recycle tx must be alone in its block or the script stops.
import fs from 'node:fs';import pg from 'pg';import {createPublicClient,createWalletClient,http,parseAbi,getAddress} from 'viem';import {anvil} from 'viem/chains';
const RPC='http://127.0.0.1:8547';const d=JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8'));const target=BigInt(process.argv[2]||'30000')*1000000n;
const c=createPublicClient({transport:http(RPC),cacheTime:0});const erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function totalSupply() view returns(uint256)']);
if((await c.getBlock({blockNumber:0n})).hash!==d.genesis||await c.getChainId()!==31337)throw Error('LOCAL_LINEAGE2_ONLY');
const db=new pg.Pool({connectionString:'postgresql://postgres@127.0.0.1:5543/alder',max:1,options:'-c default_transaction_read_only=on'});
// Round 6 (review F-L7): sweep ONLY recipients settled in TEST workspaces. Any address that is a recipient of a payable in
// the primary workspace (settled or not) is never swept, unless --include-primary is passed explicitly.
const PRIMARY='00000000-0000-4000-8000-000000000001',includePrimary=process.argv.includes('--include-primary');
const rows=(await db.query(`SELECT DISTINCT lower(p.recipient) AS r FROM payables p JOIN treasury_settlements s ON s.workspace_id=p.workspace_id AND s.payable_id=p.id WHERE s.state='verified'
 AND ($2::boolean OR (p.workspace_id<>$1 AND NOT EXISTS(SELECT 1 FROM payables w WHERE w.workspace_id=$1 AND lower(w.recipient)=lower(p.recipient))))`,[PRIMARY,includePrimary])).rows;await db.end();
const bal=(a:string)=>c.readContract({address:d.token,abi:erc20,functionName:'balanceOf',args:[a as any]});const supply0=await c.readContract({address:d.token,abi:erc20,functionName:'totalSupply'});
const safe0=await bal(d.safe);const log:any[]=[];let safe=safe0;
const skip=new Set([d.safe,d.executor,d.token].map((x:string)=>x.toLowerCase()));
for(const {r} of rows){if(safe>=target)break;if(skip.has(r))continue;const b=await bal(r);if(b===0n)continue;
 const who=getAddress(r);await c.request({method:'anvil_setBalance' as any,params:[who,'0xde0b6b3a7640000'] as any});await c.request({method:'anvil_impersonateAccount' as any,params:[who] as any});
 try{const w=createWalletClient({account:who,chain:anvil,transport:http(RPC)});const hash=await w.writeContract({address:d.token,abi:erc20,functionName:'transfer',args:[d.safe,b],account:who,chain:anvil});const rc=await c.waitForTransactionReceipt({hash});if(rc.status!=='success')throw Error('RECYCLE_REVERTED '+hash);const blk=await c.getBlock({blockNumber:rc.blockNumber});if(blk.transactions.length!==1)throw Error('RECYCLE_BLOCK_NOT_ISOLATED '+hash+' (pause other runners; automine required)');safe+=b;log.push({from:who,units:String(b),tx:hash,block:String(rc.blockNumber)});}
 finally{await c.request({method:'anvil_stopImpersonatingAccount' as any,params:[who] as any});}}
const supply1=await c.readContract({address:d.token,abi:erc20,functionName:'totalSupply'});const safe1=await bal(d.safe);
if(supply1!==supply0)throw Error('SUPPLY_CHANGED');
const entry={at:new Date().toISOString(),token:d.token,safe:d.safe,totalSupply:String(supply1),safe_before:String(safe0),safe_after:String(safe1),target:String(target),transfers:log.length,recycled_units:String(safe1-safe0),detail:log};
fs.mkdirSync('runtime-logs',{recursive:true});fs.appendFileSync('runtime-logs/token-recycle.jsonl',JSON.stringify(entry)+'\n');console.log(JSON.stringify({...entry,detail:`${log.length} transfers (see runtime-logs/token-recycle.jsonl)`},null,1));
