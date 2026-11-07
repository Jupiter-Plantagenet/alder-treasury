// O5 TR-T-VERIFY adversarial campaign on the ISOLATED stack (API 9103 -> scratch PG 15543 -> O5 lying proxy 18547 -> Anvil 18548).
// Every case asserts that NO attack produces "paid" (operation state 'verified' / a verified settlement row), and every
// case that concerns a real payout ends with a positive control (honest RPC -> verified) so the negative is attributable.
// Actors are the local fixture accounts driven by this runner (simulated humans, not human testers).
import fs from 'node:fs';import {spawn} from 'node:child_process';
import {encodeAbiParameters,parseAbiParameters,keccak256,toHex,pad,toFunctionSelector,type Hex,type Address} from 'viem';
import * as L from '../round5-ops/o5-lib.ts';
process.env.ALDER_RPC_URL='http://127.0.0.1:18547';
const OUT='evidence/round6-perf/verify';fs.mkdirSync(OUT,{recursive:true});
const R=new L.Report(`${OUT}/report.json`);const s=await L.sessions();
const fx=JSON.parse(fs.readFileSync('evidence/round5-ops/fixtures-build/O5Fixtures.combined.json','utf8'));
const art=(n:string)=>{const k=Object.keys(fx.contracts).find(k=>k.endsWith(':'+n))!;const c=fx.contracts[k];return {abi:typeof c.abi==='string'?JSON.parse(c.abi):c.abi,bytecode:('0x'+c.bin) as Hex};};
const ow=L.walletFor(L.outsider);
await L.rpc('anvil_setBalance',[L.outsider.address,toHex(10n**21n)]);
async function deploy(name:string,args:any[]=[]){const a=art(name);const h=await ow.deployContract({abi:a.abi,bytecode:a.bytecode,args,gas:5000000n});const r=await L.chain.waitForTransactionReceipt({hash:h});if(r.status!=='success')throw Error('deploy '+name);return r.contractAddress as Address;}
const T={ES:keccak256(toHex('ExecutionSuccess(bytes32,uint256)')),PE:keccak256(toHex('PaymentExecuted(bytes32,bytes32,address,address,uint256)')),BE:keccak256(toHex('BatchExecuted(bytes32,bytes32,uint256,uint256)')),TR:keccak256(toHex('Transfer(address,address,uint256)'))};
const notPaid=async(opId:string)=>{const st=await L.opState(opId);const set=await L.settlementsFor(opId);const rep=await L.lastReport(opId);if(st==='verified'||set.some((x:any)=>x.state==='verified'))throw Error('PAID_UNDER_ATTACK '+JSON.stringify({st,set}));return {opState:st,settlements:set.length,reportState:rep?.state,reason:rep?.reason};};
const paid=async(opId:string,n:number)=>{const st=await L.opState(opId);const set=await L.settlementsFor(opId);if(st!=='verified'||set.filter((x:any)=>x.state==='verified').length!==n)throw Error('CONTROL_NOT_VERIFIED '+JSON.stringify({st,set,rep:await L.lastReport(opId)}));return {opState:st,verifiedSettlements:set.length};};
const transferData=(to:Address,v:bigint)=>L.encodeFunctionData({abi:L.erc20,functionName:'transfer',args:[to,v]});
const tamperLines=()=>fs.existsSync(`${OUT}/proxy-tamper.jsonl`)?fs.readFileSync(`${OUT}/proxy-tamper.jsonl`,'utf8').trim().split('\n').length:0;
await L.proxy([]);
const forger=await deploy('O5Forger');R.note('SETUP','O5Forger deployed (non-executor contract emitting identical event signatures)',{forger});

