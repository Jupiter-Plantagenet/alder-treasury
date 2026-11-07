import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {parseAttachment,MAX_ATTACHMENT_BYTES,trustedScanState,linkPayableAttachments,requireAttachmentSchema} from '../apps/api/attachments.ts';
import {canonicalJson} from '../packages/canonical.ts';

const multipart=(bytes:Buffer,mime='application/pdf')=>Buffer.concat([Buffer.from('--edge\r\nContent-Disposition: form-data; name="file"; filename="ignored.pdf"\r\nContent-Type: '+mime+'\r\n\r\n'),bytes,Buffer.from('\r\n--edge--\r\n')]);
const contentType='multipart/form-data; boundary=edge';
const ws='00000000-0000-4000-8000-000000000001',attachmentId='00000000-0000-4000-8000-000000000003';
const keys=generateKeyPairSync('ed25519'),scannerKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
function signedFile(){const content=Buffer.from('%PDF-1.7\nprivate\n%%EOF');const row:any={workspace_id:ws,id:attachmentId,mime:'application/pdf',byte_length:content.length,content,sha256:createHash('sha256').update(content).digest('hex'),scan_version:'independent-engine-1',verdict:'clean'};
 row.signature=sign(null,Buffer.from(canonicalJson({domain:'alder.private-attachment.scan.v1',workspace_id:row.workspace_id,attachment_id:row.id,sha256:row.sha256,scan_version:row.scan_version,verdict:row.verdict})),keys.privateKey).toString('hex');return row;
}

test('partial optional storage schema fails as 503 before any new command',async()=>{
 await assert.rejects(()=>requireAttachmentSchema({query:async(sql:string)=>{if(sql.includes('AS ready'))return {rows:[{ready:true}]};throw Object.assign(Error('missing column'),{code:'42703'});}}),{statusCode:503});
});

test('multipart enforces actual bytes, exact 10MiB cap, one file and no client scan fields',()=>{
 const max=Buffer.alloc(MAX_ATTACHMENT_BYTES);max.write('%PDF-1.7'); assert.equal(parseAttachment(contentType,multipart(max)).byte_length,MAX_ATTACHMENT_BYTES);
 assert.equal(parseAttachment(contentType,multipart(Buffer.from('%PDF-1.7')).subarray(0,-2)).mime,'application/pdf');
 assert.throws(()=>parseAttachment(contentType,multipart(Buffer.concat([max,Buffer.from('x')]))),{statusCode:413});
 assert.throws(()=>parseAttachment(contentType,multipart(Buffer.from('<html>payload</html>'))),{statusCode:415});
 assert.throws(()=>parseAttachment(contentType,multipart(Buffer.from('%PDF-1.7'),'image/png')),{statusCode:415});
 assert.equal(parseAttachment(contentType,multipart(Buffer.from([137,80,78,71,13,10,26,10]),'image/png')).mime,'image/png');
 assert.equal(parseAttachment(contentType,multipart(Buffer.from([255,216,255,224]),'image/jpeg')).mime,'image/jpeg');
 const flag=Buffer.from(multipart(Buffer.from('%PDF-1.7')).toString().replace('--edge--\r\n','--edge\r\nContent-Disposition: form-data; name="scan_state"\r\n\r\nclean\r\n--edge--\r\n'));
 assert.throws(()=>parseAttachment(contentType,flag),{statusCode:422});
 assert.throws(()=>parseAttachment('application/octet-stream',max),{statusCode:415});
});

test('only an independently signed exact tenant/id/hash/version verdict releases quarantine',()=>{
 const row=signedFile();assert.equal(trustedScanState(row),'pending');assert.equal(trustedScanState({...row,scan_state:'clean',signature:'0'.repeat(128)},scannerKey),'pending');assert.equal(trustedScanState(row,scannerKey),'clean');
 for(const mutation of [{workspace_id:attachmentId},{id:ws},{sha256:'0'.repeat(64)},{scan_version:'other'},{verdict:'quarantine'}])assert.equal(trustedScanState({...row,...mutation},scannerKey),'pending');
 const other=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();assert.equal(trustedScanState(row,other),'pending');
});

