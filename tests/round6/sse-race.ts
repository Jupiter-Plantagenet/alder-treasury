// Round 6 runner F-M5: SSE caps under concurrency (live, S6). 20 simultaneous opens from ONE session -> at most 3
// accepted; 3 sessions x 20 simultaneous opens for ONE user -> at most 6 accepted; slots are freed on close.
import {S,Runner,expect,sleep,stream} from './s6-lib.ts';
const R=new Runner('sse-race');
await R.check('F-M5','20 concurrent opens from one session: <=3 accepted (cap 3/session), the rest 429 SSE_LIMIT',async()=>{const s=await S.as('s6-accountant');
 const all=await Promise.all(Array.from({length:20},()=>stream(s)));const ok=all.filter(x=>x.status===200).length,limited=all.filter(x=>x.status===429).length;
 all.forEach(x=>x.close());await sleep(800);expect(ok<=3&&ok>=1&&ok+limited===20,'session cap',{ok,limited});return {accepted:ok,limited};});
await R.check('F-M5','3 sessions x 20 concurrent opens for one user: <=6 accepted in total (cap 6/user)',async()=>{const ss=await Promise.all([S.as('s6-priya'),S.as('s6-priya'),S.as('s6-priya')]);
 const all=await Promise.all(ss.flatMap(s=>Array.from({length:20},()=>stream(s))));const ok=all.filter(x=>x.status===200).length;
 all.forEach(x=>x.close());await sleep(800);expect(ok<=6&&ok>=1,'user cap',{ok});return {accepted:ok,total:all.length};});
await R.check('F-M5','slots are released on close: after closing, a new stream is accepted again',async()=>{const s=await S.as('s6-accountant');await sleep(500);const a=await stream(s);a.close();
 expect(a.status===200,'reopen',a.status);return {reopen:a.status};});
await R.check('F-M5','slots are released when the client closes THROUGH each front proxy (dev 5103, release 5113) and direct: open 3, close, reopen 3 -> all 200 (found and fixed: the dev proxy leaked closed SSE upstreams)',async()=>{const res:any={};
 for(const origin of ['https://127.0.0.1:5103','https://127.0.0.1:5113','https://127.0.0.1:8103']){const s=await S.as('s6-admin2','https://127.0.0.1:5103');s.origin=origin;
  const a=await Promise.all([stream(s),stream(s),stream(s)]);a.forEach(x=>x.close());await sleep(2500);const b=await Promise.all([stream(s),stream(s),stream(s)]);b.forEach(x=>x.close());await sleep(2500);
  res[origin]={first:a.map(x=>x.status),after_close:b.map(x=>x.status)};}
 expect(Object.values(res).every((r:any)=>[...r.first,...r.after_close].every((x:number)=>x===200)),'release',res);return res;});
const out=R.finish();process.exit(out.failed?1:0);
