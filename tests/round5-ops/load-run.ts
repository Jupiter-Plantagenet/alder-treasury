// O5 TR-T-LOAD runner (isolated stack only: API 9103 -> scratch PG 15543 -> proxy 18547 -> Anvil 18548).
// Open-loop schedule: READ_RPS GETs + WRITE_RPS mutations for DURATION s over SESSIONS logged-in sessions
// (logins spread over 127.0.0.1..127.0.0.5 so the real per-IP login throttle is not tripped), SSE subscribers measuring
// DB-commit -> event-visible latency, a cross-workspace outsider probe, and a "batch lane" running real 100-item payout cycles.
// Every request is recorded raw (NDJSON). Nothing is excluded except the declared chain/wallet-bound lane calls, which are
// reported separately. Simulated users (automated), not humans.
import http from 'node:http';import fs from 'node:fs';import {randomUUID} from 'node:crypto';import * as L from './o5-lib.ts';
const DURATION=Number(process.env.O5_DURATION||1800),READ_RPS=Number(process.env.O5_READ_RPS||20),WRITE_RPS=Number(process.env.O5_WRITE_RPS||5),SESSIONS=Number(process.env.O5_SESSIONS||100),SSE_N=Number(process.env.O5_SSE||10);
const BATCH_AT=(process.env.O5_BATCH_AT||'480,1080').split(',').map(Number).filter(x=>x<DURATION);
const OUT=process.env.O5_OUT||'evidence/round5-ops/load/run-'+new Date().toISOString().replace(/[:.]/g,'').slice(0,15);fs.mkdirSync(OUT,{recursive:true});
const raw=fs.createWriteStream(`${OUT}/raw.ndjson`);const WS=L.WS;const HOST='127.0.0.1',PORT=9103,ORIGIN='http://127.0.0.1:5103';
const outsiders=JSON.parse(fs.readFileSync('.local/round4-outsiders.json','utf8'));
type Sess={who:string,cookie:string,csrf:string,agent:http.Agent,la:string,cursors:string[],role:string};
function call(s:{cookie?:string,csrf?:string,agent?:http.Agent,la?:string},method:string,path:string,body?:any,extra:any={}):Promise<{status:number,ms:number,bytes:number,body:any,headers:any}>{
 return new Promise(res=>{const t=performance.now();const data=body===undefined?undefined:Buffer.from(JSON.stringify(body));const headers:any={origin:ORIGIN,...extra};if(s.cookie)headers.cookie=s.cookie;if(method!=='GET'){if(s.csrf)headers['x-csrf-token']=s.csrf;headers['idempotency-key']=randomUUID();}if(data){headers['content-type']='application/json';headers['content-length']=data.length;}
  const r=http.request({host:HOST,port:PORT,method,path,headers,agent:s.agent,localAddress:s.la},resp=>{const chunks:Buffer[]=[];resp.on('data',c=>chunks.push(c));resp.on('end',()=>{const b=Buffer.concat(chunks);let j:any=null;try{j=JSON.parse(b.toString('utf8'));}catch{}res({status:resp.statusCode||0,ms:performance.now()-t,bytes:b.length,body:j,headers:resp.headers});});});
  r.on('error',e=>res({status:0,ms:performance.now()-t,bytes:0,body:{error:{code:'NETWORK_'+(e as any).code}},headers:{}}));r.setTimeout(30000,()=>r.destroy(Object.assign(new Error('timeout'),{code:'TIMEOUT'})));if(data)r.write(data);r.end();});}