test('private content handler rechecks storage, role and membership boundary, quarantines, verifies integrity and sets download headers',async()=>{
 const {registerAttachments}=await import('../apps/api/attachments.ts');let row:any=signedFile(),ready=true,visible=true,roles=['accountant'];const seen:string[]=[];
 const pool={query:async(sql:string)=>{seen.push(sql);if(sql.includes('AS ready'))return {rows:[{ready}]};return {rows:visible?[row]:[]};}};
 const app=Fastify();app.addHook('preHandler',async(req:any)=>{req.roles=roles;});registerAttachments(app,()=>{throw Error('READ_ONLY');},pool,scannerKey);
 const get=()=>app.inject({method:'GET',url:`/api/v1/workspaces/${ws}/attachments/${attachmentId}/content`});
 const clean=await get();assert.equal(clean.statusCode,200,clean.body);assert.deepEqual(clean.rawPayload,row.content);assert.equal(clean.headers['cache-control'],'no-store');assert.match(String(clean.headers['content-disposition']),/^attachment; filename="attachment-/);assert.equal(clean.headers['x-content-type-options'],'nosniff');assert.match(String(clean.headers['content-security-policy']),/sandbox/);
 assert(seen.some(sql=>sql.includes('JOIN memberships m')&&sql.includes('m.user_id=alder_actor()')&&sql.includes('a.workspace_id=$1 AND a.id=$2')));
 row={...row,signature:'0'.repeat(128),scan_state:'clean'};assert.equal((await get()).statusCode,409);
 row={...signedFile(),content:Buffer.from('corruption')};assert.equal((await get()).statusCode,503);
 visible=false;assert.equal((await get()).statusCode,404);visible=true;roles=[];assert.equal((await get()).statusCode,403);roles=['accountant'];ready=false;assert.equal((await get()).statusCode,503);
 await app.close();
});

test('required payable startup gate remains mandatory and only new attachment storage is optional',async()=>{
 const {registerPayables}=await import('../apps/api/payables.ts');const {registerAttachments}=await import('../apps/api/attachments.ts');
 const unavailable={query:async()=>{throw Error('UNAVAILABLE');},connect:async()=>{throw Error('UNAVAILABLE');}};
 const required=Fastify();registerPayables(required,()=>{},unavailable);
 await assert.rejects(async()=>{await required.ready();},{statusCode:503,message:'PAYABLE_SCHEMA_REQUIRED'});
 await required.close();
 const app=Fastify();app.addHook('preHandler',async(req:any)=>{req.roles=['preparer'];req.identity={user_id:'actor'};});
 app.get('/legacy',async()=>({ok:true}));registerAttachments(app,()=>{},unavailable);
 await app.ready();assert.equal((await app.inject('/legacy')).statusCode,200);
 const upload=await app.inject({method:'POST',url:`/api/v1/workspaces/${ws}/attachments`,headers:{'content-type':contentType,'idempotency-key':'new'},payload:multipart(Buffer.from('%PDF-1.7'))});assert.equal(upload.statusCode,503);
 await app.close();
});

test('linking rejects foreign/missing IDs and duplicate inputs without any insert',async()=>{
 const db={query:async(sql:string)=>{if(sql.includes('AS ready'))return {rows:[{ready:true}]};if(sql.includes('WHERE false'))return {rows:[]};assert(sql.startsWith('SELECT id,sha256'));return {rows:[]};}};
 await assert.rejects(()=>linkPayableAttachments(db,ws,attachmentId,[attachmentId]),{statusCode:404});
 await assert.rejects(()=>linkPayableAttachments(db,ws,attachmentId,[attachmentId,attachmentId]),{statusCode:422});
});

test('attachment upload route accepts multipart and always returns pending, ignoring client clean authority',async()=>{
 const {registerAttachments}=await import('../apps/api/attachments.ts');
 const app=Fastify();const inserted:any[]=[];
 const db={query:async(sql:string,args:any[])=>{if(sql.includes('INSERT INTO private_attachments')){inserted.push(args);return {rows:[]};}return {rows:[]};}};
 app.addHook('preHandler',async(req:any)=>{req.identity={user_id:'actor'};req.roles=['preparer'];});
 const mutate=async(req:any,roles:string[],command:string,fn:any)=>{assert.equal(command,'attachment-upload');assert(!Buffer.isBuffer(req.body));assert.equal(req.body.sha256.length,64);return fn(db);};
 registerAttachments(app,mutate,{query:async()=>({rows:[{ready:true}]})});
 const bytes=Buffer.from('%PDF-1.7\nprivate invoice\n%%EOF');
 const body=Buffer.concat([Buffer.from('--edge\r\nContent-Disposition: form-data; name="file"; filename="private.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),bytes,Buffer.from('\r\n--edge--\r\n')]);
 const res=await app.inject({method:'POST',url:'/api/v1/workspaces/00000000-0000-4000-8000-000000000001/attachments',headers:{'content-type':'multipart/form-data; boundary=edge','idempotency-key':'upload-1'},payload:body});
 assert.equal(res.statusCode,201,res.body);assert.equal(res.json().scan_state,'pending');assert.equal(inserted.length,1);assert.deepEqual(inserted[0].find(Buffer.isBuffer),bytes);
 await app.close();
});

test('link API advances business revision once, preserves hash binding and never alters frozen payables',async()=>{
 const {registerAttachments}=await import('../apps/api/attachments.ts');
 const ws='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002',file='00000000-0000-4000-8000-000000000003';
 const queries:{sql:string,args:any[]}[]=[];let reserved=false,linked=false;let p:any={workspace_id:ws,id,revision:1,reviewed_by:'old-reviewer'};
 const db={query:async(sql:string,args:any[]=[])=>{queries.push({sql,args});
  if(sql.includes('AS ready'))return {rows:[{ready:true}]};
  if(sql.startsWith('SELECT * FROM payables'))return {rows:[p]};
  if(sql.includes('FROM reservations'))return {rows:reserved?[{}]:[],rowCount:reserved?1:0};
  if(sql.includes('FROM payable_attachments'))return {rows:linked?[{attachment_id:file}]:[]};
  if(sql.includes('SELECT id,sha256 FROM private_attachments'))return {rows:[{id:file,sha256:'a'.repeat(64)}]};
  if(sql.startsWith('INSERT INTO payable_attachments')){linked=true;return {rows:[]};}
  if(sql.startsWith('UPDATE payables')){p={...p,revision:p.revision+1,reviewed_by:null};return {rows:[p]};}
  return {rows:[]};
 }};
 const app=Fastify();app.addHook('preHandler',async(req:any)=>{req.identity={user_id:'actor'};req.roles=['preparer'];});
 registerAttachments(app,async(req:any,_roles:any,command:string,fn:any)=>{assert.equal(command,'attachment-link');return fn(db);},db);
 const post=()=>app.inject({method:'POST',url:`/api/v1/workspaces/${ws}/payables/${id}/attachments`,headers:{'if-match':'"'+p.revision+'"','idempotency-key':'link'},payload:{expected_revision:p.revision,attachment_ids:[file]}});
 const first=await post();assert.equal(first.statusCode,200,first.body);assert.equal(first.json().new_revision,2);assert.equal(p.reviewed_by,null);
 assert(queries.some(q=>q.sql.startsWith('INSERT INTO payable_attachments')&&q.args.join('|')===[ws,id,file,'a'.repeat(64)].join('|')));
 const again=await post();assert.equal(again.statusCode,200,again.body);assert.equal(p.revision,2);
 reserved=true;assert.equal((await post()).statusCode,409);assert.equal(p.revision,2);await app.close();
});
