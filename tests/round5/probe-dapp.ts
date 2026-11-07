import '../tls-trust.ts';// @ts-nocheck -- exploration probe for the dApp side: onboard via driver, open the live UI, request accounts, dump popup.
import {launchWallet,verifyPinnedWallet,dump,sleep,extPage,onboard,importPrivateKey,addLocalNetwork,nextPopup} from './metamask.ts';import fs from 'node:fs';
import {generateMnemonic,english} from 'viem/accounts';import {email,password} from '../round4/api-client.ts';
const out='evidence/round5-wallet/probe';fs.mkdirSync(out,{recursive:true});const log=(...a:any[])=>console.log(...a.map(x=>typeof x==='string'?x:JSON.stringify(x)));
verifyPinnedWallet();const {ctx,id,home}=await launchWallet('.local/wallet-profiles/probe-'+Date.now().toString(36));
const w=await extPage(ctx,id,home);await onboard(w,home,{seed:generateMnemonic(english),password:'W5-'+crypto.randomUUID()},log);
await importPrivateKey(w,home,'0x'+(101).toString(16).padStart(64,'0'),log,'owner0');await importPrivateKey(w,home,'0x'+(202).toString(16).padStart(64,'0'),log,'owner1');
await addLocalNetwork(w,home,log);
const app=await ctx.newPage();app.on('console',m=>{if(m.type()==='error')console.log('APPCONSOLE',m.text().slice(0,200));});
await app.goto('https://127.0.0.1:5103/#overview');
console.log('provider',await app.evaluate(async()=>({has:!!window.ethereum,isMM:window.ethereum?.isMetaMask,chain:await window.ethereum.request({method:'eth_chainId'}),accts:await window.ethereum.request({method:'eth_accounts'})})));
const p=app.evaluate(()=>window.ethereum.request({method:'eth_requestAccounts'})).catch(e=>'ERR '+e.message);
await sleep(5000);console.log('pages',ctx.pages().map(x=>x.url()));let pop=ctx.pages().find(x=>x.url().includes('notification.html'));if(!pop){pop=await ctx.newPage();await pop.goto(`chrome-extension://${id}/notification.html`);}await sleep(3000);await pop.screenshot({path:out+'/dapp-connect.png'});console.log(JSON.stringify(await dump(pop),null,1));
await pop.getByText('Imported Account 2',{exact:true}).first().click();await sleep(2000);await pop.screenshot({path:out+'/dapp-connect-accounts.png'});console.log('ACCOUNTSEL',JSON.stringify(await dump(pop),null,1));await ctx.close();process.exit(0);console.log('connect result',await p);
const st=async()=>app.evaluate(async()=>({chain:await window.ethereum.request({method:'eth_chainId'}),accts:await window.ethereum.request({method:'eth_accounts'})}));console.log('after connect',await st());
const sw=app.evaluate(()=>window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x7a69'}]}).then(()=>'ok',(e:{code:number,message:string})=>'ERR '+e.code+' '+e.message));
await sleep(3000);const pending=await Promise.race([sw,sleep(100).then(()=>'PENDING')]);console.log('switch',pending);
if(pending==='PENDING'){const p2=await ctx.newPage();await p2.goto(`chrome-extension://${id}/notification.html`);await sleep(3000);await p2.screenshot({path:out+'/dapp-switch.png'});console.log(JSON.stringify(await dump(p2),null,1));const b=p2.getByTestId('confirmation-submit-button').or(p2.getByRole('button',{name:/Switch|Confirm|Approve/})).first();await b.click();console.log('switch result',await sw);await p2.close().catch(()=>{});}
console.log('after switch',await st());
const typed={types:{EIP712Domain:[{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}],SafeTx:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'},{name:'operation',type:'uint8'},{name:'safeTxGas',type:'uint256'},{name:'baseGas',type:'uint256'},{name:'gasPrice',type:'uint256'},{name:'gasToken',type:'address'},{name:'refundReceiver',type:'address'},{name:'nonce',type:'uint256'}]},primaryType:'SafeTx',domain:{chainId:31337,verifyingContract:'0xC91B3bb241564757b1b4261B2f5dd996A3eC6663'},message:{to:'0x32dd8cdeabbaaf25c3bc27fe3cc584dbf89b496b',value:'0',data:'0x1234',operation:0,safeTxGas:'500000',baseGas:'0',gasPrice:'0',gasToken:'0x0000000000000000000000000000000000000000',refundReceiver:'0x0000000000000000000000000000000000000000',nonce:'999'}};
const acct=(await st()).accts[0];const sg=app.evaluate(([a,t])=>window.ethereum.request({method:'eth_signTypedData_v4',params:[a,t]}).then((x:unknown)=>x,(e:{code:number,message:string})=>'ERR '+e.code+' '+e.message),[acct,JSON.stringify(typed)]);
await sleep(3000);const p3=await ctx.newPage();await p3.goto(`chrome-extension://${id}/notification.html`);await sleep(4000);await p3.screenshot({path:out+'/dapp-sign.png',fullPage:true});console.log(JSON.stringify(await dump(p3),null,1));
await p3.getByTestId('confirm-footer-cancel-button').or(p3.getByRole('button',{name:/Cancel|Reject/})).first().click();console.log('sign result',await sg);
await ctx.close();