const T0=Date.now();const rec=(cls:string,ep:string,r:{status:number,ms:number,bytes:number},extra:any={})=>raw.write(JSON.stringify({t:Date.now()-T0,cls,ep,st:r.status,ms:Math.round(r.ms*100)/100,bytes:r.bytes,...extra})+'\n');
async function login(email:string,pass:string,la:string,role:string):Promise<Sess>{const agent=new http.Agent({keepAlive:true,maxSockets:4,localAddress:la} as any);for(let i=0;i<5;i++){const r=await call({agent,la},'POST','/api/v1/auth/login',{email,password:pass});rec('auth','POST /auth/login',r);if(r.status===200)return {who:email,cookie:String((r.headers['set-cookie']||[''])[0]).split(';')[0],csrf:r.body.csrf,agent,la,cursors:[],role};await L.sleep(3000);}throw Error('login failed '+email);}
// ---- sessions ----
const mix:[string,string,number][]=[['jordan','preparer',40],['priya','reviewer',30],['owner','owner',15],['accountant','accountant',15]];
const sessions:Sess[]=[];let k=0;for(const [who,role,n] of mix)for(let i=0;i<Math.round(n*SESSIONS/100);i++){sessions.push(await login(`${who}@alder.local`,L.accounts.password,`127.0.0.${1+(k%8)}`,role));k++;}
const outs=await login('o1.round4@alder.local',outsiders.password,'127.0.0.9','outsider');
console.log(`sessions ${sessions.length} + outsider; logins ${((Date.now()-T0)/1000).toFixed(1)}s`);
const by=(role:string)=>sessions.filter(s=>s.role===role);const pick=<T>(a:T[])=>a[Math.floor(Math.random()*a.length)];
const contacts=(await L.q("SELECT id FROM contacts WHERE workspace_id=$1 AND display_name LIKE 'O5-LOAD contact %'",[WS])).map((r:any)=>r.id);
const seedIds=fs.readFileSync('evidence/round5-ops/load/seed-ledger.ndjson','utf8').trim().split('\n').map(l=>JSON.parse(l).id);
// GET /policy returns 422 IMPACT_TOO_LARGE above 1000 impacted payables (recorded as a load read); the harness takes the current revision from the DB.
const policyRev=(await L.q('SELECT max(revision)::int r FROM review_policy_revisions WHERE workspace_id=$1',[WS]))[0].r;
const created:{id:string,units:string,ref:string,at:number}[]=[];const ledger=fs.createWriteStream(`${OUT}/write-ledger.ndjson`);
// ---- SSE subscribers: DB commit (write response) -> event visible ----
const writeDone=new Map<string,number>();const sseLat:number[]=[];const sseSeen=new Set<string>();let sseErrors=0;
for(let i=0;i<SSE_N;i++){const s=sessions[sessions.length-1-i];const open=()=>{const r=http.request({host:HOST,port:PORT,path:`/api/v1/workspaces/${WS}/events/stream`,headers:{cookie:s.cookie,origin:ORIGIN,accept:'text/event-stream'},localAddress:s.la},resp=>{if(resp.statusCode!==200){sseErrors++;return;}let buf='';resp.on('data',c=>{buf+=c;let idx;while((idx=buf.indexOf('\n\n'))>=0){const msg=buf.slice(0,idx);buf=buf.slice(idx+2);const dl=msg.split('\n').find(l=>l.startsWith('data:'));if(!dl)continue;try{const ev=JSON.parse(dl.slice(5));const id=ev?.data?.id;if(id&&writeDone.has(id)&&!sseSeen.has(id+':'+i)){sseSeen.add(id+':'+i);sseLat.push(Date.now()-writeDone.get(id)!);}}catch{}}});resp.on('end',()=>{if(Date.now()-T0<DURATION*1000)setTimeout(open,200);});});r.on('error',()=>{sseErrors++;});r.end();};open();}
// ---- read / write actions ----
async function doRead(){const roll=Math.random();
 if(roll<0.35){const s=pick(sessions);const r=await call(s,'GET',`/api/v1/workspaces/${WS}/snapshot`);rec('read','GET /snapshot',r);return;}
 if(roll<0.55){const s=pick([...by('preparer'),...by('reviewer')]);if(s.cursors.length&&Math.random()<0.9){const c=pick(s.cursors);const r=await call(s,'GET',`/api/v1/workspaces/${WS}/views/payables?q=&review=all&limit=25&cursor=${encodeURIComponent(c)}`);rec('read','GET /views/payables (cursor page)',r);if(r.status===410||r.status===404)s.cursors=[];if(r.status===200&&r.body?.next_cursor&&s.cursors.length<40)s.cursors.push(r.body.next_cursor);return;}
  const r=await call(s,'GET',`/api/v1/workspaces/${WS}/views/payables?q=&review=all&limit=25`);rec('read','GET /views/payables (open: new snapshot)',r,r.status>=400?{code:r.body?.error?.code}:{});if(r.status===200&&r.body?.next_cursor)s.cursors=[r.body.next_cursor];return;}
 if(roll<0.70){const s=pick(sessions);const r=await call(s,'GET',`/api/v1/workspaces/${WS}/contacts`);rec('read','GET /contacts',r);return;}
 if(roll<0.80){const s=pick(sessions);const r=await call(s,'GET',`/api/v1/workspaces/${WS}/policy`);rec('read','GET /policy',r);return;}
 if(roll<0.90){const s=pick(sessions);const r=await call(s,'GET',`/api/v1/workspaces/${WS}/settings`);rec('read','GET /settings',r);return;}
 if(roll<0.95){const s=pick(sessions);const r=await call(s,'GET','/api/v1/auth/session');rec('read','GET /auth/session',r);return;}
 {const s=pick(sessions);const r=await call(s,'GET',`/api/v1/workspaces/${WS}/payables/${pick(seedIds)}/attachments`);rec('read','GET /payables/:id/attachments',r);}}
