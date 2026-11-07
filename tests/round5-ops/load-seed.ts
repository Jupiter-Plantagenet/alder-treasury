// O5 LOAD seeding on the ISOLATED stack only: bring workspace payables to 10,000 through the REAL API (preparer creates,
// all validation/RLS/idempotency/domain-lock paths exercised). Exact amounts are recorded for the post-run accounting check.
import fs from 'node:fs';import * as L from './o5-lib.ts';
const OUT='evidence/round5-ops/load';fs.mkdirSync(OUT,{recursive:true});
const TARGET=Number(process.env.O5_TARGET||10000),CONC=Number(process.env.O5_CONC||6);
const s=await L.sessions();const t0=Date.now();
const have=(await L.q('SELECT count(*)::int n FROM payables WHERE workspace_id=$1',[L.WS]))[0].n;
const contacts:string[]=[];for(let i=0;i<100;i++){const c=await L.contact(s,`O5-LOAD contact ${i}`);contacts.push(c.id);}
const need=Math.max(0,TARGET-have);let next=0,done=0,errors=0;const lat:number[]=[];const ledger=fs.createWriteStream(`${OUT}/seed-ledger.ndjson`);
const rnd=()=>{const big=BigInt(Math.floor(Math.random()*1e15))*BigInt(1+Math.floor(Math.random()*1000))+1n;return big.toString();};
async function worker(){while(true){const i=next++;if(i>=need)return;const units=rnd();const ref=`O5-LOAD-${L.RUN}-${i}`;const t=performance.now();
 const r=await s.J.post('/payables',{contact_id:contacts[i%contacts.length],external_reference:ref,amount_units:units,attachment_ids:[]});lat.push(performance.now()-t);
 if(r.status!==201){errors++;if(errors<5)console.log('seed error',r.status,JSON.stringify(r.body).slice(0,200));}else ledger.write(JSON.stringify({id:r.body.id,ref,units})+'\n');done++;if(done%1000===0)console.log(`seeded ${done}/${need} in ${((Date.now()-t0)/1000).toFixed(0)}s`);}}
await Promise.all(Array.from({length:CONC},worker));ledger.end();
lat.sort((a,b)=>a-b);const p=(q:number)=>lat[Math.min(lat.length-1,Math.floor(q*lat.length))];
const after=(await L.q('SELECT count(*)::int n FROM payables WHERE workspace_id=$1',[L.WS]))[0].n;
const summary={run:L.RUN,before:have,created:done,errors,after,contacts:contacts.length,seconds:(Date.now()-t0)/1000,createLatencyMs:{p50:p(.5),p95:p(.95),p99:p(.99)},concurrency:CONC};
fs.writeFileSync(`${OUT}/seed-summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));await L.db.end();process.exit(0);
