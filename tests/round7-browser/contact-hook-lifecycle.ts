import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {chromium} from '@playwright/test';

const out=process.env.ALDER_R7_OUTPUT;if(!out||!path.isAbsolute(out))throw Error('ABSOLUTE_TEST_OWNED_OUTPUT_REQUIRED');fs.mkdirSync(out,{recursive:true});
const built=await build({entryPoints:[path.resolve('tests/round7-browser/contact-hook-fixture.tsx')],bundle:true,write:false,outdir:out,platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}}),js=built.outputFiles.find(f=>f.path.endsWith('.js'))!.text;
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(js);}else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script>');});
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw Error('EPHEMERAL_LOOPBACK_LISTENER_REQUIRED');
const browser=await chromium.launch({headless:true,executablePath:process.env.ALDER_E2E_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'}),checks:string[]=[];
try{
 const page=await browser.newPage();page.setDefaultTimeout(4000);const pageErrors:string[]=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await page.goto(`http://127.0.0.1:${address.port}/?scenario=error`);await page.getByRole('alert').filter({hasText:'AUTHORED_FIRST_PAGE_FAILURE'}).waitFor();await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>window.contactHarness.calls.length),1,'initial error must wait for explicit Retry, not loop');
 await page.evaluate(()=>{window.contactHarness.allowRetry=true;});await page.getByRole('button',{name:'Retry contact loading'}).click();await page.getByText('Showing 2 of 2 contacts.').waitFor();assert.equal(await page.evaluate(()=>window.contactHarness.calls.length),2);checks.push('initial page failure stops automatic retry loop; explicit Retry recovers');

 await page.goto(`http://127.0.0.1:${address.port}/?scenario=stale`);await page.waitForFunction(()=>window.contactHarness.calls.length===1);await page.getByRole('button',{name:'Switch snapshot'}).click();await page.waitForFunction(()=>window.contactHarness.calls.length===2);
 await page.getByText('Showing 2 of 3 contacts.').waitFor();await page.evaluate(()=>window.contactHarness.releaseOld?.());await page.waitForTimeout(100);
 assert.equal(await page.locator('[data-contact-ids]').textContent(),'B0,B1','stale response must not repopulate the new snapshot');
 await page.getByRole('button',{name:'Load more contacts'}).click();await page.getByText('Showing 3 of 3 contacts.').waitFor();
 assert.equal(await page.evaluate(()=>window.contactHarness.calls.length),3);assert(new URL(await page.evaluate(()=>window.contactHarness.calls.at(-1)!),'http://local').searchParams.get('cursor')==='cursor-B','stale cursor must not replace the current generation cursor');
 assert.equal(await page.locator('[data-contact-ids]').textContent(),'B0,B1,B2');checks.push('snapshot change invalidates in-flight old page/cursor; current cursor remains usable');
 await page.goto(`http://127.0.0.1:${address.port}/?scenario=stale`);await page.waitForFunction(()=>window.contactHarness.calls.length===1);await page.getByRole('button',{name:'Unmount directory'}).click();await page.getByText('Directory unmounted').waitFor();await page.evaluate(()=>window.contactHarness.releaseOld?.());await page.waitForTimeout(100);assert.deepEqual(pageErrors,[]);assert.equal(await page.evaluate(()=>window.contactHarness.calls.length),1);checks.push('unmount invalidates active read and its late response causes no page error');
 const result={passed:true,browser:browser.version(),scope:'Chromium React hook lifecycle regression with authored page responses; no service/database/chain used',checks};fs.writeFileSync(path.join(out,'contact-hook-lifecycle.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
