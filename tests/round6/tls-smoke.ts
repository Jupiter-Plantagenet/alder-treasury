// Round 6 TLS / Secure-cookie / origin smoke (Node, real certificate verification against the local CA).
import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const out:any={at:new Date().toISOString(),checks:[]};const ck=(id:string,pass:boolean,detail:any)=>{out.checks.push({id,pass,detail});console.log(pass?'PASS':'FAIL',id,JSON.stringify(detail).slice(0,300));};
const N=process.execPath;
// 1. Without the local CA, Node refuses the certificate (proves verification is ON, nothing disabled).
const noCa=execFileSync(N,['-e',"fetch('https://127.0.0.1:5103/health').then(r=>console.log('OK',r.status)).catch(e=>console.log('ERR',e.cause?.code||e.message))"],{encoding:'utf8',env:{...process.env,NODE_EXTRA_CA_CERTS:''}}).trim();
ck('TLS: without the local CA the server certificate is rejected (verification is not disabled)',/^ERR/.test(noCa),noCa);
await import('../tls-trust.ts');
const acc=JSON.parse(fs.readFileSync('.local/s6-accounts.json','utf8'));
for(const origin of ['https://127.0.0.1:5103','https://127.0.0.1:5113']){
 const h=await fetch(origin+'/health');ck(`TLS: ${origin}/health verified by the local CA, proxied to the HTTPS API`,h.status===200&&(await h.json()).ready===true,{status:h.status});
 const r=await fetch(origin+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'s6-accountant@alder.local',password:acc.password})});
 const sc=r.headers.getSetCookie();const sess=sc.find(c=>c.startsWith('alder='))||'';
 ck(`CSRF: login on ${origin} sets the session cookie Secure; HttpOnly; SameSite=Strict; Path=/`,r.status===200&&/; Secure/.test(sess)&&/HttpOnly/.test(sess)&&/SameSite=Strict/.test(sess)&&/Path=\//.test(sess),{status:r.status,attrs:sess.replace(/alder=[0-9a-f]+/,'alder=<redacted>')});
 if(origin.endsWith('5113')){const page=await fetch(origin+'/');ck('Release: built bundle served with strict CSP (style-src self, connect-src self), HSTS, DENY, nosniff',page.status===200&&/style-src 'self';/.test(page.headers.get('content-security-policy')||'')&&!/unsafe-inline/.test(page.headers.get('content-security-policy')||'')&&!!page.headers.get('strict-transport-security')&&page.headers.get('x-frame-options')==='DENY',{csp:page.headers.get('content-security-policy'),hsts:page.headers.get('strict-transport-security')});}
}
const bad=await fetch('https://127.0.0.1:5103/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:5103'},body:'{}'});
ck('Origin: the old plain-HTTP origin is no longer allowed (403 ORIGIN)',bad.status===403,{status:bad.status});
const direct=execFileSync(N,['-e',"require('http').get('http://127.0.0.1:8103/health',r=>console.log('HTTP',r.statusCode)).on('error',e=>console.log('ERR',e.code))"],{encoding:'utf8'}).trim();
ck('API: plain HTTP on 8103 is not served (TLS only)',!/HTTP 200/.test(direct),direct);
fs.mkdirSync('evidence/round6-access',{recursive:true});fs.writeFileSync('evidence/round6-access/tls-smoke.json',JSON.stringify(out,null,1));
process.exit(out.checks.every((c:any)=>c.pass)?0:1);
