// Round 5 TR-T-INBOX bulk import: CSV upload with per-row validation, exact integer base units, duplicate external
// references (in-file and existing), and idempotent re-upload (the exact file digest maps to one import forever).
// All-or-nothing: an import commits only when every row is valid; otherwise 422 with per-row errors and no writes.
import fs from 'node:fs';import {randomUUID,randomBytes,createHash} from 'node:crypto';
const fail=(statusCode:number,code:string,details?:any)=>Object.assign(new Error(code),{statusCode,details});
export const IMPORT_COLUMNS=['external_reference','contact_id','amount_units'];const OPTIONAL=['service'];
const MAX_ROWS=5000,MAX_BYTES=1048576;
export function parseCsv(text:string){const rows:string[][]=[];let row:string[]=[],field='',quoted=false,i=0;const t=text.replace(/^﻿/,'');
 while(i<t.length){const ch=t[i];
  if(quoted){if(ch==='"'){if(t[i+1]==='"'){field+='"';i+=2;continue;}quoted=false;i++;continue;}field+=ch;i++;continue;}
  if(ch==='"'){if(field!=='')throw fail(422,'CSV_MALFORMED',{row:rows.length+1,code:'QUOTE_IN_UNQUOTED_FIELD'});quoted=true;i++;continue;}
  if(ch===','){row.push(field);field='';i++;continue;}
  if(ch==='\r'||ch==='\n'){row.push(field);field='';rows.push(row);row=[];if(ch==='\r'&&t[i+1]==='\n')i++;i++;continue;}
  field+=ch;i++;}
 if(quoted)throw fail(422,'CSV_MALFORMED',{row:rows.length+1,code:'UNTERMINATED_QUOTE'});
 if(field!==''||row.length){row.push(field);rows.push(row);}
 return rows.filter(r=>!(r.length===1&&r[0]===''));
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function validateImport(db:any,ws:string,body:any){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['filename','csv'].includes(k)))throw fail(422,'INVALID_IMPORT_FIELDS');
 const {filename,csv}=body;if(typeof filename!=='string'||!filename.trim()||filename.length>200||/[\u0000-\u001f\u007f\\/]/.test(filename))throw fail(422,'INVALID_FILENAME');
 if(typeof csv!=='string'||!csv.length)throw fail(422,'EMPTY_FILE');if(Buffer.byteLength(csv,'utf8')>MAX_BYTES)throw fail(413,'FILE_TOO_LARGE');
 const digest=createHash('sha256').update(csv,'utf8').digest('hex');
 const table=parseCsv(csv);if(!table.length)throw fail(422,'EMPTY_FILE');
 const header=table[0].map(h=>h.trim().toLowerCase());const missing=IMPORT_COLUMNS.filter(c=>!header.includes(c)),unknown=header.filter(h=>![...IMPORT_COLUMNS,...OPTIONAL].includes(h));
 if(missing.length||unknown.length||new Set(header).size!==header.length)throw fail(422,'IMPORT_HEADER_INVALID',{expected:IMPORT_COLUMNS,optional:OPTIONAL,missing,unknown});
 const data=table.slice(1);if(!data.length)throw fail(422,'EMPTY_FILE');if(data.length>MAX_ROWS)throw fail(422,'TOO_MANY_ROWS',{max:MAX_ROWS});
 const col=(r:string[],name:string)=>r[header.indexOf(name)];
 const contacts=new Map((await db.query("SELECT c.id,c.display_name,c.revision,r.address,r.chain_id,v.decision FROM contacts c JOIN contact_revisions r ON r.workspace_id=c.workspace_id AND r.contact_id=c.id AND r.revision=c.revision LEFT JOIN destination_verifications v ON v.workspace_id=c.workspace_id AND v.contact_id=c.id AND v.destination_revision=c.revision WHERE c.workspace_id=$1",[ws])).rows.map((c:any)=>[c.id,c]));
 const refs=data.map(r=>col(r,'external_reference')??'');
 const existing=new Set((await db.query('SELECT display_reference AS r FROM payables WHERE workspace_id=$1 AND display_reference=ANY($2::text[]) UNION SELECT external_reference FROM payable_intakes WHERE workspace_id=$1 AND external_reference=ANY($2::text[])',[ws,refs])).rows.map((x:any)=>x.r));
 const seen=new Map<string,number>();let total=0n;
 const rows=data.map((r,i)=>{const n=i+2,errors:string[]=[];// row numbers are 1-based file lines (header is line 1)
  if(r.length!==header.length)errors.push('ROW_SHAPE');
  const ref=col(r,'external_reference')??'',cid=(col(r,'contact_id')??'').trim(),units=col(r,'amount_units')??'',service=OPTIONAL.some(o=>header.includes(o))?(col(r,'service')??''):'';
  if(!ref||ref!==ref.trim()||ref.length>200||/[\u0000-\u001f\u007f]/.test(ref))errors.push('INVALID_EXTERNAL_REFERENCE');
  else{if(seen.has(ref))errors.push('DUPLICATE_IN_FILE');else seen.set(ref,n);if(existing.has(ref))errors.push('DUPLICATE_REFERENCE');}
  if(!UUID.test(cid))errors.push('INVALID_CONTACT');else{const c:any=contacts.get(cid);if(!c)errors.push('CONTACT_NOT_FOUND');else if(c.chain_id!=='31337')errors.push('UNSUPPORTED_CHAIN');}
  if(!/^[1-9][0-9]{0,77}$/.test(units)||BigInt(/^[0-9]+$/.test(units)?units:'0')>=2n**256n)errors.push('INVALID_AMOUNT_UNITS');else if(!errors.length)total+=BigInt(units);
  if(service.length>200||/[\u0000-\u001f\u007f]/.test(service))errors.push('INVALID_SERVICE');
  return {row:n,external_reference:ref,contact_id:cid,amount_units:units,service:service||'Imported payable',errors};});
 const fileErrors:string[]=[];if(total>=2n**256n)fileErrors.push('SUM_OVERFLOW');
 const invalid=rows.filter(r=>r.errors.length);
 return {filename,digest,rows,file_errors:fileErrors,row_count:rows.length,valid_count:rows.length-invalid.length,error_count:invalid.length,total_units:total.toString(),contacts};
}
export function registerImports(app:any,mutate:any,pool:any){
 const read=async(fn:(db:any)=>Promise<any>)=>{const db=await pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
 const prior=async(db:any,ws:string,digest:string)=>(await db.query('SELECT id,filename,row_count,total_units::text,created_at,created_by FROM payable_imports WHERE workspace_id=$1 AND digest=$2',[ws,digest])).rows[0];
 const strip=(v:any)=>{const {contacts,...rest}=v;return rest;};
 app.post('/api/v1/workspaces/:ws/payables/imports/preview',{bodyLimit:2*MAX_BYTES},async(req:any)=>{if(!req.roles.includes('preparer'))throw fail(403,'ROLE_DENIED');return read(async db=>{const v=await validateImport(db,req.params.ws,req.body);const p=await prior(db,req.params.ws,v.digest);return {...strip(v),already_imported:p||null,committable:!p&&v.error_count===0&&!v.file_errors.length,not_authorization:true};});});
 app.get('/api/v1/workspaces/:ws/payables/imports',async(req:any)=>read(async db=>({imports:(await db.query('SELECT id,filename,digest,row_count,total_units::text,created_by,created_at FROM payable_imports WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 50',[req.params.ws])).rows})));
 app.post('/api/v1/workspaces/:ws/payables/imports',{bodyLimit:2*MAX_BYTES},async(req:any,reply:any)=>{if(!req.roles.includes('preparer'))throw fail(403,'ROLE_DENIED');
  const result=await mutate(req,['preparer'],'payable-import',async(db:any)=>{
   const v=await validateImport(db,req.params.ws,req.body);const p=await prior(db,req.params.ws,v.digest);
   if(p)return {id:p.id,import_id:p.id,replay:true,created:0,row_count:p.row_count,total_units:p.total_units,digest:v.digest};
   if(v.error_count||v.file_errors.length)throw fail(422,'IMPORT_VALIDATION_FAILED',{rows:v.rows.filter(r=>r.errors.length).slice(0,500).map(r=>({row:r.row,external_reference:r.external_reference,errors:r.errors})),file_errors:v.file_errors,error_count:v.error_count,row_count:v.row_count});
   const d=JSON.parse(fs.readFileSync(process.env.ALDER_DEPLOYMENT_FILE||'evidence/app-deployment.json','utf8'));if(d.chainId!==31337||d.profile!=='ALDER_FIXED_SUPPLY_6_DECIMALS')throw fail(422,'UNSUPPORTED_ASSET');
   const token_identity={chain_id:String(d.chainId),address:d.token,profile:d.profile};const importId=randomUUID();const ids:string[]=[];
   await db.query('INSERT INTO payable_imports(workspace_id,id,digest,filename,row_count,total_units,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[req.params.ws,importId,v.digest,v.filename,v.row_count,v.total_units,req.identity.user_id]);
   for(const r of v.rows){const c:any=v.contacts.get(r.contact_id);const id=randomUUID();ids.push(id);
    try{const row=(await db.query('INSERT INTO payables(workspace_id,id,display_reference,contact,service,recipient,amount_units,prepared_by,verified,payment_id,contact_id,destination_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[req.params.ws,id,r.external_reference,c.display_name,r.service,c.address,r.amount_units,req.identity.user_id,c.decision==='approve','0x'+randomBytes(32).toString('hex'),c.id,c.revision])).rows[0];
     const meta=(await db.query('INSERT INTO payable_intakes(workspace_id,payable_id,external_reference,token_identity) VALUES($1,$2,$3,$4) RETURNING *',[req.params.ws,id,r.external_reference,token_identity])).rows[0];
     await db.query('INSERT INTO payable_revision_history(workspace_id,payable_id,revision,snapshot,actor_id,reason) VALUES($1,$2,1,$3,$4,$5)',[req.params.ws,id,{...row,external_reference:meta.external_reference,token_identity,import_id:importId,import_row:r.row},req.identity.user_id,`Bulk import ${v.filename} line ${r.row}`]);
     await db.query('INSERT INTO payable_import_rows(workspace_id,import_id,row_number,payable_id,external_reference) VALUES($1,$2,$3,$4,$5)',[req.params.ws,importId,r.row,id,r.external_reference]);
    }catch(e:any){if(e.code==='23505')throw fail(409,'DUPLICATE_REFERENCE',{row:r.row,external_reference:r.external_reference});throw e;}}
   await db.query('INSERT INTO outbox(workspace_id,kind,dedupe_key,payload) VALUES($1,$2,$3,$4)',[req.params.ws,'payables.imported','import:'+importId,{entity:'payable_import',entity_id:importId,state:'committed',row_count:v.row_count}]);
   return {id:importId,import_id:importId,replay:false,created:ids.length,row_count:v.row_count,total_units:v.total_units,digest:v.digest,payable_ids:ids};
  });reply.code(result.replay?200:201);return result;});
}
