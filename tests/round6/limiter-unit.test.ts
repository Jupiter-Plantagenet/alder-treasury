// Focused login throttle checks. The persisted throttle tests use a small SQL model;
// production PostgreSQL transaction/RLS certification remains a separate gate.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {LoginLimiter,normalizeAccount,clientKey,issueDevice,verifyDevice,LIMITS} from '../../apps/api/login-limiter.ts';
import {authenticateKnownUser,loginThrottleGate,recordLoginFailure,MAX_DEVICE_BUCKETS_PER_USER} from '../../apps/api/login-throttle.ts';
import {proxySecret} from '../../apps/api/tls.ts';

function throttlePool(){const accounts=new Map<string,any>(),devices=new Map<string,any>(),tails=new Map<string,Promise<void>>();return {accounts,devices,async connect(){const unlocks:(()=>void)[]=[];return {release(){},async query(sql:string,args:any[]=[]){
 if(sql==='BEGIN')return {rows:[]};if(sql==='COMMIT'||sql==='ROLLBACK'){for(const unlock of unlocks.splice(0))unlock();return {rows:[]};}
 if(sql.startsWith('INSERT INTO login_account_throttles')){if(!accounts.has(args[0]))accounts.set(args[0],{failure_times:[],next_at:new Date(0)});return {rows:[]};}
 if(sql.startsWith('SELECT failure_times,next_at FROM login_account_throttles')){const user=args[0];let unlock!:()=>void;const current=new Promise<void>(resolve=>{unlock=resolve;}),previous=tails.get(user)||Promise.resolve();tails.set(user,current);await previous;unlocks.push(()=>{unlock();if(tails.get(user)===current)tails.delete(user);});return {rows:accounts.has(user)?[{...accounts.get(user)}]:[]};}
 if(sql.startsWith('DELETE FROM login_device_throttles WHERE user_id=$1 AND expires_at'))return {rows:[]};
 if(sql.startsWith('SELECT failure_times,next_at FROM login_device_throttles')){const d=devices.get(args[0]+':'+args[2]+':'+args[1]);return {rows:d?[{...d}]:[]};}
 if(sql.startsWith('SELECT count(*)::int AS n FROM login_device_throttles'))return {rows:[{n:[...devices.keys()].filter(k=>k.startsWith(args[0]+':device:0')).length}]};
 if(sql.startsWith('UPDATE login_account_throttles SET failure_times=$2')){accounts.set(args[0],{failure_times:args[1],next_at:args[2]});return {rows:[]};}
 if(sql.startsWith('INSERT INTO login_device_throttles')){devices.set(args[0]+':'+args[2]+':'+args[1],{failure_times:args[3],next_at:args[4]});return {rows:[]};}
 throw new Error('unmodeled throttle SQL: '+sql);
}};}};}

test('normalised account key: case, whitespace, zero-width, NFKC variants collapse',()=>{
 for(const v of ['S6-Victim@Alder.Local',' s6-victim@alder.local ','s6-vic​tim@alder.local','ｓ6-victim@alder.local','s6-victim@alder.local⁠'])assert.equal(normalizeAccount(v),'s6-victim@alder.local');});
test('client state remains hard-bounded and saturated clients receive a soft delay, never denial',()=>{const L=new LoginLimiter(()=>1_000_000,2);L.failure('client-a');L.failure('client-b');L.failure('client-a');assert.equal(L.clients.size,2);assert.equal(L.gate('client-c'),LIMITS.CLIENT_SLOW_MS);for(let i=0;i<100;i++)L.failure('client-c');assert.equal(L.clients.size,2);assert.equal(L.gate('client-c'),LIMITS.CLIENT_SLOW_MS);});
test('known account failures persist independently of saturated process client state and keep exponential delay',async()=>{let now=1_000_000;const pool=throttlePool(),user='known-user',client=new LoginLimiter(()=>now,1);client.failure('already-tracked');assert.equal(client.gate('untracked'),LIMITS.CLIENT_SLOW_MS);for(let i=0;i<5;i++)await recordLoginFailure(pool,user,null,now);assert.deepEqual(await loginThrottleGate(pool,user,null,now),{action:'deny',retryAfterS:1});assert.equal(pool.accounts.size,1);now+=1001;assert.deepEqual(await loginThrottleGate(pool,user,null,now),{action:'allow'});await recordLoginFailure(pool,user,null,now);assert.deepEqual(await loginThrottleGate(pool,user,null,now),{action:'deny',retryAfterS:2});});
test('valid devices retain separate bounded budgets through hashed overflow buckets',async()=>{const pool=throttlePool(),user='known-user',now=2_000_000;
 for(let i=0;i<5;i++)await recordLoginFailure(pool,user,null,now);assert.equal((await loginThrottleGate(pool,user,null,now)).action,'deny');
 for(let i=0;i<10;i++)await recordLoginFailure(pool,user,'device-primary',now);assert.deepEqual(await loginThrottleGate(pool,user,'device-primary',now),{action:'deny',retryAfterS:900});
 for(let i=0;i<MAX_DEVICE_BUCKETS_PER_USER-1;i++)await recordLoginFailure(pool,user,'device-'+i,now);
 assert.equal(pool.devices.size,MAX_DEVICE_BUCKETS_PER_USER);assert.deepEqual(await loginThrottleGate(pool,user,'overflow-device',now),{action:'allow'});
 for(let i=0;i<10;i++)await recordLoginFailure(pool,user,'overflow-device',now);
 assert.deepEqual(await loginThrottleGate(pool,user,'overflow-device',now),{action:'deny',retryAfterS:900});assert.equal(pool.accounts.get(user).failure_times.length,5);assert.equal(pool.devices.size,MAX_DEVICE_BUCKETS_PER_USER+1);
});
test('per-user row lock serializes gate, password result, and failure update',async()=>{const pool=throttlePool(),user='parallel-user';let checks=0;const results=await Promise.all(Array.from({length:6},()=>authenticateKnownUser(pool,user,null,()=>{checks++;return false;},5_000_000)));assert.equal(checks,5);assert.equal(results.filter(r=>r.action==='invalid').length,5);assert.deepEqual(results.filter(r=>r.action==='deny'),[{action:'deny',retryAfterS:1}]);assert.equal(pool.accounts.get(user).failure_times.length,5);});
test('device cookie proves prior success for this account only',()=>{const key=Buffer.alloc(32,7);const dev=issueDevice('v@x',key);const id=verifyDevice(dev,'v@x',key);assert.ok(id);assert.equal(verifyDevice(dev,'other@x',key),null);assert.equal(verifyDevice(dev.slice(0,-2)+'AA','v@x',key),null);});
test('clientKey trusts X-Forwarded-For only with the exact proxy secret',()=>{const s=proxySecret();const base={raw:{socket:{remoteAddress:'127.0.0.1'}}};
 assert.equal(clientKey({...base,headers:{'x-forwarded-for':'203.0.113.9'}}),'socket:127.0.0.1');
 assert.equal(clientKey({...base,headers:{'x-forwarded-for':'203.0.113.9','x-alder-proxy':'0'.repeat(64)}}),'socket:127.0.0.1');
 if(s)assert.equal(clientKey({...base,headers:{'x-forwarded-for':'203.0.113.9','x-alder-proxy':s.toString()}}),'proxy:203.0.113.9');});
