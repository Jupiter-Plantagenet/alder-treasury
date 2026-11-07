// @ts-nocheck -- Round 6 (perf/UI fork) private measurement harness. DISPOSABLE database only: 127.0.0.1:15544
// (container alder-r6ui-pg, restored from a schema-only dump; no live rows). Starts the CURRENT buildApp() on 9203 and the
// PRE-ROUND-6 buildApp() (evidence/round6-perf/pre-round6 copy) on 9204, both via constructor injection with the
// non-superuser, non-BYPASSRLS roles. RPC: 127.0.0.1:18547 (allowlisted, chain reads only; may be absent -> chainError).
// Usage: node --import tsx tests/round6-perf/ui-harness.ts seed|measure|serve   (password file: .local/scratch-r6/r6-ui/pw.txt)
process.env.ALDER_RPC_URL ||= 'http://127.0.0.1:18547';
import pg from 'pg';import fs from 'node:fs';import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
const DIR='.local/scratch-r6/r6-ui';const PW=fs.readFileSync(DIR+'/pw.txt','utf8').trim();const PORT=15544;
const url=(role:string,db='alder')=>`postgresql://${role}:${encodeURIComponent(PW)}@127.0.0.1:${PORT}/${db}`;
export const WS='00000000-0000-4000-8000-0000000006e1';const ORIGIN=process.env.R6U_ORIGIN||'https://127.0.0.1:5103';
const people=[['r6u-preparer','R6U Preparer',['preparer']],['r6u-reviewer','R6U Reviewer',['reviewer']],['r6u-owner','R6U Owner',['owner']],['r6u-accountant','R6U Accountant',['accountant']],['r6u-admin','R6U Admin',['admin']]];
const accountsFile=DIR+'/accounts.json';
async function provision(){const password=randomBytes(18).toString('base64url');const db=new pg.Client({connectionString:url('postgres')});await db.connect();
 try{await db.query('BEGIN');for(const [h,name,roles] of people){const salt=randomBytes(16).toString('hex');const u=(await db.query('INSERT INTO users(id,email,password_hash,salt,name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,salt=EXCLUDED.salt RETURNING id',[randomUUID(),h+'@alder.local',scryptSync(password,salt,64).toString('hex'),salt,name])).rows[0];await db.query('INSERT INTO memberships(workspace_id,user_id,roles) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[WS,u.id,roles]);}
  await db.query("INSERT INTO workspace_profiles(workspace_id,display_name) VALUES($1,'R6U perf workspace') ON CONFLICT DO NOTHING",[WS]);await db.query('COMMIT');}finally{await db.end();}
 fs.writeFileSync(accountsFile,JSON.stringify({password}));}
export async function start(port:number,src='../..'){const {buildApp}=await import(src+'/apps/api/app.ts');const {scopedPool}=await import(src+'/apps/api/database.ts');
 const app=await buildApp({pool:scopedPool(new pg.Pool({connectionString:url('alder_app'),max:8})),indexerPool:new pg.Pool({connectionString:url('alder_indexer'),max:2})});await app.listen({host:'127.0.0.1',port});return app;}
// The pre-round-6 snapshot (9204) predates the parallel agent's HTTPS origin change.
const originFor=(base:string)=>base.endsWith(':9204')?'http://127.0.0.1:5103':ORIGIN;
export class S{cookie='';csrf='';constructor(public base:string){}
 static async login(base:string,h:string){const s=new S(base);const pw=JSON.parse(fs.readFileSync(accountsFile,'utf8')).password;const r=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:originFor(base)},body:JSON.stringify({email:h+'@alder.local',password:pw})});if(r.status!==200)throw Error('login '+r.status+' '+await r.text());s.cookie=(r.headers.get('set-cookie')||'').split(';')[0];s.csrf=(await r.json()).csrf;return s;}
 async req(method:string,path:string,body?:any,ifMatch?:any){const h:any={cookie:this.cookie,origin:originFor(this.base)};if(method!=='GET'){h['x-csrf-token']=this.csrf;h['idempotency-key']=randomUUID();if(body!==undefined)h['content-type']='application/json';}if(ifMatch!==undefined)h['if-match']=`"${ifMatch}"`;
  const t=performance.now();const r=await fetch(this.base+(path.startsWith('/api')?path:`/api/v1/workspaces/${WS}${path}`),{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let j:any=null;try{j=JSON.parse(text);}catch{}return {status:r.status,body:j,bytes:Buffer.byteLength(text),ms:performance.now()-t,headers:r.headers};}
 get(p:string){return this.req('GET',p);}post(p:string,b:any,m?:any){return this.req('POST',p,b,m);}}
const addr=()=>'0x'+randomBytes(20).toString('hex');
async function pool<T>(n:number,items:T[],fn:(x:T,i:number)=>Promise<void>){let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const k=i++;await fn(items[k],k);}}));}
async function seed(N:number){await provision();const app=await start(9203);const base='http://127.0.0.1:9203';
 try{const J=await S.login(base,'r6u-preparer'),P=await S.login(base,'r6u-reviewer');
  const pol=await P.post('/policies',{conditions:{mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,rules:[{id:'ALL',label:'Reference token payouts up to 50,000 ALDR',asset:{chain_id:'31337',address:JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8')).token,profile:'ALDER_FIXED_SUPPLY_6_DECIMALS'},min_units:'1',max_units:'50000000000'}]},reason:'R6U perf fixture policy'});
  if(pol.status!==200)console.log('policy',pol.status,JSON.stringify(pol.body).slice(0,300));
  const contacts:string[]=[];for(let i=0;i<40;i++){const c=await J.post('/contacts',{display_name:`R6U contact ${String(i).padStart(3,'0')}`,address:addr(),chain_id:'31337'});if(c.status!==200)throw Error('contact '+JSON.stringify(c.body));if(i<36){const v=await P.post(`/contacts/${c.body.id}/verifications`,{destination_revision:1,second_channel_reference:'R6U simulated callback',decision:'approve'},1);if(v.status!==200)throw Error('verify '+JSON.stringify(v.body));}contacts.push(c.body.id);}
  const pr=(await P.get('/policy')).body.policy.revision;const t0=Date.now();let errs=0;const created:any[]=[];
  await pool(8,Array.from({length:N},(_,i)=>i),async i=>{const p=await J.post('/payables',{contact_id:contacts[i%contacts.length],external_reference:`R6U-${String(i).padStart(6,'0')}`,amount_units:String(1000000+(i*7919)%900000000),attachment_ids:[]});if(p.status!==201){errs++;return;}created.push(p.body);});
  console.log('payables',created.length,'errors',errs,'s',(Date.now()-t0)/1000);
  const toReview=created.filter(p=>p.verified).slice(0,600);let rv=0;await pool(6,toReview,async p=>{const r=await P.post(`/payables/${p.id}/review`,{revision:p.revision,policy_revision:pr,reason:'R6U fixture review'},p.revision);if(r.status===200)rv++;});console.log('reviewed',rv);
 }finally{await app.close();}}
async function measure(which:string){const file=DIR+'/measure.json';const out:any=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};out.db='disposable 15544 (schema-only restore + synthetic R6U workspace)';
 const now=which==='now'?await start(9203):null,old=which==='pre'?await start(9204,'../../evidence/round6-perf/pre-round6'):null;
 try{for(const [label,base] of (which==='now'?[['round6','http://127.0.0.1:9203']]:[['pre_round6','http://127.0.0.1:9204']])){out[label+'_at']=new Date().toISOString();const O=await S.login(base,'r6u-owner');const lat:number[]=[];let r:any;for(let i=0;i<20;i++){r=await O.get('/snapshot');lat.push(r.ms);}lat.sort((a,b)=>a-b);
   const pol=await O.get('/policy');const inbox=await O.get('/views/payables?q=&review=all&limit=25');
   out[label]={snapshot_status:r.status,snapshot_bytes:r.bytes,snapshot_ms_p50:+lat[10].toFixed(1),snapshot_ms_p95:+lat[18].toFixed(1),payables_in_snapshot:r.body?.payables?.length,limits:r.body?.limits,summary:r.body?.summary,policy_status:pol.status,policy_code:pol.body?.error?.code??null,policy_bytes:pol.bytes,impact_rows:pol.body?.impact?.length,impact_total:pol.body?.impact_total,inbox_status:inbox.status,inbox_code:inbox.body?.error?.code??null,inbox_total:inbox.body?.total_count,inbox_ms:+inbox.ms.toFixed(1)};}
  fs.writeFileSync(file,JSON.stringify(out,null,1));console.log(JSON.stringify(out,null,1).slice(0,4000));
 }finally{await now?.close();await old?.close();}}
const cmd=process.argv[2];
if(cmd==='seed')await seed(Number(process.argv[3]||10000));
else if(cmd==='measure')await measure(process.argv[3]||'now');
else if(cmd==='serve'){await start(9203);console.log('serving 9203');}
else if(cmd==='schema'){const {verifyPayableSchema}=await import('../../apps/api/payable-schema.ts');const {scopedPool}=await import('../../apps/api/database.ts');const p=scopedPool(new pg.Pool({connectionString:url('alder_app'),max:2}));try{await verifyPayableSchema(p);console.log('schema ok');}catch(e){console.log('ERR',e.message,e.code??'',String(e.detail??'').slice(0,200));}await p.end();}
else if(cmd==='lat'){const app=await start(9203);try{const O=await S.login('http://127.0.0.1:9203','r6u-owner');const res:any={note:'chain RPC absent; chain failure cached via ALDER_SNAPSHOT_CHAIN_TTL_MS so DB/API cost is isolated',at:new Date().toISOString()};
 const paths:any={snapshot:'/snapshot',inbox_open:'/views/payables?q=&review=all&limit=25',reads_ready:'/reads/payables?view=ready&limit=100',reads_all:'/reads/payables?view=all&limit=100',reads_search:'/reads/payables?view=all&q=r6u-0099&limit=100',policy:'/policy',operations:'/reads/operations?limit=50',contacts:'/reads/contacts?limit=100'};
 for(const [k,p] of Object.entries(paths)){const lat:number[]=[];let r:any;for(let i=0;i<30;i++){r=await O.get(p as string);if(r.status!==200)throw Error(k+' '+r.status+' '+JSON.stringify(r.body).slice(0,200));lat.push(r.ms);}lat.sort((a,b)=>a-b);res[k]={status:r.status,bytes:r.bytes,p50:+lat[15].toFixed(1),p95:+lat[28].toFixed(1),max:+lat[29].toFixed(1)};}
 // inbox cursor walk across the stored prefix boundary into the live continuation
 let r=await O.get('/views/payables?q=&review=all&limit=100');let pages=1,seen=new Set(r.body.items.map((x:any)=>x.id)),dup=0,cons=new Set([r.body.consistency]);while(r.body.next_cursor&&pages<12){r=await O.get('/views/payables?q=&review=all&limit=100&cursor='+encodeURIComponent(r.body.next_cursor));pages++;for(const x of r.body.items){if(seen.has(x.id))dup++;seen.add(x.id);}cons.add(r.body.consistency);}
 res.inbox_walk={pages,unique:seen.size,duplicates:dup,consistency:[...cons],last_status:r.status};
 let c=await O.get('/reads/payables?view=all&limit=200'),all=new Set(c.body.items.map((x:any)=>x.id)),n=1;while(c.body.next_cursor){c=await O.get('/reads/payables?view=all&limit=200&cursor='+encodeURIComponent(c.body.next_cursor));n++;for(const x of c.body.items)all.add(x.id);}res.reads_walk={pages:n,unique:all.size,total:c.body.total_count};
 const t=await O.get('/reads/payables?view=all&limit=200&cursor=abc.def');const bad=await O.get('/reads/payables?view=nope');res.tamper={malformed:t.status,bad_view:bad.status};
 fs.writeFileSync(DIR+'/latency.json',JSON.stringify(res,null,1));console.log(JSON.stringify(res,null,1));}finally{await app.close();}}
else if(cmd==='mix'){// open-loop smoke of the reference MIX at the reference RATE (20 r/s + 5 w/s) for DUR seconds; NOT the LOAD acceptance run
 const DUR=Number(process.argv[3]||60);const app=await start(9203);const base='http://127.0.0.1:9203';
 try{const roles=['r6u-preparer','r6u-reviewer','r6u-owner','r6u-accountant'];const ss:any={};for(const r of roles)ss[r]=await Promise.all([0,1,2].map(()=>S.login(base,r)));
  const pick=(r:string)=>ss[r][Math.floor(Math.random()*3)];const any=()=>pick(roles[Math.floor(Math.random()*4)]);const recs:any[]=[];let inflight=0,maxInflight=0,k=0;
  const contacts=(await pick('r6u-owner').get('/reads/contacts?limit=200')).body.items.filter((c:any)=>c.verification_state==='approve').map((c:any)=>c.id);
  const pending=(await pick('r6u-owner').get('/reads/payables?view=review&limit=200')).body.items.filter((p:any)=>p.verified);
  const reads:[number,string][]=[[.35,'/snapshot'],[.2,'/views/payables?q=&review=all&limit=25'],[.15,'/reads/contacts?limit=100'],[.1,'/policy'],[.1,'/settings'],[.05,'/api/v1/auth/session'],[.05,'/reads/payables?view=ready&limit=100']];
  const one=async(kind:string)=>{inflight++;maxInflight=Math.max(maxInflight,inflight);const t=performance.now();let r:any;let label='';
   try{if(kind==='read'){let x=Math.random(),p='';for(const [w,q] of reads){if((x-=w)<=0){p=q;break;}}p||=reads[0][1];label='GET '+p.split('?')[0];r=await any().get(p);}
    else{const x=Math.random();if(x<.6){label='POST payables';r=await pick('r6u-preparer').post('/payables',{contact_id:contacts[k%contacts.length],external_reference:`R6U-MIX-${Date.now().toString(36)}-${k++}`,amount_units:String(1000000+k),attachment_ids:[]});}
     else if(x<.8){label='POST contacts';r=await pick('r6u-preparer').post('/contacts',{display_name:`R6U mix contact ${Date.now().toString(36)}-${k++}`,address:addr(),chain_id:'31337'});}
     else{const p=pending.pop();label='POST review';if(!p){r={status:0};}else{const pr=1;r=await pick('r6u-reviewer').post(`/payables/${p.id}/review`,{revision:p.revision,policy_revision:pr,reason:'R6U mix review'},p.revision);}}}}
   catch(e:any){r={status:-1,err:String(e.message).slice(0,80)};}
   inflight--;recs.push({kind,label,status:r.status,ms:performance.now()-t,code:r.body?.error?.code});};
  const t0=Date.now();const timers:Promise<void>[]=[];let n=0;
  while(Date.now()-t0<DUR*1000){const due=Math.floor((Date.now()-t0)/1000*25);while(n<due){n++;timers.push(one(n%5===0?'write':'read'));}await new Promise(r=>setTimeout(r,10));}
  await Promise.all(timers);const pct=(a:number[],q:number)=>{const s=[...a].sort((x,y)=>x-y);return +(s[Math.min(s.length-1,Math.floor(q*s.length))]??0).toFixed(1);};
  const sum:any={duration_s:DUR,requests:recs.length,max_inflight:maxInflight,at:new Date().toISOString(),note:'private disposable DB, 12 sessions, chain RPC absent (cached failure); smoke of mix, not TR-T-LOAD acceptance'};
  for(const kind of ['read','write']){const r=recs.filter(x=>x.kind===kind&&x.status!==0);const ok=r.filter(x=>x.status>=200&&x.status<300);sum[kind]={n:r.length,errors:r.length-ok.length,codes:Object.fromEntries([...new Set(r.filter(x=>!(x.status>=200&&x.status<300)).map(x=>x.status+':'+x.code))].map(c=>[c,r.filter(x=>x.status+':'+x.code===c).length])),p50:pct(ok.map(x=>x.ms),.5),p95:pct(ok.map(x=>x.ms),.95),p99:pct(ok.map(x=>x.ms),.99)};}
  sum.by_route=Object.fromEntries([...new Set(recs.map(x=>x.label))].map(l=>{const r=recs.filter(x=>x.label===l&&x.status>=200&&x.status<300);return [l,{n:r.length,p95:pct(r.map(x=>x.ms),.95)}];}));
  const {readinessCacheStats}=await import('../../apps/api/eligibility.ts');sum.readiness_index=readinessCacheStats;sum.backpressure=(app as any).backpressure.stats();sum.rss_mb=Math.round(process.memoryUsage().rss/1048576);
  fs.writeFileSync(DIR+'/mix-'+DUR+'s.json',JSON.stringify(sum,null,1));console.log(JSON.stringify(sum,null,1));}finally{await app.close();}}
