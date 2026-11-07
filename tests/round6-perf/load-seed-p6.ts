// O5 LOAD seeding on the ISOLATED stack only: bring workspace payables to 10,000 through the REAL API (preparer creates,
// all validation/RLS/idempotency/domain-lock paths exercised). Exact amounts are recorded for the post-run accounting check.
import fs from 'node:fs';import * as L from '../round5-ops/o5-lib.ts';
import {p6OutputPath} from './p6-output.ts';
const OUT=p6OutputPath('load','.local/scratch-r6/load');fs.mkdirSync(OUT,{recursive:true});
const ledgerPath=p6OutputPath('load/seed-ledger.ndjson','.local/scratch-r6/load/seed-ledger.ndjson');
const summaryPath=p6OutputPath('load/seed-summary.json','.local/scratch-r6/load/seed-summary.json');
if(process.env.P6_RUN_ID&&(fs.existsSync(ledgerPath)||fs.existsSync(summaryPath)))throw new Error('P6_SEED_OUTPUT_ALREADY_EXISTS_USE_NEW_RUN_ID');
const TARGET=Number(process.env.O5_TARGET||10000),CONC=Number(process.env.O5_CONC||6);
const s=await L.sessions();const t0=Date.now();
const have=(await L.q('SELECT count(*)::int n FROM payables WHERE workspace_id=$1',[L.WS]))[0].n;
const baseline=(await L.q('SELECT id,amount_units::text AS units FROM payables WHERE workspace_id=$1 ORDER BY id LIMIT $2',[L.WS,TARGET])) as {id:string,units:string}[];
const contacts:string[]=[];for(let i=0;i<100;i++){const c=await L.contact(s,`P6-LOAD contact ${i}`);contacts.push(c.id);}
const need=Math.max(0,TARGET-have);let next=0,done=0,errors=0;const lat:number[]=[];const ledger=fs.createWriteStream(ledgerPath,{flags:'wx'});
for(const row of baseline)ledger.write(JSON.stringify({id:row.id,units:row.units,baseline:true})+'\n');
const rnd=()=>{const big=BigInt(Math.floor(Math.random()*1e15))*BigInt(1+Math.floor(Math.random()*1000))+1n;return big.toString();};
async function worker(){while(true){const i=next++;if(i>=need)return;const units=rnd();const ref=`P6-LOAD-${L.RUN}-${i}`;const t=performance.now();
 const r=await s.J.post('/payables',{contact_id:contacts[i%contacts.length],external_reference:ref,amount_units:units,attachment_ids:[]});lat.push(performance.now()-t);
 if(r.status!==201){errors++;if(errors<5)console.log('seed error',r.status,JSON.stringify(r.body).slice(0,200));}else ledger.write(JSON.stringify({id:r.body.id,ref,units})+'\n');done++;if(done%1000===0)console.log(`seeded ${done}/${need} in ${((Date.now()-t0)/1000).toFixed(0)}s`);}}
await Promise.all(Array.from({length:CONC},worker));
await new Promise<void>((resolve,reject)=>{ledger.once('error',reject);ledger.end(resolve);});
lat.sort((a,b)=>a-b);const p=(q:number)=>lat.length?lat[Math.min(lat.length-1,Math.floor(q*lat.length))]:null;
const after=(await L.q('SELECT count(*)::int n FROM payables WHERE workspace_id=$1',[L.WS]))[0].n;
const ledgerRows=baseline.length+done;
const summary={run:L.RUN,target:TARGET,before:have,baselineLedgerRows:baseline.length,ledgerRows,created:done,errors,after,contacts:contacts.length,seconds:(Date.now()-t0)/1000,createLatencyMs:{p50:p(.5),p95:p(.95),p99:p(.99)},concurrency:CONC};
fs.writeFileSync(summaryPath,JSON.stringify(summary,null,2),{flag:'wx'});console.log(JSON.stringify(summary));await L.db.end();
if(errors>0||ledgerRows<TARGET||after<TARGET)process.exitCode=1;