async function doWrite(){const roll=Math.random();
 if(roll<0.6){const s=pick(by('preparer'));const units=String(1_000_000n+BigInt(Math.floor(Math.random()*9_000_000_000)));const ref=`O5-LOADW-${L.RUN}-${randomUUID().slice(0,8)}`;const r=await call(s,'POST',`/api/v1/workspaces/${WS}/payables`,{contact_id:pick(contacts),external_reference:ref,amount_units:units,attachment_ids:[]});rec('write','POST /payables',r,r.status>=300?{code:r.body?.error?.code}:{});if(r.status===201){writeDone.set(r.body.id,Date.now());created.push({id:r.body.id,units,ref,at:Date.now()});ledger.write(JSON.stringify({id:r.body.id,units,ref})+'\n');}return;}
 if(roll<0.8){const s=pick(by('preparer'));const r=await call(s,'POST',`/api/v1/workspaces/${WS}/contacts`,{display_name:`O5-LOADW contact ${randomUUID().slice(0,8)}`,address:L.newAddress(),chain_id:'31337'});rec('write','POST /contacts',r,r.status>=300?{code:r.body?.error?.code}:{});if(r.status===200)writeDone.set(r.body.id,Date.now());return;}
 {const cand=created.filter(c=>Date.now()-c.at>2000&&!(c as any).reviewed);if(!cand.length){return doWrite();}const c=pick(cand);(c as any).reviewed=true;const s=pick(by('reviewer'));const r=await call(s,'POST',`/api/v1/workspaces/${WS}/payables/${c.id}/review`,{revision:1,policy_revision:policyRev,reason:'O5 load review (simulated reviewer)'},{'if-match':'"1"'});rec('write','POST /payables/:id/review',r,r.status>=300?{code:r.body?.error?.code}:{});}}
