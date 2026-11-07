import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';

const out=process.env.ALDER_R7_OUTPUT;
if(!out||!path.isAbsolute(out))throw Error('ABSOLUTE_TEST_OWNED_OUTPUT_REQUIRED');
fs.mkdirSync(out,{recursive:true});
const built=await build({entryPoints:[path.resolve('tests/round7-browser/inbox-fixture.tsx')],bundle:true,write:false,outdir:out,platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
const js=built.outputFiles.find(f=>f.path.endsWith('.js'))!.text;
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(js);}else if(req.url==='/fixture.css'){res.setHeader('content-type','text/css');res.end(fs.readFileSync(path.resolve('apps/web/style.css')));}else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');});
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const address=server.address();if(!address||typeof address==='string')throw Error('EPHEMERAL_LOOPBACK_LISTENER_REQUIRED');
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.ALDER_E2E_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${address.port}`);await page.getByText(/100 records in snapshot/).waitFor();
 const total=Array.from({length:100},(_,i)=>BigInt((i+1)*1000001)).reduce((a,b)=>a+b,0n).toString();
 await expect(page.locator('dl.kv')).toContainText(`${total} base units · 100 records`);
 const visited:string[]=[];
 for(let n=0;n<4;n++){const refs=await page.locator('tbody tr td:first-child button').allTextContents();visited.push(...refs);if(n<3)await page.getByRole('button',{name:'Next snapshot page'}).click();}
 assert.equal(visited.length,100);assert.equal(new Set(visited).size,100);assert.equal(visited[0],'R7-001');assert.equal(visited.at(-1),'R7-100');
 await page.getByLabel('Search payables').fill('no-match');await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByText('No matching payables',{exact:true}).waitFor();await expect(page.locator('dl.kv dt, dl.kv dd')).toHaveCount(0);
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();await page.getByText(/100 records in snapshot/).waitFor();await page.getByRole('button',{name:'R7-001',exact:true}).waitFor();
 await page.locator('input[type=file]').setInputFiles({name:'duplicates.csv',mimeType:'text/csv',buffer:Buffer.from('external_reference,contact_id,amount_units\nDUPLICATE-REF,contact-r7,100\nDUPLICATE-REF,contact-r7,200\n')});
 await page.getByRole('region',{name:'Import validation errors'}).waitFor();await expect(page.getByText('duplicate_external_reference_in_file',{exact:true})).toHaveCount(2);await expect(page.getByRole('button',{name:'Import 0 payables'})).toBeDisabled();
 assert.deepEqual(await page.evaluate(()=>window.round7Calls.filter(x=>x.body).map(x=>x.path)),['/payables/imports/preview'],'duplicate fixture must be preview-only; no import commit request');
 assert.deepEqual(errors,[]);
 const result={passed:true,browser:browser.version(),scope:'actual React Workspace/Inbox in Chromium with authored API responses only; no API/PostgreSQL/chain/wallet execution',checks:['100 exact snapshot rows traversed across four 25-row pages with no duplicates or omissions','integer base-unit aggregate matches sum of all 100 rendered snapshot records','no-match query renders empty state and clear restores snapshot','duplicate external references shown as row errors and import commit disabled','no import commit request and no page errors'],fixtures:{record_count:100,total_units:total,duplicate_reference:'DUPLICATE-REF'},provenance:{runner:'tests/round7-browser/inbox.ts',fixture:'tests/round7-browser/inbox-fixture.tsx'}};
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(browser)await browser.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
