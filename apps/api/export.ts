// TR-Export (round 5, O5 ops agent): workspace evidence export — private full packet vs redacted packet.
// - Workspace-scoped and RLS-enforced: every read runs as alder_app inside the scoped transaction (SET LOCAL
//   alder.workspace_id + session), so FORCE RLS limits rows to the caller's membership; no superuser/BYPASSRLS path.
// - Private full packet: business records + immutable intent manifests (exact calldata / SafeTx typed data) + broadcast
//   observations + independent verifier reports + settlements, so a holder can independently re-verify every paid item
//   against the chain. EXCLUDED always: owner signatures (treasury_signatures/signatures and the signature-bearing outer
//   transaction_data), attachment bytes, sessions, idempotency cache, credentials.
// - Redacted packet: names, references, review/verification notes, revision snapshots, attachment hashes removed;
//   recipient addresses replaced by per-export keyed tags (unlinkable across exports); calldata/typed data dropped.
//   It DECLARES its verification loss: it cannot be replayed against the chain. Address redaction is not erasure of
//   public chain data.
// - Integrity: SHA-256 per artifact and a manifest digest (SHA-256 over canonical JSON); the digest is also recorded in
//   an append-only audit event, and every read re-verifies all digests before serving bytes.
// - Retention: export bytes expire (ALDER_EXPORT_RETENTION_SECONDS, default 30 days) and are purged on the next export
//   activity in that workspace; the audit events (public history) are retained.
import fs from 'node:fs';import path from 'node:path';import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
const fail=(status:number,code:string)=>Object.assign(new Error(code),{statusCode:status});
export const EXPORT_MANIFEST_VERSION='alder-evidence-export/1';
const ROLES=['preparer','reviewer','owner','accountant','admin'];
// Round 6 (review F-L5): the PRIVATE full packet (full recipient addresses, calldata, SafeTx typed data) may be created
// and downloaded only by owner/accountant/admin; preparer/reviewer may create and read REDACTED packets only. Quotas:
// at most EXPORT_ACTOR_BURST exports per actor per 10 min, EXPORT_WS_LIVE retained (unpurged) exports and
// EXPORT_WS_BYTES stored/reserved bytes per workspace (429 EXPORT_QUOTA / EXPORT_RATE_LIMIT). Expired committed bytes
// are purged on every export request (create/list/read) and by the operator retention job (ops/retention-purge.ts);
// the purge event commits BEFORE those bytes are deleted. Pending and preserved orphan bytes count against byte quota.
export const PRIVATE_ROLES=['owner','accountant','admin'];
export const EXPORT_ACTOR_BURST=Number(process.env.ALDER_EXPORT_ACTOR_BURST||3),EXPORT_WS_LIVE=Number(process.env.ALDER_EXPORT_WS_LIVE||20),EXPORT_WS_BYTES=Number(process.env.ALDER_EXPORT_WS_BYTES||64*1024*1024);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
export function canonical(v:any):string{if(v===null||v===undefined)return 'null';if(typeof v==='bigint')return JSON.stringify(v.toString());if(v instanceof Date)return JSON.stringify(v.toISOString());
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(typeof v==='object')return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
export const exportRoot=()=>path.resolve(process.env.ALDER_EXPORT_DIR||'.local/exports');
const retentionMs=()=>Number(process.env.ALDER_EXPORT_RETENTION_SECONDS||30*86400)*1000;
// A reservation survives process death. Once its lease has elapsed, recovery under the
// workspace export lock either proves the created event committed or archives its bytes.
const PENDING_EXPORT_GRACE_MS=60*60*1000;
const dirFor=(ws:string,id:string)=>{if(!UUID.test(id)||!/^[0-9a-f-]{36}$/.test(ws))throw fail(404,'NOT_FOUND');return path.join(exportRoot(),ws,id);};
const pendingRoot=(ws:string)=>path.join(exportRoot(),ws,'.pending');
const orphanRoot=(ws:string)=>path.join(exportRoot(),ws,'.orphaned');
const LIMITS_PRIVATE=['Signatures are excluded (sensitive authorization evidence); the on-chain transaction is the authorization record.','Attachment bytes are excluded (quarantined pending a trusted scanner verdict); attachment metadata and SHA-256 are included.','Independent replay requires a JSON-RPC endpoint for the recorded chain instance (genesis + code hashes in deployment); a single provider is independent software, not independent node trust.','Payables without an on-chain verified settlement are business records only; nothing here asserts they were paid.'];
const LIMITS_REDACTED=['VERIFICATION LOSS: recipient addresses, calldata and SafeTx typed data are removed, so this packet CANNOT be independently replayed against the chain; only the private full packet can.','Recipient tags are keyed per export and are not linkable across exports; amounts, block hashes and transaction hashes remain and are public on chain.','Address redaction is a sharing convenience, not anonymization: public chain history cannot be erased.','Signatures, attachment bytes and attachment hashes are excluded.'];
async function collect(db:any,ws:string){const q=async(sql:string)=>(await db.query(sql,[ws])).rows;return {
 payables:await q('SELECT p.*,i.external_reference,i.token_identity,i.created_at AS intake_created_at FROM payables p LEFT JOIN payable_intakes i ON i.workspace_id=p.workspace_id AND i.payable_id=p.id WHERE p.workspace_id=$1 ORDER BY p.display_reference,p.id'),
 payable_revisions:await q('SELECT * FROM payable_revision_history WHERE workspace_id=$1 ORDER BY payable_id,revision'),
 contacts:await q('SELECT * FROM contacts WHERE workspace_id=$1 ORDER BY id'),contact_revisions:await q('SELECT * FROM contact_revisions WHERE workspace_id=$1 ORDER BY contact_id,revision'),
 destination_verifications:await q('SELECT * FROM destination_verifications WHERE workspace_id=$1 ORDER BY at,id'),destination_holds:await q('SELECT * FROM destination_operation_holds WHERE workspace_id=$1 ORDER BY at'),
 reviews:await q('SELECT * FROM business_reviews WHERE workspace_id=$1 ORDER BY at,id'),policies:await q('SELECT * FROM review_policies WHERE workspace_id=$1 ORDER BY id'),policy_revisions:await q('SELECT * FROM review_policy_revisions WHERE workspace_id=$1 ORDER BY policy_id,revision'),
 batches:await q('SELECT * FROM batches WHERE workspace_id=$1 ORDER BY id'),reservations:await q('SELECT * FROM reservations WHERE workspace_id=$1 ORDER BY batch_id,payable_id'),
 operations:await q('SELECT * FROM treasury_operations WHERE workspace_id=$1 ORDER BY created_at,id'),
 attempts:await q('SELECT workspace_id,id,operation_id,sender,sender_nonce,created_at FROM treasury_attempts WHERE workspace_id=$1 ORDER BY created_at,id'),
 observations:await q('SELECT * FROM treasury_observations WHERE workspace_id=$1 ORDER BY id'),reports:await q('SELECT * FROM treasury_reports WHERE workspace_id=$1 ORDER BY id'),settlements:await q('SELECT * FROM treasury_settlements WHERE workspace_id=$1 ORDER BY payable_id'),
 attachments:await q('SELECT a.workspace_id,a.id,a.sha256,a.mime,a.byte_length,a.scan_state,a.created_by,a.created_at FROM private_attachments a WHERE a.workspace_id=$1 ORDER BY a.created_at,a.id'),attachment_links:await q('SELECT * FROM payable_attachments WHERE workspace_id=$1 ORDER BY payable_id,attachment_id'),
 events:await q("SELECT * FROM events WHERE workspace_id=$1 AND kind NOT LIKE 'evidence-export%' ORDER BY id")};}
const ADDR=/^0x[0-9a-fA-F]{40}$/;
function redactPacket(d:any,salt:Buffer,publicAddrs:Set<string>){const tag=(a:any)=>typeof a==='string'&&ADDR.test(a)&&!publicAddrs.has(a.toLowerCase())?'addr:'+createHmac('sha256',salt).update(a.toLowerCase()).digest('hex').slice(0,16):a;const R='[redacted]';const inv:string[]=[];
 const deep=(v:any):any=>Array.isArray(v)?v.map(deep):v&&typeof v==='object'&&!(v instanceof Date)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,deep(x)])):tag(v);
 const out:any={...d};
 out.payables=d.payables.map((p:any)=>({...p,display_reference:R,contact:R,service:R,external_reference:R,recipient:tag(p.recipient)}));inv.push('payables.display_reference/contact/service/external_reference','payables.recipient->keyed tag');
 out.payable_revisions=d.payable_revisions.map((r:any)=>({...r,snapshot:null,reason:R}));inv.push('payable_revisions.snapshot/reason');
 out.contacts=d.contacts.map((c:any)=>({...c,display_name:R}));out.contact_revisions=d.contact_revisions.map((c:any)=>({...c,raw_address:tag(c.raw_address),address:tag(c.address),reason:R}));inv.push('contacts.display_name','contact_revisions.address/raw_address->keyed tag, reason');
 out.destination_verifications=d.destination_verifications.map((v:any)=>({...v,second_channel_reference:R}));inv.push('destination_verifications.second_channel_reference');
 out.reviews=d.reviews.map((r:any)=>({...r,reason:R}));out.policy_revisions=d.policy_revisions.map((r:any)=>({...r,reason:R}));inv.push('reviews.reason','policy_revisions.reason');
 const man=(m:any)=>{if(!m||typeof m!=='object')return m;const {calldata,typedData,message,initializer,...rest}=m;return deep({...rest,items:Array.isArray(m.items)?m.items.map((i:any)=>({paymentId:i.paymentId,amount:i.amount,recipient:tag(i.recipient)})):m.items,calldata_removed:true});};
 out.batches=d.batches.map((b:any)=>({...b,manifest:man(b.manifest)}));out.operations=d.operations.map((o:any)=>({...o,manifest:man(o.manifest)}));inv.push('batches/operations manifest: calldata, typedData, message, initializer removed; item recipients->keyed tag');
 out.reports=d.reports.map((r:any)=>({...r,report:deep(r.report)}));inv.push('reports: recipient addresses->keyed tag');
 out.attachments=d.attachments.map((a:any)=>({...a,sha256:null}));out.attachment_links=d.attachment_links.map((a:any)=>({...a,sha256:null}));inv.push('attachments.sha256 removed (dictionary/correlation risk)');
 out.events=d.events.map((e:any)=>({...e,data:deep(e.data)}));inv.push('events.data addresses->keyed tag');
 return {packet:out,inventory:inv};}