async function probeOutsider(){const r=await call(outs,'GET',`/api/v1/workspaces/${WS}/snapshot`);rec('isolation','GET /snapshot (outsider)',r);const r2=await call(outs,'GET',`/api/v1/workspaces/${WS}/views/payables?limit=5`);rec('isolation','GET /views/payables (outsider)',r2);}
// ---- batch lane: real 100-item payout cycle (chain-bound calls recorded as class 'chain') ----
const lane:any[]=[];
async function batchLane(tag:string){const t=Date.now();try{const s=await L.sessions();const recips=Array.from({length:100},()=>L.newAddress());const ps:any[]=[];
 for(let i=0;i<100;i++){const c=await L.contact(s,`${tag} C${i}`,recips[i]);ps.push(await L.payable(s,c.id,`${tag}-P${i}`,String(1_000_000+i),true,policyRev));}
 const t1=Date.now();await L.allowanceCycle(s,ps.map(p=>p.id));const t2=Date.now();const fz=performance.now();const f=await L.freeze(s,ps.map(p=>p.id));const freezeMs=performance.now()-fz;rec('chain','POST /batches (freeze 100)',{status:200,ms:freezeMs,bytes:0});
 for(const i of [0,1]){const a=performance.now();const r=await L.sign(s,f.operationId,i);rec('chain','POST /operations/:id/signatures',{status:r.status,ms:performance.now()-a,bytes:0});}
 const a=performance.now();const p=await L.prepare(s,f.operationId);rec('chain','POST /operations/:id/attempts',{status:p.status,ms:performance.now()-a,bytes:0});
 const est=await L.chain.estimateGas({account:L.owners[0].address,to:p.body.to,data:p.body.data});const h=await L.send(s,p.body);const rc=await L.chain.waitForTransactionReceipt({hash:h});await L.mine(12);
 const rs=performance.now();const rr=await L.resync(s);const resyncMs=performance.now()-rs;rec('chain','POST /resync',{status:rr.status,ms:resyncMs,bytes:0});
 lane.push({tag,ok:(await L.opState(f.operationId))==='verified',opId:f.operationId,items:100,gasUsed:String(rc.gasUsed),estimateGas:String(est),blockGasLimit:String((await L.chain.getBlock({blockNumber:rc.blockNumber})).gasLimit),freezeMs,resyncMs,setupSeconds:(t1-t)/1000,allowanceSeconds:(t2-t1)/1000,totalSeconds:(Date.now()-t)/1000,verifiedSettlements:(await L.settlementsFor(f.operationId)).length});}catch(e:any){lane.push({tag,ok:false,error:String(e.message).slice(0,500)});}}
// ---- scheduler ----
let inflight=0,maxInflight=0;const fire=(f:()=>Promise<any>)=>{inflight++;maxInflight=Math.max(maxInflight,inflight);f().catch(e=>rec('runner','exception',{status:-1,ms:0,bytes:0},{err:String(e).slice(0,200)})).finally(()=>inflight--);};
const end=T0+DURATION*1000+ (Date.now()-T0);const start=Date.now();const ri=setInterval(()=>fire(doRead),1000/READ_RPS),wi=setInterval(()=>fire(doWrite),1000/WRITE_RPS),oi=setInterval(()=>fire(probeOutsider),1000);
const laneP=Promise.all(BATCH_AT.map((sec,i)=>new Promise(r=>setTimeout(()=>batchLane(`O5-LOAD-B${i}-${L.RUN}`).then(r),sec*1000))));
const prog=setInterval(()=>console.log(`t=${((Date.now()-start)/1000).toFixed(0)}s inflight=${inflight} created=${created.length} sse=${sseLat.length}`),60000);
await L.sleep(DURATION*1000);clearInterval(ri);clearInterval(wi);clearInterval(oi);clearInterval(prog);void end;
for(let i=0;i<300&&inflight>0;i++)await L.sleep(100);await laneP;await L.sleep(2500);raw.end();ledger.end();
// ---- post-run correctness: accounting (exact units persisted) and isolation ----
const ids=created.map(c=>c.id);const rows=ids.length?await L.q('SELECT id,amount_units::text u FROM payables WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[WS,ids]):[];const m=new Map(rows.map((r:any)=>[r.id,r.u]));
const accountingDefects=created.filter(c=>m.get(c.id)!==c.units).length;
fs.writeFileSync(`${OUT}/meta.json`,JSON.stringify({DURATION,READ_RPS,WRITE_RPS,SESSIONS:sessions.length,SSE_N,BATCH_AT,start:new Date(start).toISOString(),end:new Date().toISOString(),maxInflight,created:created.length,accountingDefects,sseLatenciesMs:sseLat,sseErrors,lane,host:{os:'Windows 11 Pro 10.0.26200',logicalCpus:16,ramGiB:31.1,node:process.version,network:'loopback 127.0.0.0/8 (no LAN hop)'}},null,1));
console.log(JSON.stringify({out:OUT,created:created.length,accountingDefects,sse:sseLat.length,maxInflight,lane}));await L.db.end();process.exit(0);
