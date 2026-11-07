// Round 6 runner F-M4 (separation of duties, session revocation) and F-M3/F-L3 API side (resync request, outbox
// re-queue, no machine credential in the API process). LIVE stack, S6 workspace only.
import {S,Runner,expect,sleep,stream,q,USERS6,login,run} from './s6-lib.ts';import {execFileSync} from 'node:child_process';
const R=new Runner('access-sod');
const A=await S.as('s6-admin'),A2=await S.as('s6-admin2'),O=await S.as('s6-owner'),J=await S.as('s6-jordan');
const me=USERS6['s6-admin'],admin2=USERS6['s6-admin2'],priya=USERS6['s6-priya'],invitee=USERS6['s6-invitee'];
const rolesOf=async(u:string)=>(await q('SELECT roles FROM memberships WHERE workspace_id=$1 AND user_id=$2',[(await q("SELECT '00000000-0000-4000-8000-0000000000c6'::uuid AS w"))[0].w,u]))[0]?.roles??null;
await R.check('F-M4','an admin cannot change its OWN roles (403 SELF_ROLE_CHANGE), including granting itself owner/reviewer/preparer',async()=>{
 const r1=await A.post(`/members/${me}/roles`,{expected_roles:['admin'],roles:['admin','owner'],reason:run+' self owner'});
 const r2=await A.post(`/members/${me}/roles`,{expected_roles:['admin'],roles:['reviewer'],reason:run+' self reviewer'});
 const r3=await A.post(`/members/${me}/roles`,{expected_roles:['admin'],roles:['admin','preparer'],reason:run+' self preparer'});
 expect([r1,r2,r3].every(r=>r.status===403&&r.body.error.code==='SELF_ROLE_CHANGE')&&JSON.stringify(await rolesOf(me))==='["admin"]','self',{r1:r1.body,r2:r2.body,r3:r3.body});return {self_owner:r1.status,self_reviewer:r2.status,self_preparer:r3.status,roles_after:await rolesOf(me)};});
await R.check('F-M4','admin is never combined with treasury roles: another admin cannot make an admin owner/reviewer/preparer (refused: ADMIN_TREASURY_ROLE_CONFLICT or OWNER_GRANT_OUT_OF_BAND; roles unchanged)',async()=>{
 const a=await A2.post(`/members/${me}/roles`,{expected_roles:['admin'],roles:['admin','reviewer'],reason:run+' admin+reviewer'});
 const b=await A2.post(`/members/${me}/roles`,{expected_roles:['admin'],roles:['admin','owner'],reason:run+' admin+owner'});
 expect(a.status===422&&a.body.error.code==='ADMIN_TREASURY_ROLE_CONFLICT'&&[403,422].includes(b.status)&&['OWNER_GRANT_OUT_OF_BAND','ADMIN_TREASURY_ROLE_CONFLICT'].includes(b.body.error.code)&&JSON.stringify(await rolesOf(me))==='["admin"]','combo',{a:a.body,b:b.body});return {admin_plus_reviewer:a.body.error.code,admin_plus_owner:b.body.error.code};});
await R.check('F-M4','owner is never granted in-app (custody-owner change is out-of-band): set_roles and invitations with owner -> 403 OWNER_GRANT_OUT_OF_BAND',async()=>{
 const cur=await rolesOf(priya);const a=await A.post(`/members/${priya}/roles`,{expected_roles:cur,roles:['reviewer','owner'],reason:run+' grant owner'});
 const i=await A.post('/members/invitations',{email:'s6-invitee@alder.local',roles:['owner'],reason:run+' invite owner'});
 expect(a.status===403&&a.body.error.code==='OWNER_GRANT_OUT_OF_BAND'&&i.status===403&&i.body.error.code==='OWNER_GRANT_OUT_OF_BAND'&&JSON.stringify(await rolesOf(priya))===JSON.stringify(cur),'owner',{a:a.body,i:i.body});return {set_roles:a.body.error.code,invite:i.body.error.code};});
let inviteeSession:any;
await R.check('F-M4','positive control: an admin invites another account as preparer, it accepts, the admin adds reviewer (allowed SoD for a non-admin), audited',async()=>{
 for(const m of (await A.get('/members')).body.members.filter((m:any)=>m.user_id===invitee))await A.post(`/members/${invitee}/revoke`,{expected_roles:m.roles,reason:run+' reset'});
 for(const i of (await A.get('/members')).body.invites.filter((i:any)=>i.email==='s6-invitee@alder.local'&&!i.accepted_at&&!i.revoked_at))await A.post(`/members/invitations/${i.id}/revoke`,{reason:run+' reset'});
 const inv=await A.post('/members/invitations',{email:'s6-invitee@alder.local',roles:['preparer'],reason:run+' invite preparer'});expect(inv.status===200,'invite',inv.body);
 inviteeSession=await S.as('s6-invitee');const acc=await inviteeSession.post(`/api/v1/invitations/00000000-0000-4000-8000-0000000000c6/${inv.body.id}/accept`,{});expect(acc.status===200,'accept',acc.body);
 const up=await A.post(`/members/${invitee}/roles`,{expected_roles:['preparer'],roles:['preparer','reviewer'],reason:run+' add reviewer'});
 expect(up.status===200&&JSON.stringify(await rolesOf(invitee))==='["preparer","reviewer"]','grant',up.body);return {invite:inv.status,accept:acc.status,add_reviewer:up.status};});
