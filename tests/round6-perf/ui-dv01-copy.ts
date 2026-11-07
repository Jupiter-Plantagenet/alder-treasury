import '../tls-trust.ts';import {chromium,expect} from '@playwright/test';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Bundle the actual component, not a selector copy. Route only this disposable
// harness: no authentication, database, API, wallet or chain requests are used.
const dir='.local/scratch-r6/r6-ui/dv01';fs.mkdirSync(dir,{recursive:true});
const bundle=await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {Workspace} from './apps/web/App.tsx';
const root=createRoot(document.getElementById('root'));
const payables=['one','two','three','four'].map((id,i)=>({id,payment_id:'payment-'+id,workspace_id:'ws-a',contact:id,display_reference:id,service:'Fixture',recipient:'original-'+id,amount_units:String((i+1)*1000000),reviewed_by:'reviewer',verified:true}));
window.fixture={screen:'batch',workspaceId:'ws-a',snapshot:{user:{id:'actor-a',name:'Fixture'},roles:['preparer','owner'],payables,readiness:Object.fromEntries(['one','two','three','four'].map(id=>[id,{ready:true,reasons:[]}])),batches:[],operations:[],events:[],allowance:'0'},calls:[]};
window.draw=(patch={})=>{Object.assign(window.fixture,patch);root.render(<Workspace {...window.fixture} onCommand={(...args)=>window.fixture.calls.push(args)}/>);};window.draw();
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser'});
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div><script>'+bundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')+'</script>'}));
async function selected(ids:string[]){await expect(page.getByRole('checkbox',{checked:true})).toHaveCount(ids.length);for(const id of ids)await expect(page.getByRole('checkbox',{name:'Select '+id,exact:true})).toBeChecked();}
async function draw(expression:string){await page.evaluate(expression);await page.waitForTimeout(30);}
const freeze=()=>page.getByRole('button',{name:'Freeze batch & review intent',exact:true});
const allowance=()=>page.getByRole('button',{name:'Propose exact bounded allowance',exact:true});
try{
 await page.goto('https://127.0.0.1:5103/dv01-component-harness');await selected(['one','two','three']);
 // Choose only the fourth, then clear the final choice.
 await page.getByRole('checkbox',{name:'Select four',exact:true}).check();
 for(const id of ['one','two','three'])await page.getByRole('checkbox',{name:'Select '+id,exact:true}).uncheck();
 await selected(['four']);await page.getByRole('checkbox',{name:'Select four',exact:true}).uncheck();
 await selected([]);
 await expect(page.locator('dt',{hasText:'Selected payables'}).locator('+ dd')).toHaveText('0');
 await expect(page.locator('dt',{hasText:'Exact raw total'}).locator('+ dd')).toHaveText('0');
 await expect(page.locator('.total span')).toHaveText('0 ALDR');
 await expect(freeze()).toBeDisabled();await expect(allowance()).toBeDisabled();
 await freeze().evaluate((b:HTMLButtonElement)=>b.click());await allowance().evaluate((b:HTMLButtonElement)=>b.click());
 assert.deepEqual(await page.evaluate('window.fixture.calls'),[]);await page.screenshot({path:dir+'/empty-disabled.png'});
 await draw('window.draw({snapshot:{...window.fixture.snapshot,payables:window.fixture.snapshot.payables.map(x=>({...x}))}})');await selected([]);
 await page.getByRole('checkbox',{name:'Select four',exact:true}).check();
 await draw('window.draw({snapshot:{...window.fixture.snapshot,payables:[...window.fixture.snapshot.payables].reverse()}})');await selected(['four']);
 await freeze().click();await allowance().click();assert.deepEqual(await page.evaluate('window.fixture.calls.map(x=>[x[0],x[1]])'),[['/batches',{ids:['four']}],['/allowances',{ids:['four']}]]);
 // A selected ID disappearing must not restore defaults or return on a later refresh.
 await draw('window.saved=window.fixture.snapshot.payables;window.draw({snapshot:{...window.fixture.snapshot,payables:window.saved.filter(x=>x.id!=="four")}})');await selected([]);await expect(freeze()).toBeDisabled();await expect(allowance()).toBeDisabled();
 await draw('window.draw({snapshot:{...window.fixture.snapshot,payables:window.saved}})');await selected([]);
 // Scope boundaries reset independently even when payable IDs overlap.
 await draw('window.draw({workspaceId:"ws-b",snapshot:{...window.fixture.snapshot,payables:[...window.saved].reverse()}})');await selected(['one','two','three']);
 await page.getByRole('checkbox',{name:'Select four',exact:true}).check();
 await draw('window.draw({snapshot:{...window.fixture.snapshot,user:{id:"actor-b",name:"Other"}}})');await selected(['one','two','three']);
 // Frozen intent is not derived from the current draft or live payable values.
 await draw('window.draw({screen:"intent",snapshot:{...window.fixture.snapshot,batches:[{id:"frozen",manifest:{items:[{paymentId:"payment-four",recipient:"immutable-destination",amount:"777000000"}]}}],payables:window.saved.map(x=>({...x,recipient:"changed-live",amount_units:"1"}))}})');
 await expect(page.locator('tbody')).toContainText('immutable-destination');await expect(page.locator('tbody')).toContainText('777');await expect(page.locator('tbody')).not.toContainText('changed-live');
 await draw('window.draw({snapshot:{...window.fixture.snapshot,payables:[]}})');await expect(page.locator('tbody')).toContainText('immutable-destination');await expect(page.locator('tbody')).toContainText('777');
 assert.deepEqual(errors,[]);await page.screenshot({path:dir+'/frozen.png'});
 fs.writeFileSync(dir+'/browser-green.json',JSON.stringify({passed:true,browser:browser.version(),actualComponent:'apps/web/App.tsx',checks:['four-only then clear: 0 checked / 0 count / 0 total','freeze and allowance disabled; callbacks not called','empty survives refresh','valid fourth-only IDs survive reordered refresh; exact callback IDs','removed IDs pruned without defaults or later resurrection','workspace and account scope reset with overlapping IDs','frozen manifest destination/amount survive live edits and absent payables'],pageErrors:errors},null,2));console.log('PASS DV01 actual-component Chrome interaction regression');
}finally{await browser.close();}