async function events(db:any,ws:string,exportId?:string){return (await db.query(`SELECT id,kind,data,at,actor_id FROM events WHERE workspace_id=$1 AND kind IN ('evidence-export-created','evidence-export-purged','evidence-export-accessed')${exportId?" AND data->>'export_id'=$2":''} ORDER BY id`,exportId?[ws,exportId]:[ws])).rows;}
async function purgeExpired(db:any,ws:string,actor:string){const ev=await events(db,ws);const purged=new Set(ev.filter((e:any)=>e.kind==='evidence-export-purged').map((e:any)=>e.data.export_id));const out:string[]=[];
 for(const e of ev.filter((e:any)=>e.kind==='evidence-export-created'&&Date.parse(e.data.retention_until)<=Date.now())){const id=e.data.export_id;if(purged.has(id)){// This purge event was committed earlier; retry its cleanup while the caller holds the workspace lock.
   fs.rmSync(dirFor(ws,id),{recursive:true,force:true});continue;}const dir=dirFor(ws,id);const existed=fs.existsSync(dir);
  await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[ws,actor,'evidence-export-purged',{id,export_id:id,manifest_digest:e.data.manifest_digest,bytes_deleted:existed,state:'expired'}]);out.push(id);}return out;}
// Called only AFTER the purge transaction commits. Reacquire the workspace lock and
// re-prove both the committed creation and retention-purge events before physical cleanup.
async function deletePurgedBytes(pool:any,ws:string,ids:string[]){if(!ids.length)return;const db=await pool.connect();const lockKey='evidence-export:'+ws;let locked=false;try{
 await db.query('SELECT pg_advisory_lock(hashtext($1))',[lockKey]);locked=true;const confirmed:string[]=[];let inTx=false;
 try{await db.query('BEGIN');inTx=true;for(const id of new Set(ids)){if(!UUID.test(id))continue;const proof=await db.query("SELECT c.data->>'retention_until' AS retention_until FROM events c WHERE c.workspace_id=$1 AND c.kind='evidence-export-created' AND c.data->>'export_id'=$2 AND EXISTS (SELECT 1 FROM events p WHERE p.workspace_id=c.workspace_id AND p.kind='evidence-export-purged' AND p.data->>'export_id'=c.data->>'export_id')",[ws,id]);if(!proof.rows.length)continue;const expires=Date.parse(proof.rows[0].retention_until);if(Number.isFinite(expires)&&expires<=Date.now())confirmed.push(id);}await db.query('COMMIT');inTx=false;for(const id of confirmed)fs.rmSync(dirFor(ws,id),{recursive:true,force:true});}
 catch(e){if(inTx)await db.query('ROLLBACK').catch(()=>{});throw e;}
 }finally{if(locked)try{await db.query('SELECT pg_advisory_unlock(hashtext($1))',[lockKey]);}finally{db.release();}else db.release();}}
