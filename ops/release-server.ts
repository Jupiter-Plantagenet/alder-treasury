// Round 6 (review F-L8): production static server for the BUILT bundle (dist/) on the allow-listed release origin
// https://127.0.0.1:5113. No dev server, no HMR, no inline styles: strict CSP (style-src 'self'), HSTS, nosniff, DENY.
// /api/* and /health are proxied to the HTTPS API (certificate verified against the local CA) with the trusted-proxy
// secret and the browser socket address as X-Forwarded-For; client-supplied values for both are overwritten.
// Usage: node --import tsx ops/release-server.ts   (started by ops/round4-services.ps1 start release)
import https from 'node:https';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {parseReleasePath} from './release-path.ts';
const ROOT=path.resolve('dist'),TLS='.local/tls/',PORT=Number(process.env.ALDER_RELEASE_PORT||5113);
const CSP="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const ca=fs.readFileSync(TLS+'ca.pem'),secret=fs.readFileSync(TLS+'proxy-secret','utf8').trim();
const agent=new https.Agent({ca,keepAlive:true});
const TYPES:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const security=(res:any)=>{res.setHeader('Content-Security-Policy',CSP);res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Opener-Policy','same-origin');};
const manifest=JSON.stringify({dist_index_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,'index.html'))).digest('hex')});
const server=https.createServer({key:fs.readFileSync(TLS+'server.key'),cert:fs.readFileSync(TLS+'server.pem')},(req,res)=>{
 const parsed=parseReleasePath(req.url);
 if(!parsed){security(res);res.writeHead(400);res.end();return;}
 if(parsed.pathname.startsWith('/api/')||parsed.pathname==='/health'){
  const headers:any={...req.headers,host:'127.0.0.1:8103','x-alder-proxy':secret,'x-forwarded-for':req.socket.remoteAddress||''};
  const up=https.request({host:'127.0.0.1',port:8103,method:req.method,path:req.url,headers,agent},(r)=>{res.writeHead(r.statusCode||502,r.headers);r.pipe(res);});
  up.on('error',(e:any)=>{console.error('upstream error',e?.code||'',String(e?.message||'').slice(0,120));if(!res.headersSent){res.writeHead(502,{'content-type':'application/json'});res.end('{"error":{"code":"API_UNAVAILABLE"}}');}else res.end();});
  res.on('close',()=>{if(!res.writableFinished)up.destroy();});req.pipe(up);return;} // client gone (e.g. SSE closed) -> drop upstream
 security(res);
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
 if(parsed.pathname==='/__release.json'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(manifest);return;}
 let rel=parsed.decoded;
 let file=path.resolve(ROOT,'.'+rel);if(!file.startsWith(ROOT+path.sep)&&file!==ROOT){res.writeHead(404);res.end();return;}
 if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(ROOT,'index.html'); // SPA fallback (hash routes)
 const type=TYPES[path.extname(file)]||'application/octet-stream';
 res.writeHead(200,{'content-type':type,'cache-control':file.includes(path.sep+'assets'+path.sep)?'public, max-age=31536000, immutable':'no-store'});
 if(req.method==='HEAD'){res.end();return;}fs.createReadStream(file).pipe(res);
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Alder release (dist) on https://127.0.0.1:${PORT}`));