// ---------- V1: forged events from a non-executor/non-Safe contract with IDENTICAL signatures ----------
{const x=await L.preparedPayout(s,'P6-V1',['1100000','2200000']);const m=x.manifest;
 const total=m.items.reduce((n:bigint,p:any)=>n+BigInt(p.amount),0n);const fa=L.encodeFunctionData({abi:art('O5Forger').abi,functionName:'emitLog',args:[[T.ES,m.safeTxHash],encodeAbiParameters(parseAbiParameters('uint256'),[0n])]});
 const logs:any[]=[[[T.ES,m.safeTxHash],encodeAbiParameters(parseAbiParameters('uint256'),[0n])],[[T.BE,m.batchId],encodeAbiParameters(parseAbiParameters('bytes32,uint256,uint256'),[keccak256(m.calldata),total,BigInt(m.items.length)])]];
 for(const p of m.items){logs.push([[T.PE,m.batchId,p.paymentId,pad(p.recipient)],encodeAbiParameters(parseAbiParameters('address,uint256'),[d_token(),BigInt(p.amount)])]);logs.push([[T.TR,pad(m.safe),pad(p.recipient)],encodeAbiParameters(parseAbiParameters('uint256'),[BigInt(p.amount)])]);}
 const hashes=[];for(const [topics,data] of logs){const h=await ow.sendTransaction({to:forger,data:L.encodeFunctionData({abi:art('O5Forger').abi,functionName:'emitLog',args:[topics,data]}),gas:200000n});hashes.push(h);await L.chain.waitForTransactionReceipt({hash:h});}
 void fa;await L.mine(12);const rs=await L.resync(s);
 await R.check('TR-T-VERIFY','V1 forged ExecutionSuccess/BatchExecuted/PaymentExecuted/Transfer from a non-Safe/non-executor contract (identical signatures, exact hash/ids/amounts) => not paid',async()=>({resync:rs.status,forgedTxs:hashes.length,...await notPaid(x.opId)}));
 const h=await L.send(s,x.prepared);await L.mine(12);await L.resyncOk(s);
 await R.check('TR-T-VERIFY','V1 control: the same operation executed for real through the Safe => verified (forgery neither paid nor blocked it)',async()=>({tx:h,...await paid(x.opId,2)}));}
function d_token(){return L.d.token as Address;}

// ---------- V2: lying RPC injects a Safe ExecutionSuccess log (address = real Safe) for an unexecuted operation ----------
let realOther:any;
{const x=await L.preparedPayout(s,'P6-V2',['1300000']);await L.mine(13);const blk=await L.chain.getBlock({blockNumber:(await L.chain.getBlockNumber())-12n});
 await L.proxy([{kind:'forge-success-log',safe:L.d.safe,safeTxHash:x.manifest.safeTxHash,blockNumber:toHex(blk.number),blockHash:blk.hash,transactionHash:'0x'+'0b5'.repeat(21)+'0'}]);
 const before=tamperLines();const rs=await L.resync(s);
 await R.check('TR-T-VERIFY','V2a lying RPC: eth_getLogs fabricates the Safe ExecutionSuccess(safeTxHash) at a real canonical block with a non-existent tx hash => not paid',async()=>({resync:rs.status,tampered:tamperLines()-before,...await notPaid(x.opId)}));
 // re-point to a REAL other executed payout tx (genuine receipt, genuine Safe success for a different safeTxHash)
 const other=(await L.q("SELECT o.id,o.manifest FROM treasury_operations o WHERE o.workspace_id=$1 AND o.kind='payout' AND o.state='verified' AND o.manifest->>'genesis'=$2 LIMIT 1",[L.WS,L.d.genesis]))[0];
 const otherRep=await L.lastReport(other.id);realOther={tx:otherRep.transactionHash,blockHash:otherRep.blockHash,blockNumber:otherRep.blockNumber};
 await L.proxy([{kind:'forge-success-log',safe:L.d.safe,safeTxHash:x.manifest.safeTxHash,blockNumber:toHex(BigInt(otherRep.blockNumber)),blockHash:otherRep.blockHash,transactionHash:otherRep.transactionHash}]);
 const rs2=await L.resync(s);
 await R.check('TR-T-VERIFY','V2b lying RPC re-points the forged Safe success log to a REAL executed payout tx (genuine receipt of a different SafeTx) => not paid',async()=>({resync:rs2.status,...await notPaid(x.opId)}));
 await L.proxy([]);const h=await L.send(s,x.prepared);await L.mine(12);await L.resyncOk(s);
 await R.check('TR-T-VERIFY','V2 control: honest RPC + real execution => verified',async()=>({tx:h,...await paid(x.opId,1)}));}

