import '../tls-trust.ts';// Round-4 real-API client: talks through the real UI origin; ALDER_ORIGIN selects compiled release (default dev UI).
// Credentials come from the private .local/accounts.json and are never printed or logged.
import fs from 'node:fs';import {randomUUID} from 'node:crypto';
export const ORIGIN=process.env.ALDER_ORIGIN||'https://127.0.0.1:5103';
// Round 6: ALDER_ACCOUNTS_FILE / ALDER_EMAIL_PREFIX let the same runners target the S6 workspace (.local/s6-accounts.json, s6-*).
export const accounts=JSON.parse(fs.readFileSync(process.env.ALDER_ACCOUNTS_FILE||'.local/accounts.json','utf8'));
export const WS:string=accounts.workspace;
export type Who='jordan'|'priya'|'owner'|'accountant';
export const email=(who:Who)=>`${process.env.ALDER_EMAIL_PREFIX||''}${who}@alder.local`;
export const password=()=>accounts.password as string;
export class Session{
 cookie='';csrf='';constructor(public who:Who){}
 static async login(who:Who,base=ORIGIN){const s=new Session(who);const r=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({email:email(who),password:password()})});if(r.status!==200)throw Error('LOGIN_FAILED '+who+' '+r.status);s.cookie=(r.headers.get('set-cookie')||'').split(';')[0];s.csrf=(await r.json()).csrf;return s;}
 async req(method:string,path:string,body?:any,opts:{key?:string,ifMatch?:string|number,origin?:string|null,csrf?:string|null,base?:string}={}){
  const headers:any={cookie:this.cookie};const o=opts.origin===undefined?ORIGIN:opts.origin;if(o)headers.origin=o;
  if(method!=='GET'){headers['x-csrf-token']=opts.csrf===undefined?this.csrf:(opts.csrf??'');headers['idempotency-key']=opts.key||randomUUID();if(body!==undefined)headers['content-type']='application/json';}
  if(opts.ifMatch!==undefined)headers['if-match']=`"${opts.ifMatch}"`;
  const url=(opts.base||ORIGIN)+(path.startsWith('/api/')||path.startsWith('/health')?path:`/api/v1/workspaces/${WS}${path}`);
  const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let json:any;try{json=JSON.parse(text);}catch{json=text;}
  return {status:r.status,body:json};
 }
 get=(p:string,o?:any)=>this.req('GET',p,undefined,o);post=(p:string,b:any,o?:any)=>this.req('POST',p,b,o);put=(p:string,b:any,o?:any)=>this.req('PUT',p,b,o);
}
export function expect(cond:any,msg:string,detail?:any){if(!cond){throw Error('ASSERTION '+msg+(detail===undefined?'':' :: '+JSON.stringify(detail).slice(0,800)));}}
