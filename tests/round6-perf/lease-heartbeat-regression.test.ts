import assert from 'node:assert/strict';
import test from 'node:test';
import {withReadPhaseLeaseHeartbeat,type Lease} from '../../services/lease.ts';

const lease:Lease={name:'indexer',holder:'test-holder',fence:'9',token:'test-token'};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('read phase longer than the lease TTL is renewed and then commits only after heartbeat joins',async()=>{
  let renewals=0,writeStarted=false;
  const pool={query:async(_sql:string)=>({rows:[{ok:(()=>{renewals++;return true;})()}]})};
  const result=await withReadPhaseLeaseHeartbeat(pool,lease,async()=>{
    await sleep(1100); // exceeds the short 1s test TTL
    return 'read-snapshot';
  },async(snapshot)=>{
    writeStarted=true;
    return snapshot;
  },{intervalMs:100,ttlSeconds:1});
  assert.equal(result,'read-snapshot');
  assert.ok(renewals>=2,`expected periodic lease renewal, observed ${renewals}`);
  assert.equal(writeStarted,true);
});

test('a lost heartbeat aborts before projection/write phase',async()=>{
  let renewals=0,projectionWrites=0;
  const pool={query:async(_sql:string)=>({rows:[{ok:(()=>{renewals++;return false;})()}]})};
  await assert.rejects(withReadPhaseLeaseHeartbeat(pool,lease,async()=>{
    await sleep(30);
    return 'read-snapshot';
  },async()=>{
    projectionWrites++;
    return 'committed';
  },{intervalMs:5,ttlSeconds:1}),{message:'LEASE_LOST'});
  assert.equal(renewals,1);
  assert.equal(projectionWrites,0);
});
