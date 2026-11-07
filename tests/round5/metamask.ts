// @ts-nocheck -- live-stack wallet driver; product types are checked in apps/, packages/, services/
// ROUND-5 EXTENSION-WALLET DRIVER (TR-T-FLOW wallet clause, TR-T-BROWSER extension clause).
// Drives the real, unmodified MetaMask Chrome extension (pinned release, SHA256-verified, loaded unpacked from
// .local/wallets/) inside a persistent Chrome-for-Testing profile. Every wallet decision is made by clicking the
// extension's OWN onboarding / confirmation UI. Secrets (generated seed, wallet password, fixture owner keys) are
// typed into extension inputs via Playwright fill() and are never logged, printed or screenshotted.
// Network self-limit: the browser resolves only loopback hosts (--host-resolver-rules), so neither the extension nor
// the page can reach any public endpoint; the only chain is the local Anvil 127.0.0.1:8547 / 31337.
import {chromium,type BrowserContext,type Page} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';

export const WALLET={name:'MetaMask',version:'13.50.0',zip:'.local/wallets/metamask-chrome-13.50.0/metamask-chrome-13.50.0.zip',zipSha256:'b759caca275dec1a10edfebb9d1de1d26589a92104d8b0523ec442930e20e47c',
 source:'https://github.com/MetaMask/metamask-extension/releases/download/v13.50.0/metamask-chrome-13.50.0.zip',dir:'.local/wallets/metamask-chrome-13.50.0/unpacked'};
export const BROWSER_EXE=process.env.ALDER_W5_BROWSER||'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
export const LOOPBACK_ONLY='MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost';
export const chromeTlsArgs=()=>fs.existsSync('.local/tls/server.spki')?[`--ignore-certificate-errors-spki-list=${fs.readFileSync('.local/tls/server.spki','utf8').trim()}`]:[];

export function verifyPinnedWallet(){const sum=crypto.createHash('sha256').update(fs.readFileSync(WALLET.zip)).digest('hex');if(sum!==WALLET.zipSha256)throw Error('WALLET_PIN_MISMATCH '+sum);
 const m=JSON.parse(fs.readFileSync(path.join(WALLET.dir,'manifest.json'),'utf8'));if(!String(m.version).startsWith(WALLET.version))throw Error('WALLET_UNPACKED_VERSION '+m.version);return {zipSha256:sum,manifestVersion:m.version,manifest_version:m.manifest_version};}

export async function launchWallet(profileDir:string,opts:{headless?:boolean}={}){
 fs.mkdirSync(profileDir,{recursive:true});const ext=path.resolve(WALLET.dir);
 const ctx=await chromium.launchPersistentContext(profileDir,{executablePath:BROWSER_EXE,headless:opts.headless??true,viewport:{width:1440,height:1000},
  args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,...chromeTlsArgs(),...(process.env.ALDER_W5_DIAG_OPEN_NET==='1'?[]:[`--host-resolver-rules=${LOOPBACK_ONLY}`]),'--no-first-run','--no-default-browser-check']});
 let sw=ctx.serviceWorkers()[0];if(!sw)sw=await ctx.waitForEvent('serviceworker',{timeout:30000});
 const id=new URL(sw.url()).host;return {ctx,id,home:`chrome-extension://${id}/home.html`};}

// Visible text/buttons dump for exploration and failure diagnostics (never includes input values).
// MetaMask runs under LavaMoat scuttling, so page.evaluate in the main world is unavailable; locators run in
// Playwright's isolated utility world and are used instead.
export async function dump(page:Page){
 const buttons:string[]=[];for(const b of await page.locator('button:visible,[role=button]:visible,a:visible').all()){try{const t=(await b.innerText({timeout:500})).trim().replace(/\s+/g,' ');const tid=await b.getAttribute('data-testid',{timeout:500});const dis=await b.isDisabled({timeout:500}).catch(()=>false);buttons.push((t||await b.getAttribute('aria-label')||'')+(tid?` [${tid}]`:'')+(dis?' (disabled)':''));}catch{}if(buttons.length>80)break;}
 const inputs:string[]=[];for(const i of await page.locator('input:visible,textarea:visible').all()){try{inputs.push(`${await i.getAttribute('type')}:${(await i.getAttribute('data-testid'))||(await i.getAttribute('id'))||(await i.getAttribute('name'))||(await i.getAttribute('placeholder'))||''}`);}catch{}}
 const text=(await page.locator('body').innerText({timeout:2000}).catch(()=>'')).replace(/\s+/g,' ').slice(0,1500);
 return {url:page.url(),buttons,inputs,text};}

export const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

