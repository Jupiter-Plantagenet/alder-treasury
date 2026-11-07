import {test} from 'node:test';import assert from 'node:assert/strict';
import {buildApp} from '../apps/api/app.ts';
import {scopedPool} from '../apps/api/database.ts';
test('scoped adapter uses an explicitly supplied physical pool rather than opening the ambient profile',async()=>{
 let closed=0;const raw:any={end:async()=>{closed++;}};await scopedPool(raw).end();assert.equal(closed,1);
});
test('explicit trusted constructor pools isolate ordinary tests without bypassing any route readiness gate',async()=>{
 let closed=0;
 const pool:any={connect:async()=>{throw Error('TEST_PREREQUISITE_UNAVAILABLE');},query:async()=>{throw Error('TEST_PREREQUISITE_UNAVAILABLE');},end:async()=>{closed++;}};
 let machineAccess=0;const indexerPool:any={query:async()=>{machineAccess++;throw Error('MACHINE_POOL_FORBIDDEN');},end:async()=>{machineAccess++;}};
 const app=await buildApp({pool,indexerPool});
 try{await assert.rejects(async()=>{await app.ready();},/PAYABLE_SCHEMA_REQUIRED/);}finally{await app.close();}
 assert.equal(closed,1,'only the application pool is owned');assert.equal(machineAccess,0,'the ignored legacy indexerPool must never be opened or closed by the API');
});

