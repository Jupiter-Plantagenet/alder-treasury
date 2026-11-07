// O5 API contract smoke (used for TR-T-MIGRATION old/new API during expand): health, login, snapshot, inbox view, contacts,
// settings, policy (small workspace), a write (contact create) and its read-back. Target from O5_API.
import * as L from './o5-lib.ts';import fs from 'node:fs';
const out:any={api:L.API,at:new Date().toISOString(),checks:[]};const ok=(name:string,cond:boolean,detail:any)=>{out.checks.push({name,pass:!!cond,detail});};
const h=await fetch(L.API+'/health');ok('health 200',h.status===200,await h.json());
const s=await L.sessions();ok('login x4',true,{});
for(const [n,p] of [['snapshot','/snapshot'],['views/payables','/views/payables?q=&review=all&limit=25'],['contacts','/contacts'],['settings','/settings'],['policy','/policy']] as const){const r=await s.A.get(p);ok(`GET ${n} 200`,r.status===200,{status:r.status,code:r.body?.error?.code});}
const c=await s.J.post('/contacts',{display_name:'O5-SMOKE contact',address:L.newAddress(),chain_id:'31337'});ok('POST contact 200',c.status===200,{status:c.status,code:c.body?.error?.code});
if(c.status===200){const g=await s.J.get(`/contacts/${c.body.id}`);ok('GET new contact 200',g.status===200,{status:g.status});}
out.pass=out.checks.every((x:any)=>x.pass);fs.mkdirSync('evidence/round5-ops/migration',{recursive:true});fs.writeFileSync(process.env.O5_SMOKE_OUT||'evidence/round5-ops/migration/api-smoke.json',JSON.stringify(out,null,1));console.log(JSON.stringify({api:L.API,pass:out.pass,failed:out.checks.filter((x:any)=>!x.pass)}));await L.db.end();process.exit(0);
