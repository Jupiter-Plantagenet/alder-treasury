import {createHash} from 'node:crypto';
import {requestFingerprint} from '../../packages/canonical.ts';
// Extracted verbatim from app.ts so route modules can be exercised with an injected pool.
// Semantics unchanged: role check -> idempotency key -> canonical digest -> one transaction
// (actor/command/key advisory lock, replay/409, workspace domain lock, effect, cache row, event row).
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');const json=(v:any)=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));const fail=(status:number,code:string)=>Object.assign(new Error(code),{statusCode:status});
// Commands serialized on the workspace domain lock (destination, review, freeze and, now, review policy edits).
export const DOMAIN_LOCKED_COMMANDS=['freeze','allowance-freeze','operation-signature','operation-prepare','contact-create','payable-create','attachment-link','destination-revise','destination-verify','payable-destination-revise','review','policy-create','policy-revise','invalidation-propose','payable-import','membership-admin'];
export function createMutate(pool:any){return async(req:any,roles:string[],command:string,fn:(db:any)=>Promise<any>,afterRollback?:(db:any)=>void|Promise<void>)=>{if(!req.roles.some((x:string)=>roles.includes(x)))throw fail(403,'ROLE_DENIED');const key=req.headers['idempotency-key'];if(typeof key!=='string'||key.length>128)throw fail(422,'IDEMPOTENCY_KEY_REQUIRED');const ws=req.params.ws,actor=req.identity.user_id;const digest=hash(requestFingerprint(req));const db=await pool.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[ws+actor+command+key]);const prior=(await db.query('SELECT * FROM idempotency WHERE workspace_id=$1 AND actor_id=$2 AND command=$3 AND key=$4',[ws,actor,command,key])).rows[0];if(prior){if(prior.digest!==digest)throw fail(409,'IDEMPOTENCY_CONFLICT');await db.query('COMMIT');return prior.result;}if(DOMAIN_LOCKED_COMMANDS.includes(command))await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['destination:'+ws]);const result=json(await fn(db));await db.query('INSERT INTO idempotency VALUES($1,$2,$3,$4,$5,$6)',[ws,actor,command,key,digest,result]);await db.query('INSERT INTO events(workspace_id,actor_id,kind,data) VALUES($1,$2,$3,$4)',[ws,actor,command,{id:result.id||null}]);await db.query('COMMIT');return result;}catch(e){let rolledBack=false;try{await db.query('ROLLBACK');rolledBack=true;}catch{/* A failed/ambiguous rollback must preserve external artifacts. */}if(rolledBack&&afterRollback)try{await afterRollback(db);}catch{/* Cleanup failure must not hide the transaction error. */}throw mapDatabaseError(e);}finally{db.release();}};}
// Round 6 (round-5 ops finding 8): database conflicts are typed client/retry errors, never a generic 500.
//  - unique violation on operation_exact_intent: the identical SafeTx hash (same chain id, Safe, calldata, safeTxGas and
//    nonce) already exists in this workspace, e.g. an authorization frozen on another chain instance with the same chain
//    id and Safe address -> 409 SAFE_TX_HASH_COLLISION;
//  - any other unique violation -> 409 UNIQUE_CONFLICT (constraint named, no row data);
//  - serialization failure / deadlock / lock or statement timeout -> 503 retryable.
export function mapDatabaseError(e:any){
 if(!e||e.statusCode)return e;
 if(e.code==='23505'){if(e.constraint==='operation_exact_intent')return Object.assign(new Error('SAFE_TX_HASH_COLLISION'),{statusCode:409,details:{constraint:e.constraint,reason:'an operation with this exact SafeTx hash already exists in this workspace (same chain id, Safe address and nonce; possibly another chain instance). Nothing was stored.'}});
  return Object.assign(new Error('UNIQUE_CONFLICT'),{statusCode:409,details:{constraint:e.constraint??null}});}
 if(['40001','40P01','55P03','57014'].includes(e.code))return Object.assign(new Error('DATABASE_BUSY'),{statusCode:503,details:{sqlstate:e.code}});
 return e;
}
