import {createHash,randomUUID,createPublicKey,verify} from 'node:crypto';
import {canonicalJson} from '../../packages/canonical.ts';
import {exactRevision,retainPayable} from './destinations.ts';

const fail=(statusCode:number,code:string)=>Object.assign(new Error(code),{statusCode});
export const MAX_ATTACHMENT_BYTES=10*1024*1024;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const readers=['preparer','reviewer','owner','accountant','admin'];
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

/** Bounded single-file multipart contract. Extra parts (including scan flags) are rejected.
 * Filename is neither stored nor reflected. MIME is derived from bytes, not its extension.
 * Magic recognition is not malware scanning; every accepted file starts quarantined.
 */
export function parseAttachment(contentType:string,raw:Buffer){
 const match=/^multipart\/form-data\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,.\/:=?-]{1,70})"|([0-9A-Za-z'()+_,.\/:=?-]{1,70}))\s*$/i.exec(contentType);
 if(!match)throw fail(415,'MULTIPART_REQUIRED');
 const boundary=match[1]||match[2],start=Buffer.from('--'+boundary+'\r\n');
 const close=Buffer.from('\r\n--'+boundary+'--'),withCrlf=Buffer.concat([close,Buffer.from('\r\n')]);
 const end=raw.subarray(-withCrlf.length).equals(withCrlf)?withCrlf:close;
 if(!raw.subarray(0,start.length).equals(start)||!raw.subarray(-end.length).equals(end))throw fail(422,'INVALID_MULTIPART');
 const split=raw.indexOf('\r\n\r\n',start.length);
 if(split<0||split-start.length>8192)throw fail(422,'INVALID_MULTIPART');
 const lines=raw.subarray(start.length,split).toString('latin1').split('\r\n'),headers=new Map<string,string>();
 for(const line of lines){const h=/^([A-Za-z-]+):[ \t]*([^\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*)$/.exec(line);if(!h||headers.has(h[1].toLowerCase()))throw fail(422,'INVALID_MULTIPART');headers.set(h[1].toLowerCase(),h[2]);}
 if([...headers.keys()].some(k=>!['content-disposition','content-type'].includes(k))||!/^form-data;\s*name="file";\s*filename="[^"\r\n]*"$/i.test(headers.get('content-disposition')||''))throw fail(422,'ONE_FILE_REQUIRED');
 const bytes=raw.subarray(split+4,raw.length-end.length);
 if(bytes.includes(Buffer.from('\r\n--'+boundary)))throw fail(422,'ONE_FILE_REQUIRED');
 if(bytes.length>MAX_ATTACHMENT_BYTES)throw fail(413,'ATTACHMENT_TOO_LARGE');
 let mime:string;
 if(bytes.subarray(0,5).equals(Buffer.from('%PDF-')))mime='application/pdf';
 else if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
 else if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
 else throw fail(415,'UNSUPPORTED_ATTACHMENT');
 if(headers.get('content-type')?.toLowerCase()!==mime)throw fail(415,'MIME_MISMATCH');
 return {bytes,mime,sha256:sha(bytes),byte_length:bytes.length};
}

// Request-time only: an unapplied additive schema must not break sign-in or old reads.
export async function requireAttachmentSchema(db:any){
 try{
  const row=(await db.query(`SELECT current_user='alder_app'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolbypassrls))
   AND count(*)=3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity AND c.relkind='r' AND pg_catalog.pg_get_userbyid(c.relowner)<>current_user
    AND pg_catalog.has_table_privilege(c.oid,'SELECT') AND NOT pg_catalog.has_table_privilege(c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER')
    AND CASE WHEN c.relname='attachment_scan_verdicts' THEN NOT pg_catalog.has_table_privilege(c.oid,'INSERT') ELSE pg_catalog.has_table_privilege(c.oid,'INSERT') END) AS ready
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN ('private_attachments','payable_attachments','attachment_scan_verdicts')`)).rows[0];
  if(!row?.ready)throw Error('SCHEMA_REQUIRED');
  // Resolve every required column/type and SELECT permission without reading bytes.
  await db.query(`SELECT a.workspace_id,a.id,a.sha256,a.mime,a.byte_length,a.content,a.scan_state,a.created_by,a.created_at,
   l.payable_id,l.attachment_id,l.sha256,v.attachment_id,v.sha256,v.scan_version,v.verdict,v.signature
   FROM private_attachments a LEFT JOIN payable_attachments l ON l.workspace_id=a.workspace_id AND l.attachment_id=a.id AND l.sha256=a.sha256
   LEFT JOIN attachment_scan_verdicts v ON v.workspace_id=a.workspace_id AND v.attachment_id=a.id AND v.sha256=a.sha256 WHERE false`);
 }catch{throw fail(503,'ATTACHMENT_STORAGE_REQUIRED');}
}

