import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs';
import {buildApp} from '../apps/api/app.ts';
import {episode,login,headers} from './episode.ts';
import {client,testAccounts,send} from './chain-kit.ts';
import {reconcileApplication} from '../services/treasury-indexer.ts';

// Real viem HTTP transport, real verifier, real application reconciler and isolated PG.
// Only the verifier endpoint switches to a one-request B view; outer headers stay A.
test('AL-01B: actual reconciliation rejects ABA supporting evidence at every effect RPC seam',async()=>{
 const f=await episode(),app=await buildApp(),original=process.env.ALDER_RPC_URL!;
 const trace:any[]=[],cases:any[]=[];let attack:any=null,effect=0,armed=false;
 const B='0x'+'ab'.repeat(32);
 const server=createServer(async(req,res)=>{try{
  let body='';for await(const c of req)body+=c;
  const q=JSON.parse(body);const upstream=await fetch(original,{method:'POST',headers:{'content-type':'application/json'},body});const answer=await upstream.json() as any;
  const relevant=q.method.startsWith('eth_');
  if(armed&&relevant){const index=effect++;trace.push({index,method:q.method,params:q.params});
   if(attack?.index===index){
    if(q.method==='eth_call'){
     // A canonical-hash call during B must fail, never fall back to a height.
     if(typeof q.params[1]==='object') {delete answer.result;answer.error={code:attack.unsupported?-32602:-32000,message:attack.unsupported?'EIP1898 unsupported':'captured A hash not canonical during B'};}
     // Old number-based reads see B's matching effects, concealing ABA.
    }else if(q.method==='eth_getLogs'){
     for(const l of answer.result||[]){if(attack.field==='blockNumber')l.blockNumber='0x0';else if(attack.field==='removed')l.removed=true;else if(attack.field==='transactionHash')l.transactionHash=B;else if(attack.field==='transactionIndex')l.transactionIndex='0x99';else if(attack.field==='logIndex')l.logIndex='0x99';else if(attack.field==='data')l.data='0x';else l.blockHash=B;}
    }else if(q.method==='eth_getTransactionByHash'){answer.result[attack.field||'blockHash']=attack.field==='blockNumber'?'0x0':attack.field==='transactionIndex'?'0x99':B;
    }else if(q.method==='eth_chainId'){answer.result='0x1';}else if(q.method==='eth_getCode'){answer.result='0x6000';}else if(q.method.startsWith('eth_getBlock')){answer.result.hash=B;}else {if(attack.field==='log')answer.result.logs[0].blockHash=B;else if(attack.field==='removed')answer.result.logs[0].removed=true;else if(attack.field==='transactionHash')answer.result.transactionHash=B;else answer.result.blockHash=B;}
   }
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify(answer));
 }catch(e){res.statusCode=500;res.end(String(e));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const proxy='http://127.0.0.1:'+(server.address() as any).port;
 try{
  await reconcileApplication(f.db,{rebuild:true});const s=await login(app,f,'owner'),preparer=await login(app,f,'preparer'),base=`/api/v1/workspaces/${f.ws}`;
  async function post(path:string,body:any,session=s){const r=await app.inject({method:'POST',url:base+path,headers:headers(session),payload:body});assert.equal(r.statusCode,200,r.body);return r.json();}
  async function execute(op:any){for(const a of testAccounts.slice(0,2))await post(`/operations/${op.id}/signatures`,{owner:a.address,scheme:'EIP712_EOA',signature:await a.signTypedData(op.manifest.typedData)});const tx=await post(`/operations/${op.id}/attempts`,{sender:testAccounts[0].address});const receipt=await send(tx.to,tx.data);assert.equal(receipt.status,'success');await client.request({method:'anvil_mine' as any,params:['0xb'] as any});return receipt;}
  async function reconcileFault(a:any){attack=a;effect=0;trace.length=0;armed=true;process.env.ALDER_RPC_URL=proxy;try{await reconcileApplication(f.db,{rebuild:true});}finally{armed=false;process.env.ALDER_RPC_URL=original;}return structuredClone(trace);}
  let allowance=await post('/allowances',{ids:f.ids});let allowanceReceipt=await execute(allowance);if(allowance.manifest.reset){await reconcileFault(null);allowance=await post('/allowances',{ids:f.ids});allowanceReceipt=await execute(allowance);}
  const entireAllowanceTrace=await reconcileFault(null);const allowanceStart=entireAllowanceTrace.findIndex(x=>x.method==='eth_getTransactionReceipt'&&x.params[0]===allowanceReceipt.transactionHash);assert(allowanceStart>=0);const allowanceBegin=entireAllowanceTrace.reduce((last,x,i)=>i<allowanceStart&&x.method==='eth_chainId'?i:last,-1);const allowanceTrace=entireAllowanceTrace.slice(allowanceBegin);assert.equal((await f.db.query('SELECT state FROM treasury_operations WHERE id=$1',[allowance.id])).rows[0].state,'verified');
  for(const seam of process.env.ALDER_ABA_RED_PAYOUT==='1'?[]:allowanceTrace){const field=seam.method==='eth_getTransactionReceipt'?'log':undefined;await reconcileFault({index:seam.index,field});assert.equal((await f.db.query('SELECT state FROM treasury_operations WHERE id=$1',[allowance.id])).rows[0].state,'unverified',`allowance ABA ${seam.method} #${seam.index}`);assert.equal((await f.db.query('SELECT report FROM treasury_reports WHERE operation_id=$1 ORDER BY id DESC LIMIT 1',[allowance.id])).rows[0].report.paid,false);cases.push({kind:'allowance',...seam});}
  await reconcileFault(null);
  const snapshot=await client.request({method:'evm_snapshot' as any});const batch=await post('/batches',{ids:f.ids},preparer);const op=(await f.db.query('SELECT * FROM treasury_operations WHERE id=$1',[batch.operationId])).rows[0];const payoutReceipt=await execute(op);
  const baseline=await reconcileFault(null);assert.equal((await f.db.query("SELECT count(*) FROM treasury_settlements WHERE workspace_id=$1 AND state='verified'",[f.ws])).rows[0].count,'3');
  // Trace also contains allowance reads. Restrict payout's suffix, located by receipt tx hash.
  const start=baseline.findIndex(x=>x.method==='eth_getTransactionReceipt'&&x.params[0]===payoutReceipt.transactionHash);assert(start>=0);
  const payoutBegin=baseline.reduce((last,x,i)=>i<start&&x.method==='eth_chainId'?i:last,-1);const seams=baseline.slice(payoutBegin);
  for(const seam of seams){const fields=seam.method==='eth_getLogs'?['blockHash','blockNumber','removed','transactionHash','transactionIndex','logIndex','data']:seam.method==='eth_getTransactionReceipt'?['blockHash','log','removed','transactionHash']:seam.method==='eth_getTransactionByHash'?['blockHash','blockNumber','transactionIndex','hash']:[undefined];
   for(const field of fields){await reconcileFault({index:seam.index,field});assert.equal((await f.db.query("SELECT count(*) FROM treasury_settlements WHERE workspace_id=$1 AND state='verified'",[f.ws])).rows[0].count,'0',`payout ABA ${seam.method} #${seam.index} ${field}`);cases.push({kind:'payout',...seam,field});}
  }
  const call=seams.find(x=>x.method==='eth_call')!;await reconcileFault({index:call.index,unsupported:true});assert.equal((await f.db.query('SELECT state FROM treasury_operations WHERE id=$1',[op.id])).rows[0].state,'unverified');
  await reconcileFault(null);assert.equal((await f.db.query("SELECT count(*) FROM treasury_settlements WHERE workspace_id=$1 AND state='verified'",[f.ws])).rows[0].count,'3');
  for(const seam of [...allowanceTrace,...seams])if(seam.method==='eth_call'){assert.equal(typeof seam.params[1],'object');assert.equal(seam.params[1].requireCanonical,true);assert.match(seam.params[1].blockHash,/^0x[0-9a-f]{64}$/);}
  const logs=seams.find(x=>x.method==='eth_getLogs')!;assert.equal(logs.params[0].blockHash,payoutReceipt.blockHash);assert.equal(logs.params[0].fromBlock,undefined);const parent=await client.getBlock({blockHash:payoutReceipt.blockHash});for(const seam of seams.filter(x=>x.method==='eth_call'))assert([payoutReceipt.blockHash,parent.parentHash].includes(seam.params[1].blockHash),'all calls bound to captured ancestry');
  assert(await client.request({method:'evm_revert' as any,params:[snapshot] as any}));await client.request({method:'anvil_mine' as any,params:['0xf'] as any});await reconcileApplication(f.db,{rebuild:true});assert.equal((await f.db.query("SELECT count(*) FROM treasury_settlements WHERE workspace_id=$1 AND state='retracted'",[f.ws])).rows[0].count,'3');
  await assert.rejects(client.request({method:'eth_call',params:[call.params[0],call.params[1]]} as any),'actual Anvil rejects orphaned hash after branch replacement');assert.equal((await f.db.query('SELECT count(*) FROM reservations WHERE workspace_id=$1',[f.ws])).rows[0].count,'3');
  fs.mkdirSync('evidence/al01b-v3',{recursive:true});fs.writeFileSync('evidence/al01b-v3/rpc-wire.json',JSON.stringify({passed:true,scope:'Actual verifier + actual reconciliation + isolated PG + Anvil18547; single-request controlled ABA fault adapter, not a consistently lying provider proof',cases,allowanceTrace,payoutTrace:seams,reorg:'3 verified -> 3 retracted; reservations retained'},null,2));
 }finally{process.env.ALDER_RPC_URL=original;await new Promise<void>(r=>server.close(()=>r()));await app.close();await f.db.end();}
});
