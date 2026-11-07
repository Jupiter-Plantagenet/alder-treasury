import '../tls-trust.ts';// @ts-nocheck -- live-stack runner; product types are checked in apps/, packages/, services/
// ROUND-5 EXTENSION-WALLET END-TO-END RUNNER (TR-T-FLOW "supported browser wallet signs real typed payload";
// TR-T-BROWSER "automated extension actual local EOA signing"). Test-record prefix W5.
//
// Path: Chrome for Testing (persistent profile) + real MetaMask extension (pinned 13.50.0, SHA256-verified, unmodified)
//  → LIVE compiled UI 127.0.0.1:5113 → release proxy → LIVE API 127.0.0.1:8103 → PostgreSQL `alder` → Anvil 127.0.0.1:8547 (31337).
// No test facade is injected anywhere in this run. The owner's page sees only the provider MetaMask injects (EIP-6963 +
// window.ethereum). Every connect / typed-data signature / transaction is approved or refused by clicking MetaMask's own
// confirmation UI. The two Safe owner keys (public Anvil-style fixtures 0x65, 0xca) are imported into MetaMask through its
// "Import an account" screen; they and the generated SRP/password are never printed, logged or screenshotted.
// The preparer and reviewer use a separate plain browser with no wallet. DB reads are READ ONLY assertions. The test
// controller only mines empty blocks (anvil_mine) to reach finality depth; it never signs or broadcasts.
import {chromium,type Page,type Response} from '@playwright/test';import fs from 'node:fs';import pg from 'pg';import {execFileSync} from 'node:child_process';
import {createPublicClient,http,parseAbi,getAddress,hashTypedData,recoverTypedDataAddress} from 'viem';import {generatePrivateKey,privateKeyToAccount,generateMnemonic,english} from 'viem/accounts';
import {Session,WS,email,password,expect} from '../round4/api-client.ts';import screens from '../../apps/web/screens.json' with {type:'json'};import {types} from '../../packages/intent.ts';
import {WALLET,BROWSER_EXE,LOOPBACK_ONLY,chromeTlsArgs,verifyPinnedWallet,launchWallet,extPage,onboard,importPrivateKey,addLocalNetwork,dump,sleep} from './metamask.ts';

const ORIGIN=process.env.ALDER_ORIGIN||'https://127.0.0.1:5103';
if(!ORIGIN.startsWith('https://127.0.0.1:'))throw Error('W5_LOOPBACK_HTTPS_ORIGIN_REQUIRED');
const run='W5'+Date.now().toString(36).toUpperCase();const dir=`evidence/round5-wallet/e2e-${run}`;fs.mkdirSync(dir,{recursive:true});
const log=(...a:any[])=>{const line=`[${new Date().toISOString()}] `+a.map(x=>typeof x==='string'?x:JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v)).join(' ');console.log(line);fs.appendFileSync(dir+'/steps.log',line+'\n');};
const chain=createPublicClient({transport:http('http://127.0.0.1:8547'),cacheTime:0});const d=JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8'));
const erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)']);const safeAbi=parseAbi(['function nonce() view returns(uint256)']);
const db=new pg.Pool({connectionString:'postgresql://postgres@127.0.0.1:5543/alder',max:2,options:'-c default_transaction_read_only=on'});
const q=async(sql:string,args:any[]=[])=>(await db.query(sql,args)).rows;
async function until(fn:()=>Promise<any>,what:string,ms=30000){const t=Date.now();let v;while(Date.now()-t<ms){v=await fn();if(v)return v;await sleep(200);}throw Error('TIMEOUT '+what);}
const mine=(n:number)=>chain.request({method:'anvil_mine' as any,params:['0x'+n.toString(16)] as any});
const report:any={run,workspace:WS,wallet:{...WALLET},browser_exe:BROWSER_EXE,network_policy:`--host-resolver-rules=${LOOPBACK_ONLY}`,deployment:{genesis:d.genesis,safe:d.safe,executor:d.executor,token:d.token},steps:[],wallet_screens:[],signatures:[]};
const step=(name:string,data:any={})=>{report.steps.push({name,at:new Date().toISOString(),...data});log('STEP',name,data);};
const errors:string[]=[];

// Owner fixture keys (public test fixtures; values never leave this process except into MetaMask's masked input).
const ownerKeys=[101,202].map(n=>('0x'+n.toString(16).padStart(64,'0')) as `0x${string}`);const ownerAddr=ownerKeys.map(k=>privateKeyToAccount(k).address);
const walletLabel=['Imported Account 1','Imported Account 2'];

let W:any,O!:Page,plain:any,J:any,P:any;const notif=()=>`chrome-extension://${W.id}/notification.html`;
const nav=async(page:Page,id:string)=>{await page.locator(`nav [data-screen="${id}"]`).click();await page.getByRole('heading',{level:1,name:screens.find(s=>s.id===id)!.title,exact:true}).waitFor();};
const refresh=async(page:Page)=>{const r=page.waitForResponse((x:Response)=>x.url().endsWith('/snapshot'));await page.getByRole('button',{name:'Refresh',exact:true}).click();await r;};
const shot=(page:Page,name:string)=>page.screenshot({path:`${dir}/${name}.png`,fullPage:true});
async function resync(page:Page){const r=page.waitForResponse((x:Response)=>x.request().method()==='POST'&&new URL(x.url()).pathname.endsWith('/resync'));await page.getByRole('button',{name:'Resynchronize canonical evidence',exact:true}).first().click();const res=await r;expect(res.status()===200,'resync 200',await res.text());return res.json();}
async function pick(page:Page,names:string[]){for(const box of await page.getByRole('checkbox').all()){const label=(await box.getAttribute('aria-label'))||'';const want=names.some(n=>label==='Select '+n);if((await box.isChecked())!==want)await box.click();}
 for(const n of names)expect(await page.getByRole('checkbox',{name:'Select '+n,exact:true}).isChecked(),'picked '+n);}
