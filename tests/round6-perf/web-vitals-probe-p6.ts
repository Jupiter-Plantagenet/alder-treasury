// @ts-nocheck -- O5 TR-T-LOAD browser vitals probe (own-system measurement, not a benchmark).
// Cold Chrome contexts load the DEPLOYED UI assets from the local release's Vite server (127.0.0.1:5103, static GETs only) while
// EVERY /api and /health request is routed by Playwright to the ISOLATED API 9103 (10,000-payable workspace) — no API call
// reaches the live API. Declared network profile: loopback + CDP emulation of a LAN (2 ms RTT, 100 Mbit/s up/down).
// LCP: PerformanceObserver('largest-contentful-paint') for the authenticated cold load. INP: max interaction duration from
// PerformanceObserver('event', durationThreshold 16) across clicks on all 13 nav screens (web-vitals-style approximation).
import {chromium} from '@playwright/test';import fs from 'node:fs';import screens from '../../apps/web/screens.json' with {type:'json'};
import {Session} from '../round5-ops/o5-lib.ts';
const RUNS=Number(process.env.O5_RUNS||10);const OUT=process.env.O5_OUT||'.local/scratch-r6/load/web-vitals';fs.mkdirSync(OUT,{recursive:true});
const b=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});const results=[];
try{for(let i=0;i<RUNS;i++){const s=await Session.login('owner');const [name,value]=s.cookie.split('=');
 const ctx=await b.newContext({viewport:{width:1440,height:1000}});await ctx.addCookies([{name,value,domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'}]);
 await ctx.route(/^http:\/\/127\.0\.0\.1:5103\/(api\/|health)/,async route=>{const url=route.request().url().replace('127.0.0.1:5103','127.0.0.1:9103');
  // the SSE notification stream cannot be proxied by route.fetch (never completes); it is answered 204 (EventSource stops) - snapshot reads are unaffected
  if(url.includes('/events/stream'))return route.fulfill({status:204,body:''}).catch(()=>{});
  try{const resp=await route.fetch({url,timeout:60000});await route.fulfill({response:resp});}catch{await route.abort().catch(()=>{});}});
 const p=await ctx.newPage();const cdp=await ctx.newCDPSession(p);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:2,downloadThroughput:12.5e6,uploadThroughput:12.5e6});
 await p.addInitScript(()=>{window.__lcp=0;window.__ev=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lcp=Math.max(window.__lcp,e.startTime);}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())if(e.interactionId)window.__ev.push({d:e.duration,n:e.name,id:e.interactionId});}).observe({type:'event',durationThreshold:16,buffered:true});});
 const errs=[];p.on('pageerror',e=>errs.push(e.message));const t0=Date.now();
 await p.goto('http://127.0.0.1:5103/#overview',{waitUntil:'load'});await p.getByRole('heading',{level:1,name:'Treasury workspace',exact:true}).waitFor({timeout:60000});const ready=Date.now()-t0;await p.waitForTimeout(500);
 const lcp=await p.evaluate(()=>window.__lcp);const nav=[];
 for(const sc of screens){const a=Date.now();await p.locator(`nav [data-screen="${sc.id}"]`).click();await p.getByRole('heading',{level:1,name:sc.title,exact:true}).waitFor({timeout:60000});nav.push({id:sc.id,ms:Date.now()-a});}
 await p.waitForTimeout(300);const ev=await p.evaluate(()=>window.__ev);const byId=new Map();for(const e of ev)byId.set(e.id,Math.max(byId.get(e.id)||0,e.d));const inter=[...byId.values()].sort((x,y)=>x-y);
 results.push({run:i,lcpMs:lcp,authenticatedOverviewReadyMs:ready,interactions:inter.length,inpMs:inter.length?inter[inter.length-1]:0,interactionDurations:inter,screenNavMs:nav,pageErrors:errs});console.log(JSON.stringify(results.at(-1)).slice(0,300));await ctx.unrouteAll({behavior:'ignoreErrors'});await ctx.close();}}
finally{await b.close();}
const pct=(a,q)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(q*s.length))];};
const summary={runs:results.length,lcpP50:pct(results.map(r=>r.lcpMs),.5),lcpP95:pct(results.map(r=>r.lcpMs),.95),inpP50:pct(results.map(r=>r.inpMs),.5),inpP95:pct(results.map(r=>r.inpMs),.95),overviewReadyP95:pct(results.map(r=>r.authenticatedOverviewReadyMs),.95),profile:'Chrome headless 156 (system), cold context + cache disabled, CDP LAN emulation 2ms/100Mbit, API->isolated 9103 (10k payables), UI assets from local release Vite dev server',at:new Date().toISOString()};
fs.writeFileSync(`${OUT}/report.json`,JSON.stringify({summary,results},null,1));console.log(JSON.stringify(summary));process.exit(0);
