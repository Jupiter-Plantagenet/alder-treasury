// Chromium component check of Policy/Settings with AUTHORED responses only (no API/PG/chain).
import {build} from 'esbuild';import {createServer} from 'node:http';import path from 'node:path';import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium,expect} from '@playwright/test';
const root=path.resolve(import.meta.dirname,'..'),out=process.env.ALDER_INBOX_OUTPUT;if(!out)throw Error('EXPLICIT_OUTPUT_REQUIRED');fs.mkdirSync(out,{recursive:true});
assert.equal(process.env.ALDER_DENIED_AMBIENT_SENTINEL,undefined,'denied ambient sentinel must not reach Node');
const bundle=await build({entryPoints:[path.join(root,'tests/policy-fixture.tsx')],bundle:true,write:false,outdir:out,platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
const server=createServer((req,res)=>{const ext=req.url==='/fixture.js'?'.js':req.url==='/fixture.css'?'.css':null;if(ext){res.setHeader('content-type',ext==='.js'?'text/javascript':'text/css');res.end(bundle.outputFiles.find(f=>f.path.endsWith(ext))!.text);}else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('LISTENER_REQUIRED');
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;const checks:string[]=[];
const focusedWithin=(page:any,selector:string)=>page.evaluate((s:string)=>!!document.activeElement&&!!document.activeElement.closest(s)||document.activeElement?.matches?.(s),selector);
try{
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage();page.setDefaultTimeout(3000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${address.port}`);
 await page.getByRole('heading',{name:'Business review policy · revision 3'}).waitFor();
 const locked=page.locator('input[type=checkbox][disabled]:checked');assert.equal(await locked.count(),3);
 await expect(page.getByText('Custody authorization is separate')).toBeVisible();await expect(page.getByText('Held · no matching rule')).toBeVisible();
 checks.push('policy loads with version, three locked mandatory gates, text statuses and custody boundary');
 // Keyboard-only: Tab from Rule label to Minimum and edit; activate preview with Enter.
 await page.getByLabel('Rule label').focus();await page.keyboard.press('Control+A');await page.keyboard.type('Keyboard edited rule');
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>(document.activeElement as HTMLInputElement).value),'1','Tab reaches minimum units');
 await page.getByRole('button',{name:'Preview impact'}).focus();await page.keyboard.press('Enter');
 await page.getByRole('heading',{name:'Impact preview · revision 4'}).waitFor();await page.getByText('Impact preview only. Nothing was saved.').waitFor();
 assert.equal((await page.evaluate(()=>window.policySchedule.calls.at(-1))).path,'/policies/preview');
 checks.push('keyboard edit + Enter preview; preview shows proposed revision and says nothing was saved');
 // Conflict: 412 keeps the draft, focuses an alert and offers reload.
 await page.evaluate(()=>{window.policySchedule.conflict=true;});
 await page.getByLabel('Change reason').fill('Authored conflict');await page.getByRole('button',{name:'Save policy revision 4'}).click();
 await page.getByRole('alert').filter({hasText:'Revision conflict'}).waitFor();
 assert.equal(await page.getByLabel('Rule label').inputValue(),'Keyboard edited rule','draft retained on 412');
 assert(await focusedWithin(page,'[tabindex="-1"]'),'focus moved to status region');
 const conflictCall=await page.evaluate(()=>window.policySchedule.calls.at(-1));assert.equal(conflictCall.path,'/policies/pol/revisions');assert.equal(conflictCall.body.expected_revision,3);assert.deepEqual([conflictCall.body.conditions.mandatory_review,conflictCall.body.conditions.required_reviewer_role,conflictCall.body.conditions.mandatory_destination_check],[true,'reviewer',true]);
 await page.getByRole('button',{name:'Reload current policy'}).click();await page.getByRole('heading',{name:'Business review policy · revision 4'}).waitFor();
 checks.push('412 conflict: alert, focus, draft kept, explicit reload to current revision 4');
 // Successful revision against the reloaded revision.
 await page.evaluate(()=>{window.policySchedule.conflict=false;});
 await page.getByLabel('Change reason').fill('Authored relabel');await page.getByRole('button',{name:'Save policy revision 5'}).click();
 await page.getByText(/Saved policy revision 5\. 1 unreserved approved payable\(s\) now need re-review; 1 reserved payable\(s\) keep their frozen intent unchanged\./).waitFor();
 await page.getByRole('heading',{name:'Business review policy · revision 5'}).waitFor();
 assert(await page.evaluate(()=>document.activeElement?.textContent?.startsWith('Saved policy revision 5')),'focus on saved status');
 assert.equal((await page.evaluate(()=>window.policySchedule.calls.at(-1))).body.expected_revision,4);
 checks.push('save revision 5: re-review count and reserved-unchanged notice survive reload; focus on status');
 // Settings: no role switcher, keyboard preference toggle, PUT with revision, custody denial explained.
 await page.evaluate(()=>window.navigate('settings'));await page.getByRole('heading',{name:'Workspace controls'}).waitFor();
 assert.equal(await page.locator('main select').count(),1,'only the screen navigation select; no role switcher');assert.equal(await page.getByText('View role').count(),0);
 await page.getByLabel('Redact full addresses in private exports by default').focus();await page.keyboard.press('Space');
 await page.getByRole('button',{name:'Save preferences'}).click();await page.getByText('Saved preference revision 3. Custody owners and threshold are unchanged.').waitFor();
 const pref=await page.evaluate(()=>window.policySchedule.calls.at(-1));assert.deepEqual([pref.method,pref.body],['PUT',{expected_revision:2,pending_reminders:true,default_redaction:true}]);
 await page.getByRole('button',{name:'Request Safe owner or threshold change'}).click();
 await page.getByRole('alert').filter({hasText:'Custody change denied'}).waitFor();await expect(page.getByRole('alert').filter({hasText:'Custody change denied'})).toContainText('outside this app');
 checks.push('settings: no role switcher; keyboard toggle; PUT exact revision; custody owner change denied with outside-app explanation');
 // 360px mobile: no page-level horizontal overflow on both screens.
 await page.setViewportSize({width:360,height:800});
 for(const screen of ['settings','policy']){await page.evaluate(s=>window.navigate(s),screen);await page.waitForTimeout(150);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);await page.screenshot({path:path.join(out,`${screen}-360.png`),fullPage:true});assert(overflow<=0,`${screen} horizontal overflow ${overflow}px`);}
 checks.push('360px policy/settings: no page horizontal overflow (screenshots retained)');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({result:'PASS',browser:browser.version(),fixture:'authored API responses only; not API/PostgreSQL/RLS evidence',checks},null,2));
 console.log('PASS',browser.version());for(const c of checks)console.log(' -',c);
}finally{await browser?.close();server.close();}
