import {createHash} from 'node:crypto';
import {delayFor,LIMITS} from './login-limiter.ts';

export const MAX_DEVICE_BUCKETS_PER_USER=32,OVERFLOW_DEVICE_BUCKETS_PER_USER=32,MAX_FAILURE_TIMESTAMPS=64;
type Row={failure_times?:unknown,next_at?:unknown};
type Gate={action:'deny',retryAfterS:number}|{action:'allow'};
const millis=(v:any)=>{if(v instanceof Date)return v.getTime();if(v==='-infinity')return Number.NEGATIVE_INFINITY;const n=Date.parse(String(v));return Number.isFinite(n)?n:Number.NEGATIVE_INFINITY;};
const failures=(v:any,now:number)=>Array.isArray(v)?v.map(millis).filter((x:number)=>x>now-LIMITS.ACCOUNT_WINDOW_MS&&x<=now):[];
const denied=(row:Row,now:number):Gate=>{const next=millis(row.next_at);return next>now?{action:'deny',retryAfterS:Math.max(1,Math.ceil((next-now)/1000))}:{action:'allow'};};
// Direct device rows use the 0-prefixed namespace; fixed overflow buckets use 1.
const deviceKey=(id:string)=>'0'+createHash('sha256').update('alder-login-device:'+id).digest('hex').slice(1);
// Overflow devices hash deterministically to one of 32 per-user buckets. Collisions
// conservatively share a device delay budget (false-positive slowdown), never account state.
const overflowDeviceKey=(userId:string,id:string)=>{const index=Number(BigInt('0x'+createHash('sha256').update('alder-login-overflow-index:'+userId+':'+id).digest('hex'))%BigInt(OVERFLOW_DEVICE_BUCKETS_PER_USER));return '1'+createHash('sha256').update('alder-login-overflow-bucket:'+userId+':'+index).digest('hex').slice(1);};
async function withUserLock<T>(pool:any,userId:string,fn:(db:any,account:Row)=>Promise<T>):Promise<T>{
 const db=await pool.connect();try{await db.query('BEGIN');await db.query("INSERT INTO login_account_throttles(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",[userId]);const account=(await db.query('SELECT failure_times,next_at FROM login_account_throttles WHERE user_id=$1 FOR UPDATE',[userId])).rows[0] as Row;await db.query('DELETE FROM login_device_throttles WHERE user_id=$1 AND expires_at<=now()',[userId]);const value=await fn(db,account);await db.query('COMMIT');return value;}catch(e){try{await db.query('ROLLBACK');}catch{/* preserve the original throttle/database failure */}throw e;}finally{db.release();}}