await R.check('F-M4','role REMOVAL ends the subject\'s sessions (session 401 on the next request); audit row records sessions_revoked',async()=>{
 const before=await inviteeSession.get('/api/v1/auth/session');const down=await A.post(`/members/${invitee}/roles`,{expected_roles:['preparer','reviewer'],roles:['preparer'],reason:run+' remove reviewer'});
 const after=await inviteeSession.get('/api/v1/auth/session');const ev=(await q("SELECT archived FROM membership_events WHERE subject_user_id=$1 AND kind='roles-changed' ORDER BY id DESC LIMIT 1",[invitee]))[0];
 expect(before.status===200&&down.status===200&&after.status===401&&ev.archived.sessions_revoked>=1,'remove',{before:before.status,down:down.body,after:after.status,ev});return {before:before.status,after:after.status,sessions_revoked:ev.archived.sessions_revoked};});
await R.check('F-M4','membership REVOKE invalidates every session of the user: open SSE stream gets `revoked` within 5 s and the session is 401 (not merely 404)',async()=>{
 inviteeSession=await S.as('s6-invitee');const st=await stream(inviteeSession);await sleep(1200);const t=Date.now();
 const rv=await A.post(`/members/${invitee}/revoke`,{expected_roles:['preparer'],reason:run+' revoke'});
 while(!st.events.includes('revoked')&&Date.now()-t<6000)await sleep(50);const ms=Date.now()-t;
 const next=await inviteeSession.get('/api/v1/auth/session');const left=(await q('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[invitee]))[0].n;
 expect(st.status===200&&rv.status===200&&st.events.includes('revoked')&&ms<=5000&&next.status===401&&left===0,'revoke',{st:st.status,events:st.events,rv:rv.body,ms,next:next.status,left});st.close();
 return {sse:'revoked',revoked_after_ms:ms,next_request:next.status,sessions_left:left};});
await R.check('F-M4','admin session revocation endpoint: revokes all sessions of a member (audited), non-admin gets 403',async()=>{
 const P=await S.as('s6-priya');const denied=await J.post(`/members/${priya}/sessions/revoke`,{reason:'x'});
 const r=await A.post(`/members/${priya}/sessions/revoke`,{reason:run+' incident: revoke sessions'});const after=await P.get('/api/v1/auth/session');
 const ev=(await q("SELECT kind,archived FROM membership_events WHERE subject_user_id=$1 ORDER BY id DESC LIMIT 1",[priya]))[0];
 expect(denied.status===403&&r.status===200&&r.body.sessions_revoked>=1&&after.status===401&&ev.kind==='sessions-revoked','sessrevoke',{denied:denied.status,r:r.body,after:after.status,ev});return {non_admin:denied.status,revoked:r.body.sessions_revoked,after:after.status,audit:ev.kind};});
await R.check('F-M3','resync from the API is a request answered by the live worker (no lease or machine credential in the API); accountant 403',async()=>{
 const acc=await S.as('s6-accountant');const d=await acc.post('/resync',{});const r=await O.post('/resync',{});
 expect(d.status===403&&r.status===200&&r.body.via==='worker'&&r.body.request_id,'resync',{d:d.status,r:r.body});return {accountant:d.status,owner:{status:r.status,via:r.body.via,head:r.body.head,request_id:r.body.request_id}};});
await R.check('F-L3','outbox re-queue goes through the SECURITY DEFINER function: a non-held item -> 409 OUTBOX_NOT_HELD; preparer 403',async()=>{
 const any=(await q("SELECT id::text FROM outbox WHERE workspace_id='00000000-0000-4000-8000-0000000000c6' LIMIT 1"))[0]?.id||'1';
 const r=await O.post(`/outbox/${any}/retry`,{});const p=await J.post(`/outbox/${any}/retry`,{});
 expect((r.status===409&&r.body.error.code==='OUTBOX_NOT_HELD')&&p.status===403,'outbox',{r:r.body,p:p.status});return {owner_non_held:r.body.error.code,preparer:p.status};});
await R.check('F-M3','source-pinned pool attribution: API has app-role backends and every live indexer backend is tagged with the actual worker PID (positive controls, no empty/NAT-port inference)',async()=>{
 const api=Number(execFileSync('powershell',['-NoProfile','-Command','(Get-NetTCPConnection -State Listen -LocalPort 8103|Select -First 1).OwningProcess'],{encoding:'utf8'}).trim());
 const worker=Number(execFileSync('powershell',['-NoProfile','-Command','(Get-NetTCPConnection -State Listen -LocalPort 8113|Select -First 1).OwningProcess'],{encoding:'utf8'}).trim());
 const health=await O.get('/health');expect(health.status===200,'positive API connection');
 const conns=await q("SELECT usename,application_name FROM pg_stat_activity WHERE usename IN ('alder_app','alder_indexer')");
 const app=conns.filter(c=>c.usename==='alder_app'),indexer=conns.filter(c=>c.usename==='alder_indexer');
 expect(app.some(c=>c.application_name==='alder-api:'+api)&&indexer.length>0&&indexer.every(c=>c.application_name==='alder-worker:'+worker),'role attribution',{app,indexer,api,worker});
 return {api_pid:api,worker_pid:worker,app_backends:app.length,indexer_backends:indexer.length,application_names:[...new Set(conns.map(c=>c.application_name))],scope:'current source process diagnostics; application_name is not an authorization boundary'};});

const out=R.finish();process.exit(out.failed?1:0);
