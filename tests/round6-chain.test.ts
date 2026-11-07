// Round 6 pure tests: incremental header window (CAPACITY/F-L6, VERIFY S3), attempt binding (F-M1), corroborated
// archive fallback (F-L2), safeTxGas margin (ops #2) and typed DB conflicts (ops #8). No DB or chain needed.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {encodeFunctionData,hashTypedData,parseAbi,zeroAddress,keccak256,toHex} from 'viem';
import {headerHash,headerWindow,fetchRange} from '../services/header-view.ts';
import {validateAttemptTransaction,validateAttemptReceipt} from '../services/attempt-evidence.ts';
import {corroborateArchiveGap,reloadPoints} from '../services/archive-corroboration.ts';
import {withMargin} from '../packages/gas.ts';
import {mapDatabaseError} from '../apps/api/mutate.ts';

const Z32='0x'+'00'.repeat(32),BLOOM='0x'+'00'.repeat(256);
function mkChain(n:number,salt='a'){const out:any[]=[];for(let i=0;i<=n;i++){const b:any={number:BigInt(i),parentHash:i?out[i-1].hash:Z32,sha3Uncles:Z32,miner:'0x'+'00'.repeat(20),stateRoot:keccak256(toHex(salt+i)),transactionsRoot:Z32,receiptsRoot:Z32,logsBloom:BLOOM,difficulty:0n,gasLimit:30000000n,gasUsed:0n,timestamp:BigInt(1000+i),extraData:'0x',mixHash:Z32,nonce:'0x0000000000000000',baseFeePerGas:1n,withdrawalsRoot:Z32};b.hash=headerHash(b);out.push(b);}return out;}
function fork(base:any[],from:number,len:number,salt='b'){const out=base.slice(0,from);for(let i=from;i<from+len;i++){const b:any={...base[Math.min(i,base.length-1)],number:BigInt(i),parentHash:out[i-1].hash,stateRoot:keccak256(toHex(salt+i)),timestamp:BigInt(5000+i)};b.hash=headerHash(b);out.push(b);}return out;}
const client=(chain:()=>any[],tamper?:(b:any)=>any)=>({calls:0,async getBlock(a?:any){this.calls++;const c=chain();const b=a?.blockNumber==null?c[c.length-1]:c[Number(a.blockNumber)];return tamper?tamper({...b}):b;}});
function fakePool(rows:any[]){return {async query(sql:string,p:any[]){if(/number BETWEEN/.test(sql))return {rows:rows.filter(r=>r.canonical&&BigInt(r.number)>=BigInt(p[1])&&BigInt(r.number)<=BigInt(p[2])).map(r=>({number:String(r.number),hash:r.hash,parent_hash:r.parentHash}))};
 if(/number=ANY/.test(sql))return {rows:rows.filter(r=>r.canonical&&p[1].includes(String(r.number))).map(r=>({number:String(r.number),hash:r.hash,parent_hash:r.parentHash}))};throw Error('unexpected '+sql);}};}
const stored=(c:any[])=>c.map(b=>({number:b.number,hash:b.hash,parentHash:b.parentHash,canonical:true}));

test('header hash is recomputed (keccak rlp) and a flipped hash is a disagreement',async()=>{const c=mkChain(5);const st={rpc:0};assert.equal((await fetchRange(client(()=>c),0n,5n,st)).length,6);
 const w=await headerWindow(client(()=>c,b=>b.number===3n?{...b,hash:'0x'+'11'.repeat(32)}:b),fakePool(stored(c)),'k',c[5],{number:'5',hash:c[5].hash});assert.equal(w.disagreement?.reason,'HEADER_HASH_RECOMPUTE');});

test('incremental pass reads only the overlap window, not genesis..head',async()=>{const c=mkChain(5000);const cl=client(()=>c);const cp=c[4990];const w=await headerWindow(cl,fakePool(stored(c.slice(0,4991))),'k',c[5000],{number:'4990',hash:cp.hash});
 assert.equal(w.mode,'incremental');assert.equal(w.disagreement,null);assert.equal(w.depth,0n);assert.equal(w.write.length,10);assert.ok(cl.calls<=1+267+64,'rpc headers '+cl.calls);});

test('rolling audit: a lie about a deep historical block (far below the window) is detected within a bounded number of passes',async()=>{
 const c=mkChain(2000);const K=300;const lie=(b:any):any=>{if(b.number===BigInt(K)){const x={...b,stateRoot:keccak256(toHex('deep-lie'))};x.hash=headerHash(x);return x;}if(b.number===BigInt(K+1))return {...b,parentHash:lie({...c[K]}).hash};return b;};
 let found=null,passes=0;for(;passes<40&&!found;passes++){const w=await headerWindow(client(()=>c,lie),fakePool(stored(c)),'audit-k',c[2000],{number:'2000',hash:c[2000].hash});found=w.disagreement;}
 assert.ok(found,'not detected');assert.ok(/^(HISTORICAL_HEADER_AUDIT|HEADER_HASH_RECOMPUTE)/.test(String(found!.reason)),found!.reason);assert.ok(passes<=30,'passes '+passes);});

