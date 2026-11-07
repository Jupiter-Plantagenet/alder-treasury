// Round 6 runner F-M2 (login limiter) against the LIVE stack through the HTTPS Vite proxy (all browsers arrive as
// 127.0.0.1). Accounts: S6 only. The "attacker" uses random non-existent addresses and the s6-victim account.
import {login,Runner,expect,sleep,ORIGIN} from './s6-lib.ts';import {randomUUID} from 'node:crypto';import '../tls-trust.ts';
const R=new Runner('limiter');
let victimDevice='';
await R.check('F-M2','setup: the victim signs in once from "their" browser and receives an HttpOnly Secure device cookie scoped to the login path',async()=>{const l=await login('s6-victim');victimDevice=l.device;
 const attrs=(l.setCookie.find(c=>c.startsWith('alder_dev='))||'').replace(/alder_dev=[^;]+/,'alder_dev=<redacted>');
 expect(l.status===200&&!!victimDevice&&/Secure/.test(attrs)&&/HttpOnly/.test(attrs)&&/Path=\/api\/v1\/auth\/login/.test(attrs),'device',{status:l.status,attrs});return {status:l.status,device_cookie_attrs:attrs};});
await R.check('F-M2','global lockout is gone: 60 failed logins for random addresses (one shared 127.0.0.1 client) do not stop an unrelated user; at most a soft delay',async()=>{
 const codes:Record<string,number>={};for(let i=0;i<60;i++){const r=await login('x',{email:`s6-nobody-${randomUUID()}@alder.local`,password:'wrong'});codes[r.status]=(codes[r.status]||0)+1;}
 const t=Date.now();const ok=await login('s6-accountant');const ms=Date.now()-t;
 expect(codes['401']===60&&ok.status===200,'global',{codes,ok:ok.status});return {attacker_statuses:codes,unrelated_user_status:ok.status,unrelated_user_latency_ms:ms,note:'per-client bucket is a slow-down (1 s) not a hard 429'};});
await R.check('F-M2','case/whitespace/invisible-character variants share ONE normalised account key (5 variants then backoff), so there is no per-variant bypass',async()=>{
 const variants=['S6-VICTIM@alder.local',' s6-victim@alder.local','s6-victim@ALDER.local\t','s6-vic​tim@alder.local','ｓ6-victim@alder.local'];const st:number[]=[];
 for(const v of variants){st.push((await login('x',{email:v,password:'wrong-'+v.length})).status);await sleep(20);}
 const sixth=await login('x',{email:'s6-victim@alder.local',password:'wrong'});
 expect(st.every(s=>s===401)&&sixth.status===429&&sixth.body?.error?.code==='ACCOUNT_BACKOFF','variants',{st,sixth:sixth.status,code:sixth.body?.error?.code});return {variant_statuses:st,sixth:{status:sixth.status,code:sixth.body.error.code,retry_after:sixth.retryAfter}};});
await R.check('F-M2','victim is NOT locked out: with the device cookie the correct password succeeds immediately during the backoff; without it, after the (short) delay',async()=>{
 const fresh=await login('s6-victim');const withDevice=await login('s6-victim',{device:victimDevice});
 const wait=Number(fresh.retryAfter||0);await sleep(wait*1000+300);const later=await login('s6-victim');
 expect(withDevice.status===200&&(fresh.status===200||(fresh.status===429&&wait<=60))&&later.status===200,'victim',{fresh:fresh.status,withDevice:withDevice.status,later:later.status,wait});
 return {fresh_browser_during_backoff:{status:fresh.status,retry_after_s:wait},device_cookie_during_backoff:withDevice.status,fresh_browser_after_delay:later.status};});
await R.check('F-M2','delay is exponential (1 s, 2 s, 4 s ...) and attempts during the delay are not counted (attacker gets at most one guess per step)',async()=>{
 const waits:number[]=[];let fails=0,denied=0;while(fails<8){const a=await login('x',{email:'s6-victim@alder.local',password:'bad'+fails});if(a.status===401)fails++;else if(a.status===429){denied++;const w=Number(a.retryAfter);waits.push(w);
  const extra=await login('x',{email:'s6-victim@alder.local',password:'bad-during-delay'});if(extra.status!==429)throw Error('attempt during delay was evaluated');await sleep(w*1000+150);}else throw Error('unexpected '+a.status);}
 const ok=await login('s6-victim',{device:victimDevice});
 expect(waits.length>=3&&waits[1]>waits[0]&&waits[2]>waits[1]&&ok.status===200,'expo',{waits,ok:ok.status});return {failures_evaluated:fails,retry_after_steps_s:waits,device_holder_still_ok:ok.status};});
await R.check('F-M2','a forged X-Forwarded-For / x-alder-proxy from a client is overwritten by the trusted proxy (client cannot pick its own bucket); a wrong proxy secret straight to the API is ignored',async()=>{
 const r=await fetch(ORIGIN+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN,'x-forwarded-for':'203.0.113.9','x-alder-proxy':'0'.repeat(64)},body:JSON.stringify({email:`s6-nobody-${randomUUID()}@alder.local`,password:'x'})});
 const d=await fetch('https://127.0.0.1:8103/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN,'x-forwarded-for':'198.51.100.7','x-alder-proxy':'f'.repeat(64)},body:JSON.stringify({email:`s6-nobody-${randomUUID()}@alder.local`,password:'x'})});
 expect(r.status===401&&d.status===401,'xff',{proxied:r.status,direct:d.status});return {via_proxy:r.status,direct_with_forged_secret:d.status,unit_evidence:'tests/round6/limiter-unit.test.ts asserts clientKey ignores XFF without the exact secret'};});
await R.check('F-M2','reset: the victim signs in normally (state cleared on success)',async()=>{await sleep(1500);const l=await login('s6-victim',{device:victimDevice});expect(l.status===200,'reset',l.status);return {status:l.status};});
const out=R.finish();process.exit(out.failed?1:0);
