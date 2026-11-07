// Round 5 TR-Access membership administration. Every change goes through an audited SECURITY DEFINER function
// (db/010) that re-authorizes the session actor as an admin of the request workspace, keeps at least one admin,
// archives the before-state and appends an immutable membership_events row. Revocation takes effect on the next
// request and on open SSE streams (membership re-checked every poll).
// Round 6 (review F-M4): separation of duties in db/012: no self role change (SELF_ROLE_CHANGE), `admin` cannot be
// combined with owner/reviewer/preparer, `owner` is never granted in-app (OWNER_GRANT_OUT_OF_BAND: custody-owner
// changes are out-of-band), and revocation or any role removal deletes the subject's sessions.
import {databaseScope} from './database.ts';
const fail=(statusCode:number,code:string)=>Object.assign(new Error(code),{statusCode});
const MAP:any={SELF_ROLE_CHANGE:403,OWNER_GRANT_OUT_OF_BAND:403,ADMIN_TREASURY_ROLE_CONFLICT:422,ADMIN_REQUIRED:403,INVALID_ROLES:422,ALREADY_MEMBER:409,NOT_FOUND:404,STALE_ROLES:412,LAST_ADMIN:409,INVITE_NOT_OPEN:409,AUTH_REQUIRED:401};
const mapError=(e:any)=>{if(e?.code==='P0001'&&MAP[e.message])return fail(MAP[e.message],e.message);if(e?.code==='23505')return fail(409,'INVITE_ALREADY_OPEN');if(e?.code==='23514')return fail(422,/admin_not_treasury/.test(e?.constraint||'')?'ADMIN_TREASURY_ROLE_CONFLICT':'INVALID_INVITATION');return e;};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const roles=(v:any)=>{if(!Array.isArray(v)||!v.length||v.length>5||v.some(r=>!['preparer','reviewer','owner','accountant','admin'].includes(r))||new Set(v).size!==v.length)throw fail(422,'INVALID_ROLES');return v;};
const reason=(v:any)=>{if(typeof v!=='string'||!v.trim()||v.length>2000)throw fail(422,'REASON_REQUIRED');return v;};
export function registerMembers(app:any,mutate:any,pool:any){
 const admin=(req:any)=>{if(!req.roles?.includes('admin'))throw fail(403,'ROLE_DENIED');};
 const call=async(db:any,sql:string,args:any[])=>{try{return (await db.query(sql,args)).rows[0];}catch(e){throw mapError(e);}};
 app.get('/api/v1/workspaces/:ws/members',async(req:any)=>{admin(req);const db=await pool.connect();try{await db.query('BEGIN');
  const members=(await db.query('SELECT * FROM alder_membership_list($1)',[req.params.ws]).catch((e:any)=>{throw mapError(e);})).rows;
  const invites=(await db.query('SELECT id,email,roles,invited_by,created_at,expires_at,accepted_at,revoked_at FROM membership_invites WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',[req.params.ws])).rows;
  const events=(await db.query('SELECT id::text,kind,subject_user_id,subject_email,actor_id,before_roles,after_roles,reason,at FROM membership_events WHERE workspace_id=$1 ORDER BY id DESC LIMIT 100',[req.params.ws])).rows;
  await db.query('COMMIT');return {members,invites,events,self:req.identity.user_id};}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}});
 app.post('/api/v1/workspaces/:ws/members/invitations',async(req:any)=>{admin(req);return mutate(req,['admin'],'membership-admin',async(db:any)=>{const b=req.body||{};if(typeof b.email!=='string'||!/^[^@\s]{1,64}@[^@\s]{1,190}$/.test(b.email))throw fail(422,'INVALID_EMAIL');
  const r=await call(db,'SELECT alder_membership_invite($1,$2,$3,$4) AS id',[req.params.ws,b.email,roles(b.roles),reason(b.reason)]);return {id:r.id,state:'invited',email:b.email.toLowerCase(),roles:b.roles};});});
 app.post('/api/v1/workspaces/:ws/members/invitations/:id/revoke',async(req:any)=>{admin(req);if(!UUID.test(req.params.id))throw fail(404,'NOT_FOUND');return mutate(req,['admin'],'membership-admin',async(db:any)=>{await call(db,'SELECT alder_invite_revoke($1,$2,$3)',[req.params.ws,req.params.id,reason(req.body?.reason)]);return {id:req.params.id,state:'revoked'};});});
 app.post('/api/v1/workspaces/:ws/members/:user/roles',async(req:any)=>{admin(req);if(!UUID.test(req.params.user))throw fail(404,'NOT_FOUND');return mutate(req,['admin'],'membership-admin',async(db:any)=>{const b=req.body||{};const r=await call(db,'SELECT alder_membership_set_roles($1,$2,$3,$4,$5) AS roles',[req.params.ws,req.params.user,roles(b.expected_roles),roles(b.roles),reason(b.reason)]);return {id:req.params.user,roles:r.roles};});});
 app.post('/api/v1/workspaces/:ws/members/:user/revoke',async(req:any)=>{admin(req);if(!UUID.test(req.params.user))throw fail(404,'NOT_FOUND');return mutate(req,['admin'],'membership-admin',async(db:any)=>{const b=req.body||{};await call(db,'SELECT alder_membership_revoke($1,$2,$3,$4)',[req.params.ws,req.params.user,roles(b.expected_roles),reason(b.reason)]);return {id:req.params.user,state:'revoked'};});});
 // Round 6 (F-M4): admin session revocation; the subject's sessions are deleted (SSE streams end within one poll).
 app.post('/api/v1/workspaces/:ws/members/:user/sessions/revoke',async(req:any)=>{admin(req);if(!UUID.test(req.params.user))throw fail(404,'NOT_FOUND');return mutate(req,['admin'],'membership-admin',async(db:any)=>{const r=await call(db,'SELECT alder_membership_revoke_sessions($1,$2,$3) AS n',[req.params.ws,req.params.user,reason(req.body?.reason)]);return {id:req.params.user,sessions_revoked:r.n};});});
 // Invitee acceptance: authenticated session, CSRF-checked, no prior membership required.
 app.post('/api/v1/invitations/:ws/:id/accept',async(req:any)=>{const {ws,id}=req.params;if(!UUID.test(ws)&&!/^[0-9a-f-]{36}$/.test(ws)||!UUID.test(id))throw fail(404,'NOT_FOUND');
  const ctx=databaseScope.getStore();if(!ctx)throw Error('AUTH_CONTEXT_REQUIRED');ctx.workspace=ws;
  const db=await pool.connect();try{await db.query('BEGIN');const r=await call(db,'SELECT alder_membership_accept($1,$2) AS roles',[ws,id]);await db.query('COMMIT');return {workspace_id:ws,roles:r.roles,state:'accepted'};}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}});
}