// fund an unrelated third party with tokens through an off-app owner-quorum Safe transfer (treasury activity outside the app)
const r0=await L.safeExec(L.d.token,transferData(L.outsider.address,50_000_000n));
R.note('SETUP','off-app Safe transfer funds an unrelated third party (outsider 0x..404 fixture key) with 50 ALDR',{tx:r0.transactionHash,status:r0.status});
async function sameBlock(sends:(()=>Promise<any>)[]){await L.rpc('evm_setAutomine',[false]);const hs=[];try{for(const f of sends)hs.push(await f());await L.mine(1);}finally{await L.rpc('evm_setAutomine',[true]);}const rc=await Promise.all(hs.map(h=>L.chain.waitForTransactionReceipt({hash:h})));return {hashes:hs,blocks:rc.map(r=>String(r.blockNumber)),statuses:rc.map(r=>r.status)};}

// ---------- V3: unrelated transfer to the SAME recipient in the SAME block ----------
{const recip=L.newAddress();const x=await L.preparedPayout(s,'P6-V3',['1400000'],[recip]);
 const sb=await sameBlock([()=>L.send(s,x.prepared),()=>ow.sendTransaction({to:L.d.token,data:transferData(recip,1n),gas:120000n})]);await L.mine(12);const rs=await L.resync(s);
 await R.check('TR-T-VERIFY','V3 unrelated third-party transfer to the SAME recipient in the SAME block as a real payout => ambiguity stays unreconciled (not paid)',async()=>{if(sb.blocks[0]!==sb.blocks[1])throw Error('not same block '+sb.blocks);return {sameBlock:sb,resync:rs.status,truthRecipientBalance:String(await L.balance(recip)),...await notPaid(x.opId)};});}
// V3 control: unrelated transfer to the same recipient one block EARLIER is not ambiguous
{const recip=L.newAddress();const x=await L.preparedPayout(s,'P6-V3b',['1450000'],[recip]);
 const h0=await ow.sendTransaction({to:L.d.token,data:transferData(recip,7n),gas:120000n});await L.chain.waitForTransactionReceipt({hash:h0});
 const h=await L.send(s,x.prepared);await L.mine(12);await L.resyncOk(s);
 await R.check('TR-T-VERIFY','V3 control: unrelated transfer to the same recipient in an EARLIER block; isolated payout block => verified with exact parent->inclusion delta',async()=>({tx:h,...await paid(x.opId,1)}));}

// ---------- V4: netting - recipient in AND out in the same block; Safe-side inflow masking outflow ----------
{const rk=L.newKey();const {privateKeyToAccount}=await import('viem/accounts');const ra=privateKeyToAccount(rk);await L.rpc('anvil_setBalance',[ra.address,toHex(10n**20n)]);
 const pre=await ow.sendTransaction({to:L.d.token,data:transferData(ra.address,5_000_000n),gas:120000n});await L.chain.waitForTransactionReceipt({hash:pre});
 const x=await L.preparedPayout(s,'P6-V4',['1500000'],[ra.address]);const rw=L.walletFor(ra as any);
 const b0=await L.balance(ra.address);const sb=await sameBlock([()=>L.send(s,x.prepared),()=>rw.sendTransaction({to:L.d.token,data:transferData(L.outsider.address,1_500_000n),gas:120000n})]);
 await L.mine(12);const rs=await L.resync(s);
 await R.check('TR-T-VERIFY','V4a netting: recipient receives the payout and sends the same amount out in the SAME block (net delta 0) => not paid',async()=>{if(sb.blocks[0]!==sb.blocks[1])throw Error('not same block');return {sameBlock:sb,recipientNetDelta:String((await L.balance(ra.address))-b0),resync:rs.status,...await notPaid(x.opId)};});}
{const x=await L.preparedPayout(s,'P6-V4b',['1600000']);
 const sb=await sameBlock([()=>L.send(s,x.prepared),()=>ow.sendTransaction({to:L.d.token,data:transferData(L.d.safe,1_600_000n),gas:120000n})]);await L.mine(12);const rs=await L.resync(s);
 await R.check('TR-T-VERIFY','V4b aggregate netting on the treasury side: third party sends the Safe exactly the payout total in the same block (Safe end-of-block delta 0) => not paid',async()=>{if(sb.blocks[0]!==sb.blocks[1])throw Error('not same block');return {sameBlock:sb,resync:rs.status,...await notPaid(x.opId)};});}

