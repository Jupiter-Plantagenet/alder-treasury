// Round 7 isolated-stack revocation and RPC recovery measurement.
// Deliberately not wired to npm test: run only in the main-approved post-LOAD window.
// A uniquely named user is created on the isolated scratch DB at execution time; no pre-provisioned login is required.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import * as L from './round5-ops/o5-lib.ts';

const WS=L.WS, RUN=`R7REV-${Date.now().toString(36).toUpperCase()}`;
const started=new Date().toISOString();const evidence:any={run:RUN,started,stack:{api:L.API,worker:'http://127.0.0.1:9113',database:'127.0.0.1:15543',rpcProxy:L.PROXY,truth:L.TRUTH},assertions:[],outcomes:[]};
const provisionDb=new pg.Pool({connectionString:'postgresql://postgres@127.0.0.1:15543/alder',max:1});
let proxyBaseline:any;let inviteId:string|undefined;let subjectId:string|undefined;let adminId:string|undefined;let subject:any;let admin:any;let disposableEmail:string|undefined;let adminEmail:string|undefined;
let blackholeServer:any;const faultSockets=new Set<any>();
function record(id:string,detail:any){evidence.outcomes.push({id,at:new Date().toISOString(),...detail});}
function check(ok:boolean,id:string,detail:any){record(id,{pass:ok,...detail});if(!ok)throw Error(`ASSERTION ${id} ${JSON.stringify(detail).slice(0,1400)}`);}
async function fetchJson(url:string,init?:RequestInit){const r=await fetch(url,init);const text=await r.text();let body:any;try{body=JSON.parse(text);}catch{body=text;}return {status:r.status,body};}
async function portIsClosed(port:number){return new Promise<boolean>(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',(e:any)=>resolve(e.code==='ECONNREFUSED'));});}
const workerStatus=async()=>{const r=await fetchJson('http://127.0.0.1:9113/status');if(r.status!==200)throw Error('P6_WORKER_STATUS_'+r.status);return r.body;};
async function loginExact(email:string,password:string){const s=new L.Session(email);const r=await fetch(L.API+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:L.ORIGIN},body:JSON.stringify({email,password})});const body:any=await r.json().catch(()=>null);if(r.status!==200)throw Error(`DISPOSABLE_LOGIN_FAILED_${r.status}`);s.cookie=(r.headers.get('set-cookie')||'').split(';')[0];s.csrf=body.csrf;return s;}
async function run(){
 if(!/^http:\/\/127\.0\.0\.1:9103$/.test(L.API))throw Error('ROUND7_REVOCATION_API_MUST_BE_9103');
 proxyBaseline=await L.proxyStats();check(proxyBaseline.upstream===L.TRUTH,'proxy-upstream-is-isolated-truth',{upstream:proxyBaseline.upstream,expected:L.TRUTH});
 // The clone has no admin in its four standard fixture memberships. Create a test-only admin actor on this P6 DB.
 const adminPassword=randomBytes(32).toString('hex'),adminSalt=randomBytes(16).toString('hex');adminId=randomUUID();adminEmail=`r7-admin-${adminId}@alder.local`;
 await provisionDb.query('INSERT INTO users(id,email,password_hash,salt,name) VALUES($1,$2,$3,$4,$5)',[adminId,adminEmail,scryptSync(adminPassword,adminSalt,64).toString('hex'),adminSalt,'Round 7 disposable admin actor']);
 await provisionDb.query('INSERT INTO memberships(workspace_id,user_id,roles) VALUES($1,$2,$3)',[WS,adminId,['admin']]);
 admin=await loginExact(adminEmail,adminPassword);const members=await admin.get('/members');check(members.status===200,'disposable-admin-can-manage-members',{status:members.status,adminUserId:adminId});
 // Create one fresh, owned disposable identity on the P6 clone using the same scrypt format as apps/api/auth.
 // The generated password stays in memory, is used only for this login, and is never persisted or logged.
 const userId=randomUUID(),password=randomBytes(32).toString('hex'),salt=randomBytes(16).toString('hex');disposableEmail=`r7-rev-${userId}@alder.local`;
 await provisionDb.query('INSERT INTO users(id,email,password_hash,salt,name) VALUES($1,$2,$3,$4,$5)',[userId,disposableEmail,scryptSync(password,salt,64).toString('hex'),salt,'Round 7 disposable revocation test']);subjectId=userId;
 record('provision-disposable-user',{userId,email:disposableEmail,database:'127.0.0.1:15543/alder',passwordStored:false});
 const invite=await admin.post('/members/invitations',{email:disposableEmail,roles:['preparer'],reason:RUN+' disposable revocation convergence'});check(invite.status===200,'create-disposable-membership-invitation',{status:invite.status,body:invite.body});inviteId=invite.body.id;
 subject=await loginExact(disposableEmail,password);const accepted=await subject.post(`/api/v1/invitations/${WS}/${inviteId}/accept`,{});check(accepted.status===200,'accept-disposable-membership',{status:accepted.status,body:accepted.body});
 const me=await subject.get('/api/v1/auth/session');check(me.status===200&&me.body?.user?.id===subjectId,'disposable-member-session-established',{status:me.status,subjectId});
 const stream=httpStream(subject);await stream.ready;const t=Date.now();const revoke=await admin.post(`/members/${subjectId}/revoke`,{expected_roles:['preparer'],reason:RUN+' enforce membership revocation'});
 while(!stream.events.includes('revoked')&&Date.now()-t<5500)await new Promise(r=>setTimeout(r,40));const enforcementMs=Date.now()-t;
 const next=await subject.get('/api/v1/auth/session');const remaining=await L.q('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[subjectId]);stream.close();
 check(revoke.status===200&&stream.status===200&&stream.events.includes('revoked')&&enforcementMs<=5000&&next.status===401&&remaining[0].n===0,'membership-revocation-enforced-within-5s',{revokeStatus:revoke.status,sseStatus:stream.status,events:stream.events,enforcementMs,nextSessionStatus:next.status,sessionsRemaining:remaining[0].n});
 // Prove the chosen loopback outage port is closed before installing it as this proxy's upstream.
 const faultPort=18559;check(await portIsClosed(faultPort),'fault-upstream-is-unavailable',{port:faultPort});
 const initialWorker=await workerStatus();const faultStarted=Date.now();const outage=await fetchJson(L.PROXY+'/__o5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({upstream:`http://127.0.0.1:${faultPort}`,rules:[]})});record('install-unavailable-rpc-upstream',{outage});
 const failedResyncP=admin.post('/resync',{}, {timeoutMs:45_000}).then((r:any)=>({status:r.status,body:r.body})).catch((e:any)=>({transportError:String(e?.message||e)}));let degraded:any;
 while(Date.now()-faultStarted<30_000){const w=await workerStatus();if(w.consecutive_failures>initialWorker.consecutive_failures&&w.last_error){degraded=w;break;}await new Promise(r=>setTimeout(r,200));}
 const failedResync=await Promise.race([failedResyncP,new Promise(r=>setTimeout(()=>r({stillPending:true}),1000))]);
 check(!!degraded&&degraded.last_error&&degraded.consecutive_failures>0,'worker-observes-rpc-failure',{worker:degraded,resync:failedResync,outageUpstream:`http://127.0.0.1:${faultPort}`});
 // Hold a second worker-backed resync against a controlled blackhole; observe its durable request as pending,
 // then restore the real isolated upstream and release the in-flight socket.
 blackholeServer=http.createServer((req,res)=>{faultSockets.add(req.socket);req.socket.on('close',()=>faultSockets.delete(req.socket));req.on('data',()=>{});});
 await new Promise<void>((resolve,reject)=>{blackholeServer.once('error',reject);blackholeServer.listen(faultPort,'127.0.0.1',()=>resolve());});
 await fetchJson(L.PROXY+'/__o5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({upstream:`http://127.0.0.1:${faultPort}`,rules:[]})});
 const pendingResyncP=admin.post('/resync',{}, {timeoutMs:45_000}).then((r:any)=>({status:r.status,body:r.body})).catch((e:any)=>({transportError:String(e?.message||e)}));let pending:any,workerPending:any;const pendingStarted=Date.now();
 while(Date.now()-pendingStarted<25_000){const rows=await L.q("SELECT id::text,done_at,error FROM indexer_requests WHERE kind='resync' AND requested_by=$1 ORDER BY id DESC LIMIT 1",[`api:${adminId}`]);const w=await workerStatus();if(rows[0]&&!rows[0].done_at&&w.phase==='reconciling'){pending=rows[0];workerPending=w;break;}await new Promise(r=>setTimeout(r,150));}
 check(!!pending&&workerPending?.phase==='reconciling','worker-resync-is-outstanding-before-restore',{pending,worker:workerPending,socketCount:faultSockets.size,elapsedMs:Date.now()-pendingStarted});
 const restoreAt=Date.now();const restored=await fetchJson(L.PROXY+'/__o5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({upstream:L.TRUTH,rules:[]})});for(const socket of faultSockets)socket.destroy();
 const heldOutcome=await Promise.race([pendingResyncP,new Promise(r=>setTimeout(()=>r({stillPending:true}),10_000))]);const attempts:any[]=[];let healthy:any;
 while(Date.now()-restoreAt<120_000){const [health,resync]=await Promise.all([fetchJson(L.API+'/health'),admin.post('/resync',{})]);attempts.push({at:Date.now(),healthStatus:health.status,health:health.body,resyncStatus:resync.status,resync:resync.body});
  if(health.status===200&&health.body?.chain?.status==='ready'&&resync.status===200){healthy={health,resync};break;}await new Promise(r=>setTimeout(r,500));}
 const convergenceMs=Date.now()-restoreAt;const stats=await L.proxyStats();blackholeServer.close();blackholeServer=undefined;
 check(!!healthy&&convergenceMs<=120_000&&stats.rules.length===0&&stats.upstream===L.TRUTH,'rpc-recovers-and-pending-request-converges-within-120s',{convergenceMs,restored,heldOutcome,healthy,attemptCount:attempts.length,attempts,proxy:stats});
 evidence.assertions=['membership revocation: SSE revoked event and next session 401 with zero remaining sessions within <=5,000 ms','unavailable loopback RPC upstream: worker consecutive_failures increases and last_error is non-null','blackholed upstream: a worker resync is observed outstanding in indexer_requests while worker phase is reconciling before restoration','after restoring isolated truth upstream: API health reports chain ready and a worker-backed resync returns 200 within <=120,000 ms; outstanding request outcome and proxy restoration are recorded'];
}
function httpStream(s:any){const ac=new AbortController();const state:any={status:0,events:[],ready:Promise.resolve(),close:()=>ac.abort()};state.ready=(async()=>{const r=await fetch(`${L.API}/api/v1/workspaces/${WS}/events/stream`,{headers:{cookie:s.cookie,origin:L.ORIGIN,accept:'text/event-stream'},signal:ac.signal});state.status=r.status;if(r.status!==200||!r.body)return;void(async()=>{const dec=new TextDecoder();try{for await(const ch of r.body as any){for(const m of dec.decode(ch).matchAll(/^event: (\S+)/gm))state.events.push(m[1]);}}catch{}})();})();return state;}
try{await run();}catch(e:any){evidence.failure=String(e?.stack||e).slice(0,3500);console.error('ROUND7_REVOCATION_CONVERGENCE_FAIL',evidence.failure);process.exitCode=1;}finally{
 // Always restore the O5 proxy to direct transparent forwarding, even on assertion or transport failure.
 try{evidence.proxyRestoration=await fetchJson(L.PROXY+'/__o5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({upstream:L.TRUTH,rules:[]})});}catch(e:any){evidence.proxyRestorationError=String(e?.message||e);process.exitCode=1;}
 for(const socket of faultSockets)socket.destroy();if(blackholeServer)try{blackholeServer.close();}catch{}
 if(subjectId&&admin)try{const row=(await provisionDb.query('SELECT roles FROM memberships WHERE workspace_id=$1 AND user_id=$2',[WS,subjectId])).rows[0];if(row){const cleanup=await admin.post(`/members/${subjectId}/revoke`,{expected_roles:row.roles,reason:RUN+' cleanup disposable membership'});evidence.membershipCleanup={status:cleanup.status,body:cleanup.body};}}catch(e:any){evidence.membershipCleanupError=String(e?.message||e);process.exitCode=1;}
 if(inviteId&&admin)try{const invite=(await provisionDb.query('SELECT accepted_at,revoked_at FROM membership_invites WHERE id=$1',[inviteId])).rows[0];if(invite&&!invite.accepted_at&&!invite.revoked_at){const cleanup=await admin.post(`/members/invitations/${inviteId}/revoke`,{reason:RUN+' cleanup unused disposable invitation'});evidence.invitationCleanup={status:cleanup.status,body:cleanup.body};}}catch(e:any){evidence.invitationCleanupError=String(e?.message||e);process.exitCode=1;}
 if(adminId)try{await provisionDb.query('DELETE FROM sessions WHERE user_id=$1',[adminId]);await provisionDb.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2',[WS,adminId]);evidence.adminFixtureCleanup={membershipRemoved:true,sessionsRemoved:true,userRetainedForAuditReferences:true};}catch(e:any){evidence.adminFixtureCleanupError=String(e?.message||e);process.exitCode=1;}
 evidence.disposableIdentity={userId:subjectId,email:disposableEmail,passwordPersisted:false,membershipRevoked:evidence.outcomes.some((x:any)=>x.id==='membership-revocation-enforced-within-5s'&&x.pass)};
 evidence.finished=new Date().toISOString();const dir='evidence/round7-access';fs.mkdirSync(dir,{recursive:true});const out=`${dir}/revocation-convergence-${RUN}.json`;fs.writeFileSync(out,JSON.stringify(evidence,null,2)+'\n');console.log('EVIDENCE',out);await Promise.all([L.db.end(),provisionDb.end()]);
}
