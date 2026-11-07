// O5 live chain-lab on the ISOLATED Anvil 18548: TR-T-ATOMIC (return-false + delta-mismatch token variants),
// TR-T-REPLAY (delegate context, exact executor time boundaries, app-level equality boundaries) and TR-T-1271
// (live contract-owner submission against the API, plus on-chain legacy-vs-modern 1271 semantics).
// Fixture tokens/owners are test instrumentation, not supported profiles. Simulated actors only.
import fs from 'node:fs';import {encodeFunctionData,decodeEventLog,parseEventLogs,keccak256,toHex,pad,concat,encodeAbiParameters,parseAbiParameters,zeroAddress,type Hex,type Address} from 'viem';
import * as L from './o5-lib.ts';
const OUT='evidence/round5-ops/chain-lab';fs.mkdirSync(OUT,{recursive:true});const R=new L.Report(`${OUT}/report.json`);
const fx=JSON.parse(fs.readFileSync('evidence/round5-ops/fixtures-build/O5Fixtures.combined.json','utf8'));
const o5=(n:string)=>{const k=Object.keys(fx.contracts).find(k=>k.endsWith(':'+n))!;const c=fx.contracts[k];return {abi:typeof c.abi==='string'?JSON.parse(c.abi):c.abi,bytecode:('0x'+c.bin) as Hex,runtime:('0x'+c['bin-runtime']) as Hex};};
const prod=(n:string)=>{const a=JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`,'utf8'));return {abi:a.abi,bytecode:a.bytecode.object as Hex};};
const ow=L.walletFor(L.outsider);await L.rpc('anvil_setBalance',[L.outsider.address,toHex(10n**21n)]);for(const o of L.owners)await L.rpc('anvil_setBalance',[o.address,toHex(10n**21n)]);
async function deploy(a:{abi:any,bytecode:Hex},args:any[]=[]){const h=await ow.deployContract({abi:a.abi,bytecode:a.bytecode,args,gas:12000000n});const r=await L.chain.waitForTransactionReceipt({hash:h});if(r.status!=='success')throw Error('deploy failed');return r.contractAddress as Address;}
const SafeA=prod('Safe'),Factory=prod('SafeProxyFactory'),Exec=prod('BatchExecutor'),RefTok=prod('ReferenceToken');
async function newSafe(owners:Address[],threshold:number){const init=encodeFunctionData({abi:SafeA.abi,functionName:'setup',args:[owners,BigInt(threshold),zeroAddress,'0x',zeroAddress,zeroAddress,0n,zeroAddress]});const h=await ow.sendTransaction({to:L.d.factory,data:encodeFunctionData({abi:Factory.abi,functionName:'createProxyWithNonce',args:[L.d.singleton,init,BigInt(Date.now())+BigInt(Math.floor(Math.random()*1e9))]}),gas:1000000n});const r=await L.chain.waitForTransactionReceipt({hash:h});return (parseEventLogs({abi:Factory.abi,logs:r.logs})[0] as any).args.proxy as Address;}
const execAbi=Exec.abi;const tokAbi=L.erc20;
const ES=keccak256(toHex('ExecutionSuccess(bytes32,uint256)')),EF=keccak256(toHex('ExecutionFailure(bytes32,uint256)'));
const safeEvents=(r:any,safe:Address)=>r.logs.filter((l:any)=>l.address.toLowerCase()===safe.toLowerCase()).map((l:any)=>l.topics[0]===ES?'ExecutionSuccess':l.topics[0]===EF?'ExecutionFailure':'other');
const payload=(ex:Address,batch:Hex,after:bigint,until:bigint,auth:Hex,items:any[])=>encodeFunctionData({abi:execAbi,functionName:'executeBatch',args:[batch,after,until,auth,items]});
const auth=(ex:Address)=>L.chain.readContract({address:ex,abi:execAbi,functionName:'authorityHash'}) as Promise<Hex>;
const used=(ex:Address,id:Hex)=>L.chain.readContract({address:ex,abi:execAbi,functionName:'usedPaymentId',args:[id]}) as Promise<boolean>;
const executed=(ex:Address,id:Hex)=>L.chain.readContract({address:ex,abi:execAbi,functionName:'executedBatch',args:[id]}) as Promise<boolean>;
const bal=(t:Address,a:Address)=>L.chain.readContract({address:t,abi:tokAbi,functionName:'balanceOf',args:[a]}) as Promise<bigint>;
const rid=()=>keccak256(toHex(Math.random().toString()+Date.now())) as Hex;
const now=async()=>(await L.chain.getBlock()).timestamp;const setNext=(t:bigint)=>L.rpc('evm_setNextBlockTimestamp',[toHex(t)]);

// ================= TR-T-ATOMIC =================
const lab=await newSafe(L.owners.map(o=>o.address),2);R.note('SETUP','lab Safe 2-of-3 (fixture EOAs) created through the deployed factory/singleton',{lab});
for(const [variant,art] of [['return-false',o5('O5ReturnFalseToken')],['delta-mismatch',o5('O5DeltaToken')]] as const){
 const tok=await deploy(art,[lab,1_000_000_000_000n]);const ex=await deploy(Exec,[lab,tok,31337n]);
 await L.safeExec(tok,encodeFunctionData({abi:tokAbi,functionName:'approve',args:[ex,1_000_000n]}),{safe:lab});
 const rec=[L.newAddress(),L.newAddress(),L.newAddress()] as Address[];await ow.writeContract({address:tok,abi:art.abi,functionName:'setFail',args:[rec[2]],gas:100000n} as any).then(h=>L.chain.waitForTransactionReceipt({hash:h}));
 const batch=rid();const items=rec.map((r,i)=>({paymentId:rid(),recipient:r,amount:BigInt(100+i)}));const t=await now();
 const data=payload(ex,batch,t,t+86400n,await auth(ex),items);
 const before={safe:await bal(tok,lab),r:await Promise.all(rec.map(r=>bal(tok,r))),nonce:await L.safeNonce(lab)};
 const r=await L.safeExec(ex,data,{safe:lab,safeTxGas:1_000_000n});
 const after={safe:await bal(tok,lab),r:await Promise.all(rec.map(r=>bal(tok,r))),nonce:await L.safeNonce(lab)};
 const execLogs=r.logs.filter((l:any)=>l.address.toLowerCase()===ex.toLowerCase()).length,tokLogs=r.logs.filter((l:any)=>l.address.toLowerCase()===tok.toLowerCase()).length;
 const markers={batch:await executed(ex,batch),ids:await Promise.all(items.map(i=>used(ex,i.paymentId)))};
 await R.check('TR-T-ATOMIC',`${variant} token fails on the THIRD transfer after two good ones; signed nonzero safeTxGas => outer receipt success + Safe ExecutionFailure + Safe nonce advanced, and ALL recipient/treasury balances, payment-ID markers, batch marker, executor and token logs rolled back`,async()=>{
  const ok=r.status==='success'&&safeEvents(r,lab).includes('ExecutionFailure')&&!safeEvents(r,lab).includes('ExecutionSuccess')&&after.nonce===before.nonce+1n&&after.safe===before.safe&&after.r.every(x=>x===0n)&&!markers.batch&&markers.ids.every(x=>!x)&&execLogs===0&&tokLogs===0;
  if(!ok)throw Error(JSON.stringify({status:r.status,ev:safeEvents(r,lab),before,after,markers,execLogs,tokLogs},(_,v)=>typeof v==='bigint'?String(v):v));
  return {tx:r.transactionHash,outerStatus:r.status,safeEvents:safeEvents(r,lab),nonce:[before.nonce,after.nonce],safeBalanceUnchanged:after.safe===before.safe,recipientBalances:after.r,markers,execLogs,tokLogs};});
 // safeTxGas = 0: Safe requires inner success => outer revert, nonce NOT consumed (the other branch; never conflated)
 const n0=await L.safeNonce(lab);let outer0:any;try{const rr=await L.safeExec(ex,payload(ex,rid(),t,t+86400n,await auth(ex),items.map(i=>({...i,paymentId:rid()}))),{safe:lab,safeTxGas:0n});outer0={status:rr.status,tx:rr.transactionHash};}catch(e:any){outer0={error:String(e.shortMessage||e.message).slice(0,200)};}
 await R.check('TR-T-ATOMIC',`${variant} with safeTxGas=0 => outer transaction reverts (Safe GS013 path), Safe nonce not consumed, no token effect`,async()=>{const n1=await L.safeNonce(lab);if(n1!==n0||(outer0.status&&outer0.status!=='reverted')||(await bal(tok,rec[0]))!==0n)throw Error(JSON.stringify({outer0,n0:String(n0),n1:String(n1)}));return {outer:outer0,nonce:[n0,n1]};});
 // control: fixture disarmed => the very same shape executes exactly
 await ow.writeContract({address:tok,abi:art.abi,functionName:'setFail',args:[zeroAddress],gas:100000n} as any).then(h=>L.chain.waitForTransactionReceipt({hash:h}));
 const b2=rid();const items2=items.map(i=>({...i,paymentId:rid()}));const rc=await L.safeExec(ex,payload(ex,b2,t,t+86400n,await auth(ex),items2),{safe:lab,safeTxGas:1_000_000n});
 await R.check('TR-T-ATOMIC',`${variant} control: fixture disarmed => same 3-item batch succeeds with exact per-item effects`,async()=>{const rb=await Promise.all(rec.map(r=>bal(tok,r)));if(!safeEvents(rc,lab).includes('ExecutionSuccess')||rb.some((x,i)=>x!==BigInt(100+i)))throw Error(JSON.stringify({ev:safeEvents(rc,lab),rb:rb.map(String)}));return {tx:rc.transactionHash,recipientBalances:rb};});
}

// ================= TR-T-REPLAY =================
const rt=await deploy(RefTok,[lab,1_000_000_000_000n]);const ex=await deploy(Exec,[lab,rt,31337n]);await L.safeExec(rt,encodeFunctionData({abi:tokAbi,functionName:'approve',args:[ex,10_000_000n]}),{safe:lab});
const authHash=await auth(ex);const owners0=await L.chain.readContract({address:lab,abi:L.safeAbi,functionName:'getOwners'});
{const t=await now();const recp=L.newAddress();const items=[{paymentId:rid(),recipient:recp,amount:500n}];const batch=rid();const data=payload(ex,batch,t,t+86400n,authHash,items);
 const n0=await L.safeNonce(lab);const r=await L.safeExec(ex,data,{safe:lab,operation:1,safeTxGas:1_000_000n});
 await R.check('TR-T-REPLAY','delegate context: owner-quorum Safe tx with operation=1 (DELEGATECALL) into the executor => executor code runs in Safe context, OnlySafe fails, Safe ExecutionFailure, no token effect, no executor or Safe storage change (owners/threshold intact)',async()=>{
  const owners1=await L.chain.readContract({address:lab,abi:L.safeAbi,functionName:'getOwners'});const th=await L.chain.readContract({address:lab,abi:L.safeAbi,functionName:'getThreshold'});
  if(!safeEvents(r,lab).includes('ExecutionFailure')||(await bal(rt,recp))!==0n||(await used(ex,items[0].paymentId))||(await executed(ex,batch))||JSON.stringify(owners1)!==JSON.stringify(owners0)||th!==2n)throw Error('delegate effect');
  return {tx:r.transactionHash,safeEvents:safeEvents(r,lab),nonce:[n0,await L.safeNonce(lab)],ownersIntact:true,threshold:th};});
 const direct=await L.callError(L.outsider.address,ex,data);
 await R.check('TR-T-REPLAY','wrong caller: EOA calls executeBatch directly (allowance exists) => OnlySafe',async()=>{if(!direct)throw Error('accepted');return {revert:direct};});
 // same batch via normal CALL then replays
 const ok=await L.safeExec(ex,data,{safe:lab,safeTxGas:1_000_000n});const rep=await L.safeExec(ex,data,{safe:lab,safeTxGas:1_000_000n});
 const items2=[{paymentId:items[0].paymentId,recipient:L.newAddress(),amount:1n}];const rep2=await L.safeExec(ex,payload(ex,rid(),t,t+86400n,authHash,items2),{safe:lab,safeTxGas:1_000_000n});
 await R.check('TR-T-REPLAY','after one accepted execution: identical batch at a NEW Safe nonce and the same payment ID in a NEW batch are both rejected (ExecutionFailure), recipient credited exactly once',async()=>{if(!safeEvents(ok,lab).includes('ExecutionSuccess')||!safeEvents(rep,lab).includes('ExecutionFailure')||!safeEvents(rep2,lab).includes('ExecutionFailure')||(await bal(rt,recp))!==500n)throw Error('replay');return {first:ok.transactionHash,replaySameBatch:rep.transactionHash,replaySameIdNewBatch:rep2.transactionHash,recipient:await bal(rt,recp)};});}
// exact executor time boundaries (validAfter <= ts <= validUntil, until>after, until-after <= 7 days)
{const base=(await now())+1000n;const D7=7n*86400n;const cases:[string,bigint,bigint,bigint,boolean][]=[
  ['ts = validAfter - 1',base,base+600n,base-1n,false],['ts = validAfter (equality)',base,base+600n,base,true],
  ['ts = validUntil (equality)',base-500n,base+10n,base+10n,true],['ts = validUntil + 1',base-500n,base+20n,base+21n,false],
  ['validUntil == validAfter (empty window)',base+100n,base+100n,base+100n,false],['duration exactly 7 days',base+200n-D7,base+200n,base+200n,true],['duration 7 days + 1 s',base+300n-D7-1n,base+300n,base+300n,false]];
 for(const [name,after,until,ts,expect] of cases){const recp=L.newAddress();const items=[{paymentId:rid(),recipient:recp,amount:7n}];const batch=rid();const data=payload(ex,batch,after,until,authHash,items);
  // sign at current nonce first, then pin the inclusion timestamp exactly
  const nonce=await L.safeNonce(lab);const m={to:ex,value:0n,data,operation:0,safeTxGas:1_000_000n,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce};const sig=await L.sigsFor(m,[0,1],lab);
  await setNext(ts);const h=await L.walletFor(L.owners[0]).sendTransaction({to:lab,data:L.execData(m,sig),gas:3000000n});const r=await L.chain.waitForTransactionReceipt({hash:h});const blk=await L.chain.getBlock({blockNumber:r.blockNumber});
  await R.check('TR-T-REPLAY',`executor time boundary: ${name} => ${expect?'accepted':'rejected'}`,async()=>{const ev=safeEvents(r,lab);const got=ev.includes('ExecutionSuccess');const b=await bal(rt,recp);if(blk.timestamp!==ts||got!==expect||(expect?b!==7n:b!==0n)||(await used(ex,items[0].paymentId))!==expect)throw Error(JSON.stringify({blockTs:String(blk.timestamp),ts:String(ts),ev,b:String(b)}));return {validAfter:after,validUntil:until,blockTimestamp:blk.timestamp,safeEvent:ev,recipient:b};});}}

// ================= TR-T-REPLAY app-level equality boundaries on the APP deployment =================
{const s=await L.sessions();
 // C: prepared one second before validUntil, included EXACTLY at validUntil => executor accepts, app verifies
 const c=await L.preparedPayout(s,'O5-TB-C',['3100000']);const vu=BigInt(c.manifest.validUntil);
 await setNext(vu-1n);await L.mine(1);const hC0=await (async()=>{await setNext(vu);return L.send(s,c.prepared);})();const rC=await L.chain.waitForTransactionReceipt({hash:hC0});const bC=await L.chain.getBlock({blockNumber:rC.blockNumber});
 await L.mine(12);await L.resyncOk(s);
 await R.check('TR-T-REPLAY','app-level: payout included in a block whose timestamp EQUALS validUntil => executor accepts and the app verifies it',async()=>{if(bC.timestamp!==vu||await L.opState(c.opId)!=='verified')throw Error(JSON.stringify({blockTs:String(bC.timestamp),vu:String(vu),st:await L.opState(c.opId),rep:await L.lastReport(c.opId)}));return {validUntil:vu,inclusionTimestamp:bC.timestamp,opState:'verified'};});
 // A: latest block timestamp == validUntil => API still signs/prepares (equality); inclusion at validUntil+1 => executor rejects, not paid
 const ps=await L.readyPayables(s,'O5-TB-A',['3200000']);const f=await L.freeze(s,ps.map((p:any)=>p.id));const vuA=BigInt(f.manifest.validUntil);
 await setNext(vuA);await L.mine(1);const sa=await L.sign(s,f.operationId,0),sb=await L.sign(s,f.operationId,1);const pa=await L.prepare(s,f.operationId);
 await R.check('TR-T-REPLAY','app-level: latest block timestamp EQUALS validUntil => API accepts both signatures and prepare (inclusive bound, same as executor)',async()=>{if(sa.status!==200||sb.status!==200||pa.status!==200)throw Error(JSON.stringify([sa.body,sb.body,pa.body]));return {latestTs:(await L.chain.getBlock()).timestamp,validUntil:vuA,sign:[sa.status,sb.status],prepare:pa.status};});
 const hA=await L.send(s,pa.body);const rA=await L.chain.waitForTransactionReceipt({hash:hA});const bA=await L.chain.getBlock({blockNumber:rA.blockNumber});await L.mine(12);await L.resyncOk(s);
 await R.check('TR-T-REPLAY','app-level: the prepared payout lands at validUntil+1 => Safe ExecutionFailure (executor expiry), app NOT paid, reservations kept',async()=>{const st=await L.opState(f.operationId);const set=await L.settlementsFor(f.operationId);if(bA.timestamp<=vuA||!safeEvents(rA,L.d.safe).includes('ExecutionFailure')||st==='verified'||set.length)throw Error(JSON.stringify({ts:String(bA.timestamp),ev:safeEvents(rA,L.d.safe),st}));return {inclusionTimestamp:bA.timestamp,validUntil:vuA,safeEvents:safeEvents(rA,L.d.safe),opState:st,reservations:(await L.q('SELECT count(*)::int n FROM reservations WHERE workspace_id=$1 AND batch_id=$2',[L.WS,f.id]))[0].n};});
 // B: frozen, then chain time passes validUntil before signing => 409 INTENT_TIME_WINDOW
 const ps2=await L.readyPayables(s,'O5-TB-B',['3300000']);const f2=await L.freeze(s,ps2.map((p:any)=>p.id));await setNext(BigInt(f2.manifest.validUntil)+1n);await L.mine(1);const sb2=await L.sign(s,f2.operationId,0);
 await R.check('TR-T-REPLAY','app-level: latest block timestamp = validUntil+1 => signature refused 409 INTENT_TIME_WINDOW before any executable state',async()=>{if(sb2.status!==409||sb2.body?.error?.code!=='INTENT_TIME_WINDOW')throw Error(JSON.stringify(sb2.body));return {status:sb2.status,code:sb2.body.error.code};});}

// ================= TR-T-1271 =================
const legacy=await deploy(o5('O5LegacyOwner')),modern=await deploy(o5('O5ModernOwner'));
function contractSig(entries:{owner:Address,ecdsa?:Hex}[]){const sorted=[...entries].sort((a,b)=>a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()));const n=sorted.length;let statics:Hex[]=[],dyn:Hex[]=[];let off=65n*BigInt(n);
 for(const e of sorted){if(e.ecdsa){statics.push(e.ecdsa);}else{statics.push(concat([pad(e.owner),pad(toHex(off)),'0x00']));const inner='0xabcd' as Hex;dyn.push(concat([pad(toHex(2)),inner]));off+=32n+2n;}}return concat([...statics,...dyn]);}
async function execWithContractOwner(safe:Address,cOwner:Address){const nonce=await L.safeNonce(safe);const m={to:safe,value:0n,data:'0x' as Hex,operation:0,safeTxGas:0n,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce};const typed={domain:{chainId:31337,verifyingContract:safe},types:L.safeTypes,primaryType:'SafeTx' as const,message:m};const e0=await L.owners[0].signTypedData(typed as any);
 const sig=contractSig([{owner:cOwner},{owner:L.owners[0].address,ecdsa:e0}]);return L.callError(L.owners[0].address,safe,L.execData(m,sig)).then(async err=>{if(err)return {accepted:false,revert:err};const h=await L.walletFor(L.owners[0]).sendTransaction({to:safe,data:L.execData(m,sig),gas:1000000n});const r=await L.chain.waitForTransactionReceipt({hash:h});return {accepted:safeEvents(r,safe).includes('ExecutionSuccess'),tx:h};});}
{const sL=await newSafe([legacy,L.owners[0].address,L.owners[1].address],2),sM=await newSafe([modern,L.owners[0].address,L.owners[1].address],2);
 const a=await execWithContractOwner(sL,legacy),b=await execWithContractOwner(sM,modern);
 R.note('TR-T-1271','on-chain semantics (outside the app): Safe 1.4.1 v=0 contract signatures call LEGACY isValidSignature(bytes,bytes); a legacy-only contract owner is accepted, a modern-ERC-1271-only (bytes32) contract owner is rejected => not interchangeable',{legacyOwnerSafe:sL,legacy:a,modernOwnerSafe:sM,modern:b});
 await R.check('TR-T-1271','on-chain probe matches the blueprint statement (legacy accepted / modern-only rejected with GS024)',async()=>{if(!a.accepted||b.accepted||!String((b as any).revert).includes('GS024'))throw Error(JSON.stringify({a,b}));return {legacyAccepted:a.accepted,modernRevert:(b as any).revert};});}
{const s=await L.sessions();const appSafe=L.d.safe as Address;const SENT='0x0000000000000000000000000000000000000001';
 const ownersBefore=await L.chain.readContract({address:appSafe,abi:L.safeAbi,functionName:'getOwners'}) as Address[];const authBefore=await L.chain.readContract({address:L.d.executor,abi:execAbi,functionName:'authorityHash'});
 const victim=L.owners[2].address;const idx=ownersBefore.findIndex(a=>a.toLowerCase()===victim.toLowerCase());const prev=idx===0?SENT:ownersBefore[idx-1];
 const swap=await L.safeExec(appSafe,encodeFunctionData({abi:SafeA.abi,functionName:'swapOwner',args:[prev,victim,legacy]}));
 const ownersNow=await L.chain.readContract({address:appSafe,abi:L.safeAbi,functionName:'getOwners'}) as Address[];
 R.note('TR-T-1271','app Safe (isolated chain) owner 0x..303 swapped for the legacy contract owner by an owner-quorum Safe tx (custody action outside the app)',{tx:swap.transactionHash,owners:ownersNow});
 const ps=await L.readyPayables(s,'O5-1271',['3400000']);const f=await L.freeze(s,ps.map((p:any)=>p.id));const opRow=await L.opRow(f.operationId);
 const typed=opRow.manifest.typedData;const cs=contractSig([{owner:legacy}]);const outsiderSig=await L.outsider.signTypedData(typed);
 const tries:[string,any][]=[
  ['scheme EIP1271 with the Safe v=0 contract-signature bytes',{owner:legacy,scheme:'EIP1271',signature:cs}],
  ['scheme EIP1271 with a 65-byte contract signature',{owner:legacy,scheme:'EIP1271',signature:cs.slice(0,132)}],
  ['scheme PERSONAL_SIGN for the contract owner',{owner:legacy,scheme:'PERSONAL_SIGN',signature:outsiderSig}],
  ['scheme EIP712_EOA, owner=contract, v=0 contract-signature bytes',{owner:legacy,scheme:'EIP712_EOA',signature:cs.slice(0,132)}],
  ['scheme EIP712_EOA, owner=contract, valid ECDSA from a non-owner key',{owner:legacy,scheme:'EIP712_EOA',signature:outsiderSig}],
 ];
 for(const [name,body] of tries){const r=await s.O.post(`/operations/${f.operationId}/signatures`,body);await R.check('TR-T-1271',`live contract-owner submission: ${name} => rejected 422 before any executable state`,async()=>{if(r.status!==422)throw Error(JSON.stringify(r.body));return {status:r.status,code:r.body.error.code};});}
 // a current EOA owner whose address now carries code (EIP-7702-like / setCode) => CONTRACT_OWNER_UNSUPPORTED
 await L.rpc('anvil_setCode',[L.owners[0].address,o5('O5LegacyOwner').runtime]);const sig0=await L.owners[0].signTypedData(typed);const rc=await s.O.post(`/operations/${f.operationId}/signatures`,{owner:L.owners[0].address,scheme:'EIP712_EOA',signature:sig0});await L.rpc('anvil_setCode',[L.owners[0].address,'0x']);
 await R.check('TR-T-1271','live: valid EIP-712 ECDSA from a current owner whose address now has contract code => 422 CONTRACT_OWNER_UNSUPPORTED',async()=>{if(rc.status!==422||rc.body?.error?.code!=='CONTRACT_OWNER_UNSUPPORTED')throw Error(JSON.stringify(rc.body));return {status:rc.status,code:rc.body.error.code};});
 const stored=(await L.q('SELECT count(*)::int n FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[L.WS,f.operationId]))[0].n;const pr=await L.prepare(s,f.operationId);
 await R.check('TR-T-1271','after every contract-owner attempt: zero stored signatures, prepare => 409 QUORUM_REQUIRED (no executable state); no generic EIP-1271 support claimed',async()=>{if(stored!==0||pr.status!==409||pr.body?.error?.code!=='QUORUM_REQUIRED')throw Error(JSON.stringify({stored,pr:pr.body}));return {storedSignatures:stored,prepare:[pr.status,pr.body.error.code],opState:await L.opState(f.operationId)};});
 // the two EOA owners still complete it; then restore the original owner set
 await L.signAll(s,f.operationId);const p2=await L.prepare(s,f.operationId);const h=await L.send(s,p2.body);await L.mine(12);await L.resyncOk(s);
 await R.check('TR-T-1271','control: with the contract owner present, the two supported EOA owners still authorize and the payout verifies',async()=>{if(await L.opState(f.operationId)!=='verified')throw Error(String(await L.opState(f.operationId)));return {tx:h,opState:'verified'};});
 const cur=await L.chain.readContract({address:appSafe,abi:L.safeAbi,functionName:'getOwners'}) as Address[];const j=cur.findIndex(a=>a.toLowerCase()===legacy.toLowerCase());const back=await L.safeExec(appSafe,encodeFunctionData({abi:SafeA.abi,functionName:'swapOwner',args:[j===0?SENT:cur[j-1],legacy,victim]}));
 const authAfter=await L.chain.readContract({address:L.d.executor,abi:execAbi,functionName:'authorityHash'});
 R.note('TR-T-1271','original owner set restored on the isolated app Safe',{tx:back.transactionHash,authorityHashRestored:authAfter===authBefore,owners:await L.chain.readContract({address:appSafe,abi:L.safeAbi,functionName:'getOwners'})});}
R.save({run:'O5-CHAIN-LAB',chain:'isolated anvil 18548',deployment:L.d.genesis});console.log(JSON.stringify({pass:R.steps.filter(x=>x.result==='PASS').length,fail:R.steps.filter(x=>x.result==='FAIL').length}));await L.db.end();process.exit(0);
