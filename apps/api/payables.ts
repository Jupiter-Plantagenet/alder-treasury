import fs from 'node:fs';
import {verifyPayableSchema} from './payable-schema.ts';
import {validateAttachmentIds,linkPayableAttachments,requireAttachmentSchema} from './attachments.ts';
import {randomUUID,randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {getAddress} from 'viem';
import {canonicalJson} from '../../packages/canonical.ts';
import {readinessIndex} from './eligibility.ts';
const fail=(statusCode:number,code:string)=>Object.assign(new Error(code),{statusCode});
const uuid=(v:any)=>{if(typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v))throw fail(422,'INVALID_CONTACT');return v;};
// Round 6 (TR-T-LOAD): inbox snapshots store exact totals plus the first PREFIX ordered members (id, revision, review
// state), not every row: no 10,000-row ceiling and bounded bytes per snapshot. SESSION_ACTIVE_LIMIT bounds snapshots per
// session (RLS scopes the count to the session) and an unchanged view is reused for REUSE_MS.
const PREFIX=Number(process.env.ALDER_INBOX_PREFIX||500),SESSION_ACTIVE_LIMIT=Number(process.env.ALDER_INBOX_SESSION_LIMIT||60),REUSE_MS=Number(process.env.ALDER_INBOX_REUSE_MS||30000);
const snapshotSize=(p:any)=>Array.isArray(p?.items)?p.items.length:Number(p?.total_count||0);
const ROW_SQL=`SELECT p.*,i.external_reference,i.token_identity,i.created_at,
      CASE WHEN NOT p.verified OR (p.contact_id IS NOT NULL AND (c.revision IS DISTINCT FROM p.destination_revision OR v.decision IS DISTINCT FROM 'approve')) THEN 'destination_hold' WHEN p.reviewed_by IS NULL THEN 'pending' ELSE 'reviewed' END AS review_state
      FROM payables p LEFT JOIN payable_intakes i ON i.workspace_id=p.workspace_id AND i.payable_id=p.id
      LEFT JOIN contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
      LEFT JOIN destination_verifications v ON v.workspace_id=c.workspace_id AND v.contact_id=c.id AND v.destination_revision=c.revision
      WHERE p.workspace_id=$1`;
