// Synthetic harness-only contract test for bounded contact-card rendering.
// It uses local DOM fixtures, creates no product records, calls no API, and sends no chain transactions.
import {firefox} from '@playwright/test';
import fs from 'node:fs';
import {revealVerifiedContact} from './contact-pagination.ts';

const browser=await firefox.launch({headless:true});
const results:any[]=[];
const assert=(condition:boolean,message:string)=>{if(!condition)throw Error(message);};
const makeCard=(page:any)=>page.locator('#target');
const page=await browser.newPage();
try{
 // A delayed refresh moves a pending visible card off the first page. One More click mounts its verified state.
 {
  await page.setContent(`<main><p role="status">Showing 150 of 227 contacts.</p><button id="more">Show more contacts</button><section id="cards"><article id="target"><p>Verification pending</p></article></section></main><script>setTimeout(()=>document.querySelector('#target')?.remove(),120);document.querySelector('#more').onclick=()=>{document.querySelector('#cards').insertAdjacentHTML('beforeend','<article id="target"><p>Verified independently</p></article>');document.querySelector('[role=status]')?.remove();document.querySelector('#more')?.remove()}</script>`);
  const card=makeCard(page);const result=await revealVerifiedContact(page,card,'delayed-move');
  assert(result.expanded_pages===1,'delayed refresh must reveal after exactly one bounded expansion');
  assert(await card.getByText(/Verified independently/).isVisible(),'verified status must be visible after expansion');
  results.push({case:'visible pending → refresh unmount → More → verified',passed:true,expanded_pages:result.expanded_pages,refresh_observations:result.refresh_observations});
 }
 // A previously verified card is mounted on a fully expanded list with no summary or More button.
 {
  await page.setContent('<main><article id="target"><p>Verified independently</p></article></main>');
  const card=makeCard(page);const result=await revealVerifiedContact(page,card,'already-visible');
  assert(result.expanded_pages===0,'already-visible verified card must not expand');
  results.push({case:'already verified, visible, no summary',passed:true,expanded_pages:0,refresh_observations:result.refresh_observations});
 }
 // A pending card that never changes must fail at the caller-supplied short synthetic deadline.
 {
  await page.setContent('<main><p role="status">Showing 1 of 2 contacts.</p><button>Show more contacts</button><article id="target"><p>Verification pending</p></article></main>');
  const card=makeCard(page);const started=Date.now();let error='';
  try{await revealVerifiedContact(page,card,'never-changes',350);}catch(e:any){error=String(e?.message||e);}
  const elapsed=Date.now()-started;
  assert(error.includes('verified contact status did not render before bounded deadline'),'unchanged pending card must fail explicitly');
  assert(elapsed<1500,'unchanged pending card failure must remain bounded');
  const bounded=error.includes('verified contact status did not render before bounded deadline')&&elapsed<1500;
  results.push({case:'pending never changes',passed:bounded,elapsed_ms:elapsed,error});
  assert(bounded,'unchanged pending card must fail explicitly within the injected deadline');
 }
 // Missing summary plus a hidden target and no More control is a structural failure, not an unbounded retry.
 {
  await page.setContent('<main><article id="target" style="display:none"><p>Verification pending</p></article></main>');
  const card=makeCard(page);const started=Date.now();let error='';
  try{await revealVerifiedContact(page,card,'missing-without-pagination',350);}catch(e:any){error=String(e?.message||e);}
  const elapsed=Date.now()-started;
  assert(error.includes('no usable summary and target is not mounted'),'missing summary/More/target must fail with structure diagnostics');
  const bounded=error.includes('no usable summary and target is not mounted')&&elapsed<1500;
  results.push({case:'no summary, no More, hidden target',passed:bounded,elapsed_ms:elapsed,error});
  assert(bounded,'missing-pagination failure must be immediate and stay within 1.5s');
 }
 const report={at:new Date().toISOString(),synthetic_harness_only:true,product_records_created:0,api_calls:0,chain_transactions:0,browser:browser.version(),cases:results,total:results.length,passed:results.every(x=>x.passed)};
 fs.writeFileSync('.local/codex-a1/22-contact-pagination-contract-retry.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
 if(!report.passed)process.exitCode=1;
}catch(e:any){
 fs.writeFileSync('.local/codex-a1/22-contact-pagination-contract-retry.json',JSON.stringify({at:new Date().toISOString(),synthetic_harness_only:true,browser:browser.version(),cases:results,passed:false,error:String(e?.stack||e)},null,2));
 console.error(String(e?.stack||e));process.exitCode=1;
}finally{await browser.close();}
