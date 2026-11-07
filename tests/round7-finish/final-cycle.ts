// Final current-source integration: isolated local chain and scratch DB only.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import * as L from '../round5-ops/o5-lib.ts';

const output=process.env.ALDER_FINAL_PROOF;
assert.ok(output&&path.isAbsolute(output)&&path.resolve(output).startsWith(path.resolve('.local')+path.sep));
assert.ok(!fs.existsSync(output));
const report:any={schema:'alder.final-isolated-cycle/v1',startedAt:new Date().toISOString(),scope:'actual API 9103 / PostgreSQL 15543 / proxy 18547 / Anvil 18548; simulated actors and local EOA signatures',canonicalMutation:false,publicTransaction:false,pass:false};
const sourceNames=['apps/api/eligibility.ts','apps/api/reads.ts','apps/api/app.ts','apps/web/Contacts.tsx','apps/web/Destinations.tsx','contracts/src/BatchExecutor.sol','services/treasury-indexer.ts','services/verifier.ts','tests/round5-ops/o5-lib.ts'];
report.sourcePins=Object.fromEntries(sourceNames.map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
try{
 assert.equal(L.API,'http://127.0.0.1:9103');assert.equal(L.TRUTH,'http://127.0.0.1:18548');
 const proxy=await L.proxyStats();assert.deepEqual(proxy.rules,[]);assert.equal(proxy.upstream,L.TRUTH);
 const genesis=await L.chain.getBlock({blockNumber:0n});assert.equal(genesis.hash,'0xc8c7b74cc2de7dc59907efc42d233968be0b1f92d8de35d0c876bf32b16d0293');
 const sessions=await L.sessions();const units=['1100000','2200000','3300000'];const recipients=units.map(()=>L.newAddress());
 const balancesBefore=await Promise.all([L.balance(L.d.safe),...recipients.map(x=>L.balance(x))]);
 const prepared=await L.preparedPayout(sessions,'R7-FINAL-'+L.RUN,units,recipients);
 const transactionHash=await L.send(sessions,prepared.prepared);const receipt=await L.chain.waitForTransactionReceipt({hash:transactionHash});assert.equal(receipt.status,'success');
 await L.mine(12);await L.resyncOk(sessions);
 const settlements=await L.settlementsFor(prepared.opId);assert.equal(await L.opState(prepared.opId),'verified');assert.equal(settlements.length,3);assert.ok(settlements.every(x=>x.state==='verified'));
 assert.deepEqual(new Set(settlements.map(x=>x.payable_id)),new Set(prepared.payables.map(x=>x.id)));
 const balancesAfter=await Promise.all([L.balance(L.d.safe),...recipients.map(x=>L.balance(x))]);
 const deltas=balancesAfter.map((x,i)=>x-balancesBefore[i]);assert.equal(deltas[0],-units.reduce((a,x)=>a+BigInt(x),0n));
 units.forEach((x,i)=>assert.equal(deltas[i+1],BigInt(x)));
 await L.resyncOk(sessions);assert.equal((await L.settlementsFor(prepared.opId)).length,3);
 assert.deepEqual(await Promise.all([L.balance(L.d.safe),...recipients.map(x=>L.balance(x))]),balancesAfter);
 const duplicateFreeze=await sessions.J.post('/batches',{ids:prepared.payables.map(x=>x.id)});
 assert.equal(duplicateFreeze.status,409);assert.equal(duplicateFreeze.body?.error?.code,'PAYABLE_ALREADY_SETTLED');
 Object.assign(report,{genesisHash:genesis.hash,operationId:prepared.opId,transactionHash,receiptStatus:receipt.status,exactUnits:units,balanceDeltas:deltas.map(String),verifiedSettlements:settlements.length,repeatedResyncDuplicateEffects:0,settledPayablesRefreezeStatus:duplicateFreeze.status,settledPayablesRefreezeCode:duplicateFreeze.body.error.code,refreezeActorRole:'preparer',scopeLimits:['does not independently repeat all contract fuzz/reorg tests','API refusal of already-settled selection is not a new on-chain permanent-ID replay proof'],sourceUnchanged:sourceNames.every(p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex')===report.sourcePins[p]),pass:true});
 assert.equal(report.sourceUnchanged,true);
}catch(e:any){report.pass=false;report.error=String(e?.stack||e);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(output!),{recursive:true});fs.writeFileSync(output!,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({proof:output,pass:report.pass,operationId:report.operationId,settlements:report.verifiedSettlements}));await L.db.end();}