const dirBytes=(d:string)=>{try{return fs.readdirSync(d).reduce((n,f)=>n+fs.statSync(path.join(d,f)).size,0);}catch{return 0;}};
function treeBytes(d:string):number{try{return fs.readdirSync(d,{withFileTypes:true}).reduce((n,e)=>{const p=path.join(d,e.name);if(e.isSymbolicLink())return n;return n+(e.isDirectory()?treeBytes(p):e.isFile()?fs.statSync(p).size:0);},0);}catch{return 0;}}
function workspaceExportBytes(ws:string):number{
 const root=path.join(exportRoot(),ws);let total=0;try{for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);if(!e.isDirectory()||e.isSymbolicLink())continue;
  if(e.name==='.pending'){for(const j of fs.readdirSync(p).filter(n=>n.endsWith('.json'))){try{const file=path.join(p,j),r=JSON.parse(fs.readFileSync(file,'utf8'));if(!UUID.test(r.id)||r.workspace_id!==ws)continue;total+=Math.max(0,(Number(r.reserved_bytes)||0)-treeBytes(dirFor(ws,r.id)))+fs.statSync(file).size;}catch{try{total+=fs.statSync(path.join(p,j)).size;}catch{}}}}
  else total+=treeBytes(p);
 }}catch{}return total;
}
async function recoverPending(db:any,ws:string,actor:string){
 const root=pendingRoot(ws);let names:string[]=[];try{names=fs.readdirSync(root).filter(n=>n.endsWith('.json'));}catch{return;}
 for(const name of names){const file=path.join(root,name);let r:any;try{r=JSON.parse(fs.readFileSync(file,'utf8'));}catch{continue;}
  if(!r||r.workspace_id!==ws||!UUID.test(r.id)||name!==`${r.id}.json`)continue;
  // Every mutation and recovery for this workspace holds the same advisory transaction lock.
  const committed=await db.query("SELECT 1 FROM events WHERE workspace_id=$1 AND kind='evidence-export-created' AND data->>'export_id'=$2 LIMIT 1",[ws,r.id]);
  if(committed.rows.length){fs.rmSync(file,{force:true});continue;}
  if(Date.parse(r.expires_at)>Date.now()||r.state==='orphan_preserved')continue;
  const src=dirFor(ws,r.id),archive=path.join(orphanRoot(ws),r.id);fs.mkdirSync(orphanRoot(ws),{recursive:true,mode:0o700});
  if(fs.existsSync(src)&&!fs.existsSync(archive))fs.renameSync(src,archive);
  const prior=await db.query("SELECT 1 FROM events WHERE workspace_id=$1 AND kind='evidence-export-orphan-preserved' AND data->>'export_id'=$2 LIMIT 1",[ws,r.id]);
  if(!prior.rows.length)await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[ws,actor,'evidence-export-orphan-preserved',{id:r.id,export_id:r.id,state:'orphan_preserved',reason:'expired private export reservation has no committed creation event; bytes archived and retained',reserved_bytes:Number(r.reserved_bytes)||0,archive:`.orphaned/${r.id}`}]);
  r.state='orphan_preserved';r.reserved_bytes=0;r.archived_at=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(r),{mode:0o600});
 }
}
function verifyOnDisk(ws:string,id:string,expectedDigest:string){const dir=dirFor(ws,id);if(!fs.existsSync(path.join(dir,'manifest.json')))return {present:false,ok:false,artifacts:[] as any[]};
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));const {manifest_digest,...body}=manifest;const recomputed=sha256(canonical(body));
 const artifacts=manifest.artifacts.map((a:any)=>{const f=path.join(dir,a.name);const ok=/^[a-z_]+\.json$/.test(a.name)&&fs.existsSync(f)&&sha256(fs.readFileSync(f))===a.sha256;return {name:a.name,ok};});
 return {present:true,manifest,ok:recomputed===manifest_digest&&manifest_digest===expectedDigest&&artifacts.every((a:any)=>a.ok),manifestDigestMatches:recomputed===manifest_digest&&manifest_digest===expectedDigest,artifacts};}
