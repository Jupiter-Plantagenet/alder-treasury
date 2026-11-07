// Wallet connection module (round 5, TR-D-SIGNER). Standard EIP-1193 provider path for a supported injected desktop
// wallet, discovered with EIP-6963 (multi-injected-provider discovery) and falling back to the legacy `window.ethereum`
// injection. Discovery only listens for announcements; it never connects, switches or imports anything on page load.
// A connection is made only from an explicit user action (sign/broadcast button) and only to the single approved
// local chain 31337. The isolated test-key facade used by round-4 runners is NOT part of this module or the product
// bundle: runners inject it with Playwright `addInitScript`, and it is reached here only through the same legacy
// `window.ethereum` slot any injected wallet uses.
export type Eip1193Provider={request(args:{method:string,params?:unknown}):Promise<any>,on?(event:string,fn:(...a:any[])=>void):void,removeListener?(event:string,fn:(...a:any[])=>void):void,isAlderTestWallet?:boolean};
export type Eip6963ProviderInfo={uuid:string,name:string,icon:string,rdns:string};
export type DiscoveredWallet={info:Eip6963ProviderInfo,provider:Eip1193Provider};
export const LOCAL_CHAIN_ID=31337,LOCAL_CHAIN_HEX='0x7a69';

const announced=new Map<string,DiscoveredWallet>();
function onAnnounce(event:Event){const detail=(event as CustomEvent).detail;const info=detail?.info,provider=detail?.provider;
 if(!info||typeof info.uuid!=='string'||typeof info.rdns!=='string'||typeof provider?.request!=='function')return;announced.set(info.uuid,{info:Object.freeze({...info}),provider});}
export function startWalletDiscovery(){if(typeof window==='undefined')return;window.addEventListener('eip6963:announceProvider',onAnnounce);window.dispatchEvent(new Event('eip6963:requestProvider'));}
startWalletDiscovery();
export function discoveredWallets():DiscoveredWallet[]{return [...announced.values()];}

// Exactly one announced wallet is used directly. Several announced wallets are refused rather than guessed, because the
// signing wallet must be unambiguous; legacy injection is used only when nothing announced itself.
export function resolveWalletProvider():{provider:Eip1193Provider,name:string,rdns:string|null}{
 const list=discoveredWallets();
 if(list.length===1)return {provider:list[0].provider,name:list[0].info.name,rdns:list[0].info.rdns};
 if(list.length>1)throw Error(`Several wallets announced themselves (${list.map(w=>w.info.name).join(', ')}). Keep only the one disposable local owner wallet enabled for this browser profile, then retry.`);
 const legacy=(globalThis as any).ethereum as Eip1193Provider|undefined;
 if(legacy&&typeof legacy.request==='function')return {provider:legacy,name:legacy.isAlderTestWallet?'Isolated test wallet':'Injected wallet',rdns:null};
 throw Error('No supported injected desktop wallet. Install/use a separate disposable local wallet; no automatic connection.');}

// User-initiated connection. Requests account access first (the wallet shows its own connection prompt), then requires
// the approved local chain; if the wallet is elsewhere it is asked to switch to 31337 only (the wallet decides and may
// prompt). The app never adds a network or switches to any other chain.
export async function connectLocalWallet(provider:Eip1193Provider):Promise<string>{
 const accounts=await provider.request({method:'eth_requestAccounts'});const account=Array.isArray(accounts)?accounts[0]:undefined;
 if(typeof account!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(account))throw Error('Wallet returned no account.');
 if(Number(await provider.request({method:'eth_chainId'}))!==LOCAL_CHAIN_ID){
  try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:LOCAL_CHAIN_HEX}]});}
  catch(e:any){if(isWalletRefusal(e))throw e;throw Error('Wallet must be on approved local chain 31337. Add the local network (http://127.0.0.1:8547, chain 31337) in the wallet, then retry.');}
  if(Number(await provider.request({method:'eth_chainId'}))!==LOCAL_CHAIN_ID)throw Error('Wallet must be on approved local chain 31337.');}
 return account;}

// EIP-1193 userRejectedRequest (4001). Wallets sometimes nest the provider error.
export function isWalletRefusal(e:any){return e?.code===4001||e?.cause?.code===4001||e?.data?.originalError?.code===4001;}
export function walletErrorMessage(kind:string,e:any){
 if(!isWalletRefusal(e))return (e as Error)?.message||'Wallet request failed';
 return kind==='sign'?'Wallet refusal: the owner declined the connection or signature request in the wallet. No signature was created or stored.'
  :'Wallet refusal: the owner declined the broadcast in the wallet. Recorded as wallet_refused; nothing was broadcast.';}
