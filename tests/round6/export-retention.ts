// Round 6 runner TR-T-EXPORT / F-L5: private-export role limits and quotas; attachment-byte retention deletion.
// LIVE stack, S6 only. The retention job runs ONLY on S6 with a 1 s test retention; the primary workspace is refused.
import {S,Runner,expect,sleep,q,run,ORIGIN,WS6} from './s6-lib.ts';import {execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
const R=new Runner('export-retention');const N=process.execPath;
const J=await S.as('s6-jordan'),P=await S.as('s6-priya'),AC=await S.as('s6-accountant'),O=await S.as('s6-owner');
await R.check('F-L5','preparer and reviewer cannot create a PRIVATE full packet (403 PRIVATE_EXPORT_ROLE_DENIED); a preparer may create a REDACTED one',async()=>{
 const a=await J.post('/evidence/exports',{scope:'private'}),b=await P.post('/evidence/exports',{}),c=await J.post('/evidence/exports',{scope:'redacted'});
 expect(a.status===403&&a.body.error.code==='PRIVATE_EXPORT_ROLE_DENIED'&&b.status===403&&c.status===200&&c.body.export_scope==='redacted','roles',{a:a.body,b:b.body,c:c.status});return {preparer_private:a.status,reviewer_default_private:b.status,preparer_redacted:c.status};});
let privId='';
await R.check('F-L5','accountant creates a private packet; a preparer cannot download its artifacts (403), the accountant can (200)',async()=>{
 const e=await AC.post('/evidence/exports',{scope:'private'});expect(e.status===200,'create',e.body);privId=e.body.id;
 const dl=await J.get(`/evidence/exports/${privId}/artifacts/payables.json`),ok=await AC.get(`/evidence/exports/${privId}/artifacts/payables.json`);
 expect(dl.status===403&&dl.body.error.code==='PRIVATE_EXPORT_ROLE_DENIED'&&ok.status===200,'dl',{dl:dl.body,ok:ok.status});return {accountant_private:e.status,preparer_download:dl.status,accountant_download:ok.status};});
await R.check('F-L5','per-actor rate limit: an actor gets at most 3 exports per 10 min (4th -> 429 EXPORT_RATE_LIMIT); other actors unaffected',async()=>{
 const st:number[]=[];for(let i=0;i<4;i++)st.push((await O.post('/evidence/exports',{scope:'redacted'})).status);const other=await AC.post('/evidence/exports',{scope:'redacted'});
 const last=await O.post('/evidence/exports',{scope:'redacted'});
 expect(st.slice(0,3).every(s=>s===200)&&st[3]===429&&last.body.error.code==='EXPORT_RATE_LIMIT'&&other.status===200,'rate',{st,other:other.status,last:last.body});return {owner_statuses:st,accountant_meanwhile:other.status};});
const quotaInfo=await q("SELECT count(*) FILTER (WHERE kind='evidence-export-created')::int c,count(*) FILTER (WHERE kind='evidence-export-purged')::int p FROM events WHERE workspace_id=$1",[WS6]);
R.note('F-L5','Workspace quota configuration/counts only; NOT an enforcement test',{created:quotaInfo[0].c,purged:quotaInfo[0].p,limits:{per_actor_10min:3,workspace_live:20,workspace_bytes:67108864}});
let att='';
await R.check('TR-T-EXPORT','attachment upload (preparer) is quarantined: download refused 409 QUARANTINED',async()=>{
 const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'+'1f15c4890000000d49444154789c6360000002000154a24f0d0000000049454e44ae426082','hex');
 const b='----s6'+randomUUID().slice(0,8);const body=Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="s6.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${b}--\r\n`)]);
 const r=await fetch(`${ORIGIN}/api/v1/workspaces/${WS6}/attachments`,{method:'POST',headers:{cookie:J.cookie,origin:ORIGIN,'x-csrf-token':J.csrf,'idempotency-key':randomUUID(),'content-type':`multipart/form-data; boundary=${b}`},body});const j:any=await r.json();
 expect(r.status===201&&j.scan_state==='pending','upload',j);att=j.attachment_id;const d=await AC.get(`/attachments/${att}/content`);expect(d.status===409&&d.body.error.code==='QUARANTINED','q',d.body);return {upload:r.status,scan_state:j.scan_state,download:d.body.error.code};});
await R.check('TR-T-EXPORT','retention job refuses a short retention for the PRIMARY workspace (policy 180 days); nothing purged there',async()=>{
 let msg='';try{execFileSync(N,['--import','tsx','ops/retention-purge.ts','--workspace','00000000-0000-4000-8000-000000000001','--attachment-seconds','1'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});msg='RAN?!';}catch(e:any){msg=String(e.stderr||e.message).match(/RETENTION_BELOW_POLICY_REFUSED_FOR_NON_TEST_WORKSPACE/)?.[0]||String(e.stderr).slice(-200);}
 const w1=(await q("SELECT count(*)::int n FROM attachment_retention_purges WHERE workspace_id='00000000-0000-4000-8000-000000000001'"))[0].n;
 expect(msg==='RETENTION_BELOW_POLICY_REFUSED_FOR_NON_TEST_WORKSPACE'&&w1===0,'w1',{msg,w1});return {refusal:msg,w1_purges:w1};});
await R.check('TR-T-EXPORT','expired attachment bytes are deleted (S6, 1 s test retention): content NULL, metadata+SHA-256+purge record retained, download 410 ATTACHMENT_PURGED, still listed',async()=>{
 await sleep(1500);const out=JSON.parse(execFileSync(N,['--import','tsx','ops/retention-purge.ts','--workspace',WS6,'--attachment-seconds','1','--exports'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n').pop()!);
 const row=(await q('SELECT content IS NULL AS gone,purged_at IS NOT NULL AS stamped,sha256,byte_length FROM private_attachments WHERE workspace_id=$1 AND id=$2',[WS6,att]))[0];
 const rec=(await q('SELECT sha256,retention_seconds::int,purged_by FROM attachment_retention_purges WHERE workspace_id=$1 AND attachment_id=$2',[WS6,att]))[0];
 const d=await AC.get(`/attachments/${att}/content`);
 expect(out.attachments_purged>=1&&row.gone&&row.stamped&&rec&&rec.sha256===row.sha256&&d.status===410&&d.body.error.code==='ATTACHMENT_PURGED','purge',{out,row,rec,d:d.body});
 return {job:out,row_after:{content_null:row.gone,purged_at_set:row.stamped,byte_length_kept:row.byte_length},purge_record:rec,download:d.body.error.code};});
await R.check('TR-T-EXPORT','purge record is immutable (UPDATE/DELETE refused even for the migration principal)',async()=>{
 const pg=(await import('pg')).default;const c=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:5543/alder'});await c.connect();let up='',del='';
 try{await c.query('BEGIN');try{await c.query("UPDATE attachment_retention_purges SET purged_by='x' WHERE attachment_id=$1",[att]);up='OK?!';}catch(e:any){up=e.message;}await c.query('ROLLBACK');
  await c.query('BEGIN');try{await c.query('DELETE FROM attachment_retention_purges WHERE attachment_id=$1',[att]);del='OK?!';}catch(e:any){del=e.message;}await c.query('ROLLBACK');}finally{await c.end();}
 expect(/immutable/i.test(up)&&/immutable/i.test(del),'imm',{up,del});return {update:up,delete:del};});
const out=R.finish();process.exit(out.failed?1:0);