export function registerExports(app:any,mutate:any,pool:any){
 const roleCheck=(req:any)=>{if(!req.roles?.some((r:string)=>ROLES.includes(r)))throw fail(403,'ROLE_DENIED');};
 const mayPrivate=(req:any)=>req.roles?.some((r:string)=>PRIVATE_ROLES.includes(r));
 app.post('/api/v1/workspaces/:ws/evidence/exports',async(req:any)=>{let purgedIds:string[]=[];const ws=req.params.ws,actor=req.identity.user_id;const reservation=()=>path.join(pendingRoot(ws),`${pendingId}.json`);let pendingId='';const out=await mutate(req,ROLES,'evidence-export',async(db:any)=>{
  const b=req.body??{};if(typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['scope','redact_addresses','include_private_attachments','batch_revision'].includes(k)))throw fail(422,'INVALID_EXPORT_REQUEST');
  if(b.include_private_attachments!==undefined&&typeof b.include_private_attachments!=='boolean'||b.redact_addresses!==undefined&&typeof b.redact_addresses!=='boolean'||b.scope!==undefined&&!['private','redacted'].includes(b.scope))throw fail(422,'INVALID_EXPORT_REQUEST');
  if(b.include_private_attachments===true)throw fail(422,'ATTACHMENTS_NOT_EXPORTABLE');
  const scope=b.scope??(b.redact_addresses?'redacted':'private');if(scope==='private'&&b.redact_addresses===true)throw fail(422,'REDACTION_REQUIRES_REDACTED_SCOPE');
  if(scope==='private'&&!mayPrivate(req))throw fail(403,'PRIVATE_EXPORT_ROLE_DENIED');
  const id=randomUUID();dirFor(ws,id);pendingId=id;await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['evidence-export:'+ws]);await recoverPending(db,ws,actor);const purged=await purgeExpired(db,ws,actor);purgedIds=purged;
  const evs=await events(db,ws);const gone=new Set([...purged,...evs.filter((e:any)=>e.kind==='evidence-export-purged').map((e:any)=>e.data.export_id)]);
  const live=evs.filter((e:any)=>e.kind==='evidence-export-created'&&!gone.has(e.data.export_id));
  if(live.filter((e:any)=>e.actor_id===actor&&Date.parse(e.at)>Date.now()-600000).length>=EXPORT_ACTOR_BURST)throw fail(429,'EXPORT_RATE_LIMIT');
  const retainedBytes=workspaceExportBytes(ws);if(live.length>=EXPORT_WS_LIVE||retainedBytes>=EXPORT_WS_BYTES)throw fail(429,'EXPORT_QUOTA');
  const data=await collect(db,ws);
  const reportIds=new Set(data.reports.map((r:any)=>String(r.id)));if(data.settlements.some((s:any)=>s.state==='verified'&&!reportIds.has(String(s.report_id))))throw fail(409,'INCOMPLETE_EVIDENCE');
  const deployment=JSON.parse(fs.readFileSync(process.env.ALDER_DEPLOYMENT_FILE||'evidence/app-deployment.json','utf8'));
  const dep={chainId:deployment.chainId,genesis:deployment.genesis,safe:deployment.safe,token:deployment.token,executor:deployment.executor,singleton:deployment.singleton,factory:deployment.factory,deploymentBlock:String(deployment.deploymentBlock),codeHashes:deployment.codeHashes,profile:deployment.profile};
  let packet:any=data,inventory:string[]=[];if(scope==='redacted'){const pub=new Set([dep.safe,dep.token,dep.executor,dep.singleton,dep.factory].map((a:string)=>String(a).toLowerCase()));const r=redactPacket(data,randomBytes(32),pub);packet=r.packet;inventory=r.inventory;}
  const dir=dirFor(ws,id);const artifacts=[];const encoded:{name:string,body:Buffer}[]=[];
  for(const [name,rows] of Object.entries(packet)){const body=Buffer.from(canonical({artifact:name,workspace_id:ws,export_id:id,rows})+'\n');const file=`${name}.json`;encoded.push({name:file,body});artifacts.push({name:file,sha256:sha256(body),bytes:body.length,rows:(rows as any[]).length});}
  const created_at=new Date().toISOString(),retention_until=new Date(Date.now()+retentionMs()).toISOString();
  const manifest:any={manifest_version:EXPORT_MANIFEST_VERSION,export_id:id,workspace_id:ws,scope,created_at,created_by:actor,retention_until,digest_algorithm:'sha256 over canonical JSON (sorted keys); keccak256 values inside are EVM digests and are not compared with sha256',deployment:dep,artifacts,
   excluded:['treasury_signatures','signatures','treasury_attempts.transaction_data (contains packed owner signatures)','private_attachments.content (bytes)','sessions','idempotency','users credentials'],
   independent_verification_limitations:scope==='private'?LIMITS_PRIVATE:LIMITS_REDACTED,redaction_inventory:inventory,purged_before_export:purged};
  manifest.manifest_digest=sha256(canonical(manifest));const manifestBody=Buffer.from(JSON.stringify(manifest,null,1));const packetBytes=manifestBody.length+encoded.reduce((n,a)=>n+a.body.length,0);if(retainedBytes+packetBytes+512>EXPORT_WS_BYTES)throw fail(429,'EXPORT_QUOTA');
  fs.mkdirSync(path.dirname(dir),{recursive:true,mode:0o700});fs.mkdirSync(pendingRoot(ws),{recursive:true,mode:0o700});
  const reserve={id,workspace_id:ws,actor_id:actor,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+PENDING_EXPORT_GRACE_MS).toISOString(),reserved_bytes:packetBytes,state:'writing'};
  const reservationFd=fs.openSync(reservation(),'wx',0o600);try{fs.writeSync(reservationFd,JSON.stringify(reserve));fs.fsyncSync(reservationFd);}finally{fs.closeSync(reservationFd);}
  fs.mkdirSync(dir,{mode:0o700});for(const artifact of encoded)fs.writeFileSync(path.join(dir,artifact.name),artifact.body,{mode:0o600});fs.writeFileSync(path.join(dir,'manifest.json'),manifestBody,{mode:0o600});
  await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[ws,actor,'evidence-export-created',{id,export_id:id,entity:'evidence_export',state:'ready',manifest_digest:manifest.manifest_digest,scope,artifact_count:artifacts.length,retention_until}]);
  return {id,job_id:id,state:'ready',export_scope:scope,manifest_digest:manifest.manifest_digest,retention_until,artifacts:artifacts.map(a=>({name:a.name,sha256:a.sha256,bytes:a.bytes,rows:a.rows})),independent_verification_limitations:manifest.independent_verification_limitations,redaction_inventory:inventory};
 });if(pendingId)try{fs.rmSync(reservation(),{force:true});}catch{/* A committed reservation is reconciled by the next locked export request. */}await deletePurgedBytes(pool,req.params.ws,purgedIds);return out;});
 const readTx=async(fn:(db:any)=>Promise<any>)=>{const db=await pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
 const purgeForRead=async(req:any)=>{const ids=await readTx(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['evidence-export:'+req.params.ws]);await recoverPending(db,req.params.ws,req.identity.user_id);return purgeExpired(db,req.params.ws,req.identity.user_id);});await deletePurgedBytes(pool,req.params.ws,ids);};
 app.get('/api/v1/workspaces/:ws/evidence/exports',async(req:any)=>{roleCheck(req);await purgeForRead(req);return readTx(async db=>{const ev=await events(db,req.params.ws);const purged=new Set(ev.filter((e:any)=>e.kind==='evidence-export-purged').map((e:any)=>e.data.export_id));
  return {exports:ev.filter((e:any)=>e.kind==='evidence-export-created').map((e:any)=>({id:e.data.export_id,scope:e.data.scope,manifest_digest:e.data.manifest_digest,created_at:e.at,created_by:e.actor_id,retention_until:e.data.retention_until,state:purged.has(e.data.export_id)?'expired_purged':Date.parse(e.data.retention_until)<=Date.now()?'expired_pending_purge':'ready'}))};});});
 app.get('/api/v1/workspaces/:ws/evidence/exports/:id',async(req:any)=>{roleCheck(req);if(!UUID.test(req.params.id))throw fail(404,'NOT_FOUND');await purgeForRead(req);return readTx(async db=>{const ev=await events(db,req.params.ws,req.params.id);const created=ev.find((e:any)=>e.kind==='evidence-export-created');if(!created)throw fail(404,'NOT_FOUND');
  if(ev.some((e:any)=>e.kind==='evidence-export-purged'))return {id:req.params.id,state:'expired_purged',manifest_digest:created.data.manifest_digest,retained_history:'audit events retained; export bytes deleted per retention'};
  const v=verifyOnDisk(req.params.ws,req.params.id,created.data.manifest_digest);if(!v.present)throw fail(410,'EXPORT_BYTES_MISSING');
  return {id:req.params.id,state:Date.parse(created.data.retention_until)<=Date.now()?'expired_pending_purge':'ready',integrity:{ok:v.ok,manifest_digest_matches_audit_event:v.manifestDigestMatches,artifacts:v.artifacts},manifest:v.manifest};});});
 app.get('/api/v1/workspaces/:ws/evidence/exports/:id/artifacts/:name',async(req:any,reply:any)=>{roleCheck(req);if(!UUID.test(req.params.id)||!/^[a-z_]+\.json$/.test(req.params.name))throw fail(404,'NOT_FOUND');
  await purgeForRead(req);const body=await readTx(async db=>{const ev=await events(db,req.params.ws,req.params.id);const created=ev.find((e:any)=>e.kind==='evidence-export-created');if(!created)throw fail(404,'NOT_FOUND');if(ev.some((e:any)=>e.kind==='evidence-export-purged'))throw fail(410,'EXPORT_EXPIRED');
   const v=verifyOnDisk(req.params.ws,req.params.id,created.data.manifest_digest);if(!v.present)throw fail(410,'EXPORT_BYTES_MISSING');if(v.manifest.scope!=='redacted'&&!mayPrivate(req))throw fail(403,'PRIVATE_EXPORT_ROLE_DENIED');const a=v.manifest.artifacts.find((x:any)=>x.name===req.params.name);if(!a)throw fail(404,'NOT_FOUND');if(!v.ok)throw fail(409,'EXPORT_INTEGRITY_FAILED');
   await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[req.params.ws,req.identity.user_id,'evidence-export-accessed',{id:req.params.id,export_id:req.params.id,entity:a.name,state:'served'}]);
   return fs.readFileSync(path.join(dirFor(req.params.ws,req.params.id),a.name));});
  reply.header('Content-Type','application/json; charset=utf-8');reply.header('Content-Disposition',`attachment; filename="${req.params.name}"`);return reply.send(body);});
}