export function validateAttachmentIds(ids:any):asserts ids is string[]{
 if(!Array.isArray(ids)||ids.length>20||ids.some(id=>typeof id!=='string'||!uuid.test(id))||new Set(ids).size!==ids.length)throw fail(422,'INVALID_ATTACHMENT_IDS');
}

/** Called INSIDE payable-create's existing idempotent transaction. Composite FK binds
 * tenant + opaque attachment ID + immutable byte hash. Pending files may be linked,
 * but linking never makes them downloadable or grants business/custody authority.
 */
export async function linkPayableAttachments(db:any,ws:string,payableId:string,ids:string[]){
 validateAttachmentIds(ids);if(!ids.length)return;
 await requireAttachmentSchema(db);
 const rows=(await db.query('SELECT id,sha256 FROM private_attachments WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[ws,ids])).rows;
 if(rows.length!==ids.length)throw fail(404,'ATTACHMENT_NOT_FOUND');
 for(const row of rows)await db.query('INSERT INTO payable_attachments(workspace_id,payable_id,attachment_id,sha256) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,payable_id,attachment_id) DO NOTHING',[ws,payableId,row.id,row.sha256]);
}

/** Independently provisioned Ed25519 scanner key only. No browser state, DB clean
 * boolean, filename or API role can release quarantine. The signed domain binds
 * exact tenant, attachment, bytes and scan version. Scanner is NOT started here.
 */
export function trustedScanState(row:any,publicKey?:string):'pending'|'clean'|'quarantine'{
 if(!row.scan_version||!publicKey)return 'pending';
 if(!['clean','quarantine'].includes(row.verdict)||typeof row.signature!=='string'||! /^[0-9a-f]{128}$/.test(row.signature))return 'pending';
 try{
  const key=createPublicKey(publicKey);if(key.asymmetricKeyType!=='ed25519')return 'pending';
  const message=Buffer.from(canonicalJson({domain:'alder.private-attachment.scan.v1',workspace_id:row.workspace_id,attachment_id:row.id,sha256:row.sha256,scan_version:row.scan_version,verdict:row.verdict}));
  return verify(null,message,key,Buffer.from(row.signature,'hex'))?row.verdict:'pending';
 }catch{return 'pending';}
}

export function registerAttachments(app:any,mutate:any,pool:any,scannerKey=process.env.ALDER_ATTACHMENT_SCANNER_PUBLIC_KEY){
 app.addContentTypeParser('multipart/form-data',{parseAs:'buffer',bodyLimit:MAX_ATTACHMENT_BYTES+16384},(_req:any,body:Buffer,done:any)=>done(null,body));
 app.post('/api/v1/workspaces/:ws/attachments',{bodyLimit:MAX_ATTACHMENT_BYTES+16384},async(req:any,reply:any)=>{
  if(!req.roles.includes('preparer'))throw fail(403,'ROLE_DENIED');
  if(typeof req.headers['idempotency-key']!=='string'||!req.headers['idempotency-key'].trim())throw fail(422,'IDEMPOTENCY_KEY_REQUIRED');
  if(!Buffer.isBuffer(req.body))throw fail(415,'MULTIPART_REQUIRED');
  const file=parseAttachment(req.headers['content-type']||'',req.body);
  await requireAttachmentSchema(pool);
  // Only private semantic digest enters the existing fingerprint; never serialize
  // a 10MiB Buffer into idempotency JSON or log multipart bytes/filenames.
  const commandReq={method:req.method,url:req.url,params:req.params,headers:req.headers,identity:req.identity,roles:req.roles,body:{sha256:file.sha256,mime:file.mime,byte_length:file.byte_length}};
  const result=await mutate(commandReq,['preparer'],'attachment-upload',async(db:any)=>{
   const id=randomUUID();
   await db.query('INSERT INTO private_attachments(workspace_id,id,sha256,mime,byte_length,content,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[req.params.ws,id,file.sha256,file.mime,file.byte_length,file.bytes,req.identity.user_id]);
   return {attachment_id:id,sha256:file.sha256,scan_state:'pending'};
  });reply.code(201);return result;
 });
 app.post('/api/v1/workspaces/:ws/payables/:id/attachments',async(req:any)=>{
  if(!req.roles.includes('preparer'))throw fail(403,'ROLE_DENIED');
  if(!uuid.test(req.params.id))throw fail(404,'NOT_FOUND');
  if(typeof req.headers['idempotency-key']!=='string'||!req.headers['idempotency-key'].trim())throw fail(422,'IDEMPOTENCY_KEY_REQUIRED');
  const b=req.body;
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['expected_revision','attachment_ids'].includes(k)))throw fail(422,'INVALID_ATTACHMENT_FIELDS');
  validateAttachmentIds(b.attachment_ids);if(!b.attachment_ids.length)throw fail(422,'ATTACHMENT_REQUIRED');
  await requireAttachmentSchema(pool);
  return mutate(req,['preparer'],'attachment-link',async(db:any)=>{
   const p=(await db.query('SELECT * FROM payables WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[req.params.ws,req.params.id])).rows[0];
   if(!p)throw fail(404,'NOT_FOUND');exactRevision(req,p.revision,b.expected_revision);
   if((await db.query('SELECT 1 FROM reservations WHERE workspace_id=$1 AND payable_id=$2',[req.params.ws,p.id])).rowCount)throw fail(409,'SIGNED_INTENT_OUTSTANDING');
   const prior=(await db.query('SELECT attachment_id FROM payable_attachments WHERE workspace_id=$1 AND payable_id=$2',[req.params.ws,p.id])).rows.map((x:any)=>x.attachment_id);
   const added=b.attachment_ids.filter((id:string)=>!prior.includes(id));
   if(prior.length+added.length>20)throw fail(422,'INVALID_ATTACHMENT_IDS');
   if(!added.length)return {id:p.id,new_revision:p.revision,attachment_ids:prior};
   await retainPayable(db,{...p,attachment_ids:prior},req.identity.user_id,'Supporting attachments linked');
   await linkPayableAttachments(db,req.params.ws,p.id,added);
   const after=(await db.query('UPDATE payables SET revision=revision+1,reviewed_by=NULL,prepared_by=$3 WHERE workspace_id=$1 AND id=$2 RETURNING *',[req.params.ws,p.id,req.identity.user_id])).rows[0];
   const attachment_ids=[...prior,...added].sort();
   await retainPayable(db,{...after,attachment_ids},req.identity.user_id,'Supporting attachments linked');
   return {id:p.id,new_revision:after.revision,attachment_ids,requires_business_rereview:true};
  });
 });
 const selection=`SELECT a.workspace_id,a.id,a.sha256,a.mime,a.byte_length,a.created_at,v.scan_version,v.verdict,v.signature`;
 const joins=` FROM private_attachments a LEFT JOIN attachment_scan_verdicts v ON v.workspace_id=a.workspace_id AND v.attachment_id=a.id AND v.sha256=a.sha256
   JOIN memberships m ON m.workspace_id=a.workspace_id AND m.user_id=alder_actor()`;
 const authorize=(req:any)=>{if(!req.roles.some((r:string)=>readers.includes(r)))throw fail(403,'ROLE_DENIED');};
 // Separate projection: absent optional schema never changes old snapshot queries.
 app.get('/api/v1/workspaces/:ws/payables/:id/attachments',async(req:any)=>{
  authorize(req);if(!uuid.test(req.params.id))throw fail(404,'NOT_FOUND');await requireAttachmentSchema(pool);
  const rows=(await pool.query(selection+joins+` JOIN payable_attachments l ON l.workspace_id=a.workspace_id AND l.attachment_id=a.id AND l.sha256=a.sha256
   WHERE l.workspace_id=$1 AND l.payable_id=$2 ORDER BY a.created_at,a.id`,[req.params.ws,req.params.id])).rows;
  return {items:rows.map((row:any)=>({attachment_id:row.id,sha256:row.sha256,mime:row.mime,byte_length:row.byte_length,scan_state:trustedScanState(row,scannerKey)}))};
 });
 app.get('/api/v1/workspaces/:ws/attachments/:id/content',async(req:any,reply:any)=>{
  authorize(req);if(!uuid.test(req.params.id))throw fail(404,'NOT_FOUND');await requireAttachmentSchema(pool);
  // RLS plus current membership at this exact read, not an upload-time grant or URL token.
  const row=(await pool.query(selection+',a.content'+joins+' WHERE a.workspace_id=$1 AND a.id=$2',[req.params.ws,req.params.id])).rows[0];
  if(!row)throw fail(404,'NOT_FOUND');
  // Round 6 (TR-T-EXPORT): bytes deleted by retention -> 410; metadata, hash and purge record are retained.
  if(row.content===null)throw fail(410,'ATTACHMENT_PURGED');
  if(trustedScanState(row,scannerKey)!=='clean')throw fail(409,'QUARANTINED');
  if(!Buffer.isBuffer(row.content)||row.content.length!==row.byte_length||sha(row.content)!==row.sha256)throw fail(503,'ATTACHMENT_INTEGRITY');
  const extension=row.mime==='application/pdf'?'pdf':row.mime==='image/png'?'png':row.mime==='image/jpeg'?'jpg':null;
  if(!extension)throw fail(503,'ATTACHMENT_INTEGRITY');
  return reply.header('Content-Type',row.mime).header('Content-Disposition',`attachment; filename="attachment-${row.id}.${extension}"`).header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"sandbox; default-src 'none'").send(row.content);
 });
}
