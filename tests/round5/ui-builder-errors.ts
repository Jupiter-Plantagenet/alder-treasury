// @ts-nocheck -- live-stack runner
// Round-5 checks for the wallet agent's findings (B5 workspace, real Chrome, live stack):
//  (3) batch builder: when the latest batch is nonce_consumed the builder opens and "Propose" uses the CURRENT selection,
//      never the dead batch's rows;  (2) an identical allowance intent proposed twice -> 409 INTENT_ALREADY_FROZEN naming
//      the existing operation (not 500);  (4) the error banner survives SSE-driven refreshes until the user dismisses it.
// The dead batch is then exited through verified invalidation (no release without verification).
import fs from 'node:fs';import {chromium} from '@playwright/test';
import {sessions5,contact,payable,readyPayables,allowanceCycle,freeze,signAll,prepare,send,waitState,opState,mine,expect,Report,q,db,sleep,WS5,ORIGIN,newAddress} from './b5-lib.ts';
const run='B5U'+Date.now().toString(36).toUpperCase();const dir=`evidence/round5/ui-builder-${run}`;fs.mkdirSync(dir,{recursive:true});const R=new Report(`${dir}/report.json`);
const pw=JSON.parse(fs.readFileSync('.local/round5-accounts.json','utf8')).password;const s=await sessions5();
try{
 const [x]=await readyPayables(s,run+' DEAD',['1000000']);const X=await freeze(s,[x.id]);
 const cb=await contact(s,`${run} Next`);const b=await payable(s,cb.id,`${run}-NEXT`,'2000000');await allowanceCycle(s,[b.id]);// consumes X's Safe nonce
 const xs=await waitState(X.operationId,['nonce_consumed']);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});const errs:string[]=[];
 try{const page=await (await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1100}})).newPage();page.on('pageerror',e=>errs.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(ORIGIN+'/');await page.getByLabel('Email').fill('b5-owner@alder.local');await page.getByLabel('Password').fill(pw);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{level:1,name:'Treasury workspace'}).waitFor();
  await page.goto(ORIGIN+'/#batch');await page.getByRole('heading',{level:1,name:'Build payment batch'}).waitFor();
  let firstId='';
  await R.check('WALLET-FINDING-3','latest batch nonce_consumed: the builder is open (checkboxes enabled, state explained) and the allowance proposal uses exactly the current selection, not the dead batch rows',async()=>{await page.getByText(/Previous batch: Safe nonce consumed/).waitFor({timeout:15000});
   for(const box of await page.getByRole('checkbox').all()){const label=(await box.getAttribute('aria-label'))||'';const want=label==='Select '+b.contact;if(await box.isDisabled())throw Error('checkbox disabled: '+label);if((await box.isChecked())!==want)await box.click();}
   const resp=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/allowances'));await page.getByRole('button',{name:'Propose exact bounded allowance',exact:true}).click();const res=await resp;const body=await res.json();firstId=body.id;
   await page.screenshot({path:`${dir}/builder-open-after-nonce-consumed.png`,fullPage:true});
   expect(xs==='nonce_consumed'&&res.status()===200&&JSON.stringify(body.manifest.ids)===JSON.stringify([b.id])&&!body.manifest.ids.includes(x.id),'selection',{xs,status:res.status(),ids:body.manifest.ids});return {dead_batch_state:xs,proposal:body.id,manifest_ids:body.manifest.ids,dead_batch_payable_excluded:true};});
  await R.check('WALLET-FINDING-2+4','the identical allowance intent proposed again gives 409 INTENT_ALREADY_FROZEN naming the existing operation; the error banner stays visible across SSE-driven snapshot refreshes and disappears only on Dismiss',async()=>{
   const resp=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/allowances'));await page.getByRole('button',{name:'Propose exact bounded allowance',exact:true}).click();const res=await resp;const body=await res.json();
   const banner=page.locator('.error-banner');await banner.waitFor();const t0=Date.now();const snaps:number[]=[];page.on('response',r=>{if(new URL(r.url()).pathname.endsWith('/snapshot'))snaps.push(Date.now()-t0);});
   for(let i=0;i<3;i++){await s.J.post('/contacts',{display_name:`${run} sse-trigger ${i}`,address:newAddress(),chain_id:'31337'});await sleep(1500);}
   await sleep(1500);const still=await banner.isVisible();const text=await banner.innerText();await page.screenshot({path:`${dir}/error-banner-persists.png`});await page.getByRole('button',{name:'Dismiss',exact:true}).click();await sleep(300);const gone=!(await banner.isVisible().catch(()=>false));
   expect(res.status()===409&&body.error.code==='INTENT_ALREADY_FROZEN'&&body.error.details.operation_id===firstId&&snaps.length>=1&&still&&/INTENT_ALREADY_FROZEN/.test(text)&&gone&&!errs.length,'banner',{status:res.status(),body,snaps,still,text,gone,errs});
   return {status:res.status(),code:body.error.code,existing_operation:body.error.details.operation_id,background_snapshot_refreshes_during_banner:snaps.length,banner_visible_after_ms:Date.now()-t0,dismissed:gone};});
 }finally{await browser.close();}
 // exit the dead batch through verified invalidation
 await R.check('TR-T-CANCEL','the nonce_consumed batch keeps its reservation until its own verified invalidation, then is released',async()=>{const before=(await q('SELECT count(*)::int n FROM reservations r JOIN batches b ON b.id=r.batch_id WHERE b.operation_id=$1',[X.operationId]))[0].n;const inv=await s.O.post(`/operations/${X.operationId}/invalidations`,{reason:`${run} release dead batch via verified invalidation`});expect(inv.status===200,'inv',inv);await signAll(s,inv.body.id);const p=await prepare(s,inv.body.id);expect(p.status===200,'prep',p);await send(s,p.body);await mine(12);await waitState(inv.body.id,['verified']);const st=await waitState(X.operationId,['invalidated']);const rel=(await q('SELECT count(*)::int n FROM reservation_releases WHERE target_operation_id=$1',[X.operationId]))[0].n;expect(before===1&&rel===1,'rel',{before,rel});return {before,state:st,released:rel};});
}catch(e:any){R.bad('RUNNER','unexpected',{error:String(e?.stack||e).slice(0,3000)});}
finally{R.save({run,workspace:WS5});await db.end();console.log('REPORT',R.file,'pass',R.steps.filter((x:any)=>x.result==='PASS').length,'fail',R.steps.filter((x:any)=>x.result==='FAIL').length);}
