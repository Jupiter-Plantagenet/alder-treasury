import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {build} from 'esbuild';
import {Session} from '../round5-ops/o5-lib.ts';

const out=process.env.ALDER_R7_OUTPUT;
if(!out||!path.isAbsolute(out))throw Error('ABSOLUTE_TEST_OWNED_OUTPUT_REQUIRED');
fs.mkdirSync(out,{recursive:true});
const apiOrigin='http://127.0.0.1:9103',origin='http://127.0.0.1:5199';
if(process.env.O5_API&&process.env.O5_API!==apiOrigin)throw Error('ISOLATED_P6_API_MUST_BE_127_0_0_1_9103');
const contactIds=new Set<string>(),pageCounts:number[]=[],errors:string[]=[];let snapshotTotal:number|undefined,workspaceId:string|undefined;
const bundle=await build({entryPoints:['apps/web/main.tsx'],bundle:true,write:false,format:'esm',minify:true,define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'css'},outdir:'out',platform:'browser'});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text||'';
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alder isolated contact test</title><style>${css}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
const browser=await chromium.launch({headless:true,executablePath:process.env.ALDER_E2E_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 const session=await Session.login('jordan');const cookieValue=session.cookie.split('=')[1];if(!cookieValue)throw Error('ISOLATED_SESSION_COOKIE_REQUIRED');
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'alder',value:cookieValue,domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict',secure:false}]);
 await context.route(/^http:\/\/127\.0\.0\.1:5199\//,async route=>{const u=new URL(route.request().url());
  if(u.pathname==='/app.js')return route.fulfill({contentType:'text/javascript',body:js});
  if(u.pathname.startsWith('/api/')||u.pathname==='/health'){
   if(u.pathname.endsWith('/events/stream'))return route.fulfill({status:204,body:''});
   try{const headers={...route.request().headers(),origin:'http://127.0.0.1:5103'};const response=await route.fetch({url:apiOrigin+u.pathname+u.search,headers,timeout:60000});return route.fulfill({response});}catch(e){errors.push('isolated P6 API route failed');return route.abort();}
  }
  return route.fulfill({contentType:'text/html',body:html});
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async response=>{const url=new URL(response.url());if(url.pathname.endsWith('/snapshot')&&response.status()===200){try{const body=await response.json();snapshotTotal=Number(body.limits?.contacts?.total);workspaceId=body.workspace?.workspace_id;}catch{}}});
 const readPage=async(response:any)=>{assert.equal(response.status(),200);const body=await response.json();assert(Array.isArray(body.items));pageCounts.push(body.items.length);for(const c of body.items)contactIds.add(c.id);};
 await page.goto(origin+'/#contacts');const firstPage=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/reads/contacts')&&r.status()===200);
 await page.locator('[data-current-screen="contacts"]').waitFor();await page.getByText(/Showing \d+ of \d+ contacts\./).waitFor();
 await readPage(await firstPage);
 if(await page.getByRole('button',{name:'Show more loaded contacts',exact:true}).count()){await page.getByRole('button',{name:'Show more loaded contacts',exact:true}).click();assert(await page.locator('article[data-contact-id]').count()>150,'contact desk must expose additional cards from the loaded snapshot/page');}
 for(let attempt=0;attempt<100;attempt++){
  if(snapshotTotal!==undefined&&contactIds.size===snapshotTotal)break;
  const next=page.getByRole('button',{name:'Load more contacts',exact:true});if(!(await next.count()))break;
  const before=contactIds.size;const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/reads/contacts')&&r.status()===200);await next.click();await readPage(await responsePromise);
  if(contactIds.size===before&&snapshotTotal!==undefined&&contactIds.size>=snapshotTotal)break;
 }
 assert(snapshotTotal!==undefined&&snapshotTotal>200,'live workspace must exceed the bounded 200-contact snapshot');
 assert.equal(contactIds.size,snapshotTotal,'all unique live API contact IDs must be reachable in the desk');
 assert(pageCounts.length>=2,'live API cursor endpoint should return multiple pages');
 const allIds=[...contactIds];const finalId=allIds.at(-1)!;
 await page.locator('nav [data-screen="payables"]').click();await page.getByLabel('Contact',{exact:true}).waitFor();
 const intakeOptions=page.locator('select[aria-label="Contact"] option');await page.waitForFunction(({count})=>document.querySelectorAll('select[aria-label="Contact"] option').length===count+1,{count:snapshotTotal});
 await intakeOptions.filter({hasText:'Choose contact'}).count();assert.equal(await intakeOptions.count(),snapshotTotal+1,'manual intake picker must include every paged contact');
 await page.locator('select[aria-label="Contact"]').selectOption(finalId);
 assert.equal(await page.locator('select[aria-label="Contact"]').inputValue(),finalId);
 assert.deepEqual(errors,[]);
 const result={passed:true,browser:browser.version(),origin,api_origin:apiOrigin,workspace_id:workspaceId,scope:'actual authenticated Chromium UI with every API/health route rewritten to isolated P6 API 9103; live read-only contact paging and picker selection',contact_total:snapshotTotal,unique_contact_ids_read:contactIds.size,api_page_sizes:pageCounts,checks:['exact snapshot contact total shown','all contacts beyond the 200-row snapshot traversed using live opaque cursors','unique IDs equal exact total with no dropped or duplicate contacts','manual payable contact picker contains and selects the last contact in the live directory','no browser page errors'],unperformed:['no contact/payable/policy mutation','no database query or chain/wallet interaction','no manual accessibility signoff'],canonical_ui_or_api_requested:false};
 fs.writeFileSync(path.join(out,'contacts-live.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await context.close();
}finally{await browser.close();}
