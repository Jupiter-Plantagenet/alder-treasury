// @ts-nocheck -- Round 6 (perf/UI fork) INP/LCP probe of the REAL UI (apps/web/main.tsx bundled with esbuild, production
// mode) against the private 10k-payable API (ui-harness.ts, disposable DB 15544). Chrome (system), cold context, cache
// disabled, CDP LAN emulation (2 ms RTT, 100 Mbit/s) like the round-5 O5 probe. INP = max event duration per interaction
// (PerformanceObserver 'event', durationThreshold 16), over: every nav screen click, and on the Batch screen a checkbox
// toggle, a view change, a search keystroke burst and "Load more payables".
// P6 variant: same probe, API = isolated P6 stack 9103. Usage: node --import tsx tests/round6-perf/vitals-p6.ts [runs]
process.env.ALDER_RPC_URL ||= 'http://127.0.0.1:18547';process.env.ALDER_SNAPSHOT_CHAIN_TTL_MS ||= '600000';
import {chromium} from '@playwright/test';import {build} from 'esbuild';import fs from 'node:fs';
import screens from '../../apps/web/screens.json' with {type:'json'};
import {Session} from '../round5-ops/o5-lib.ts';
const RUNS=Number(process.argv[2]||5);const OUT=process.env.P6_VITALS_OUT||'.local/scratch-r6/load/vitals';fs.mkdirSync(OUT,{recursive:true});
const b=await build({entryPoints:['apps/web/main.tsx'],bundle:true,write:false,format:'esm',minify:true,define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'css'},outdir:'out',platform:'browser'});
const js=b.outputFiles.find(f=>f.path.endsWith('.js')).text,css=b.outputFiles.find(f=>f.path.endsWith('.css'))?.text||'';
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Alder</title><style>${css}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
const app={close:async()=>{}};const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});const results=[];
try{for(let i=0;i<RUNS;i++){const s=await Session.login('jordan');const value=s.cookie.split('=')[1];
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.addCookies([{name:'alder',value,domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict',secure:false}]);
 await ctx.route(/^http:\/\/127\.0\.0\.1:5199\//,async route=>{const u=new URL(route.request().url());
  if(u.pathname==='/app.js')return route.fulfill({contentType:'text/javascript',body:js});
  if(u.pathname.startsWith('/api/')||u.pathname==='/health'){if(u.pathname.endsWith('/events/stream'))return route.fulfill({status:204,body:''});
   try{const request=route.request();const headers={...request.headers(),origin:'http://127.0.0.1:5103'};const resp=await route.fetch({url:'http://127.0.0.1:9103'+u.pathname+u.search,timeout:60000,headers});return route.fulfill({response:resp});}catch{return route.abort();}}
  return route.fulfill({contentType:'text/html',body:html});});
 const p=await ctx.newPage();const cdp=await ctx.newCDPSession(p);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:2,downloadThroughput:12.5e6,uploadThroughput:12.5e6});
 await p.addInitScript(()=>{window.__lcp=0;window.__ev=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lcp=Math.max(window.__lcp,e.startTime);}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())if(e.interactionId)window.__ev.push({d:e.duration,n:e.name,id:e.interactionId,t:e.startTime});}).observe({type:'event',durationThreshold:16,buffered:true});});
 const errs=[];p.on('pageerror',e=>errs.push(e.message));const t0=Date.now();
 await p.goto('http://127.0.0.1:5199/#overview',{waitUntil:'load'});await p.getByRole('heading',{level:1,name:'Treasury workspace',exact:true}).waitFor({timeout:60000});const ready=Date.now()-t0;await p.waitForTimeout(500);
 const lcp=await p.evaluate(()=>window.__lcp);const marks=[];const mark=async(label)=>{marks.push({label,at:await p.evaluate(()=>performance.now())});};
 for(const sc of screens){await mark('nav:'+sc.id);await p.locator(`nav [data-screen="${sc.id}"]`).click();await p.getByRole('heading',{level:1,name:sc.title,exact:true}).waitFor({timeout:60000});await p.waitForTimeout(150);}
 // Batch screen interactions at 10k payables
 await p.locator('nav [data-screen="batch"]').click();await p.getByText(/matching payables/).waitFor({timeout:30000});
 const boxes=p.getByRole('checkbox');await mark('batch:toggle');await boxes.nth(4).click();await p.waitForTimeout(150);await mark('batch:toggle2');await boxes.nth(5).click();await p.waitForTimeout(150);
 await mark('batch:view');await p.getByLabel('Show').selectOption('all');await p.getByText(/10\d{3} matching payables|matching payables/).waitFor();await p.waitForTimeout(300);
 await mark('batch:search');await p.getByLabel('Search').pressSequentially('p6-load',{delay:60});await p.waitForTimeout(600);
 await p.getByLabel('Search').fill('');await p.waitForTimeout(600);await mark('batch:more');const more=p.getByRole('button',{name:'Load more payables'});if(await more.count()){await more.click();await p.waitForTimeout(800);await more.click();await p.waitForTimeout(800);}
 await mark('batch:scroll');await p.mouse.move(400,600);await p.mouse.wheel(0,3000);await p.waitForTimeout(300);
 const domRows=await p.locator('tbody tr').count();if(i===0){await p.mouse.wheel(0,-3000);await p.waitForTimeout(200);await p.screenshot({path:OUT+'/batch-10k.png'});}
 const ev=await p.evaluate(()=>window.__ev);const byId=new Map();for(const e of ev){const o=byId.get(e.id)||{d:0,t:e.t,n:e.n};o.d=Math.max(o.d,e.d);byId.set(e.id,o);}
 const inter=[...byId.values()].map(o=>({...o,label:[...marks].reverse().find(m=>m.at<=o.t+1)?.label||'load'}));const durs=inter.map(x=>x.d).sort((a,b)=>a-b);
 results.push({run:i,lcpMs:lcp,overviewReadyMs:ready,interactions:inter.length,inpMs:durs.at(-1)||0,worst:inter.sort((a,b)=>b.d-a.d).slice(0,5),domRowsAfterLoadMore:domRows,pageErrors:errs});console.log(JSON.stringify(results.at(-1)).slice(0,400));await ctx.close();}}
finally{await browser.close();await app.close();}
const pct=(a,q)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(q*s.length))];};
const summary={runs:results.length,lcpP50:pct(results.map(r=>r.lcpMs),.5),lcpP95:pct(results.map(r=>r.lcpMs),.95),inpP50:pct(results.map(r=>r.inpMs),.5),inpP95:pct(results.map(r=>r.inpMs),.95),pageErrors:results.reduce((n,r)=>n+r.pageErrors.length,0),profile:'Chrome (system) headless, cold context + cache disabled, CDP LAN 2ms/100Mbit; UI = esbuild production bundle of apps/web/main.tsx; Playwright rewrites allowed 5103 origin and routes every API/health request to real isolated P6 API 9103 (SSE only returns 204) (current source) on scratch DB 15543 (restored from a fresh live dump), W1-copy workspace seeded to >=10k payables; isolated worker 9113; RPC proxy 18547 -> Anvil 18548',at:new Date().toISOString()};
fs.writeFileSync(OUT+'/report.json',JSON.stringify({summary,results},null,1));console.log(JSON.stringify(summary));process.exit(0);
