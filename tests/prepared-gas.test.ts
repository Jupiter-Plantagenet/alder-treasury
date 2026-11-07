import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeFunctionData,hashTypedData,numberToHex,toHex,zeroAddress,type Address,type Hex} from 'viem';
import {batchAbi,safeAbi,types} from '../packages/intent.ts';
import {estimatePreparedOuterGas} from '../packages/prepared.ts';

const account:Address='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const safe:Address='0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const executor:Address='0xcccccccccccccccccccccccccccccccccccccccc';
const hex32=(n:number):Hex=>toHex(BigInt(n),{size:32});

function prepared(itemCount=100,safeTxGas=9_000_000n){
 const items=Array.from({length:itemCount},(_,i)=>({paymentId:hex32(i+1),recipient:numberToHex(BigInt(i+1),{size:20}),amount:BigInt(i+1)}));
 const data=encodeFunctionData({abi:batchAbi,functionName:'executeBatch',args:[hex32(500),1n,100n,hex32(501),items]});
 const message={to:executor,value:0n,data,operation:0,safeTxGas,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce:7n};
 const safeTxHash=hashTypedData({domain:{chainId:31337,verifyingContract:safe},types,primaryType:'SafeTx',message});
 const signatures=toHex(new Uint8Array([...Array(65).fill(0x11),...Array(65).fill(0x22)]));
 const outer=encodeFunctionData({abi:safeAbi,functionName:'execTransaction',args:[message.to,message.value,message.data,message.operation,message.safeTxGas,message.baseGas,message.gasPrice,message.gasToken,message.refundReceiver,signatures]});
 return {manifest:{safe,message,safeTxHash,threshold:2},tx:{to:safe,data:outer,value:'0x0',chainId:31337,senderNonce:'7'}};
}

function provider({estimate='0x7a1200',pending='0x7',blockGas='0x1c9c380'}:{estimate?:any;pending?:any;blockGas?:any}={}){
 const calls:any[]=[];
 return {calls,request:async({method,params}:any)=>{
  calls.push({method,params});
  if(method==='eth_getTransactionCount')return pending;
  if(method==='eth_getBlockByNumber')return {gasLimit:blockGas};
  if(method==='eth_estimateGas')return estimate;
  throw Error('unexpected method '+method);
 }};
}

test('100-item prepared Safe outer gas uses exact sender transaction, headroom, and product/block caps',async()=>{
 const {manifest,tx}=prepared(100,9_000_000n),p=provider();
 const result=await estimatePreparedOuterGas(p,account,manifest,tx);
 const request=p.calls.find(x=>x.method==='eth_estimateGas')!;
 assert.deepEqual(request.params[0],{from:account,to:tx.to,data:tx.data,value:'0x0',nonce:'0x7'});
 assert.equal(result.estimate,8_000_000n);
 assert.equal(result.gasLimit,10_025_000n);
 assert.equal(result.cap,15_000_000n);
 assert.ok(tx.data.length>15_000,'the prepared outer call represents all 100 batch items');
});

test('an underestimated outer estimate cannot fall below the signed Safe EIP-150 floor',async()=>{
 const {manifest,tx}=prepared(100,12_000_000n),p=provider({estimate:'0x1e8480'});
 const result=await estimatePreparedOuterGas(p,account,manifest,tx);
 assert.ok(result.estimate<result.safeFloor);
 assert.equal(result.gasLimit,result.safeFloor);
 assert.ok(result.gasLimit>=((12_000_000n*64n+62n)/63n));
});

test('malformed, zero, over-cap, and block-budget estimates fail closed',async t=>{
 for(const [label,estimate] of [['malformed','not-hex'],['zero','0x0'],['over-cap','0xe4e1c1']] as const){
  await t.test(label,async()=>{const {manifest,tx}=prepared(1),p=provider({estimate});await assert.rejects(()=>estimatePreparedOuterGas(p,account,manifest,tx));});
 }
 await t.test('block-budget',async()=>{const {manifest,tx}=prepared(1,9_500_000n),p=provider({estimate:'0x895440',blockGas:'0xa00000'});await assert.rejects(()=>estimatePreparedOuterGas(p,account,manifest,tx),/EXCEEDS_CAP/);});
 await t.test('pending-nonce-mismatch',async()=>{const {manifest,tx}=prepared(1),p=provider({pending:'0x8'});await assert.rejects(()=>estimatePreparedOuterGas(p,account,manifest,tx),/SENDER_NONCE_MISMATCH/);assert.equal(p.calls.some(x=>x.method==='eth_estimateGas'),false);});
});

test('a tampered prepared Safe call is rejected before provider estimation',async()=>{
 const {manifest,tx}=prepared(100);tx.data='0x1234';const p=provider();
 await assert.rejects(()=>estimatePreparedOuterGas(p,account,manifest,tx),/PREPARED_OUTER_INTENT_MISMATCH/);
 assert.equal(p.calls.length,0);
});

test('signed safeTxGas above the product cap is rejected before estimation',async()=>{
 const {manifest,tx}=prepared(1,15_000_001n),p=provider();
 await assert.rejects(()=>estimatePreparedOuterGas(p,account,manifest,tx),/SIGNED_GAS_OUT_OF_RANGE/);
 assert.equal(p.calls.length,0);
});
