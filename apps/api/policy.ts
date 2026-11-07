// Treasury business review policy (TR-Policy), policy-bound review (TR-Review), freeze re-check,
// settings preferences (TR-Preferences) and the explicit custody boundary (TR-T-POLICY).
// Business policy is application workflow only: it never constrains the Safe, its owners or threshold.
import {readinessIndex} from './eligibility.ts';
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {getAddress,isAddress} from 'viem';
import {canonicalJson} from '../../packages/canonical.ts';
import {exactRevision,recordBusinessReview} from './destinations.ts';
const fail=(status:number,code:string)=>Object.assign(new Error(code),{statusCode:status});
const MEMBER_ROLES=['preparer','reviewer','owner','accountant','admin'];
const POLICY_EDITORS=['reviewer','admin'];
const UINT256=2n**256n;
export const CUSTODY_BOUNDARY={
 managed_in_app:false,
 source:'Safe proxy owners and threshold on the local chain (31337)',
 change_route:'Only a Safe owner/threshold transaction authorized by the current Safe owner quorum, executed on-chain outside this application. Workspace settings, roles and review policy never change it.',
 external_ability:'Current Safe owners can still authorize transfers, approvals and owner/threshold changes through other Safe routes outside this application; business review is not a global Safe guard or module.',
};
// Keys that would express custody authority. Normalized: lower case without '_'/'-'.
const CUSTODY_KEYS=new Set(['owner','owners','safeowner','safeowners','custodyowner','custodyowners','threshold','safethreshold','custodythreshold','custody','signers','quorum','modules','module','guard','fallbackhandler','addowner','removeowner','swapowner','changethreshold']);
// Keys that would weaken or bypass mandatory independent review.
const BYPASS_KEYS=new Set(['skipreview','autoapprove','autoapproval','bypassreview','bypass','reviewexempt','exempt','allowselfapproval','selfapproval','selfreview','reviewrequired','requiresreview','mandatoryreview','requiredreviewerrole','mandatorydestinationcheck','reviewerrole','minreviewers','requiredapprovals']);
const norm=(k:string)=>k.toLowerCase().replace(/[_-]/g,'');
const plain=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
// Walk the entire body: custody intent anywhere is refused for every role before anything else.
export function rejectCustodyFields(body:any){const walk=(v:any,depth:number)=>{if(depth>8)throw fail(422,'INVALID_POLICY');if(Array.isArray(v)){for(const x of v)walk(x,depth+1);return;}if(!plain(v))return;for(const k of Object.keys(v)){if(CUSTODY_KEYS.has(norm(k)))throw fail(403,'CUSTODY_CHANGE_OUTSIDE_APP');walk(v[k],depth+1);}};walk(body,0);}
const integer=(v:any)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(v)||BigInt(v)>=UINT256)throw fail(422,'INVALID_POLICY');return v;};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function asset(v:any){if(!plain(v)||Object.keys(v).sort().join()!=='address,chain_id,profile')throw fail(422,'INVALID_POLICY');if(v.chain_id!=='31337'||typeof v.address!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(v.address)||!isAddress(v.address,{strict:true})||typeof v.profile!=='string'||!/^[A-Z0-9_]{1,100}$/.test(v.profile))throw fail(422,'INVALID_POLICY');return {chain_id:'31337',address:getAddress(v.address),profile:v.profile};}
function rule(v:any){
 if(!plain(v))throw fail(422,'INVALID_POLICY');
 for(const k of Object.keys(v))if(BYPASS_KEYS.has(norm(k)))throw fail(422,'MANDATORY_REVIEW');
 if(Object.keys(v).some(k=>!['id','label','asset','min_units','max_units','contact_ids'].includes(k)))throw fail(422,'INVALID_POLICY');
 if(typeof v.id!=='string'||!/^[A-Z][A-Z0-9-]{0,31}$/.test(v.id))throw fail(422,'INVALID_POLICY');
 if(typeof v.label!=='string'||!v.label.trim()||v.label!==v.label.trim()||v.label.length>200||/[\u0000-\u001f\u007f]/.test(v.label))throw fail(422,'INVALID_POLICY');
 const min=integer(v.min_units),max=v.max_units===null||v.max_units===undefined?null:integer(v.max_units);
 if(BigInt(min)<1n||max!==null&&BigInt(max)<BigInt(min))throw fail(422,'INVALID_POLICY');
 let contact_ids:string[]|null=null;
 if(v.contact_ids!==undefined&&v.contact_ids!==null){if(!Array.isArray(v.contact_ids)||!v.contact_ids.length||v.contact_ids.length>100||v.contact_ids.some((c:any)=>typeof c!=='string'||!UUID.test(c))||new Set(v.contact_ids).size!==v.contact_ids.length)throw fail(422,'INVALID_POLICY');contact_ids=[...v.contact_ids].sort();}
 return {id:v.id,label:v.label,asset:asset(v.asset),min_units:min,max_units:max,contact_ids};
}
// Policy schema v1. The mandatory floor is not configurable: every matched payable needs one
// independent `reviewer` (never its current preparer) and a current independently verified destination.
export function validatePolicyConditions(input:any){
 rejectCustodyFields(input);
 if(!plain(input))throw fail(422,'INVALID_POLICY');
 if(input.mandatory_review!==true||input.required_reviewer_role!=='reviewer'||input.mandatory_destination_check!==true)throw fail(422,'MANDATORY_REVIEW');
 for(const k of Object.keys(input))if(!['mandatory_review','required_reviewer_role','mandatory_destination_check','rules','schema_version'].includes(k))throw fail(422,BYPASS_KEYS.has(norm(k))?'MANDATORY_REVIEW':'INVALID_POLICY');
 if(input.schema_version!==undefined&&input.schema_version!==1)throw fail(422,'INVALID_POLICY');
 if(!Array.isArray(input.rules)||input.rules.length<1||input.rules.length>50)throw fail(422,'INVALID_POLICY');
 const rules=input.rules.map(rule);if(new Set(rules.map((r:any)=>r.id)).size!==rules.length)throw fail(422,'INVALID_POLICY');
 return {schema_version:1,mandatory_review:true as const,required_reviewer_role:'reviewer' as const,mandatory_destination_check:true as const,rules};
}
export const policyDigest=(conditions:any)=>createHash('sha256').update(canonicalJson(conditions)).digest('hex');
// Pure matcher. Unknown/legacy asset identity, different asset, out-of-range amount or contact outside
// a rule's scope never matches. Returns matched rule IDs in policy order; [] means hold.
export function matchPolicy(conditions:any,facts:{amount_units:string,contact_id:string|null,token_identity:any}):string[]{
 const t=facts.token_identity;if(!plain(t)||typeof t.address!=='string')return [];
 let amount:bigint;try{amount=BigInt(String(facts.amount_units));}catch{return [];}
 return (conditions?.rules||[]).filter((r:any)=>String(t.chain_id)===r.asset.chain_id&&t.address.toLowerCase()===r.asset.address.toLowerCase()&&t.profile===r.asset.profile&&amount>=BigInt(r.min_units)&&(r.max_units==null||amount<=BigInt(r.max_units))&&(r.contact_ids==null||(facts.contact_id!=null&&Array.isArray(r.contact_ids)&&r.contact_ids.includes(facts.contact_id)))).map((r:any)=>r.id);
}
// Status of one payable against a policy (current, or a proposed next revision for preview).
export function classify(row:any,policy:{revision:number,conditions:any}|null){
 const matched=policy?matchPolicy(policy.conditions,row):[];
 const status=row.reserved?'reserved_unchanged':!policy?'policy_missing_hold':!matched.length?'unmatched_hold':!row.destination_current?'destination_hold':row.reviewed_by&&(row.approved_policy_revisions||[]).includes(policy.revision)?'approved_current':row.reviewed_by?'rereview_required':'review_pending';
 return {id:row.id,display_reference:row.display_reference,contact:row.contact,amount_units:String(row.amount_units),revision:row.revision,matched_rules:matched,status};
}
const schemaError=(e:any)=>e?.statusCode?e:['42P01','42703','42501','42P10'].includes(e?.code)?fail(503,'POLICY_SCHEMA_REQUIRED'):e;
// Request-scoped readiness, mirroring requireAttachmentSchema: non-owner, non-bypass app role,
// FORCE RLS, append-only table privileges (column UPDATE grants only), required columns resolvable.
export async function requirePolicySchema(db:any){
 try{
  const row=(await db.query(`SELECT current_user='alder_app'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolbypassrls))
   AND count(*)=3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity AND c.relkind='r' AND pg_catalog.pg_get_userbyid(c.relowner)<>current_user
    AND pg_catalog.has_table_privilege(c.oid,'SELECT') AND pg_catalog.has_table_privilege(c.oid,'INSERT') AND NOT pg_catalog.has_table_privilege(c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER')) AS ready
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN ('review_policies','review_policy_revisions','workspace_preferences')`)).rows[0];
  if(!row?.ready)throw Error('SCHEMA_REQUIRED');
  await db.query(`SELECT p.id,p.revision,r.conditions,r.digest,r.actor_id,r.reason,r.at,b.policy_id,b.policy_revision,b.matched_rules,b.decision,w.revision,w.pending_reminders,w.default_redaction
   FROM review_policies p JOIN review_policy_revisions r ON r.workspace_id=p.workspace_id AND r.policy_id=p.id AND r.revision=p.revision
   CROSS JOIN business_reviews b CROSS JOIN workspace_preferences w WHERE false`);
 }catch{throw fail(503,'POLICY_SCHEMA_REQUIRED');}
}
// lock: 'share' for review/freeze readers, 'update' for policy writers. Same workspace domain advisory
// lock (mutate) additionally serializes review, freeze and policy edits.
export async function currentPolicy(db:any,ws:string,lock:''|'share'|'update'=''){
 try{const row=(await db.query(`SELECT p.id,p.revision,r.conditions,r.digest,r.actor_id,r.reason,r.at FROM review_policies p JOIN review_policy_revisions r ON r.workspace_id=p.workspace_id AND r.policy_id=p.id AND r.revision=p.revision WHERE p.workspace_id=$1${lock==='share'?' FOR SHARE OF p':lock==='update'?' FOR UPDATE OF p':''}`,[ws])).rows[0];return row||null;}catch(e){throw schemaError(e);}
}
export async function policySummary(pool:any,ws:string){try{const p=await currentPolicy(pool,ws);return p?{id:p.id,revision:p.revision,digest:p.digest}:null;}catch{return {unavailable:true};}}
async function intakeIdentities(db:any,ws:string,ids:string[]){const rows=(await db.query('SELECT payable_id,token_identity FROM payable_intakes WHERE workspace_id=$1 AND payable_id=ANY($2::uuid[])',[ws,ids])).rows;return new Map(rows.map((r:any)=>[r.payable_id,r.token_identity]));}
// Freeze/allowance gate: every payable's current approval must be bound to the CURRENT policy revision,
// the exact payable revision and the recorded reviewer; a policy change after review requires re-review.
export async function assertCurrentPolicyReviews(db:any,ws:string,rows:any[]){
 const policy=await currentPolicy(db,ws,'share');if(!policy)throw fail(422,'POLICY_HOLD_MISSING');
 const identities=await intakeIdentities(db,ws,rows.map((p:any)=>p.id));
 for(const p of [...rows].sort((a:any,b:any)=>a.id.localeCompare(b.id))){
  if(!matchPolicy(policy.conditions,{amount_units:String(p.amount_units),contact_id:p.contact_id??null,token_identity:identities.get(p.id)??null}).length)throw fail(422,'POLICY_UNMATCHED');
  if(!p.reviewed_by||!(await db.query("SELECT 1 FROM business_reviews WHERE workspace_id=$1 AND payable_id=$2 AND payable_revision=$3 AND actor_id=$4 AND policy_id=$5 AND policy_revision=$6 AND decision='approve'",[ws,p.id,p.revision,p.reviewed_by,policy.id,policy.revision])).rowCount)throw fail(422,'POLICY_REREVIEW_REQUIRED');
 }
 return policy;
}
const IMPACT_SQL=`SELECT p.id,p.display_reference,p.contact,p.amount_units::text AS amount_units,p.revision,p.contact_id,p.reviewed_by,p.prepared_by,p.verified,
 (p.verified AND p.contact_id IS NOT NULL AND c.revision IS NOT DISTINCT FROM p.destination_revision AND v.decision IS NOT DISTINCT FROM 'approve') AS destination_current,
 i.token_identity,EXISTS(SELECT 1 FROM reservations x WHERE x.workspace_id=p.workspace_id AND x.payable_id=p.id) AS reserved,
 ARRAY(SELECT b.policy_revision FROM business_reviews b WHERE b.workspace_id=p.workspace_id AND b.payable_id=p.id AND b.payable_revision=p.revision AND b.actor_id=p.reviewed_by AND b.decision='approve' AND b.policy_id=$2::uuid ORDER BY b.policy_revision) AS approved_policy_revisions
 FROM payables p LEFT JOIN payable_intakes i ON i.workspace_id=p.workspace_id AND i.payable_id=p.id
 LEFT JOIN contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
 LEFT JOIN destination_verifications v ON v.workspace_id=c.workspace_id AND v.contact_id=c.id AND v.destination_revision=c.revision
 WHERE p.workspace_id=$1 ORDER BY p.display_reference COLLATE "C",p.id LIMIT 200001`;