test('S3: provider changes ONE recorded historical header (and its child parentHash) under an unchanged checkpoint -> disagreement',async()=>{
 const c=mkChain(100);const K=85;const lie=(b:any):any=>{if(b.number===BigInt(K)){const x={...b,stateRoot:keccak256(toHex('lie'))};x.hash=headerHash(x);return x;}return b;};
 // a consistent-looking lie: K re-hashed from altered content, K+1 parentHash re-pointed but K+1's own hash kept
 const lieChild=(b:any)=>{const x=lie(b);if(b.number===BigInt(K+1)){return {...x,parentHash:lie({...c[K]}).hash};}return x;};
 const w=await headerWindow(client(()=>c,lieChild),fakePool(stored(c)),'k',c[100],{number:'100',hash:c[100].hash});
 assert.ok(w.disagreement,'disagreement expected');assert.ok(['HEADER_HASH_RECOMPUTE','HISTORICAL_HEADER_CHANGED_UNDER_UNCHANGED_CHECKPOINT'].includes(w.disagreement!.reason),w.disagreement!.reason);});

test('S3 variant with a self-consistent rewritten header K (hash recomputes) is still caught against the stored chain',async()=>{
 const c=mkChain(100);const K=90;const alt=(()=>{const x:any={...c[K],stateRoot:keccak256(toHex('alt'))};x.hash=headerHash(x);return x;})();
 const w=await headerWindow(client(()=>c,b=>b.number===BigInt(K)?alt:b),fakePool(stored(c)),'k',c[100],{number:'100',hash:c[100].hash});
 assert.ok(w.disagreement);});

test('shallow reorg (depth 2) finds the ancestor inside the window; deep reorg (15) pauses; beyond the bounded search -> ancestor unknown',async()=>{
 const a=mkChain(100);const b=fork(a,99,3);const w=await headerWindow(client(()=>b),fakePool(stored(a)),'k',b[b.length-1],{number:'100',hash:a[100].hash});
 assert.equal(w.ancestor,98n);assert.equal(w.depth,2n);assert.equal(w.deep,false);assert.equal(w.write[0].number,99n);
 const d=fork(a,86,16);const w2=await headerWindow(client(()=>d),fakePool(stored(a)),'k',d[d.length-1],{number:'100',hash:a[100].hash});assert.equal(w2.ancestor,85n);assert.equal(w2.depth,15n);assert.equal(w2.deep,true);
 const big=mkChain(1000);const far=fork(big,200,801);const w3=await headerWindow(client(()=>far),fakePool(stored(big)),'k',far[far.length-1],{number:'1000',hash:big[1000].hash});assert.equal(w3.ancestor,-1n);assert.equal(w3.deep,true);});

test('full rebuild walks genesis..head (operator tool)',async()=>{const c=mkChain(300);const cl=client(()=>c);const w=await headerWindow(cl,fakePool(stored(c.slice(0,200))),'k',c[300],{number:'199',hash:c[199].hash},{full:true});assert.equal(w.mode,'full');assert.equal(w.ancestor,199n);assert.equal(w.write.length,101);assert.ok(cl.calls>=301);});

