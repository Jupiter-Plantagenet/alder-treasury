import test from 'node:test';
import assert from 'node:assert/strict';
import {requireSingleSafeScope,terminalizeEphemeralRequestFailure,requestReconcileFailure} from '../../services/treasury-indexer.ts';

const lease:any={name:'indexer',holder:'unit-test',fence:'9',token:'not-a-real-token'};

test('single-safe deployment scope is normalized and multiple Safes fail closed',()=>{
 assert.equal(requireSingleSafeScope([{manifest:{safe:'0xAbC'}}]),'0xabc');
 assert.equal(requireSingleSafeScope([]),null);
 assert.throws(()=>requireSingleSafeScope([{manifest:{safe:'0xabc'}},{manifest:{safe:'0xdef'}}]),(e:any)=>e.code==='MULTIPLE_SAFE_ADDRESSES_UNSUPPORTED');
});

function fakePool({leaseLost=false,rowCount=2}:any={}){
 const calls:any[]=[];const db:any={query:async(sql:string,args?:any[])=>{calls.push({sql,args});if(sql.includes('alder_lease_assert')&&leaseLost)throw Object.assign(Error('LEASE_LOST'),{code:'LEASE_LOST'});if(sql.startsWith('UPDATE indexer_requests'))return {rowCount,rows:[]};return {rowCount:0,rows:[{}]};},release:()=>{calls.push({release:true});}};
 return {calls,pool:{connect:async()=>db}};
}

test('ephemeral reconcile failure is terminalized under the held fence and coalesced by kind/id',async()=>{
 const {calls,pool}=fakePool();const result=await terminalizeEphemeralRequestFailure(pool as any,lease,'71','rebuild',Error('REBUILD_PROVIDER_DISAGREEMENT'));
 assert.deepEqual(result,{terminal:true,requestPending:false,errorCode:'REBUILD_PROVIDER_DISAGREEMENT',terminalizedCount:2});
 const update=calls.find(c=>c.sql?.startsWith('UPDATE indexer_requests'));assert.ok(update);
 assert.match(update.sql,/claimed_fence=\$2,done_at=now\(\),error=\$3/);assert.match(update.sql,/kind=\$4 AND id<=\$1/);
 assert.deepEqual(update.args,['71','9','REBUILD_PROVIDER_DISAGREEMENT','rebuild']);
 assert.ok(calls.some(c=>c.sql?.includes('alder_lease_assert')));
});

test('lease loss leaves the durable request pending for a valid successor',async()=>{
 const {calls,pool}=fakePool({leaseLost:true});const result=await terminalizeEphemeralRequestFailure(pool as any,lease,'72','resync',Error('LEASE_LOST'));
 assert.equal(result.terminal,false);assert.equal(result.leaseLost,true);assert.equal(result.requestPending,true);
 assert.equal(calls.some(c=>c.sql?.startsWith('UPDATE indexer_requests')),false);
});

test('terminal-write failure never disguises a pending request as terminal',async()=>{
 const {pool}=fakePool({leaseLost:true});const result=await terminalizeEphemeralRequestFailure(pool as any,lease,'73','rebuild',Error('REBUILD_FAILED'));
 assert.equal(result.terminal,false);assert.equal(result.requestPending,true);assert.equal(result.errorCode,'LEASE_LOST');
 const thrown=requestReconcileFailure(Error('REBUILD_FAILED'),'73',result);
 assert.equal((thrown as any).request_id,'73');assert.equal((thrown as any).statusCode,503);assert.equal((thrown as any).request_terminal,false);
});

test('zero-row terminalization remains explicitly pending',async()=>{
 const {pool}=fakePool({rowCount:0});const result=await terminalizeEphemeralRequestFailure(pool as any,lease,'75','resync',Error('RECONCILE_FAILED'));
 assert.equal(result.terminal,false);assert.equal(result.requestPending,true);assert.equal(result.errorCode,'REQUEST_NOT_TERMINALIZED');
 const thrown=requestReconcileFailure(Error('RECONCILE_FAILED'),'75',result);
 assert.equal((thrown as any).statusCode,503);assert.equal((thrown as any).request_pending,true);
});

test('ordinary reconcile errors expose request id and terminal durable state',()=>{
 const thrown=requestReconcileFailure(Error('SAFE_READ_FAILED'),'74',{terminal:true,requestPending:false,errorCode:'SAFE_READ_FAILED'});
 assert.equal((thrown as any).request_id,'74');assert.equal((thrown as any).statusCode,500);assert.equal((thrown as any).request_terminal,true);
});
