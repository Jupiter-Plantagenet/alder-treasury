// Route regressions with a transaction/lock model; real-PG execution remains a separate release proof.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {createMutate} from '../apps/api/mutate.ts';

const root=path.resolve('.local/codex-round6/export-route-tests-'+randomUUID());
process.env.ALDER_EXPORT_DIR=root;
process.env.ALDER_EXPORT_WS_LIVE='2';
process.env.ALDER_EXPORT_WS_BYTES='50000';
const {registerExports}=await import('../apps/api/export.ts');
const ws='11111111-1111-4111-8111-111111111111';

function fixture(large=false,failMutationEvent=false,commitAckLost=false){
 const ev:any[]=[];
 const locks=new Map<string,Promise<void>>();
 const pool={connect:async()=>{
  const releases:(()=>void)[]=[];const inserted:any[]=[];let commitWasDurable=false;
  return {release(){},async query(sql:string,args:any[]=[]):Promise<{rows:any[]}>{
   await new Promise(resolve=>setTimeout(resolve,1));
   if(sql.includes('pg_advisory_xact_lock')){
    const key=String(args[0]);const previous=locks.get(key)??Promise.resolve();
    let unlock!:()=>void;const current=new Promise<void>(r=>{unlock=r;});locks.set(key,current);
    await previous;releases.push(()=>{unlock();if(locks.get(key)===current)locks.delete(key);});
   }
   if(sql==='BEGIN'){inserted.length=0;commitWasDurable=false;}
   if(sql==='COMMIT'||sql==='ROLLBACK'){if(sql==='COMMIT'&&commitAckLost)commitWasDurable=true;if(sql==='ROLLBACK'&&!commitWasDurable&&inserted.length){for(let i=ev.length-1;i>=0;i--)if(inserted.includes(ev[i]))ev.splice(i,1);}inserted.length=0;for(const release of releases.splice(0))release();if(sql==='COMMIT'&&commitAckLost)throw new Error('INJECTED_COMMIT_ACK_LOSS');}
   if(sql.startsWith('SELECT id,kind,data,at,actor_id FROM events'))return {rows:ev.filter(e=>!args[1]||e.data.export_id===args[1]).map(e=>({...e}))};
   if(sql.startsWith('SELECT 1 FROM events WHERE workspace_id=$1 AND kind=\'evidence-export-created\''))return {rows:ev.filter(e=>e.kind==='evidence-export-created'&&e.data.export_id===args[1]).map(()=>({one:1}))};
   if(failMutationEvent&&sql.startsWith('INSERT INTO events')&&args[2]==='evidence-export')throw new Error('INJECTED_MUTATION_EVENT_FAILURE');
   if(sql.startsWith('INSERT INTO events')){const e={id:String(ev.length+1),actor_id:args[1],kind:args[2],data:args[3],at:new Date()};ev.push(e);inserted.push(e);}
   if(sql.startsWith('SELECT p.*,i.external_reference'))return {rows:large?[{display_reference:'x'.repeat(60000)}]:[]};
   return {rows:[]};
  }};
 }};
 const app=Fastify();
 app.addHook('preHandler',async(req)=>{Object.assign(req,{roles:['accountant'],identity:{user_id:'actor'}});});
 app.setErrorHandler((e:any,_req,reply)=>reply.code(e.statusCode??500).send({error:{code:e.message}}));
 registerExports(app,createMutate(pool),pool);
 const post=()=>app.inject({method:'POST',url:`/api/v1/workspaces/${ws}/evidence/exports`,headers:{'idempotency-key':randomUUID()},payload:{scope:'private'}});
 return {app,ev,post};
}

test('a newly generated packet cannot cross the retained-byte quota',async()=>{
 const f=fixture(true);try{const r=await f.post();assert.equal(r.statusCode,429);assert.equal(r.json().error.code,'EXPORT_QUOTA');assert.equal(f.ev.filter(e=>e.kind==='evidence-export-created').length,0);}finally{await f.app.close();}
});

test('different idempotency keys serialize the workspace export quota',async()=>{
 const f=fixture();try{await f.app.ready();const results=await Promise.all([f.post(),f.post(),f.post()]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,200,429]);assert.equal(f.ev.filter(e=>e.kind==='evidence-export-created').length,2);}finally{await f.app.close();}
});

test('transaction failure after artifact writes rolls back audit and removes only the uncommitted export directory',async()=>{
 const f=fixture(false,true),workspaceDir=path.join(root,ws),before=fs.existsSync(workspaceDir)?fs.readdirSync(workspaceDir).sort():[];try{const r=await f.post();assert.equal(r.statusCode,500);assert.equal(f.ev.filter(e=>e.kind==='evidence-export-created').length,0);assert.deepEqual(fs.existsSync(workspaceDir)?fs.readdirSync(workspaceDir).sort():[],before);}finally{await f.app.close();}
});

test('ambiguous commit acknowledgement preserves artifacts when the creation event is committed',async()=>{
 const f=fixture(false,false,true),workspaceDir=path.join(root,ws),before=fs.existsSync(workspaceDir)?fs.readdirSync(workspaceDir).sort():[];try{const r=await f.post();assert.equal(r.statusCode,500);assert.equal(f.ev.filter(e=>e.kind==='evidence-export-created').length,1);assert.equal(fs.readdirSync(workspaceDir).length,before.length+1);}finally{await f.app.close();}
});

test('artifact requests purge expired bytes before serving and preserve the purge event',async()=>{
 const f=fixture();try{
  const created=await f.post();assert.equal(created.statusCode,200);const id=created.json().id;
  f.ev.find(e=>e.kind==='evidence-export-created').data.retention_until=new Date(0).toISOString();
  const r=await f.app.inject({method:'GET',url:`/api/v1/workspaces/${ws}/evidence/exports/${id}/artifacts/payables.json`});
  assert.equal(r.statusCode,410);assert.equal(r.json().error.code,'EXPORT_EXPIRED');
  assert(f.ev.some(e=>e.kind==='evidence-export-purged'&&e.data.export_id===id));
  assert.equal(fs.existsSync(path.join(root,ws,id)),false);
 }finally{await f.app.close();}
});

after(()=>{fs.rmSync(root,{recursive:true,force:true});});
