// Round 6 runner TR-T-INBOX "file quarantine visible": the private attachment upload -> quarantine -> download-refusal
// flow driven in a REAL browser (Google Chrome via Playwright) on the HTTPS dev origin, S6 workspace. Chrome trusts only
// the local leaf certificate (SPKI pin); no certificate-error bypass.
import {chromium} from '@playwright/test';import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';
import {S,Runner,expect,sleep,q,db,run,ORIGIN,WS6,S6,chromeTlsArgs,randomAddress} from './s6-lib.ts';
const R=new Runner('inbox-attachment-browser');const EXPECTED_ORIGIN='https://127.0.0.1:5113';const dir=`.local/codex-a1/inbox-browser-${run}`;fs.mkdirSync(dir,{recursive:true});
function sha(file:string){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function filePin(file:string){const actual=sha(file),expected=JSON.parse(fs.readFileSync('ops/alder-watchdog-policy.json','utf8')).sourcePins[file]||null;return {path:file,sha256:actual,policy_sha256:expected,policy_match:expected===null?null:actual===expected};}
async function bindCurrentRuntime(){
 if(process.env.ALDER_ORIGIN!==EXPECTED_ORIGIN||ORIGIN!==EXPECTED_ORIGIN)throw Error('INBOX_RELEASE_ORIGIN_REQUIRED');
 const restorePath='.local/alder-watchdog/receipts/canonical-restore-verification-20261102T091000Z.json',restoreSha=sha(restorePath);
 if(restoreSha!=='c5a11c12710d30619035b98f045f07605a24d931aad8ffeaf66aad714b968200')throw Error('CANONICAL_RESTORE_RECEIPT_PIN_MISMATCH');
 const currentRestorePath=process.env.ALDER_CURRENT_RESTORE_RECEIPT,currentRestoreExpectedSha=process.env.ALDER_CURRENT_RESTORE_RECEIPT_SHA256;
 if(!currentRestorePath||!currentRestoreExpectedSha||!path.isAbsolute(currentRestorePath))throw Error('FRESH_CURRENT_RESTORE_RECEIPT_REQUIRED');
 const currentRestoreSha=sha(currentRestorePath);if(currentRestoreSha!==currentRestoreExpectedSha)throw Error('CURRENT_RESTORE_RECEIPT_PIN_MISMATCH');
 const buildPath=process.env.ALDER_RELEASE_BUILD_RECEIPT,expectedBuildSha=process.env.ALDER_RELEASE_BUILD_RECEIPT_SHA256;
 if(!buildPath||!expectedBuildSha||!path.isAbsolute(buildPath))throw Error('FRESH_RELEASE_BUILD_RECEIPT_REQUIRED');
 const buildSha=sha(buildPath);if(buildSha!==expectedBuildSha)throw Error('RELEASE_BUILD_RECEIPT_PIN_MISMATCH');
 const receipt=JSON.parse(fs.readFileSync(restorePath,'utf8')),currentRestore=JSON.parse(fs.readFileSync(currentRestorePath,'utf8')),buildReceipt=JSON.parse(fs.readFileSync(buildPath,'utf8'));
 const localDist=sha('dist/index.html'),served=await (await fetch(ORIGIN+'/__release.json')).json();
 const [apiRes,releaseRes,workerRes]=await Promise.all([fetch('https://127.0.0.1:8103/health'),fetch(ORIGIN+'/health'),fetch('http://127.0.0.1:8113/status')]);
 const apiHealth=await apiRes.json(),releaseHealth=await releaseRes.json(),workerHealth=await workerRes.json();
 const chainChecks=await Promise.all([{method:'eth_chainId',params:[]},{method:'eth_blockNumber',params:[]},{method:'eth_getBlockByNumber',params:['0x0',false]}].map(async(call,index)=>{const response=await fetch('http://127.0.0.1:8547',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:index+1,...call})});const body=await response.json();return {status:response.status,body};}));
 const liveChain={chain_id:chainChecks[0].body.result,head:Number.parseInt(chainChecks[1].body.result,16),genesis:chainChecks[2].body.result?.hash?.toLowerCase()};
 const uiFiles=['apps/web/App.tsx','apps/web/main.tsx','apps/web/Attachments.tsx','apps/web/Destinations.tsx','apps/web/Inbox.tsx','apps/web/Policy.tsx','apps/web/Recovery.tsx','apps/web/Settings.tsx','apps/web/wallet-provider.ts','apps/web/screens.json','apps/web/style.css'];
 const apiFiles=['apps/api/app.ts','apps/api/treasury.ts','apps/api/login-throttle.ts','apps/api/attachments.ts'];
 const releaseFiles=['ops/release-server.ts','ops/release-path.ts'];
 const pins=[...apiFiles,...releaseFiles].map(filePin),mismatches=pins.filter(p=>p.policy_match===false);
 const sourceDeltaAfterBuild=uiFiles.filter(f=>!buildReceipt.source_pins?.[f]||sha(f)!==buildReceipt.source_pins[f]).map(file=>({path:file,current_sha256:sha(file),build_pin_sha256:buildReceipt.source_pins[file]||null}));
 const buildPinnedFiles=Object.keys(buildReceipt.source_pins||{}).map(file=>({path:file,build_sha256:buildReceipt.source_pins[file],current_sha256:fs.existsSync(file)?sha(file):null,match:fs.existsSync(file)?sha(file)===buildReceipt.source_pins[file]:false}));
 if(receipt.status!=='PASS'||receipt.sourceGuard?.pass!==true||receipt.sourceGuard?.pinnedFiles!==66||receipt.sourceGuard?.reviewed43Count!==43)throw Error('SOURCE_GUARD_RECEIPT_INVALID');
 if(currentRestore.passed!==true||currentRestore.transactions_submitted!==false||currentRestore.chain?.genesis?.toLowerCase()!=='0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec'||currentRestore.chain?.head!==3442||currentRestore.chain?.safe_nonce!==248||currentRestore.health?.['https://127.0.0.1:8103/health']!==200||currentRestore.health?.['http://127.0.0.1:8113/status']!==200)throw Error('FRESH_CANONICAL_RESTORE_RECEIPT_INVALID');
 if(!buildReceipt.passed||buildReceipt.tsc_exit!==0||buildReceipt.vite_exit!==0||buildReceipt.release_restarted!==true||buildReceipt.release_metadata_status!==200||buildReceipt.candidate_index_sha256!==localDist||buildReceipt.served_index_sha256!==localDist||served.dist_index_sha256!==localDist||sourceDeltaAfterBuild.length||buildPinnedFiles.some((p:any)=>!p.match))throw Error('RELEASE_BUNDLE_RUNTIME_BINDING_MISMATCH');
 if(apiRes.status!==200||apiHealth.ready!==true||releaseRes.status!==200||releaseHealth.ready!==true||workerRes.status!==200||workerHealth.role!=='active'||!(workerHealth.passes>0)||chainChecks.some(c=>c.status!==200||c.body.error)||liveChain.chain_id!=='0x7a69'||liveChain.head<3442||liveChain.genesis!=='0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec')throw Error('LIVE_RUNTIME_HEALTH_OR_CHAIN_BINDING_FAILED');
 if(mismatches.length)throw Error('SOURCE_POLICY_PIN_MISMATCH '+mismatches.map(x=>x.path).join(','));
 return {reviewer:'simulated AI tester; not human sign-off',origin:ORIGIN,binding_disposition:sourceDeltaAfterBuild.length?'built UI source hash mismatch listed':'all current UI source hashes match the build receipt',source_guard_receipt:{path:restorePath,sha256:restoreSha,status:receipt.status,source_guard_pass:receipt.sourceGuard.pass,pinned_files:receipt.sourceGuard.pinnedFiles,reviewed_pins:receipt.sourceGuard.reviewed43Count},current_restore_receipt:{path:currentRestorePath,sha256:currentRestoreSha,passed:currentRestore.passed,backup_manifest_sha256:currentRestore.backup?.manifest_sha256,chain:currentRestore.chain,recorded_health:currentRestore.health},build_receipt:{path:buildPath,sha256:buildSha,finished_at:buildReceipt.finished_at,build_runtime:buildReceipt.build_runtime,node_version:buildReceipt.node_version,tsc_exit:buildReceipt.tsc_exit,vite_exit:buildReceipt.vite_exit,candidate_index_sha256:buildReceipt.candidate_index_sha256,served_index_sha256:buildReceipt.served_index_sha256},health:{api_status:apiRes.status,api_ready:apiHealth.ready,release_status:releaseRes.status,release_ready:releaseHealth.ready,worker_status:workerRes.status,worker_role:workerHealth.role,worker_passes:workerHealth.passes,live_chain:liveChain},dist_index_sha256:localDist,served_index_sha256:served.dist_index_sha256,current_ui_source_hash_mismatches:sourceDeltaAfterBuild,build_source_pins:buildPinnedFiles,api_and_release_source_pins:pins,unbound_policy_files:pins.filter(p=>p.policy_match===null).map(p=>p.path)};
}
const binding=await bindCurrentRuntime();R.note('TR-T-INBOX','source/build/runtime binding',binding);
const J=await S.as('s6-jordan'),P=await S.as('s6-priya');
const c=await J.post('/contacts',{display_name:`${run} Attachment vendor`,address:randomAddress(),chain_id:'31337'});expect(c.status===200,'contact',c);
const v=await P.post(`/contacts/${c.body.id}/verifications`,{destination_revision:1,second_channel_reference:'S6 phone callback',decision:'approve'},{ifMatch:1});expect(v.status===200,'verify',v);
const p=await J.post('/payables',{contact_id:c.body.id,external_reference:`${run}-ATT`,amount_units:'1250',attachment_ids:[]});expect(p.status===201,'payable',p);
const browser=await chromium.launch({headless:true,executablePath:process.env.ALDER_E2E_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:chromeTlsArgs()});
const errors:string[]=[];
async function signIn(handle:string){const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(ORIGIN+'/#payable');await page.getByLabel('Email',{exact:true}).fill(`${handle}@alder.local`);await page.getByLabel('Password',{exact:true}).fill(S6.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.waitForSelector('[data-current-screen]',{timeout:20000});await page.goto(ORIGIN+'/#payable');return {ctx,page};}
const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'+'1f15c4890000000d49444154789c6360000002000154a24f0d0000000049454e44ae426082','hex');
let attId='';
await R.check('TR-T-INBOX','UI (Chrome, HTTPS, pinned cert): preparer chooses a PNG, "Upload to quarantine" -> "Upload saved · quarantined", links it to the payable revision',async()=>{const {page}=await signIn('s6-jordan');
 const sel=page.locator('select').filter({has:page.locator(`option[value="${p.body.id}"]`)});if(await sel.count())await sel.first().selectOption(p.body.id);
 const panel=page.getByRole('region',{name:'Private attachments'});await panel.waitFor({timeout:20000});
 await panel.getByLabel('Choose private attachment').setInputFiles({name:'invoice-s6.png',mimeType:'image/png',buffer:png});
 await panel.getByRole('button',{name:'Upload to quarantine'}).click();await panel.getByText('Upload saved · quarantined').waitFor({timeout:15000});
 await page.screenshot({path:`${dir}/1-uploaded-quarantined.png`,fullPage:true});
 await panel.getByRole('button',{name:/Link pending file to revision/}).click();await panel.getByText('Quarantined · pending trusted scan').waitFor({timeout:15000});
 const dl=await panel.getByText('Download private attachment').count();await page.screenshot({path:`${dir}/2-linked-quarantine-visible.png`,fullPage:true});
 const rows=await q('SELECT a.id,a.scan_state FROM payable_attachments l JOIN private_attachments a ON a.workspace_id=l.workspace_id AND a.id=l.attachment_id WHERE l.workspace_id=$1 AND l.payable_id=$2',[WS6,p.body.id]);attId=rows[0]?.id;
 expect(rows.length===1&&rows[0].scan_state==='pending'&&dl===0,'ui',{rows,dl});return {linked:rows.length,scan_state:rows[0].scan_state,download_link_shown:dl,screenshots:[`${dir}/1-uploaded-quarantined.png`,`${dir}/2-linked-quarantine-visible.png`]};});
await R.check('TR-T-INBOX','download refusal in the browser: the authenticated page fetching the content URL gets 409 QUARANTINED (no bytes); an accountant sees "Quarantined" and no download link',async()=>{const {page}=await signIn('s6-accountant');
 const sel=page.locator('select').filter({has:page.locator(`option[value="${p.body.id}"]`)});if(await sel.count())await sel.first().selectOption(p.body.id);
 const panel=page.getByRole('region',{name:'Private attachments'});await panel.getByText('Quarantined · pending trusted scan').waitFor({timeout:20000});
 const r=await page.evaluate(async(u)=>{const x=await fetch(u);return {status:x.status,type:x.headers.get('content-type'),body:(await x.text()).slice(0,200)};},`/api/v1/workspaces/${WS6}/attachments/${attId}/content`);
 const dl=await panel.getByText('Download private attachment').count();await page.screenshot({path:`${dir}/3-accountant-quarantined-no-download.png`,fullPage:true});
 expect(r.status===409&&/QUARANTINED/.test(r.body)&&dl===0,'refusal',{r,dl});return {browser_fetch:r,download_link_shown:dl};});
await R.check('TR-T-INBOX','no page errors in either browser session',async()=>{expect(errors.length===0,'errors',errors);return {page_errors:0};});
await browser.close();await db.end();const out={runner:R.name,reviewer:'simulated AI tester; not human sign-off',run,origin:ORIGIN,workspace:WS6,at:new Date().toISOString(),scope:'private S6 fixture rows and screenshots; not human acceptance',passed:R.results.filter(r=>r.pass).length,failed:R.results.filter(r=>!r.pass).length,results:R.results,notes:R.notes,private_artifact_dir:dir};fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(out,null,2));console.log('PRIVATE_RESULT',path.join(dir,'result.json'));console.log('SUMMARY',R.name,out.passed,'/',R.results.length);process.exit(out.failed?1:0);
