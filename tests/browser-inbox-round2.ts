import {build} from 'esbuild';import {createServer} from 'node:http';import path from 'node:path';import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium,expect,type Page} from '@playwright/test';
const root=path.resolve(import.meta.dirname,'..'),out=process.env.ALDER_INBOX_OUTPUT;if(!out)throw Error('EXPLICIT_OUTPUT_REQUIRED');fs.mkdirSync(out,{recursive:true});
assert.equal(process.env.ALDER_DENIED_AMBIENT_SENTINEL,undefined,'denied ambient sentinel must not reach Node');
const bundle=await build({entryPoints:[path.join(root,'tests/inbox-round2-fixture.tsx')],bundle:true,write:false,outdir:out,platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
const server=createServer((req,res)=>{const ext=req.url==='/fixture.js'?'.js':req.url==='/fixture.css'?'.css':null;if(ext){res.setHeader('content-type',ext==='.js'?'text/javascript':'text/css');res.end(bundle.outputFiles.find(f=>f.path.endsWith(ext))!.text);}else res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('LISTENER_REQUIRED');
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;const checks:string[]=[];
async function form(page:Page){await page.getByText(/1 records in snapshot/).waitFor();await page.getByLabel('Contact',{exact:true}).selectOption('c');await page.getByLabel('External reference').fill('ROUND2-EXACT');await page.getByLabel('Amount · ALDR',{exact:true}).fill('9007199254.740993');}
try{
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage();page.setDefaultTimeout(3000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${address.port}`);await form(page);
 await page.getByRole('button',{name:'Save manual payable',exact:true}).click();await page.getByRole('button',{name:'Retry exact intake request'}).waitFor();
 for(const denial of [403,401,0]){
  await page.evaluate(value=>{window.schedule.denial=value;},denial);
  await page.getByRole('button',{name:'Retry exact intake request'}).click();
  await page.getByRole('alert').filter({hasText:denial===0?'Authored authentication refusal':'Authored authorization refusal '+denial}).waitFor();
  await expect(page.getByLabel('External reference')).toBeDisabled();
  await page.getByRole('button',{name:'Leave fixture',exact:true}).click();await page.getByRole('button',{name:'Return fixture',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry exact intake request'})).toBeEnabled();
 }
 await page.evaluate(()=>{window.schedule.denial=null;});await page.getByRole('button',{name:'Retry exact intake request'}).click();await page.getByText('Saved ROUND2-EXACT',{exact:true}).waitFor();
 const f=await page.evaluate(()=>window.schedule);assert.equal(f.calls.length,5);for(const c of f.calls)assert.deepEqual(c,f.calls[0]);assert.equal(f.calls[0].body.amount_units,'9007199254740993');assert.equal(f.effects,1);checks.push('lost response → 403 → 401 → untyped auth refusal → recovered exact receipt, one modeled effect');
 // Return while the first POST is still pending, then settle with no refresh.
 await page.reload();await page.evaluate(()=>{window.schedule.mode='held';window.schedule.failRefresh=true;});await form(page);
 await page.getByRole('button',{name:'Save manual payable',exact:true}).click();
 await page.getByRole('button',{name:'Leave fixture',exact:true}).click();await page.getByRole('button',{name:'Return fixture',exact:true}).click();
 await expect(page.getByLabel('External reference')).toBeDisabled();
 await page.locator('form.destination-form').evaluate(form=>{const props=(form as any)[Object.keys(form).find(k=>k.startsWith('__reactProps$'))!];(window as any).staleIntakeSubmit=props.onSubmit;});
 await expect(page.getByRole('button',{name:'Saving…',exact:true})).toBeDisabled();
 await page.evaluate(()=>{(window as any).staleIntakeSubmit({preventDefault(){}});});assert.equal(await page.evaluate(()=>window.schedule.calls.length),1,'remounted pending command cannot send overlapping retry');
 await page.evaluate(()=>window.schedule.settle!());
 await page.getByText('Saved ROUND2-EXACT',{exact:true}).waitFor();
 await page.getByText('Payable saved. Workspace refresh unavailable; do not recreate it.').waitFor();
 await expect(page.getByRole('button',{name:'Retry exact intake request'})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).staleIntakeSubmit({preventDefault(){}});});
 // A captured prior mounted form callback must be harmless after acknowledgment.
 await page.getByRole('button',{name:'Leave fixture',exact:true}).click();await page.getByRole('button',{name:'Return fixture',exact:true}).click();
 await page.getByText('Saved ROUND2-EXACT',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.schedule.calls.length),1);assert.equal(await page.evaluate(()=>window.schedule.effects),1);
 checks.push('pending POST → leave/remount before settle → success + refresh failure notifies remount; captured stale submit sends no replacement POST');
 await page.getByRole('button',{name:'Create another payable',exact:true}).click();
 await page.evaluate(()=>{(window as any).staleIntakeSubmit({preventDefault(){}});});
 assert.equal(await page.evaluate(()=>window.schedule.calls.length),1,'old-generation callback cannot mint a replacement key after explicit new draft');
 // New account/workspace gets no prior frozen command or receipt.
 await page.getByLabel('External reference').fill('UNRESOLVED-SCOPE');
 await page.getByLabel('Amount · ALDR',{exact:true}).fill('1');
 await page.evaluate(()=>{window.schedule.mode='lost';});await page.getByRole('button',{name:'Save manual payable',exact:true}).click();await page.getByRole('button',{name:'Retry exact intake request'}).waitFor();
 await page.evaluate(()=>{window.schedule.user='other-user';});await page.getByRole('button',{name:'Rerender fixture identity'}).click();
 await expect(page.getByLabel('External reference')).toHaveValue('');await expect(page.getByRole('button',{name:'Retry exact intake request'})).toHaveCount(0);
 await form(page);await page.getByRole('button',{name:'Save manual payable',exact:true}).click();await page.getByRole('button',{name:'Retry exact intake request'}).waitFor();
 await page.evaluate(()=>{window.schedule.workspace='other-workspace';});await page.getByRole('button',{name:'Rerender fixture identity'}).click();
 await expect(page.getByLabel('External reference')).toHaveValue('');await expect(page.getByRole('button',{name:'Retry exact intake request'})).toHaveCount(0);
 checks.push('old draft generation callback refused; unresolved commands never leak to new account or workspace');
 // Explicit snapshot selection disappears from the refreshed workspace.
 for(const defaultReference of ['PAY-1043','FIRST-OTHER']){
 await page.reload();await page.getByText(/1 records in snapshot/).waitFor();await page.evaluate(value=>{window.schedule.omitSelected=true;window.schedule.defaultReference=value;},defaultReference);
 await page.getByRole('button',{name:'ROUND2-EXACT',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Selected payable is missing from the current workspace'}).waitFor();
 await expect(page.getByRole('heading',{name:'Supporting business record',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Approve business record',exact:true})).toHaveCount(0);
 await expect(page.getByText('Exact payable destination & fresh review',{exact:true})).toHaveCount(0);
 await expect(page.getByLabel('Payable to inspect')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Private attachments',exact:true})).toHaveCount(0);
 await expect(page.getByText('PAY-1043',{exact:false})).toHaveCount(0);
 await page.getByRole('button',{name:'Return fixture',exact:true}).click();await page.evaluate(()=>{window.schedule.omitSelected=false;});await page.getByRole('button',{name:'ROUND2-EXACT',exact:true}).click();
 await page.getByRole('heading',{name:'Supporting business record',exact:true}).waitFor();await expect(page.getByLabel('Payable to inspect')).toHaveValue('p');
 }
 checks.push('missing explicit selection shows no substitute record/review/destination/attachment controls; restored exact record navigates normally');
 await page.reload();await page.evaluate(()=>{window.schedule.mode='definite';});await form(page);await page.getByRole('button',{name:'Save manual payable',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Authored first validation denial'}).waitFor();await expect(page.getByLabel('External reference')).toBeEnabled();assert.equal(await page.evaluate(()=>window.schedule.effects),0);
 checks.push('first-attempt definite validation denial still allows correction, unlike rejection of an already-uncertain command');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,checks,browser:browser.version(),scope:'mounted React Workspace/Inbox with authored command/authorization schedules ONLY; actual PostgreSQL integration UNRUN'},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{if(browser)await browser.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
