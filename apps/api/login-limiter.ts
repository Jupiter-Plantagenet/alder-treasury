// Round 6 login limiter. Identity budgets for database-known users live in login-throttle.ts,
// keyed by user UUID so arbitrary nonexistent usernames cannot consume memory or durable rows.
// Account and valid-device failures use bounded persisted timestamp arrays; device rows are capped
// per user and overflow uses that user's account budget. The in-process client map is hard-bounded
// and only slows new/saturated clients; it never denies a correct password or replaces user state.
import {createHmac,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {deviceKey,fromTrustedProxy} from './tls.ts';
export const normalizeAccount=(e:unknown)=>String(e??'').normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu,'').trim().toLowerCase().slice(0,320);
export const LIMITS={ACCOUNT_WINDOW_MS:15*60000,FREE_FAILURES:5,MAX_DELAY_MS:60000,CLIENT_WINDOW_MS:60000,CLIENT_SOFT:50,CLIENT_SLOW_MS:1000,DEVICE_FAILURES:10,DEVICE_TTL_S:180*86400,MAX_TRACKED_KEYS:10000};
const b64=(b:Buffer)=>b.toString('base64url');
const acctTag=(account:string)=>createHash('sha256').update('alder-acct:'+account).digest('base64url').slice(0,22);
export function issueDevice(account:string,key=deviceKey()){const body=b64(Buffer.from(JSON.stringify({a:acctTag(account),i:b64(randomBytes(12)),e:Math.floor(Date.now()/1000)+LIMITS.DEVICE_TTL_S})));return body+'.'+b64(createHmac('sha256',key).update(body).digest());}
export function verifyDevice(cookie:string|undefined,account:string,key=deviceKey()):string|null{
 if(!cookie||!/^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/.test(cookie))return null;const [body,mac]=cookie.split('.');
 const want=createHmac('sha256',key).update(body).digest(),got=Buffer.from(mac,'base64url');if(got.length!==want.length||!timingSafeEqual(got,want))return null;
 try{const p=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));return p.a===acctTag(account)&&typeof p.e==='number'&&p.e>Date.now()/1000&&typeof p.i==='string'?p.i:null;}catch{return null;}
}
export function clientKey(req:{headers:any,socket?:any,raw?:any,ip?:string}){const sock=req.raw?.socket?.remoteAddress||req.socket?.remoteAddress||req.ip||'unknown';
 if(fromTrustedProxy(req.headers)){const x=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();if(/^[0-9a-fA-F:.]{2,45}$/.test(x))return 'proxy:'+x;}return 'socket:'+sock;}
export const delayFor=(failures:number)=>failures<LIMITS.FREE_FAILURES?0:Math.min(LIMITS.MAX_DELAY_MS,1000*2**(failures-LIMITS.FREE_FAILURES));
export class LoginLimiter{
 clients=new Map<string,number[]>();private n=0;
 constructor(private now=()=>Date.now(),private maxTrackedKeys=LIMITS.MAX_TRACKED_KEYS){}
 private prune(){const t=this.now();for(const [k,v] of this.clients){const f=v.filter(x=>x>t-LIMITS.CLIENT_WINDOW_MS);if(f.length)this.clients.set(k,f);else this.clients.delete(k);}}
 /** Client buckets are deliberately soft; saturated new keys are delayed, never denied. */
 gate(client:string):number{if(++this.n%200===0)this.prune();const failures=(this.clients.get(client)||[]).filter(x=>x>this.now()-LIMITS.CLIENT_WINDOW_MS);return failures.length>=LIMITS.CLIENT_SOFT||(!this.clients.has(client)&&this.clients.size>=this.maxTrackedKeys)?LIMITS.CLIENT_SLOW_MS:0;}
 failure(client:string){const t=this.now(),current=this.clients.get(client);if(current)this.clients.set(client,[...current.filter(x=>x>t-LIMITS.CLIENT_WINDOW_MS),t].slice(-LIMITS.CLIENT_SOFT));else if(this.clients.size<this.maxTrackedKeys)this.clients.set(client,[t]);}
}