export function registerPayables(app:any,mutate:any,pool:any){
 // Preserve the existing mandatory payable-schema startup gate. Only the new
 // attachment tables have request-scoped readiness; absence cannot waive old gates.
 const intakeReady=async()=>{try{await verifyPayableSchema(pool);}catch{throw fail(503,'PAYABLE_SCHEMA_REQUIRED');}};
 app.addHook('onReady',intakeReady);
 app.get('/api/v1/workspaces/:ws/views/payables',async(req:any)=>{
  if(!req.roles.some((r:string)=>['preparer','reviewer','owner','accountant','admin'].includes(r)))throw fail(403,'ROLE_DENIED');
  await intakeReady();
  const q=req.query;
  if(Object.keys(q).some(k=>!['q','contact_id','review','limit','cursor'].includes(k))||Object.values(q).some(v=>typeof v!=='string'))throw fail(422,'INVALID_FILTER');
  if((q.q?.length||0)>200||q.contact_id!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(q.contact_id)||q.review!==undefined&&!['all','pending','reviewed','destination_hold'].includes(q.review)||q.limit!==undefined&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(q.limit))throw fail(422,'INVALID_FILTER');
  const filters={q:q.q||'',contact_id:q.contact_id||null,review:q.review||'all',limit:q.limit===undefined?50:Number(q.limit)};
  const digest=createHash('sha256').update(canonicalJson(filters)).digest('hex');
  const sign=(s:any,n:number)=>{const data=s.id+'.'+n;return data+'.'+createHmac('sha256',s.secret).update(data+'.'+s.filter_digest).digest('hex');};
  const db=await pool.connect();try{await db.query('BEGIN');await db.query('SET LOCAL statement_timeout=10000');let s:any,offset=0;
   if(q.cursor!==undefined){
    const match=/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([1-9][0-9]{0,6})\.([0-9a-f]{64})$/.exec(q.cursor);if(!match)throw fail(404,'CURSOR_INVALID');
    s=(await db.query('SELECT *,expires_at<=clock_timestamp() AS expired FROM payable_inbox_snapshots WHERE workspace_id=$1 AND id=$2',[req.params.ws,match[1]])).rows[0];
    if(!s||s.filter_digest!==digest)throw fail(404,'CURSOR_INVALID');offset=Number(match[2]);const expected=sign(s,offset);if(!timingSafeEqual(Buffer.from(expected),Buffer.from(q.cursor)))throw fail(404,'CURSOR_INVALID');if(s.expired)throw fail(410,'CURSOR_EXPIRED');if(offset>=snapshotSize(s.payload)||offset%filters.limit!==0)throw fail(404,'CURSOR_INVALID');
   }else{
    // This lock bounds concurrent per-session materializations; it does not authorize mutations.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['inbox:'+req.params.ws+req.identity.token_hash]);
    // Round 6 (TR-T-LOAD): an unchanged view (same session, filters and newest workspace event) opened again within
    // REUSE_MS returns the existing immutable snapshot instead of materialising another one.
    const cursorNow=(await db.query('SELECT coalesce(max(id),0)::text AS c FROM events WHERE workspace_id=$1',[req.params.ws])).rows[0].c;
    s=(await db.query("SELECT *,false AS expired FROM payable_inbox_snapshots WHERE workspace_id=$1 AND filter_digest=$2 AND payload->>'events_cursor'=$3 AND created_at>clock_timestamp()-make_interval(secs=>$4) AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1",[req.params.ws,digest,cursorNow,REUSE_MS/1000])).rows[0];
    if(!s){
    const active=(await db.query('SELECT count(*)::text AS n FROM payable_inbox_snapshots WHERE workspace_id=$1 AND expires_at>clock_timestamp()',[req.params.ws])).rows[0].n;if(BigInt(active)>=BigInt(SESSION_ACTIVE_LIMIT))throw fail(429,'SNAPSHOT_LIMIT');
    // Round 6: membership, review state and exact per-asset totals are derived from the workspace readiness index as of
    // the newest committed event (eligibility.ts; full rebuild at least every 15 s, incremental for single-payable events),
    // with the same predicates as the former single-statement materialisation. Stored payload = totals + first PREFIX
    // ordered members, so bytes per snapshot are bounded and there is no row-count ceiling.
    const ix=await readinessIndex(db,req.params.ws,cursorNow);const needle=filters.q.toLowerCase();
    const reviewState=(x:any)=>!x.verified||(x.contact_id!==null&&!x.destination_current)?'destination_hold':!x.reviewed?'pending':'reviewed';
    const matched=ix.rows.filter(x=>(!needle||(x.ref+' '+x.contact+' '+x.service).toLowerCase().includes(needle))&&(!filters.contact_id||x.contact_id===filters.contact_id)).map(x=>({x,state:reviewState(x)})).filter(m=>filters.review==='all'||m.state===filters.review);
    const tally=new Map<string,{token_identity:any,count:bigint,units:bigint}>();for(const {x} of matched){const k=canonicalJson(x.token_identity);const g=tally.get(k)||{token_identity:x.token_identity,count:0n,units:0n};g.count++;g.units+=BigInt(x.amount_units);tally.set(k,g);}
    const r={totals:[...tally.values()].map(g=>({token_identity:g.token_identity,count:g.count.toString(),total_units:g.units.toString()})),prefix:matched.slice(0,PREFIX).map(({x,state})=>[x.id,x.revision,state,x.ref])};
    // Preserve unknown legacy asset identity instead of silently rebinding original records.
    const groups=new Map<string,{token_identity:any,count:string,total_units:string}>();
    for(const g of r.totals){const k=canonicalJson(g.token_identity);const group=groups.get(k)||{token_identity:g.token_identity,count:'0',total_units:'0'};group.count=(BigInt(group.count)+BigInt(g.count)).toString();group.total_units=(BigInt(group.total_units)+BigInt(g.total_units)).toString();groups.set(k,group);}
    const totals_by_asset=[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v);
    const total_units=totals_by_asset.length<=1?(totals_by_asset[0]?.total_units||'0'):null;
    const count=totals_by_asset.reduce((n,g)=>n+BigInt(g.count),0n);
    const payload={v:2,source:'readiness-index',index_key:ix.key,members:r.prefix,total_count:count.toString(),total_units,totals_by_asset,sum_within_uint256:total_units===null?null:BigInt(total_units)<2n**256n,events_cursor:cursorNow,prefix_limit:PREFIX};
    s=(await db.query('INSERT INTO payable_inbox_snapshots(workspace_id,id,actor_id,session_hash,filter_digest,secret,payload) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.params.ws,randomUUID(),req.identity.user_id,req.identity.token_hash,digest,randomBytes(32).toString('hex'),payload])).rows[0];
    }
   }
   const size=snapshotSize(s.payload);const next=offset+filters.limit;let items:any[],consistency='snapshot';
   if(Array.isArray(s.payload.items))items=s.payload.items.slice(offset,next);// legacy (v1) snapshot: full rows stored
   else{const members=s.payload.members as any[];
    if(offset<members.length){// snapshot members: current row bytes, snapshot-time review state and revision
     const slice=members.slice(offset,next);const rows=new Map((await db.query(`${ROW_SQL} AND p.id=ANY($2::uuid[])`,[req.params.ws,slice.map(m=>m[0])])).rows.map((x:any)=>[x.id,x]));
     items=slice.map(m=>{const x:any=rows.get(m[0]);return x&&{...x,review_state:m[2],snapshot_revision:m[1],current_review_state:x.review_state,changed_since_snapshot:x.revision!==m[1]||x.review_state!==m[2]};}).filter(Boolean);}
    else{// beyond the stored prefix: keyset continuation over current rows with the same filters (declared in `consistency`)
     consistency='live_after_snapshot_prefix';const last=members.at(-1);
     items=(await db.query(`SELECT * FROM (${ROW_SQL} AND ($2='' OR strpos(lower(p.display_reference||' '||p.contact||' '||p.service),lower($2))>0) AND ($3::uuid IS NULL OR p.contact_id=$3::uuid) AND (p.display_reference COLLATE "C",p.id)>($4::text COLLATE "C",$5::uuid)) x WHERE $6='all' OR review_state=$6 ORDER BY display_reference COLLATE "C",id OFFSET $7 LIMIT $8`,[req.params.ws,filters.q,filters.contact_id,last[3],last[0],filters.review,offset-members.length,filters.limit])).rows;}}
   const {items:_legacy,members:_m,events_cursor:_e,prefix_limit:_p,v:_v,source:_s,index_key:_k,...totals}=s.payload;await db.query('COMMIT');
   return {...totals,items,next_cursor:next<size&&items.length?sign(s,next):null,snapshot_version:s.id,created_at:s.created_at,expires_at:s.expires_at,filters,consistency,recovery:'CLEAR_FILTERS_OR_START_NEW_SNAPSHOT',not_authorization:true,as_of_block_hash:null,lag:null,chain:{status:'not_checked',reason:'CHAIN_INDEPENDENT_BUSINESS_SNAPSHOT'}};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 });
 app.post('/api/v1/workspaces/:ws/payables',async(req:any,reply:any)=>{
  if(typeof req.headers['idempotency-key']!=='string'||!req.headers['idempotency-key'].trim())throw fail(422,'IDEMPOTENCY_KEY_REQUIRED');
  if(!req.roles.includes('preparer'))throw fail(403,'ROLE_DENIED');
  await intakeReady();
  const result=await mutate(req,['preparer'],'payable-create',async(db:any)=>{
   const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['contact_id','amount_units','external_reference','attachment_ids','token_identity'].includes(k)))throw fail(422,'INVALID_INTAKE_FIELDS');
   uuid(b.contact_id);
   if(typeof b.amount_units!=='string'||! /^[1-9][0-9]{0,77}$/.test(b.amount_units)||BigInt(b.amount_units)>=2n**256n)throw fail(422,'INVALID_AMOUNT_UNITS');
   if(typeof b.external_reference!=='string'||!b.external_reference.trim()||b.external_reference!==b.external_reference.trim()||b.external_reference.length>200||/[\u0000-\u001f\u007f]/.test(b.external_reference))throw fail(422,'INVALID_EXTERNAL_REFERENCE');
   validateAttachmentIds(b.attachment_ids);
   if(b.attachment_ids.length)await requireAttachmentSchema(db);
   const d=JSON.parse(fs.readFileSync(process.env.ALDER_DEPLOYMENT_FILE||'evidence/app-deployment.json','utf8'));
   if(d.chainId!==31337||d.profile!=='ALDER_FIXED_SUPPLY_6_DECIMALS')throw fail(422,'UNSUPPORTED_ASSET');
   const token_identity={chain_id:String(d.chainId),address:d.token,profile:d.profile};getAddress(d.token);
   if(b.token_identity!==undefined&&canonicalJson(b.token_identity)!==canonicalJson(token_identity))throw fail(422,'UNSUPPORTED_ASSET');
   const c=(await db.query('SELECT c.id,c.display_name,c.revision,r.address,r.chain_id,v.decision FROM contacts c JOIN contact_revisions r ON r.workspace_id=c.workspace_id AND r.contact_id=c.id AND r.revision=c.revision LEFT JOIN destination_verifications v ON v.workspace_id=c.workspace_id AND v.contact_id=c.id AND v.destination_revision=c.revision WHERE c.workspace_id=$1 AND c.id=$2 FOR UPDATE OF c',[req.params.ws,b.contact_id])).rows[0];
   if(!c)throw fail(404,'NOT_FOUND');if(c.chain_id!==token_identity.chain_id)throw fail(422,'UNSUPPORTED_CHAIN');
   const id=randomUUID(),payment_id='0x'+randomBytes(32).toString('hex');let p:any,meta:any;
   try{p=(await db.query('INSERT INTO payables(workspace_id,id,display_reference,contact,service,recipient,amount_units,prepared_by,verified,payment_id,contact_id,destination_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[req.params.ws,id,b.external_reference,c.display_name,'Manual payable',c.address,b.amount_units,req.identity.user_id,c.decision==='approve',payment_id,c.id,c.revision])).rows[0];
   meta=(await db.query('INSERT INTO payable_intakes(workspace_id,payable_id,external_reference,token_identity) VALUES($1,$2,$3,$4) RETURNING *',[req.params.ws,id,b.external_reference,token_identity])).rows[0];
   }catch(e:any){if(e.code==='23505'&&['payables_workspace_id_display_reference_key','payable_intakes_workspace_id_external_reference_key'].includes(e.constraint))throw fail(409,'DUPLICATE_REFERENCE');throw e;}
   await linkPayableAttachments(db,req.params.ws,id,b.attachment_ids);
   const projection={...p,external_reference:meta.external_reference,token_identity:meta.token_identity,created_at:meta.created_at,attachment_ids:b.attachment_ids};
   await db.query('INSERT INTO payable_revision_history(workspace_id,payable_id,revision,snapshot,actor_id,reason) VALUES($1,$2,1,$3,$4,$5)',[req.params.ws,id,projection,req.identity.user_id,'Manual intake']);
   return projection;
  });reply.code(201);return result;
 });
}