// ---------- V5: lying RPC on a REAL executed payout (depth >= 12, never yet verified) ----------
{const x=await L.preparedPayout(s,'P6-V5',['1700000','1800000']);
 const allowanceOp=await s.O.post('/allowances',{ids:x.payables.map((p:any)=>p.id)});
 const h=await L.send(s,x.prepared);const rc=await L.chain.waitForTransactionReceipt({hash:h});await L.mine(12);
 const sel=(sig:string)=>toFunctionSelector(sig);
 const modes:[string,any[],string][]=[
  ['receipt: PaymentExecuted amount +1',[{kind:'receipt-tamper',tx:h,op:'amount',executor:L.d.executor}],'executor receipt logs exact'],
  ['receipt: token Transfer log dropped',[{kind:'receipt-tamper',tx:h,op:'drop-transfer',token:L.d.token}],'token log explanation required'],
  ['receipt: executor logs re-attributed to forger emitter',[{kind:'receipt-tamper',tx:h,op:'emitter',executor:L.d.executor,forger}],'emitter checked'],
  ['eth_getLogs(token,blockHash): extra fabricated Transfer',[{kind:'token-logs-inject',token:L.d.token}],'token log/receipt identity'],
  ['eth_call balanceOf at inclusion hash +1 base unit',[{kind:'balance-lie',token:L.d.token,delta:'1',blockHash:rc.blockHash}],'token state delta'],
  ['eth_call executedBatch -> false (batch marker lie)',[{kind:'call-override',to:L.d.executor,selector:sel('function executedBatch(bytes32)'),result:'0x'+'0'.repeat(64)}],'batch marker'],
  ['eth_call usedPaymentId -> false (ID marker lie)',[{kind:'call-override',to:L.d.executor,selector:sel('function usedPaymentId(bytes32)'),result:'0x'+'0'.repeat(64)}],'ID marker'],
  ['historical state unavailable (EIP-1898 eth_call error)',[{kind:'archive-unavailable'}],'unavailable -> unverified, never guessed'],
  ['stale head frozen 6 blocks after inclusion',[{kind:'stale-head',number:String(rc.blockNumber+5n)}],'depth from provider head'],
  ['wrong chain id (eth_chainId=0x1)',[{kind:'chainid',value:'0x1'}],'chain id'],
  ['genesis hash swapped',[{kind:'genesis',value:'0x'+'11'.repeat(32)}],'chain instance'],
  ['inclusion block hash disagrees with receipt/log block hash',[{kind:'block-hash',number:String(rc.blockNumber)}],'block hash'],
 ];
 for(const [name,rules,clause] of modes){await L.proxy(rules);const before=tamperLines();const rs=await L.resync(s);
  await R.check('TR-T-VERIFY',`V5 lying RPC [${name}] on a real executed payout at depth>=12 => not paid (${clause})`,async()=>({resyncStatus:rs.status,resyncError:rs.body?.error?.code,pausedByResync:rs.body?.paused??null,tamperedResponses:tamperLines()-before,...await notPaid(x.opId)}));}
 // signing is refused while the RPC reports a wrong chain id
 await L.proxy([{kind:'chainid',value:'0x1'}]);const sg=allowanceOp.status===200?await L.sign(s,allowanceOp.body.id,0):{status:0,body:allowanceOp.body};
 await R.check('TR-T-VERIFY','V5 wrong chain id at signature submission => 409 CHAIN_INSTANCE_MISMATCH, nothing stored',async()=>{if(sg.status!==409||sg.body?.error?.code!=='CHAIN_INSTANCE_MISMATCH')throw Error(JSON.stringify(sg));const n=(await L.q('SELECT count(*)::int n FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[L.WS,allowanceOp.body.id]))[0].n;if(n)throw Error('signature stored');return {status:sg.status,code:sg.body.error.code};});
 await L.proxy([]);
 // P6: round 6 pauses (sticky) on an inconsistent header answer; the documented recovery is the operator rebuild against the honest provider.
 {const cp=(await L.q('SELECT paused FROM treasury_checkpoints WHERE chain_key=$1',['http://127.0.0.1:18547:'+L.d.genesis]))[0];if(cp?.paused){const {requestReconcile}=await import((await import('node:url')).pathToFileURL(process.env.O5_SRC_ABS+'/services/treasury-indexer.ts').href);const pg=(await import('pg')).default;const ip=new pg.Pool({connectionString:'postgresql://alder_indexer@127.0.0.1:15543/alder',max:1});const rb=await requestReconcile(ip,'rebuild','operator:p6-campaign-after-V5',180000);await ip.end();R.note('TR-T-VERIFY','V5: a lie paused settlement (sticky); operator rebuild against the honest provider cleared it before the control',{paused:rb.paused,window:rb.window});}}
 await L.resyncOk(s);
 await R.check('TR-T-VERIFY','V5 control: same payout, honest RPC => verified',async()=>({tx:h,...await paid(x.opId,2)}));}

// ---------- V7: wrong chain INSTANCE: the exact signed SafeTx executed on a different Anvil with identical chainId/addresses/code ----------
{const x=await L.preparedPayout(s,'P6-V7',['1900000']);const n=BigInt(x.manifest.message.nonce);
 const anvil3=spawn('C:/Users/user/.foundry/bin/anvil.exe',['--host','127.0.0.1','--port','18549','--chain-id','31337','--hardfork','shanghai','--silent'],{stdio:'ignore'});
 try{for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:18549',{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'});break;}catch{await L.sleep(250);}}
  const c3=(await import('viem')).createPublicClient({transport:(await import('viem')).http('http://127.0.0.1:18549'),cacheTime:0});
  await L.proxy([]);await fetch(L.PROXY+'/__o5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({upstream:'http://127.0.0.1:18549'})});
  const dep=await new Promise<string>((res,rej)=>{const p=spawn(process.execPath,['--import','tsx','tests/round5-ops/deploy-isolated.ts'],{stdio:['ignore','pipe','pipe'],env:{...process.env,O5_DEPLOY_TARGET:'evidence/round6-perf/verify/chain3-deployment.json'}});let o='';p.stdout.on('data',b=>o+=b);p.stderr.on('data',b=>o+=b);p.on('exit',c=>c===0?res(o):rej(Error('deploy3 '+o.slice(-600))));});
  const d3=JSON.parse(fs.readFileSync('evidence/round6-perf/verify/chain3-deployment.json','utf8'));
  const {createWalletClient,http}=await import('viem');const {anvil}=await import('viem/chains');const w3=(i:number)=>createWalletClient({account:L.owners[i],chain:anvil,transport:http('http://127.0.0.1:18549')});
  const safeNonce3=async()=>c3.readContract({address:d3.safe,abi:L.safeAbi,functionName:'nonce'}) as Promise<bigint>;
  while(await safeNonce3()<n-1n){const nn=await safeNonce3();const m={to:d3.safe,value:0n,data:'0x' as Hex,operation:0,safeTxGas:0n,baseGas:0n,gasPrice:0n,gasToken:L.zeroAddress,refundReceiver:L.zeroAddress,nonce:nn};const sig=await L.sigsFor(m,[0,1],d3.safe);const hh=await w3(0).sendTransaction({to:d3.safe,data:L.execData(m,sig),gas:300000n});await c3.waitForTransactionReceipt({hash:hh});}
  // allowance on chain 3 so the replayed payout really moves tokens there
  {const nn=await safeNonce3();const total=x.manifest.items.reduce((a:bigint,p:any)=>a+BigInt(p.amount),0n);const m={to:d3.token,value:0n,data:L.encodeFunctionData({abi:L.erc20,functionName:'approve',args:[d3.executor,total]}),operation:0,safeTxGas:0n,baseGas:0n,gasPrice:0n,gasToken:L.zeroAddress,refundReceiver:L.zeroAddress,nonce:nn};const sig=await L.sigsFor(m,[0,1],d3.safe);const hh=await w3(0).sendTransaction({to:d3.safe,data:L.execData(m,sig),gas:300000n});await c3.waitForTransactionReceipt({hash:hh});
   const ts=BigInt(x.manifest.validAfter)+30n;const cur=(await c3.getBlock()).timestamp;if(ts>cur)await c3.request({method:'evm_setNextBlockTimestamp' as any,params:[toHex(ts)] as any});}
  const hr=await w3(0).sendTransaction({to:x.prepared.to,data:x.prepared.data,gas:3000000n});const rc3=await c3.waitForTransactionReceipt({hash:hr});
  await c3.request({method:'anvil_mine' as any,params:['0xc'] as any});const rs=await L.resync(s);
  await R.check('TR-T-VERIFY','V7 wrong chain instance: the exact signed SafeTx replayed on another Anvil (same chainId 31337, same Safe/executor/token addresses and code hashes, different genesis) and mined 12 deep, RPC silently switched to it => not paid',async()=>({chain3:{genesis:d3.genesis,addressesEqual:d3.safe.toLowerCase()===L.d.safe.toLowerCase(),tx:hr,status:rc3.status,safeExecutionSuccessLogs:rc3.logs.filter((l:any)=>l.address.toLowerCase()===d3.safe.toLowerCase()&&l.topics[0]===T.ES).length,chain3RecipientBalance:String(await c3.readContract({address:d3.token,abi:L.erc20,functionName:'balanceOf',args:[x.manifest.items[0].recipient]}))},resync:rs.status,resyncBody:rs.body,...await notPaid(x.opId)}));
  void dep;
 }finally{await fetch(L.PROXY+'/__o5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({upstream:'http://127.0.0.1:18548',rules:[]})});anvil3.kill();}
 const h=await L.send(s,x.prepared);await L.mine(12);await L.resyncOk(s);
 await R.check('TR-T-VERIFY','V7 control: RPC back on the canonical isolated instance; same signed SafeTx executed there => verified',async()=>({tx:h,...await paid(x.opId,1)}));}

// ---------- V6: provider disagreement on an already-recorded canonical block => settlement PAUSED; operator rebuild resumes ----------
{await L.mine(20);await L.resyncOk(s);const cp=(await L.q("SELECT number::text n FROM treasury_checkpoints ORDER BY number::bigint DESC LIMIT 1"))[0].n;const K=BigInt(cp)-15n;
 const safeLogsAtK=await L.chain.getLogs({address:L.d.safe,fromBlock:K,toBlock:K});
 const x=await L.preparedPayout(s,'P6-V6',['2000000']);const h=await L.send(s,x.prepared);await L.mine(12);
 await L.proxy([{kind:'block-hash',number:String(K)}]);const rs=await L.resync(s);
 await R.check('TR-T-VERIFY','V6 provider disagreement: RPC reports a different hash for an already-recorded block 15 below the checkpoint => deep-reorg PAUSE, real executed payout NOT paid',async()=>{if(safeLogsAtK.length)throw Error('K has Safe logs');if(rs.status!==200||rs.body.paused!==true)throw Error('not paused '+JSON.stringify(rs.body));return {K:String(K),resync:rs.body,...await notPaid(x.opId)};});
 await L.proxy([]);const rs2=await L.resync(s);
 await R.check('TR-T-VERIFY','V6 pause is sticky after the provider becomes honest again (no automatic resume) => still not paid',async()=>{if(rs2.body?.paused!==true)throw Error('auto-resumed '+JSON.stringify(rs2.body));return {resync:rs2.body,...await notPaid(x.opId)};});
 const {requestReconcile}=await import((await import('node:url')).pathToFileURL(process.env.O5_SRC_ABS+'/services/treasury-indexer.ts').href);const pg=(await import('pg')).default;const ip=new pg.Pool({connectionString:'postgresql://alder_indexer@127.0.0.1:15543/alder',max:1});
 const rb=await requestReconcile(ip,'rebuild','operator:p6-campaign',180000);await ip.end();
 await R.check('TR-T-VERIFY','V6 operator rebuild (reconcileApplication rebuild:true, operator-only, not HTTP) against honest RPC => pause cleared and the payout verified',async()=>({rebuild:rb,tx:h,...await paid(x.opId,1)}));}

const stats=await L.proxyStats();R.save({run:'P6-VERIFY',stack:{api:L.API,rpc:'O5 proxy 18547 -> anvil 18548',db:'scratch 15543/alder',deployment:L.d.genesis},proxyRequestCounts:stats.counts,proxyTotal:stats.total,realOther});
console.log(JSON.stringify({pass:R.steps.filter(x=>x.result==='PASS').length,fail:R.steps.filter(x=>x.result==='FAIL').length}));await L.db.end();process.exit(0);