async function login(page:Page,who:string){await page.goto(ORIGIN+'/#overview');await page.getByLabel('Email',{exact:true}).fill(email(who as any));await page.getByLabel('Password',{exact:true}).fill(password());await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{level:1}).first().waitFor();}
function watch(page:Page,who:string){page.on('pageerror',e=>errors.push(who+': '+e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused to/.test(m.text()))errors.push(who+' CSP: '+m.text().slice(0,300));});page.on('dialog',x=>{log('app confirm() dialog accepted by owner',{message:x.message().slice(0,160)});x.accept();});}
async function plainActor(who:string){const ctx=await plain.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});const page=await ctx.newPage();watch(page,who);await login(page,who);return {ctx,page};}

// ---- MetaMask confirmation handling: always the extension's own UI ----
async function approvalReady(p:Page){for(const t of ['confirm-btn','confirm-footer-button','confirmation-submit-button'])if(await p.getByTestId(t).first().isVisible().catch(()=>false))return t;return null;}
async function nextApproval(timeout=60000){const t=Date.now();let opened=0;
 while(Date.now()-t<timeout){for(const p of W.ctx.pages())if(p.url().startsWith(notif())&&!p.isClosed()){const r=await approvalReady(p);if(r)return {page:p,ready:r};}
  if(Date.now()-t>4000&&opened<20){opened++;const p=await W.ctx.newPage();try{await p.goto(notif());for(let i=0;i<8;i++){await sleep(500);if(p.isClosed())break;const r=await approvalReady(p);if(r)return {page:p,ready:r};}}catch{}if(!p.isClosed())await p.close().catch(()=>{});}
  await sleep(600);}
 throw Error('TIMEOUT waiting for MetaMask approval UI');}