// ---- F-M1
const safe='0x'+'5a'.repeat(20),sender='0x'+'01'.repeat(20),executor='0x'+'e0'.repeat(20);
const safeAbi=parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)']);
const types={SafeTx:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'},{name:'operation',type:'uint8'},{name:'safeTxGas',type:'uint256'},{name:'baseGas',type:'uint256'},{name:'gasPrice',type:'uint256'},{name:'gasToken',type:'address'},{name:'refundReceiver',type:'address'},{name:'nonce',type:'uint256'}]} as const;
const message={to:executor,value:0n,data:'0x1234',operation:0,safeTxGas:500000n,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce:7n};
const m={safe,chainId:31337,message:{...message,value:'0',safeTxGas:'500000',baseGas:'0',gasPrice:'0',nonce:'7'},safeTxHash:hashTypedData({domain:{chainId:31337,verifyingContract:safe as any},types,primaryType:'SafeTx',message:message as any})};
const input=(msg=message)=>encodeFunctionData({abi:safeAbi,functionName:'execTransaction',args:[msg.to as any,msg.value,msg.data as any,msg.operation,msg.safeTxGas,0n,0n,zeroAddress,zeroAddress,'0x'+'ab'.repeat(130) as any]});
const attempt={sender,sender_nonce:'170',transaction_data:input()};
test('F-M1: the attempt tx binds (sender, nonce, Safe, fields, SafeTx hash); an unrelated reverted tx from the same sender is a mismatch',()=>{
 assert.deepEqual(validateAttemptTransaction({from:sender,to:safe,nonce:170,input:input(),chainId:31337},attempt,m),{ok:true,rebroadcast:false,exactPreparedInput:true});
 assert.equal((validateAttemptTransaction({from:sender,to:safe,nonce:172,input:input()},attempt,m) as any).rebroadcast,true);
 // the reviewer's probe: same sender, earlier nonce 168, a different Safe call that reverted
 const unrelated=validateAttemptTransaction({from:sender,to:safe,nonce:168,input:input({...message,data:'0xdead'})},attempt,m);assert.equal(unrelated.ok,false);
 assert.equal(validateAttemptTransaction({from:sender,to:safe,nonce:171,input:input({...message,data:'0xdead'})},attempt,m).ok,false);
 assert.equal(validateAttemptTransaction({from:'0x'+'02'.repeat(20),to:safe,nonce:170,input:input()},attempt,m).ok,false);
 assert.equal(validateAttemptTransaction({from:sender,to:executor,nonce:170,input:input()},attempt,m).ok,false);
 assert.equal(validateAttemptTransaction({from:sender,to:safe,nonce:170,input:input({...message,nonce:8n})},attempt,m).ok,true,'Safe nonce is not in calldata; the hash uses the manifest nonce');
 assert.equal(validateAttemptReceipt({transactionHash:'0xaa',from:sender,to:safe,blockHash:'0xb1'},{hash:'0xaa',from:sender,to:safe,blockHash:'0xb1'},'0xb1'),null);
 assert.equal(validateAttemptReceipt({transactionHash:'0xaa',from:sender,to:safe,blockHash:'0xb1'},{hash:'0xaa',from:sender,to:safe,blockHash:'0xb1'},'0xb2'),'non-canonical');});

// ---- F-L2
test('F-L2: the receipt-log fallback needs a recorded reload point at or above the inclusion block and state served at it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r6-'));const f=path.join(dir,'rp.jsonl');process.env.ALDER_RELOAD_POINTS_FILE=f;const g='0x'+'99'.repeat(32);
 const honest={request:async({params}:any)=>{const tag=params[1];if(tag!=='latest'&&BigInt(tag)<1920n)throw Error('BlockOutOfRange');return '0x';}};
 const lying={request:async()=>{throw Error('BlockOutOfRange');}};const probe={to:'0x'+'11'.repeat(20),data:'0x'};
 assert.equal((await corroborateArchiveGap(honest,g,100n,probe)).ok,false,'no reload point recorded');
 fs.writeFileSync(f,JSON.stringify({genesis:g,height:'1920',at:'t',source:'test'})+'\n'+JSON.stringify({genesis:'0x'+'77'.repeat(32),height:'99999',at:'t',source:'other chain'})+'\n');
 assert.equal(reloadPoints(g).length,1);
 assert.equal((await corroborateArchiveGap(honest,g,1500n,probe)).ok,true);
 assert.equal((await corroborateArchiveGap(honest,g,2467n,probe)).ok,false,'reviewer probe: block above the reload point must not fall back');
 assert.equal((await corroborateArchiveGap(lying,g,1500n,probe)).ok,false,'a node refusing state everywhere is not a pruning gap');
 delete process.env.ALDER_RELOAD_POINTS_FILE;});

test('ops #2: safeTxGas margin covers the 100-item inner cost the round-5 wallet under-estimated',()=>{assert.equal(withMargin(1000000n),1275000n);assert.ok(withMargin(6050632n)>6050632n&&withMargin(6050632n)<15000000n);assert.ok(withMargin(12000000n)>15000000n,'a 12M estimate exceeds the 15M cap after margin');});

test('ops #8: unique violations map to 409, the SafeTx collision is named; busy -> 503',()=>{
 const a=mapDatabaseError({code:'23505',constraint:'operation_exact_intent'});assert.equal(a.statusCode,409);assert.equal(a.message,'SAFE_TX_HASH_COLLISION');
 assert.equal(mapDatabaseError({code:'23505',constraint:'x'}).message,'UNIQUE_CONFLICT');assert.equal(mapDatabaseError({code:'40001'}).statusCode,503);
 const typed=Object.assign(Error('X'),{statusCode:422});assert.equal(mapDatabaseError(typed),typed);});