async function readDevice(db:any,userId:string,key:string,kind:'device'|'overflow'){return (await db.query('SELECT failure_times,next_at FROM login_device_throttles WHERE user_id=$1 AND device_hash=$2 AND bucket_kind=$3 FOR UPDATE',[userId,key,kind])).rows[0] as Row|undefined;}
async function writeFailure(db:any,userId:string,table:'login_account_throttles'|'login_device_throttles',deviceHash:string|undefined,kind:'device'|'overflow'|undefined,row:Row|undefined,now:number){
 const times=failures(row?.failure_times,now);times.push(now);const bounded=times.slice(-MAX_FAILURE_TIMESTAMPS),next=table==='login_account_throttles'?new Date(now+delayFor(bounded.length)):'-infinity';
 if(table==='login_account_throttles')await db.query('UPDATE login_account_throttles SET failure_times=$2::timestamptz[],next_at=$3,updated_at=now() WHERE user_id=$1',[userId,bounded.map(x=>new Date(x)),next]);
 else await db.query('INSERT INTO login_device_throttles(user_id,device_hash,bucket_kind,failure_times,next_at,expires_at) VALUES($1,$2,$3,$4::timestamptz[],$5,now()+interval \'180 days\') ON CONFLICT(user_id,bucket_kind,device_hash) DO UPDATE SET failure_times=EXCLUDED.failure_times,next_at=EXCLUDED.next_at,expires_at=EXCLUDED.expires_at,updated_at=now()',[userId,deviceHash,kind,bounded.map(x=>new Date(x)),next]);
}
type DeviceBucket={key:string,kind:'device'|'overflow',row:Row|undefined};
async function deviceBucket(db:any,userId:string,id:string):Promise<DeviceBucket>{
 const key=deviceKey(id),direct=await readDevice(db,userId,key,'device');if(direct)return {key,kind:'device',row:direct};
 const overflowKey=overflowDeviceKey(userId,key),overflow=await readDevice(db,userId,overflowKey,'overflow');if(overflow)return {key:overflowKey,kind:'overflow',row:overflow};
 const count=Number((await db.query("SELECT count(*)::int AS n FROM login_device_throttles WHERE user_id=$1 AND bucket_kind='device' AND device_hash LIKE '0%'",[userId])).rows[0]?.n||0);
 if(count<MAX_DEVICE_BUCKETS_PER_USER)return {key,kind:'device',row:undefined};return {key:overflowKey,kind:'overflow',row:undefined};
}
function deviceGate(row:Row|undefined,now:number):Gate{const recent=failures(row?.failure_times,now);if(recent.length<LIMITS.DEVICE_FAILURES)return {action:'allow'};return {action:'deny',retryAfterS:Math.max(1,Math.ceil((recent[0]+LIMITS.ACCOUNT_WINDOW_MS-now)/1000))};}
async function resetAccount(db:any,userId:string){await db.query("UPDATE login_account_throttles SET failure_times='{}',next_at='-infinity',updated_at=now() WHERE user_id=$1",[userId]);}
export type LoginAttemptResult={action:'authenticated'}|{action:'invalid'}|{action:'deny',retryAfterS:number};
/** Hold the user row lock over gate, synchronous password verification and state update. */
export async function authenticateKnownUser(pool:any,userId:string,deviceId:string|null,verifyPassword:()=>boolean,now=Date.now()):Promise<LoginAttemptResult>{return withUserLock(pool,userId,async(db,account)=>{
  const bucket=deviceId?await deviceBucket(db,userId,deviceId):undefined,g=deviceId?deviceGate(bucket!.row,now):denied(account,now);if(g.action==='deny')return g;
  if(!verifyPassword()){if(bucket)await writeFailure(db,userId,'login_device_throttles',bucket.key,bucket.kind,bucket.row,now);else await writeFailure(db,userId,'login_account_throttles',undefined,undefined,account,now);return {action:'invalid'};}
  await resetAccount(db,userId);if(bucket)await db.query('DELETE FROM login_device_throttles WHERE user_id=$1 AND device_hash=$2 AND bucket_kind=$3',[userId,bucket.key,bucket.kind]);return {action:'authenticated'};
});}
export async function loginThrottleGate(pool:any,userId:string,deviceId:string|null,now=Date.now()):Promise<Gate>{return withUserLock(pool,userId,async(db,account)=>{
 if(!deviceId)return denied(account,now);const bucket=await deviceBucket(db,userId,deviceId);return deviceGate(bucket.row,now);
});}
export async function recordLoginFailure(pool:any,userId:string,deviceId:string|null,now=Date.now()):Promise<void>{return withUserLock(pool,userId,async(db,account)=>{
 if(deviceId){const bucket=await deviceBucket(db,userId,deviceId);await writeFailure(db,userId,'login_device_throttles',bucket.key,bucket.kind,bucket.row,now);return;}
 await writeFailure(db,userId,'login_account_throttles',undefined,undefined,account,now);
});}
export async function clearLoginFailures(pool:any,userId:string,deviceId:string|null):Promise<void>{return withUserLock(pool,userId,async(db)=>{
 await resetAccount(db,userId);if(deviceId){const bucket=await deviceBucket(db,userId,deviceId);if(bucket.row)await db.query('DELETE FROM login_device_throttles WHERE user_id=$1 AND device_hash=$2 AND bucket_kind=$3',[userId,bucket.key,bucket.kind]);}
});}