let connected=false;
async function walletScreen(p:Page,label:string){const text=(await p.locator('body').innerText()).replace(/\s+/g,' ').trim();fs.writeFileSync(`${dir}/wallet-${label}.txt`,text+'\n');await p.screenshot({path:`${dir}/wallet-${label}.png`,fullPage:true});report.wallet_screens.push({label,url:p.url().replace(/#.*$/,'#…'),route:(p.url().split('#')[1]||'').replace(/[0-9a-f-]{36}/g,'<id>')});return text;}
async function handleConnect(p:Page){await walletScreen(p,'connect-request');
 // Permit both Safe owner accounts for this origin (the wallet's own account selector), then connect.
 await p.getByText(/^Imported Account [12]$/).first().click();for(const a of ownerAddr){const k=`multichain-account-checkbox-keyring:Simple Key Pair/${a.toLowerCase()}`;const box=p.locator(`[data-testid="${k}"],[id="${k}"],[name="${k}"]`).first();if(!(await box.isChecked()))await box.click({force:true});}
 await walletScreen(p,'connect-select-owner-accounts');await p.getByTestId('connect-more-accounts-button').click();await p.getByTestId('confirm-btn').click();connected=true;step('MetaMask connection approved in its own Connect screen for both owner accounts');}
// Runs one wallet interaction: returns the confirmation text that MetaMask displayed.
async function inWallet(kind:'signature'|'transaction',decision:'confirm'|'reject',label:string){
 for(let guard=0;guard<4;guard++){const {page:p,ready}=await nextApproval();
  if(p.url().includes('/connect/')){await handleConnect(p);continue;}
  if(ready==='confirmation-submit-button'){await walletScreen(p,label+'-aux');log('aux wallet confirmation (approve)',{route:p.url().split('#')[1]});await p.getByTestId('confirmation-submit-button').click();continue;}
  const route=p.url().split('#')[1]||'';const isSig=route.includes('signature-request');if((kind==='signature')!==isSig){await walletScreen(p,label+'-unexpected');throw Error('UNEXPECTED_WALLET_SCREEN '+route);}
  await sleep(1200);const text=await walletScreen(p,label);
  await p.getByTestId(decision==='confirm'?'confirm-footer-button':'confirm-footer-cancel-button').click();step(`MetaMask ${kind} screen: clicked ${decision==='confirm'?'"Confirm"':'"Cancel"'}`,{label});return text;}
 throw Error('WALLET_FLOW_GUARD');}
async function selectWalletAccount(i:number){const wp=await W.ctx.newPage();await wp.goto(W.home+'#/');await wp.getByTestId('account-menu-icon').click();await wp.getByText(walletLabel[i],{exact:true}).first().click();await sleep(1500);await wp.close();
 if(connected)await until(async()=>((await O.evaluate(()=>window.ethereum.request({method:'eth_accounts'})))[0]||'').toLowerCase()===ownerAddr[i].toLowerCase(),'dApp sees '+walletLabel[i]);
 step('owner switched the active account in MetaMask account list',{account:walletLabel[i],address:ownerAddr[i]});}
function assertTypedDisplay(text:string,m:any,label:string){const safe=getAddress(m.safe),to=getAddress(m.typedData.message.to);const short=(a:string)=>`${a.slice(0,7)}...${a.slice(-5)}`;
 const checks={primaryType:text.includes('SafeTx'),network:text.includes('Alder Local 31337'),origin:text.includes(new URL(ORIGIN).host),verifyingContract:text.includes(short(safe)),to:text.includes(short(to)),nonce:text.includes(`Nonce: ${m.typedData.message.nonce}`),safeTxGas:text.includes(`SafeTxGas: ${m.typedData.message.safeTxGas}`),dataSelector:text.toLowerCase().includes(String(m.typedData.message.data).slice(0,10).toLowerCase())};
 report.signatures.push({label,display_checks:checks});expect(Object.values(checks).every(Boolean),'MetaMask displayed the exact typed SafeTx fields '+label,checks);return checks;}
async function verifySignature(opId:string,owner:string,label:string){const row=(await q('SELECT owner,signature FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2 AND lower(owner)=lower($3)',[WS,opId,owner]))[0];expect(row,'signature stored for '+owner);
 const m=(await q('SELECT manifest FROM treasury_operations WHERE workspace_id=$1 AND id=$2',[WS,opId]))[0].manifest;const td={...m.typedData,types};const digest=hashTypedData(td);const rec=await recoverTypedDataAddress({...td,signature:row.signature});
 expect(digest===m.safeTxHash,'typed payload digest equals frozen safeTxHash');expect(getAddress(rec)===getAddress(owner),'signature recovers to owner',{rec,owner});
 const entry={label,operation:opId,safeTxHash:m.safeTxHash,owner:getAddress(owner),recovered:getAddress(rec),signature:row.signature};report.signatures.push(entry);step('stored MetaMask signature recovers to the Safe owner',entry);}
async function signOp(page:Page,click:()=>Promise<any>,opId:string,i:number,label:string,m:any){await assertNonce(m,label);await selectWalletAccount(i);const before=(await q('SELECT count(*)::int n FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[WS,opId]))[0].n;
 await click();const text=await inWallet('signature','confirm',label);assertTypedDisplay(text,m,label);
 await until(async()=>(await q('SELECT count(*)::int n FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[WS,opId]))[0].n===before+1,'signature stored '+label);await verifySignature(opId,ownerAddr[i],label);await refresh(page);}
// The batch builder is locked while the workspace's latest batch is not verified/invalidated (a nonce_consumed batch left by
// another runner locks it: product defect reported in the round-5 wallet doc). Then the owner's allowance proposal and the
// preparer's freeze go through the same API the UI calls; every wallet action still happens in the UI + MetaMask.
async function builderOpen(page:Page,name:string){return await page.getByRole('checkbox',{name:'Select '+name,exact:true}).isEnabled().catch(()=>false);}
// Shared Safe: another agent's runner in a different workspace also consumes Safe nonces and resets the executor allowance.
// Start only after 45 s without any new treasury operation anywhere, and fail fast (never mislabel) on a nonce race.
async function quiet(what:string){const t=Date.now();while(Date.now()-t<15*60000){const r=(await q("SELECT extract(epoch from now()-max(created_at))::float s FROM treasury_operations"))[0];if(!r.s||r.s>45){step('treasury quiet window before '+what,{seconds_since_last_operation:Math.round(r.s)});return;}await sleep(5000);}throw Error('NO_QUIET_WINDOW '+what);}
async function assertNonce(m:any,what:string){const n=await chain.readContract({address:d.safe,abi:safeAbi,functionName:'nonce'});if(n!==BigInt(m.message.nonce))throw Error(`NONCE_RACE ${what}: Safe nonce ${n} != op nonce ${m.message.nonce} (another runner executed on the shared Safe)`);}
const opManifest=async(id:string)=>(await q('SELECT manifest,state FROM treasury_operations WHERE workspace_id=$1 AND id=$2',[WS,id]))[0];

try{
 // 0. Pinned wallet and isolated profile.
 const pin=verifyPinnedWallet();report.wallet.verified=pin;step('pinned wallet artifact verified',pin);
 expect(ownerAddr.every((a,i)=>getAddress(a)===getAddress(d.owners[i])),'fixture keys map to Safe owners 0 and 1');
 W=await launchWallet(`.local/wallet-profiles/${run}`);report.wallet.extension_id=W.id;report.browser=W.ctx.browser()?.version?.()||null;
 const wp=await extPage(W.ctx,W.id,W.home);const metrics=await onboard(wp,W.home,{seed:generateMnemonic(english),password:'W5-'+crypto.randomUUID()},log);report.wallet.metametrics=metrics;
 for(const i of [0,1])await importPrivateKey(wp,W.home,ownerKeys[i],log,walletLabel[i]);await addLocalNetwork(wp,W.home,log);await shot(wp,'00-wallet-networks');
 await wp.goto(W.home+'#/');await wp.getByTestId('account-menu-icon').click();await sleep(1000);await shot(wp,'00-wallet-accounts');await wp.close();
 step('MetaMask onboarded in a fresh profile: generated SRP, two owner accounts imported, local network added; all through extension UI',{accounts:walletLabel.map((l,i)=>({label:l,address:ownerAddr[i]}))});
 // Network self-limit evidence: the profile cannot resolve public hosts.
 const probe=await W.ctx.newPage();const blocked=await probe.goto('https://github.com/').then(()=>'LOADED',(e:Error)=>String(e.message).match(/net::[A-Z_]+/)?.[0]||'error');await probe.close();expect(blocked==='net::ERR_NAME_NOT_RESOLVED','public hosts unresolvable in wallet profile',blocked);step('loopback-only network policy active in wallet browser',{public_host:blocked});
 // Plain browser (no wallet, no facade) for the preparer and reviewer.
 plain=await chromium.launch({headless:true,executablePath:BROWSER_EXE,args:[...chromeTlsArgs(),`--host-resolver-rules=${LOOPBACK_ONLY}`]});
 const health=await (await fetch(ORIGIN+'/health')).json();expect(health.ready===true&&health.chainId===31337,'health ready',health);step('health',health);
 // Owner page in the wallet profile.
 O=await W.ctx.newPage();watch(O,'owner');
 O.on('response',async r=>{const m=r.request().method();if(m!=='GET'&&r.url().includes('/api/')){let body='';if(r.status()>=400)body=(await r.text().catch(()=>'')).slice(0,300);log('owner API',m,new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g,'<id>'),r.status(),body);}});
 // Errors may be cleared by an SSE-triggered snapshot refresh; capture every alert the owner sees.
 const seenAlerts=new Set<string>();setInterval(async()=>{try{for(const t of await O.getByRole('alert').allInnerTexts()){const k=t.trim().slice(0,300);if(k&&!seenAlerts.has(k)){seenAlerts.add(k);log('owner UI alert',k);}}}catch{}},400);await login(O,'owner');
 // String expression: tsx's keepNames helper (__name) does not exist in the page.
 const provider=await O.evaluate<{eip6963:{rdns:string}[],isMetaMask:boolean,isAlderTestWallet:boolean,testSelector:string,accountsBeforeConnect:string[]}>(`(async()=>{const seen=[];function h(e){seen.push({name:e.detail.info.name,rdns:e.detail.info.rdns,uuidPresent:!!e.detail.info.uuid});}window.addEventListener('eip6963:announceProvider',h);window.dispatchEvent(new Event('eip6963:requestProvider'));await new Promise(r=>setTimeout(r,300));window.removeEventListener('eip6963:announceProvider',h);
  return {eip6963:seen,isMetaMask:!!(window.ethereum&&window.ethereum.isMetaMask),isAlderTestWallet:!!(window.ethereum&&window.ethereum.isAlderTestWallet),testSelector:typeof window.__testWalletSelect,accountsBeforeConnect:await window.ethereum.request({method:'eth_accounts'})};})()`);
 expect(provider.eip6963.length===1&&provider.eip6963[0].rdns==='io.metamask'&&provider.isMetaMask&&!provider.isAlderTestWallet&&provider.testSelector==='undefined'&&provider.accountsBeforeConnect.length===0,'only the real MetaMask provider is present; no facade; not auto-connected',provider);
 step('owner page provider is MetaMask via EIP-6963 (single announcement); no test facade; no connection on page load',provider);await shot(O,'01-owner-topbar');
 J=await plainActor('jordan');P=await plainActor('priya');step('three real logins (preparer/reviewer in plain browser, owner in wallet profile)');

 const startSafe=await chain.readContract({address:d.token,abi:erc20,functionName:'balanceOf',args:[d.safe]});
 const people=['A','B','C','D'].map(x=>({name:`${run} Contractor ${x}`,address:privateKeyToAccount(generatePrivateKey()).address,ref:`${run}-INV-${x}`}));
 const amounts=['1250.5','2000','750.25','500'],units=['1250500000','2000000000','750250000','500000000'];
 // 1. Contacts; 2. second-channel verification for A..C; D stays held.
 await nav(J.page,'contacts');for(const c of people){await J.page.getByLabel('Contact display name',{exact:true}).fill(c.name);await J.page.getByLabel('Full destination address',{exact:true}).fill(c.address);await J.page.getByRole('button',{name:'Create contact',exact:true}).click();await J.page.getByRole('heading',{name:c.name,exact:true}).waitFor();}
 const contacts=await q('SELECT c.id,c.display_name,c.revision,r.address FROM contacts c JOIN contact_revisions r ON r.workspace_id=c.workspace_id AND r.contact_id=c.id AND r.revision=c.revision WHERE c.workspace_id=$1 AND c.display_name LIKE $2 ORDER BY c.display_name',[WS,run+'%']);
 expect(contacts.length===4&&contacts.every((c:any,i:number)=>getAddress(c.address)===people[i].address),'4 contacts persisted',contacts);step('contacts created by preparer');
 await nav(P.page,'contacts');await refresh(P.page);for(const c of people.slice(0,3)){const card=P.page.locator('article.panel').filter({has:P.page.getByRole('heading',{name:c.name,exact:true})});await card.getByText('Independent second-channel verification',{exact:true}).click();await card.getByLabel('Private second-channel reference',{exact:true}).fill(`Called ${c.name} on file number; read back ${c.address.slice(0,10)}…${c.address.slice(-6)}`);await card.locator('select[name="decision"]').selectOption('approve');await card.getByRole('button',{name:'Record independent verification',exact:true}).click();await P.page.locator('article.panel').filter({has:P.page.getByRole('heading',{name:c.name,exact:true})}).getByText(/Verified independently/).waitFor();}
 step('destinations A..C verified by reviewer; D pending');
 // 3. Four manual payables.
 await refresh(J.page);await nav(J.page,'payables');await J.page.getByText(/records in snapshot/).waitFor({timeout:60000});
 for(let i=0;i<4;i++){const c=contacts[i];await J.page.getByLabel('Contact',{exact:true}).selectOption(c.id);await J.page.getByLabel('External reference',{exact:true}).fill(people[i].ref);await J.page.getByLabel('Amount · ALDR',{exact:true}).fill(amounts[i]);await J.page.getByRole('button',{name:'Save manual payable',exact:true}).click();await J.page.getByText('Saved '+people[i].ref,{exact:true}).waitFor();await J.page.getByRole('button',{name:'Create another payable',exact:true}).click();}
 const pays=await q('SELECT p.* FROM payables p WHERE p.workspace_id=$1 AND p.display_reference LIKE $2 ORDER BY p.display_reference',[WS,run+'%']);
 expect(pays.length===4&&pays.every((p:any,i:number)=>p.amount_units===units[i]),'4 payables exact units',pays.map((p:any)=>p.amount_units));step('4 manual payables persisted with exact base units');
 // The workspace intentionally starts with no policy. Publish the intended review rule through
 // the normal reviewer UI; scope it to the independently verified A..C contacts and preserve D's hold.
 await refresh(P.page);await nav(P.page,'policy');
 await P.page.getByLabel('Maximum · base units (blank = no upper bound)',{exact:true}).fill('2000000000');
 await P.page.locator('select[multiple]').selectOption(contacts.slice(0,3).map((c:any)=>c.id));
 await P.page.getByLabel('Change reason',{exact:true}).fill('Clean reproduction policy: independently verified contractor contacts A–C, capped at 2,000,000,000 base units.');
 await P.page.getByRole('button',{name:'Preview impact',exact:true}).click();
 const previewPanel=P.page.getByRole('heading',{name:'Impact preview · revision 1',exact:true}).locator('xpath=..');
 const impact=previewPanel.getByRole('region',{name:'Policy impact table'});await impact.waitFor();
 const impactRows=await impact.locator('tbody tr').allInnerTexts();
 const fixtureRows=impactRows.filter((x:string)=>!people.some((p:any)=>x.includes(p.ref)));
 expect(impactRows.length===8&&people.slice(0,3).every((p:any)=>impactRows.some((x:string)=>x.includes(p.ref)&&x.includes('Awaiting independent review')))&&impactRows.some((x:string)=>x.includes(people[3].ref)&&x.includes('Held · no matching rule'))&&fixtureRows.length===4&&fixtureRows.every((x:string)=>x.includes('Held · no matching rule')),'policy preview matches A–C, holds D, and keeps four pre-existing fixture payables unmatched',impactRows);
 await P.page.getByRole('button',{name:'Create policy revision 1',exact:true}).click();
 await P.page.getByText(/Saved policy revision 1\./).waitFor();await P.page.getByRole('heading',{name:'Business review policy · revision 1',exact:true}).waitFor();
 step('reviewer publishes policy through the real UI; verified A–C match and D remains unmatched/held');
 // 4. Policy-bound review of A..C; D cannot be approved.
 await refresh(P.page);await nav(P.page,'payable');
 for(const p of pays.slice(0,3)){for(let attempt=0;;attempt++){await P.page.locator('label:has-text("Payable to inspect") select').selectOption(p.id);await P.page.getByLabel('Independent business review reason',{exact:true}).fill(`Work for ${p.display_reference} accepted; amount matches contract.`);const r=P.page.waitForResponse((x:Response)=>x.url().endsWith(`/payables/${p.id}/review`));await P.page.getByRole('button',{name:'Approve exact payable revision',exact:true}).click();const res=await r;const body=await res.text();
  // Another runner may publish a policy revision concurrently; the product correctly refuses the stale review. Re-read and retry.
  if(res.status()!==200&&/STALE_POLICY_REVISION/.test(body)&&attempt<3){log('review refused STALE_POLICY_REVISION (concurrent policy publish); refreshing',{payable:p.display_reference});await refresh(P.page);await nav(P.page,'payable');continue;}
  expect(res.status()===200,'review 200',body);await P.page.getByText('Approved by reviewer').waitFor();break;}}
 await P.page.locator('label:has-text("Payable to inspect") select').selectOption(pays[3].id);expect(await P.page.getByRole('button',{name:'Approve exact payable revision',exact:true}).isDisabled(),'held fourth approve disabled');
 const pApi=await Session.login('priya');const heldReview=await pApi.post(`/payables/${pays[3].id}/review`,{revision:1,policy_revision:1,reason:'try'},{ifMatch:1});expect(heldReview.status===422,'held fourth review refused',heldReview);step('3 policy-bound reviews; held fourth refused',{held_code:heldReview.body?.error?.code});

 // 5. Allowance. The first allowance authorization is signed by both owners in MetaMask, then the owner REFUSES the
 //    broadcast in MetaMask: the app records wallet_refused durably and nothing is sent. Because a refusal leaves the exact
 //    authorization executable and blocks a new attempt, the owner recovers through the product's invalidation path: an
 //    empty Safe self-call at the same nonce, signed by both owners and broadcast in MetaMask, verified at depth 12. Then
 //    fresh allowance authorizations (zero reset if needed, then the exact cap) are signed and broadcast in MetaMask.
 const three=people.slice(0,3).map(p=>p.name);const oApi=await Session.login('owner');await refresh(O);await nav(O,'batch');
 const allowanceRounds:any[]=[];let refusalDone=false;const ids3=pays.slice(0,3).map((p:any)=>p.id);
 const signedBy=async(opId:string)=>(await q('SELECT lower(owner) o FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[WS,opId])).map((r:any)=>r.o);
 for(let round=0;round<4;round++){
  if(round===0)await quiet('allowance');let op:any;const safeN=await chain.readContract({address:d.safe,abi:safeAbi,functionName:'nonce'});
  const r=await oApi.post('/allowances',{ids:ids3});
  if(r.status===200){op=r.body;report.allowance_proposal_path='owner API (the same endpoint the UI button calls; the batch-builder selection is unreliable while an unrelated batch is non-terminal)';}
  else{// Product defect: an identical intent (same cap at the same Safe nonce) already exists -> unique index -> HTTP 500. Reuse it.
   const ex=(await q("SELECT id,manifest FROM treasury_operations WHERE workspace_id=$1 AND kind='allowance' AND state IN ('frozen','signed') AND manifest->'message'->>'nonce'=$2 ORDER BY created_at DESC LIMIT 1",[WS,String(safeN)]))[0];
   expect(ex,'allowance proposal or reusable identical frozen intent',r);op={id:ex.id,manifest:ex.manifest};report.reused_identical_allowance_intent=(report.reused_identical_allowance_intent||[]).concat([{id:ex.id,propose_status:r.status,propose_body:r.body}]);log('allowance proposal returned',r.status,'; reusing identical frozen intent',ex.id);}
  await refresh(O);await nav(O,'batch');await O.getByRole('button',{name:'Sign separate allowance',exact:true}).waitFor();
  const latest=(await q("SELECT id FROM treasury_operations WHERE workspace_id=$1 AND kind='allowance' ORDER BY created_at DESC LIMIT 1",[WS]))[0].id;expect(latest===op.id,'UI allowance panel shows this authorization',{latest,op:op.id});
  for(const i of [1,0]){if((await signedBy(op.id)).includes(ownerAddr[i].toLowerCase())){log('owner already signed this identical intent earlier; skipping',ownerAddr[i]);continue;}await signOp(O,()=>O.getByRole('button',{name:'Sign separate allowance',exact:true}).click(),op.id,i,`allowance-r${round}-owner${i}`,op.manifest);}
  if(!refusalDone){
   const nonceBefore=await Promise.all(ownerAddr.map(a=>chain.getTransactionCount({address:a})));const reqs:string[]=[];const h=(x:any)=>{if(x.method()==='POST')reqs.push(new URL(x.url()).pathname.replace(/[0-9a-f-]{36}/g,'<id>'));};O.on('request',h);
   await O.getByRole('button',{name:'Broadcast separate allowance',exact:true}).click();await inWallet('transaction','reject','allowance-broadcast-REFUSED');
   await O.getByText(/Wallet refusal/).first().waitFor();await shot(O,'05a-allowance-wallet-refusal');const uiError=(await O.getByRole('alert').first().innerText().catch(()=>'')).trim();await sleep(1000);O.off('request',h);
   const obs=await until(async()=>(await q("SELECT o.kind,o.transaction_hash,a.sender,a.sender_nonce FROM treasury_observations o JOIN treasury_attempts a ON a.workspace_id=o.workspace_id AND a.id=o.attempt_id WHERE a.workspace_id=$1 AND a.operation_id=$2",[WS,op.id]))[0],'refusal observation');
   const nonceAfter=await Promise.all(ownerAddr.map(a=>chain.getTransactionCount({address:a})));
   expect(obs.kind==='wallet_refused'&&!obs.transaction_hash&&nonceAfter.every((n,i)=>n===nonceBefore[i]),'broadcast refusal recorded durably; nothing sent',{obs,nonceBefore,nonceAfter});
   await nav(O,'recovery');await resync(O);const refusedState=(await opManifest(op.id)).state;expect(refusedState==='wallet_refused','operation state wallet_refused after resync',refusedState);
   report.refusals={broadcast:{operation:op.id,observation:obs.kind,transaction_hash:obs.transaction_hash,owner_sender_nonces_unchanged:true,ui_error:uiError,state_after_resync:refusedState,app_posts:reqs}};
   step('owner refused the allowance broadcast in MetaMask: app recorded wallet_refused, no transaction, sender nonces unchanged',report.refusals.broadcast);
   // Recovery: product invalidation (nonce consumption) driven in the Recover screen, signed and broadcast in MetaMask.
   const n=op.manifest.message.nonce;const det=()=>O.locator('details').filter({has:O.locator('summary',{hasText:new RegExp(`allowance · nonce ${n} · Wallet refused`)})}).first();
   const openDet=async()=>{await refresh(O);await nav(O,'recovery');const dd=det();if((await dd.getAttribute('open'))===null)await dd.locator('summary').click();return dd;};
   let dd=await openDet();await dd.getByLabel('Invalidation reason',{exact:true}).fill(`${run}: owner refused the broadcast in the wallet; consume the nonce so this authorization can never execute.`);
   const ir=O.waitForResponse((x:Response)=>x.request().method()==='POST'&&/\/invalidations$/.test(new URL(x.url()).pathname));await dd.getByRole('button',{name:'Propose on-chain invalidation',exact:true}).click();const irr=await ir;expect(irr.status()===200,'invalidation proposed',await irr.text());const inv=await irr.json();
   step('owner proposed on-chain invalidation (nonce consumption) of the refused authorization',{invalidation:inv.id,method:inv.method,nonce:inv.manifest.message.nonce});
   for(const i of [1,0]){dd=await openDet();await signOp(O,()=>det().getByRole('button',{name:'Sign invalidation',exact:true}).click(),inv.id,i,`invalidation-owner${i}`,inv.manifest);}
   dd=await openDet();await assertNonce(inv.manifest,'invalidation broadcast');await dd.getByRole('button',{name:'Broadcast invalidation',exact:true}).click();await inWallet('transaction','confirm','invalidation-broadcast');await O.getByText(/Wallet observed 0x/).waitFor();
   await mine(11);await resync(O);await until(async()=>(await opManifest(inv.id)).state==='verified'&&(await opManifest(op.id)).state==='invalidated','invalidation verified; refused authorization invalidated',90000);
   await openDet().catch(()=>{});await shot(O,'05b-refused-authorization-invalidated');report.refusals.broadcast.recovery={invalidation:inv.id,invalidation_state:'verified',target_state:'invalidated'};
   step('invalidation signed by 2 owners and broadcast in MetaMask; verified at depth 12; refused authorization now invalidated',report.refusals.broadcast.recovery);
   refusalDone=true;await refresh(O);await nav(O,'batch');continue;}
  await assertNonce(op.manifest,'allowance broadcast');await O.getByRole('button',{name:'Broadcast separate allowance',exact:true}).click();await inWallet('transaction','confirm','allowance-broadcast-r'+round);await O.getByText(/Wallet observed 0x/).waitFor();
  await mine(11);await resync(O);const st=await opManifest(op.id);expect(st.state==='verified','allowance verified at depth 12',{state:st.state});
  allowanceRounds.push({id:op.id,reset:st.manifest.reset,cap:st.manifest.cap});await refresh(O);if(!st.manifest.reset)break;await nav(O,'batch');}
 const allowance=await chain.readContract({address:d.token,abi:erc20,functionName:'allowance',args:[d.safe,d.executor]});expect(allowance===4000750000n,'on-chain allowance exact',String(allowance));
 step('allowance signed by 2 owners in MetaMask, broadcast via MetaMask, independently verified',{rounds:allowanceRounds,allowance:String(allowance)});await shot(O,'05-allowance');
 const jApi=await Session.login('jordan');const heldFreeze=await jApi.post('/batches',{ids:pays.map((p:any)=>p.id)});expect(heldFreeze.status===422,'held fourth blocks freeze (422)',heldFreeze);step('freeze including held fourth refused',{status:heldFreeze.status,code:heldFreeze.body?.error?.code});
 // 6. Preparer freezes.
 await J.page.reload();await J.page.getByRole('heading',{level:1}).first().waitFor();await nav(J.page,'batch');let frozen:any;
 if(await builderOpen(J.page,three[0])){await pick(J.page,three);const fr=J.page.waitForResponse((x:Response)=>x.request().method()==='POST'&&x.url().endsWith('/batches'));await J.page.getByRole('button',{name:'Freeze batch & review intent',exact:true}).click();const frr=await fr;expect(frr.status()===200,'freeze 200',await frr.text());frozen=await frr.json();await J.page.getByRole('heading',{level:1,name:'Review signing intent',exact:true}).waitFor();report.freeze_path='ui';}
 else{const r=await jApi.post('/batches',{ids:pays.slice(0,3).map((p:any)=>p.id)});expect(r.status===200,'freeze (API; builder locked)',r);frozen=r.body;report.freeze_path='api (batch builder locked by an unrelated nonce_consumed batch)';}step('batch frozen by preparer',{batch:frozen.id,operation:frozen.operationId,safeTxHash:frozen.manifest.safeTxHash,nonce:frozen.manifest.message.nonce});
 // 7. Payout signatures: owner 0 first REFUSES in MetaMask (no signature may be created), then owners 0 and 1 sign.
 await O.reload();await O.getByRole('heading',{level:1}).first().waitFor();await nav(O,'signatures');const payoutM=(await opManifest(frozen.operationId)).manifest;
 await selectWalletAccount(0);const sigPosts:string[]=[];const hs=(r:any)=>{if(r.method()==='POST'&&/\/signatures$/.test(new URL(r.url()).pathname))sigPosts.push(r.url());};O.on('request',hs);
 await O.getByRole('button',{name:'Connect local wallet & sign exact intent',exact:true}).click();const refusedText=await inWallet('signature','reject','payout-signature-REFUSED');assertTypedDisplay(refusedText,payoutM,'payout-signature-REFUSED');
 await O.getByText(/Wallet refusal/).first().waitFor();await shot(O,'07a-signature-wallet-refusal');await sleep(1500);O.off('request',hs);
 const sigAfterRefusal=(await q('SELECT count(*)::int n FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[WS,frozen.operationId]))[0].n;const sigUi=(await O.getByRole('alert').first().innerText()).trim();
 expect(sigAfterRefusal===0&&sigPosts.length===0,'signature refusal created no signature',{sigAfterRefusal,sigPosts});
 report.refusals.signature={operation:frozen.operationId,signatures_after_refusal:sigAfterRefusal,signature_posts:sigPosts.length,ui_error:sigUi};step('owner refused the payout signature in MetaMask: UI shows wallet refusal, 0 signatures stored, no signature request sent to API',report.refusals.signature);
 await refresh(O);for(const i of [0,1])await signOp(O,()=>O.getByRole('button',{name:'Connect local wallet & sign exact intent',exact:true}).click(),frozen.operationId,i,`payout-owner${i}`,payoutM);
 await O.getByText('2 of 2 required').waitFor();await shot(O,'07-signatures');
 // 8. Owner prepares the durable attempt and broadcasts through MetaMask.
 await nav(O,'execution');await assertNonce(payoutM,'payout broadcast');await O.getByRole('button',{name:'Prepare & explicitly broadcast with wallet',exact:true}).click();await inWallet('transaction','confirm','payout-broadcast');await O.getByText(/Wallet observed 0x/).waitFor();
 const obs=(await q("SELECT o.kind,o.transaction_hash,a.sender FROM treasury_observations o JOIN treasury_attempts a ON a.workspace_id=o.workspace_id AND a.id=o.attempt_id WHERE a.workspace_id=$1 AND a.operation_id=$2",[WS,frozen.operationId]))[0];expect(obs.kind==='wallet_hash','wallet hash observed',obs);
 const rcpt=await chain.getTransactionReceipt({hash:obs.transaction_hash});const txv=await chain.getTransaction({hash:obs.transaction_hash});expect(getAddress(txv.from)===getAddress(obs.sender)&&txv.to!==null&&getAddress(txv.to)===getAddress(d.safe),'MetaMask sent the prepared Safe transaction from the owner',{from:txv.from,to:txv.to});
 step('owner prepared durable attempt, MetaMask broadcast it',{tx:obs.transaction_hash,from:txv.from,status:rcpt.status,block:String(rcpt.blockNumber)});await shot(O,'08-execution');
 // 9. Not paid before depth 12; then verified settlements and exact token deltas.
 await nav(O,'recovery');await resync(O);const early=(await q("SELECT count(*)::int n FROM treasury_settlements WHERE workspace_id=$1 AND operation_id=$2 AND state='verified'",[WS,frozen.operationId]))[0].n;expect(early===0,'receipt alone never paid');step('after receipt, before depth 12: not paid',{settled:early});
 await mine(14);await resync(O);await until(async()=>(await q("SELECT count(*)::int n FROM treasury_settlements WHERE workspace_id=$1 AND operation_id=$2 AND state='verified'",[WS,frozen.operationId]))[0].n===3,'3 settlements',60000);
 await refresh(O);await nav(O,'settlement');await O.getByText(/canonically reconciled private payable records/).waitFor();await shot(O,'09-settlement');
 const bal=await Promise.all(people.map(p=>chain.readContract({address:d.token,abi:erc20,functionName:'balanceOf',args:[p.address as any]})));const endSafe=await chain.readContract({address:d.token,abi:erc20,functionName:'balanceOf',args:[d.safe]});
 expect(bal.slice(0,3).every((b,i)=>b===BigInt(units[i]))&&bal[3]===0n&&startSafe-endSafe===4000750000n,'exact on-chain recipient effects',bal.map(String));
 step('independent depth-12 verification → 3 payables reconciled; exact token deltas',{recipient_units:bal.map(String),safe_delta:String(startSafe-endSafe)});
 // 10. Optional real API restart (off by default so a concurrent agent's run is not disturbed).
 if(process.env.W5_API_RESTART==='1'){if(process.platform==='win32')execFileSync('powershell',['-NoProfile','-File','ops/round4-services.ps1','restart','api'],{encoding:'utf8'});else execFileSync('bash',['tests/round6-repro/restart-api-linux.sh'],{encoding:'utf8'});await until(async()=>{try{return (await fetch(ORIGIN+'/health')).status===200;}catch{return false;}},'api back',30000);step('API restarted');}
 await O.reload();for(const s of screens){await nav(O,s.id);}step('all 13 screens navigate after reload (owner, wallet profile)');
 const accFreeze=await (await Session.login('accountant')).post('/batches',{ids:[pays[3].id]});expect(accFreeze.status===403,'accountant read-only',accFreeze);
 report.payables=pays.map((p:any)=>({id:p.id,ref:p.display_reference,units:p.amount_units}));report.batch=frozen.id;report.operation=frozen.operationId;report.tx=obs.transaction_hash;
 report.passed=errors.length===0;report.page_errors=errors;
}catch(e:any){report.passed=false;report.error=String(e?.stack||e);report.page_errors=errors;log('FAILED',report.error);
 try{for(const p of W?.ctx?.pages()||[])if(p.url().startsWith('chrome-extension://')){fs.writeFileSync(`${dir}/failure-wallet-dump.json`,JSON.stringify(await dump(p),null,1));}if(O)await shot(O,'failure-owner');if(J)await shot(J.page,'failure-preparer');if(P)await shot(P.page,'failure-reviewer');}catch{}}
finally{fs.writeFileSync(dir+'/report.json',JSON.stringify(report,(_,v)=>typeof v==='bigint'?String(v):v,2));await W?.ctx?.close().catch(()=>{});if(process.env.W5_KEEP_PROFILE!=='1'){try{fs.rmSync(`.local/wallet-profiles/${run}`,{recursive:true,force:true});}catch{}}await plain?.close().catch(()=>{});await db.end();log('REPORT',dir+'/report.json','passed='+report.passed);if(!report.passed)process.exitCode=1;setTimeout(()=>process.exit(),300);}