// Round 6 (TR-T-LOAD): no 1,000-row refusal. Revisions still evaluate EVERY payable (their summaries name every affected
// id); only the read/preview responses are bounded (first IMPACT_PREVIEW rows + exact per-status counts over all rows).
// IMPACT_HARD_LIMIT is a memory guard far above the reference workload, not a product ceiling.
export const IMPACT_PREVIEW=Number(process.env.ALDER_POLICY_IMPACT_PREVIEW||200),IMPACT_HARD_LIMIT=200000;
async function impactRows(db:any,ws:string,policyId:string|null){try{const rows=(await db.query(IMPACT_SQL,[ws,policyId])).rows;if(rows.length>IMPACT_HARD_LIMIT)throw fail(422,'IMPACT_TOO_LARGE');return rows;}catch(e){throw schemaError(e);}}
export function boundedImpact(all:any[]){const counts:Record<string,number>={};for(const x of all)counts[x.status]=(counts[x.status]||0)+1;return {impact:all.slice(0,IMPACT_PREVIEW),impact_total:all.length,impact_counts:counts,impact_truncated:all.length>IMPACT_PREVIEW,impact_preview_limit:IMPACT_PREVIEW};}
const reason=(v:any)=>{if(typeof v!=='string'||!v.trim()||v.length>2000)throw fail(422,'REASON_REQUIRED');return v;};
async function recordChanged(db:any,req:any,data:any){await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[req.params.ws,req.identity.user_id,'TR-RecordChanged',{schema_version:1,event_id:randomUUID(),correlation_id:req.id??null,...data}]);}
const readDeployment=()=>JSON.parse(fs.readFileSync(process.env.ALDER_DEPLOYMENT_FILE||'evidence/app-deployment.json','utf8'));
// Round 6 (TR-T-LOAD): the read-only impact of the CURRENT revision is derived from the per-workspace readiness index
// (same predicates: reservation, rule match, destination currency, review bound to this exact policy revision) instead of
// re-reading and classifying every payable on each GET. Used only when the index was built against this exact revision.
export function classifyIndexed(r:any,p:{revision:number,conditions:any}|null){return classify({id:r.id,display_reference:r.ref,contact:r.contact,amount_units:r.amount_units,revision:r.revision,contact_id:r.contact_id,token_identity:r.token_identity,reserved:r.reserved,destination_current:r.destination_current,reviewed_by:r.reviewed?'reviewed':null,approved_policy_revisions:r.review_current&&p?[p.revision]:[]},p);}
export function registerPolicy(app:any,mutate:any,pool:any,options:{deployment?:()=>any,impactIndex?:boolean}={}){
 const deployment=()=>{try{const d=(options.deployment||readDeployment)();if(d?.chainId!==31337||typeof d.token!=='string')return null;return d;}catch{return null;}};
 const workspaceAsset=()=>{const d=deployment();return d?{chain_id:'31337',address:getAddress(d.token),profile:String(d.profile)}:null;};
 const member=(req:any)=>{if(!req.roles?.some((r:string)=>MEMBER_ROLES.includes(r)))throw fail(403,'ROLE_DENIED');};
 const read=async(fn:(db:any)=>Promise<any>)=>{const db=await pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
 const policyView=(p:any)=>p&&{id:p.id,revision:p.revision,digest:p.digest,conditions:p.conditions,changed_by:p.actor_id,reason:p.reason,at:p.at};

 app.get('/api/v1/workspaces/:ws/policy',async(req:any)=>{member(req);await requirePolicySchema(pool);return read(async db=>{
  const p=await currentPolicy(db,req.params.ws);const ix=options.impactIndex===false?null:await readinessIndex(db,req.params.ws);
  const indexed=!!ix&&(ix.policy?.id??null)===(p?.id??null)&&(ix.policy?.revision??null)===(p?.revision??null);
  const classified=indexed?ix!.rows.map(r=>classifyIndexed(r,p)):(await impactRows(db,req.params.ws,p?.id??null)).map((r:any)=>classify(r,p));
  const revisions=p?(await db.query('SELECT revision,digest,actor_id,reason,at FROM review_policy_revisions WHERE workspace_id=$1 AND policy_id=$2 ORDER BY revision DESC LIMIT 20',[req.params.ws,p.id])).rows:[];
  return {policy:policyView(p),revisions,...boundedImpact(classified),impact_source:indexed?'readiness-index':'direct',workspace_asset:workspaceAsset(),can_edit:req.roles.some((r:string)=>POLICY_EDITORS.includes(r)),mandatory_floor:{mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,configurable:false},custody:CUSTODY_BOUNDARY,not_authorization:true};
 });});
 // Impact preview of a proposed revision: validation only, no write, no idempotency record.
 app.post('/api/v1/workspaces/:ws/policies/preview',async(req:any)=>{member(req);const conditions=validatePolicyConditions(req.body?.conditions);await requirePolicySchema(pool);return read(async db=>{
  const p=await currentPolicy(db,req.params.ws);const next={revision:(p?.revision??0)+1,conditions};const rows=await impactRows(db,req.params.ws,p?.id??null);
  return {proposed_revision:next.revision,digest:policyDigest(conditions),...boundedImpact(rows.map((r:any)=>classify(r,next))),not_saved:true};
 });});
 const impactSummary=(rows:any[],next:{revision:number,conditions:any})=>{const after=rows.map((r:any)=>classify(r,next));return {
  affected_draft_ids:rows.filter((r:any)=>!r.reserved&&r.reviewed_by).map((r:any)=>r.id),
  unmatched_hold_ids:after.filter(x=>x.status==='unmatched_hold').map(x=>x.id),
  outstanding_reserved_ids:rows.filter((r:any)=>r.reserved).map((r:any)=>r.id),
  reserved_intents_replaced:false};};
 app.post('/api/v1/workspaces/:ws/policies',async(req:any)=>{await requirePolicySchema(pool);return mutate(req,POLICY_EDITORS,'policy-create',async(db:any)=>{
  rejectCustodyFields(req.body);const b=req.body;if(!plain(b)||Object.keys(b).some(k=>!['conditions','reason'].includes(k)))throw fail(422,'INVALID_POLICY');
  const conditions=validatePolicyConditions(b.conditions),why=reason(b.reason);
  if(await currentPolicy(db,req.params.ws,'update'))throw fail(409,'POLICY_EXISTS');
  const id=randomUUID(),digest=policyDigest(conditions);
  try{await db.query('INSERT INTO review_policies(workspace_id,id,revision) VALUES($1,$2,1)',[req.params.ws,id]);
   await db.query('INSERT INTO review_policy_revisions(workspace_id,policy_id,revision,conditions,digest,actor_id,reason) VALUES($1,$2,1,$3,$4,$5,$6)',[req.params.ws,id,conditions,digest,req.identity.user_id,why]);}
  catch(e:any){if(e.code==='23505')throw fail(409,'POLICY_EXISTS');throw e;}
  const summary=impactSummary(await impactRows(db,req.params.ws,null),{revision:1,conditions});
  await recordChanged(db,req,{entity:'review_policy',entity_id:id,revision:1,digest});
  return {id,policy_id:id,policy_revision:1,digest,...summary};
 });});
 app.post('/api/v1/workspaces/:ws/policies/:policy/revisions',async(req:any)=>{await requirePolicySchema(pool);return mutate(req,POLICY_EDITORS,'policy-revise',async(db:any)=>{
  rejectCustodyFields(req.body);const b=req.body;if(!plain(b)||Object.keys(b).some(k=>!['expected_revision','conditions','reason'].includes(k)))throw fail(422,'INVALID_POLICY');
  const p=await currentPolicy(db,req.params.ws,'update');if(!p||p.id!==req.params.policy)throw fail(404,'NOT_FOUND');
  exactRevision(req,p.revision,b.expected_revision);
  const conditions=validatePolicyConditions(b.conditions),why=reason(b.reason),digest=policyDigest(conditions);
  if(digest===p.digest)throw fail(422,'POLICY_UNCHANGED');
  const n=p.revision+1;
  await db.query('INSERT INTO review_policy_revisions(workspace_id,policy_id,revision,conditions,digest,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[req.params.ws,p.id,n,conditions,digest,req.identity.user_id,why]);
  if(!(await db.query('UPDATE review_policies SET revision=$3 WHERE workspace_id=$1 AND id=$2 AND revision=$4',[req.params.ws,p.id,n,p.revision])).rowCount)throw fail(412,'STALE_REVISION');
  // Prior revisions/decisions and reserved/frozen/signed rows are never rewritten here.
  const summary=impactSummary(await impactRows(db,req.params.ws,p.id),{revision:n,conditions});
  await recordChanged(db,req,{entity:'review_policy',entity_id:p.id,revision:n,digest,previous_revision:p.revision,affected_draft_ids:summary.affected_draft_ids});
  return {id:p.id,policy_id:p.id,policy_revision:n,digest,...summary};
 });});
 // TR-Review bound to the current policy revision. Order: separation of duty, exact payable revision,
 // outstanding signed intent, destination, policy existence/revision, rule match.
 app.post('/api/v1/workspaces/:ws/payables/:id/review',async(req:any)=>{await requirePolicySchema(pool);return mutate(req,['reviewer'],'review',async(db:any)=>{
  const b=req.body;if(!plain(b))throw fail(422,'INVALID_REVIEW');
  const p=(await db.query('SELECT * FROM payables WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[req.params.ws,req.params.id])).rows[0];if(!p)throw fail(404,'NOT_FOUND');
  if(p.prepared_by===req.identity.user_id)throw fail(403,'SELF_APPROVAL');
  if(p.revision!==b.revision)throw fail(412,'STALE_REVISION');
  exactRevision(req,p.revision,b.revision);
  if(b.decision!==undefined&&b.decision!=='approve')throw fail(422,'DECISION_UNSUPPORTED');
  if((await db.query('SELECT 1 FROM reservations WHERE workspace_id=$1 AND payable_id=$2',[req.params.ws,p.id])).rowCount)throw fail(409,'SIGNED_INTENT_OUTSTANDING');
  if(!p.verified||!p.contact_id)throw fail(422,'DESTINATION_HOLD');
  const policy=await currentPolicy(db,req.params.ws,'share');if(!policy)throw fail(422,'POLICY_HOLD_MISSING');
  if(!Number.isSafeInteger(b.policy_revision))throw fail(422,'POLICY_REVISION_REQUIRED');
  if(b.policy_revision!==policy.revision)throw fail(412,'STALE_POLICY_REVISION');
  const identity=(await intakeIdentities(db,req.params.ws,[p.id])).get(p.id)??null;
  const matched=matchPolicy(policy.conditions,{amount_units:String(p.amount_units),contact_id:p.contact_id,token_identity:identity});
  if(!matched.length)throw fail(422,'POLICY_UNMATCHED');
  const recorded=await recordBusinessReview(db,req,p,{policy_id:policy.id,policy_revision:policy.revision,policy_digest:policy.digest,matched_rules:matched});
  await db.query('UPDATE payables SET reviewed_by=$3 WHERE workspace_id=$1 AND id=$2',[req.params.ws,p.id,req.identity.user_id]);
  await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[req.params.ws,req.identity.user_id,'TR-ReviewDecided',{schema_version:1,event_id:randomUUID(),correlation_id:req.id??null,payable_id:p.id,payable_revision:p.revision,policy_id:policy.id,policy_revision:policy.revision,decision:'approve'}]);
  return {id:p.id,approved:true,review_id:recorded.id,digest:recorded.digest,policy_id:policy.id,policy_revision:policy.revision,matched_rules:matched,eligibility:'approved'};
 });});
 // Custody is never changed by this application. Explicit refusal for every role, no state touched.
 app.post('/api/v1/workspaces/:ws/custody/owner-changes',async(req:any)=>{member(req);throw fail(403,'CUSTODY_CHANGE_OUTSIDE_APP');});
 app.get('/api/v1/workspaces/:ws/settings',async(req:any)=>{member(req);await requirePolicySchema(pool);return read(async db=>{
  const prefs=(await db.query('SELECT revision,pending_reminders,default_redaction FROM workspace_preferences WHERE workspace_id=$1 AND user_id=$2',[req.params.ws,req.identity.user_id])).rows[0];
  const p=await currentPolicy(db,req.params.ws);const d=deployment();
  return {user:{id:req.identity.user_id,name:req.identity.name},roles:req.roles,role_impersonation:false,
   preferences:prefs?{revision:prefs.revision,pending_reminders:prefs.pending_reminders,default_redaction:prefs.default_redaction}:{revision:0,pending_reminders:true,default_redaction:true},
   policy:p?{id:p.id,revision:p.revision,digest:p.digest}:null,
   workspace:d?{chain_id:'31337',asset:workspaceAsset(),safe:d.safe??null,executor:d.executor??null,decimals:6}:null,
   custody:CUSTODY_BOUNDARY};
 });});
 // TR-Preferences: self only, revisioned, cannot carry review-policy or custody intent.
 app.put('/api/v1/workspaces/:ws/preferences',async(req:any)=>{await requirePolicySchema(pool);return mutate(req,MEMBER_ROLES,'preferences',async(db:any)=>{
  rejectCustodyFields(req.body);const b=req.body;if(!plain(b))throw fail(422,'INVALID_PREFERENCES');
  for(const k of Object.keys(b))if(BYPASS_KEYS.has(norm(k)))throw fail(422,'MANDATORY_REVIEW');
  if(Object.keys(b).sort().join()!=='default_redaction,expected_revision,pending_reminders'||typeof b.pending_reminders!=='boolean'||typeof b.default_redaction!=='boolean')throw fail(422,'INVALID_PREFERENCES');
  if(req.headers['if-match']===undefined)throw fail(428,'IF_MATCH_REQUIRED');
  const current=(await db.query('SELECT revision,pending_reminders,default_redaction FROM workspace_preferences WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[req.params.ws,req.identity.user_id])).rows[0];const revision=current?.revision??0;
  if(!Number.isSafeInteger(b.expected_revision)||b.expected_revision!==revision||req.headers['if-match']!==`"${b.expected_revision}"`)throw fail(412,'STALE_REVISION');
  let saved:any;
  try{saved=current?(await db.query('UPDATE workspace_preferences SET revision=revision+1,pending_reminders=$3,default_redaction=$4,updated_at=now() WHERE workspace_id=$1 AND user_id=$2 AND revision=$5 RETURNING revision',[req.params.ws,req.identity.user_id,b.pending_reminders,b.default_redaction,revision])).rows[0]
   :(await db.query('INSERT INTO workspace_preferences(workspace_id,user_id,revision,pending_reminders,default_redaction) VALUES($1,$2,1,$3,$4) RETURNING revision',[req.params.ws,req.identity.user_id,b.pending_reminders,b.default_redaction])).rows[0];}
  catch(e:any){if(e.code==='23505')throw fail(412,'STALE_REVISION');throw e;}
  if(!saved)throw fail(412,'STALE_REVISION');
  const result={revision:saved.revision,saved_preferences:{pending_reminders:b.pending_reminders,default_redaction:b.default_redaction},custody_owner_set_unchanged:true};
  await recordChanged(db,req,{entity:'workspace_preferences',entity_id:req.identity.user_id,revision:saved.revision,digest:createHash('sha256').update(canonicalJson(result.saved_preferences)).digest('hex')});
  return result;
 });});
}
