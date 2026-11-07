// Round 6 runner library (access agent). LIVE stack over HTTPS: UI origin https://127.0.0.1:5103 (Vite proxy) or the
// release origin https://127.0.0.1:5113 -> API https://127.0.0.1:8103 -> PostgreSQL `alder` -> Anvil 8547.
// Workspace S6 only (00000000-0000-4000-8000-0000000000c6); password from .local/s6-accounts.json, never printed.
import '../tls-trust.ts';import fs from 'node:fs';import {randomUUID} from 'node:crypto';import pg from 'pg';
export const ORIGIN=process.env.ALDER_ORIGIN||'https://127.0.0.1:5103';
export const S6=JSON.parse(fs.readFileSync('.local/s6-accounts.json','utf8'));export const WS6:string=S6.workspace;export const USERS6:Record<string,string>=S6.users;
export const run='S6'+Date.now().toString(36).toUpperCase();
export const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export const db=new pg.Pool({connectionString:'postgresql://postgres@127.0.0.1:5543/alder',max:2,options:'-c default_transaction_read_only=on'});
export const q=async(sql:string,args:any[]=[])=>(await db.query(sql,args)).rows;
export async function login(handle:string,opts:{email?:string,password?:string,device?:string,origin?:string}={}){
 const o=opts.origin||ORIGIN;const headers:any={'content-type':'application/json',origin:o};if(opts.device)headers.cookie=opts.device;
 const r=await fetch(o+'/api/v1/auth/login',{method:'POST',headers,body:JSON.stringify({email:opts.email??`${handle}@alder.local`,password:opts.password??S6.password})});
 const set=r.headers.getSetCookie();const body:any=await r.json().catch(()=>null);
 return {status:r.status,body,retryAfter:r.headers.get('retry-after'),cookie:(set.find(c=>c.startsWith('alder='))||'').split(';')[0],device:(set.find(c=>c.startsWith('alder_dev='))||'').split(';')[0],setCookie:set};
}
export class S{cookie='';csrf='';user='';constructor(public handle:string,public origin=ORIGIN){}
 static async as(handle:string,origin=ORIGIN){const s=new S(handle,origin);const l=await login(handle,{origin});if(l.status!==200)throw Error('LOGIN_FAILED '+handle+' '+l.status);s.cookie=l.cookie;s.csrf=l.body.csrf;s.user=l.body.user.id;return s;}
 async req(method:string,path:string,body?:any,opts:{key?:string,ifMatch?:number}={}){const headers:any={cookie:this.cookie,origin:this.origin};if(opts.ifMatch!==undefined)headers['if-match']=`"${opts.ifMatch}"`;
  if(method!=='GET'){headers['x-csrf-token']=this.csrf;headers['idempotency-key']=opts.key||randomUUID();if(body!==undefined)headers['content-type']='application/json';}
  const url=this.origin+(path.startsWith('/api/')||path.startsWith('/health')?path:`/api/v1/workspaces/${WS6}${path}`);
  const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let json:any;try{json=JSON.parse(text);}catch{json=text;}return {status:r.status,body:json,headers:r.headers};}
 get=(p:string)=>this.req('GET',p);post=(p:string,b:any={},o?:any)=>this.req('POST',p,b,o);
}
export class Runner{results:any[]=[];notes:any[]=[];constructor(public name:string){}
 note(id:string,clause:string,detail:any){this.notes.push({id,clause,detail});console.log('INFO',id,clause);}
 async check(id:string,clause:string,fn:()=>Promise<any>){const t=Date.now();try{const detail=await fn();this.results.push({id,clause,pass:true,ms:Date.now()-t,detail});console.log('PASS',id,clause);}catch(e:any){this.results.push({id,clause,pass:false,ms:Date.now()-t,error:String(e?.message||e).slice(0,1500)});console.log('FAIL',id,clause,String(e?.message||e).slice(0,600));}}
 finish(){const out={runner:this.name,run,origin:ORIGIN,workspace:WS6,at:new Date().toISOString(),passed:this.results.filter(r=>r.pass).length,failed:this.results.filter(r=>!r.pass).length,results:this.results,notes:this.notes};
  fs.mkdirSync('evidence/round6-access',{recursive:true});fs.writeFileSync(`evidence/round6-access/${this.name}-${run}.json`,JSON.stringify(out,null,1));console.log('SUMMARY',this.name,out.passed,'/',this.results.length);return out;}
}
export function expect(c:any,msg:string,detail?:any){if(!c)throw Error('ASSERTION '+msg+(detail===undefined?'':' :: '+JSON.stringify(detail).slice(0,1200)));}
// Open an SSE stream; resolves once headers arrive. Collects event names.
export async function stream(s:S){const ac=new AbortController();const r=await fetch(`${s.origin}/api/v1/workspaces/${WS6}/events/stream`,{headers:{cookie:s.cookie,origin:s.origin},signal:ac.signal});
 const out:any={status:r.status,events:[] as string[],closed:false,close:()=>ac.abort()};
 if(r.status===200&&r.body){(async()=>{const dec=new TextDecoder();try{for await(const ch of r.body as any){for(const m of dec.decode(ch).matchAll(/^event: (\S+)/gm))out.events.push(m[1]);}}catch{}out.closed=true;})();}else{await r.text().catch(()=>{});}
 return out;}

// Chromium/Chrome: trust exactly the local leaf certificate by SPKI pin (no blanket certificate-error bypass).
export const chromeTlsArgs=()=>[`--ignore-certificate-errors-spki-list=${fs.readFileSync('.local/tls/server.spki','utf8').trim()}`];
export const randomAddress=()=>'0x'+[...crypto.getRandomValues(new Uint8Array(20))].map(b=>b.toString(16).padStart(2,'0')).join('');
