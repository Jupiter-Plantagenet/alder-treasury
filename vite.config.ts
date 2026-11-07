import {defineConfig} from 'vite';import fs from 'node:fs';import https from 'node:https';
// Round 6 (TR-T-CSRF Secure cookies): the dev UI is served over HTTPS (local CA in .local/tls, not system-installed) and
// proxies to the HTTPS API, verifying its certificate against that CA. The proxy adds the shared proxy secret plus the
// browser socket address as X-Forwarded-For (any client-supplied values are overwritten), so the API's login limiter
// can key clients by the trusted proxy header only (review F-M2).
const TLS='.local/tls/';const tlsOk=['server.key','server.pem','ca.pem','proxy-secret'].every(f=>fs.existsSync(TLS+f));
const apiAgent=tlsOk?new https.Agent({ca:fs.readFileSync(TLS+'ca.pem'),keepAlive:true}):undefined;
const proxySecret=tlsOk?fs.readFileSync(TLS+'proxy-secret','utf8').trim():'';
// Round 6 (F-M5 follow-up): when the browser side closes (e.g. an SSE EventSource), the upstream request is destroyed too,
// so the API sees the disconnect and releases the stream slot (found: closed SSE streams leaked slots through the proxy).
const apiProxy={target:'https://127.0.0.1:8103',secure:true,agent:apiAgent,changeOrigin:false,configure:(proxy:any)=>{proxy.on('proxyReq',(pr:any,req:any,res:any)=>{pr.setHeader('x-alder-proxy',proxySecret);pr.setHeader('x-forwarded-for',req.socket?.remoteAddress||'');res?.on?.('close',()=>{if(!pr.destroyed)pr.destroy();});});}};
// Round 4: strict CSP. No inline/eval script; styles inline only because Vite injects CSS via <style>.
// Round 5 (review L1): raw Anvil RPC is NOT in connect-src: page code can reach only its own origin (API via proxy) and
// the dev HMR socket. A real extension wallet does not need page-level RPC. The automated test facade reaches the chain
// through a same-origin path that only the Playwright harness intercepts (it 404s for everyone else). The SAME headers
// are applied by `vite preview` for a built bundle (production CSP without the HMR socket).
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss://127.0.0.1:5103; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const BUILT_CSP="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const securityHeaders=(csp:string)=>(req:any,res:any,next:any)=>{res.setHeader('Content-Security-Policy',csp);res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');if(req.method==='GET'&&req.headers.host==='localhost:5103'){res.writeHead(307,{Location:`https://127.0.0.1:5103${req.url||'/'}`,'Cache-Control':'no-store'});res.end();return;}next();};
export default defineConfig({plugins:[{name:'canonical-loopback-navigation',configureServer(server){server.middlewares.use(securityHeaders(CSP));},configurePreviewServer(server){server.middlewares.use(securityHeaders(BUILT_CSP));}}],preview:{host:'127.0.0.1',port:5114,strictPort:true,...(tlsOk?{https:{key:fs.readFileSync(TLS+'server.key'),cert:fs.readFileSync(TLS+'server.pem')}}:{}),proxy:{'/api':apiProxy,'/health':apiProxy}},server:{host:'127.0.0.1',port:5103,strictPort:true,...(tlsOk?{https:{key:fs.readFileSync(TLS+'server.key'),cert:fs.readFileSync(TLS+'server.pem')}}:{}),hmr:{protocol:'wss',host:'127.0.0.1',port:5103},fs:{deny:['**/.local/**','**/pgdata/**','**/evidence/**','**/tests/**','**/ops/**','**/db/**','**/npm-cache/**','**/.browsers/**','**/apps/api/**','**/.env*','**/.git/**']},watch:{ignored:['**/evidence/**','**/pgdata/**','**/npm-cache/**','**/.browsers/**']},proxy:{'/api':apiProxy,'/health':apiProxy}}});