// ---- Onboarding / setup through the extension's own UI (selectors discovered against 13.50.0; see probe logs) ----
export type WalletLog=(...a:any[])=>void;
const tid=(page:Page,id:string)=>page.getByTestId(id).first();
// The wallet validates the RPC endpoint/chain id asynchronously before enabling Save; wait for it rather than sleeping.
export async function clickWhenEnabled(page:Page,id:string,ms=30000){const t=Date.now();const b=page.getByTestId(id).first();while(Date.now()-t<ms){if(await b.isEnabled().catch(()=>false)){await b.click();return;}await sleep(300);}throw Error('NOT_ENABLED '+id);}
export async function extPage(ctx:BrowserContext,id:string,home:string){await sleep(2500);const page=ctx.pages().find(p=>p.url().startsWith(`chrome-extension://${id}/`))||await ctx.newPage();if(!page.url().startsWith(`chrome-extension://${id}/home.html`))await page.goto(home);return page;}

// Imports a locally generated, never-printed 12-word SRP (the HD accounts are unused), sets a random local password,
// skips passkey, declines metrics, then opens the wallet home.
export async function onboard(page:Page,home:string,secret:{seed:string,password:string},log:WalletLog){
 await tid(page,'onboarding-import-wallet').click();await tid(page,'onboarding-import-with-srp-button').click();
 await page.getByPlaceholder('Add a space between each word').first().click();await page.keyboard.type(secret.seed,{delay:2});
 await tid(page,'import-srp-confirm').click();log('wallet: generated local SRP imported (value not recorded)');
 await tid(page,'create-password-new-input').fill(secret.password);await tid(page,'create-password-confirm-input').fill(secret.password);await tid(page,'create-password-terms').check();await tid(page,'create-password-submit').click();
 await tid(page,'passkey-maybe-later-button').click({timeout:20000});
 await page.locator('#metametrics-opt-in').waitFor({state:'attached'});if(await page.locator('#metametrics-opt-in').isChecked())await tid(page,'metametrics-checkbox').click();
 if(await page.locator('#metametrics-datacollection-opt-in').isChecked())await tid(page,'metametrics-data-collection-checkbox').click();
 const metrics={usage:await page.locator('#metametrics-opt-in').isChecked(),marketing:await page.locator('#metametrics-datacollection-opt-in').isChecked()};
 await tid(page,'metametrics-i-agree').click();await tid(page,'onboarding-complete-done').click({timeout:20000});log('wallet: onboarding complete; MetaMetrics opt-in',metrics);
 // "Open wallet" tries to open the side panel, which a headless/automation profile has no UI for; open the full-page wallet instead.
 await sleep(2500);await page.goto(home+'#/');await tid(page,'account-menu-icon').waitFor({timeout:30000});return metrics;}

export async function importPrivateKey(page:Page,home:string,key:string,log:WalletLog,label:string){
 await page.goto(home+'#/');await tid(page,'account-menu-icon').click();await tid(page,'account-list-add-wallet-button').click();await page.getByText('Import an account',{exact:true}).click();
 const box=page.locator('#private-key-box');await box.waitFor();if((await box.getAttribute('type'))!=='password')throw Error('PRIVATE_KEY_INPUT_NOT_MASKED');await box.fill(key);await tid(page,'import-account-confirm-button').click();
 await page.getByText('Account imported').first().waitFor({timeout:20000});log('wallet: fixture owner key imported via "Import an account" (masked input; value not recorded)',{label});}

export async function addLocalNetwork(page:Page,home:string,log:WalletLog){
 await page.goto(home+'#/');await tid(page,'account-options-menu-button').click();await page.getByText('Networks',{exact:true}).first().click();await tid(page,'networks-page-add-custom-network-button').click();
 await tid(page,'network-form-network-name').fill('Alder Local 31337');await tid(page,'test-add-rpc-drop-down').click();await page.getByText('Add RPC URL',{exact:true}).click();
 await tid(page,'rpc-url-input-test').fill('http://127.0.0.1:8547');await tid(page,'rpc-name-input-test').fill('Alder Anvil 8547');await tid(page,'page-container-footer-next').click();
 await tid(page,'network-form-chain-id').fill('31337');await tid(page,'network-form-ticker-input').fill('ETH');await clickWhenEnabled(page,'page-container-footer-next',45000);
 await tid(page,'network-list-item-options-button-eip155:31337').waitFor({timeout:20000});log('wallet: custom network added through Networks UI',{name:'Alder Local 31337',rpc:'http://127.0.0.1:8547',chainId:31337});}

// The MetaMask confirmation window (notification.html) for a dApp request.
export async function nextPopup(ctx:BrowserContext,id:string,timeout=30000){const known=ctx.pages().find(p=>p.url().startsWith(`chrome-extension://${id}/notification.html`));if(known)return known;
 return ctx.waitForEvent('page',{predicate:p=>p.url().startsWith(`chrome-extension://${id}/notification.html`),timeout});}
