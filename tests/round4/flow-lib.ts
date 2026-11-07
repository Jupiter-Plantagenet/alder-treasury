// Round-4 API-level cycle helpers against the LIVE stack (UI-origin proxy → API 8103 → PG alder → Anvil 8547).
// Wallet actions (EIP-712 owner signatures, raw sends) are performed here with the public disposable Anvil
// fixture owner keys, exactly what the browser facade does; the API never sees a key.
import fs from 'node:fs';import pg from 'pg';import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,zeroAddress,type Hex,type Address} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {anvil} from 'viem/chains';
import {Session,expect,WS} from './api-client.ts';
export const RPC='http://127.0.0.1:8547';export const chain=createPublicClient({transport:http(RPC),cacheTime:0});
export const owners=[101,202,303].map(n=>privateKeyToAccount(('0x'+n.toString(16).padStart(64,'0')) as Hex));
export const outsider=privateKeyToAccount(('0x'+(404).toString(16).padStart(64,'0')) as Hex);
export const walletFor=(a:ReturnType<typeof privateKeyToAccount>)=>createWalletClient({account:a,chain:anvil,transport:http(RPC)});
export const d=JSON.parse(fs.readFileSync('evidence/app-deployment.json','utf8'));
export const erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function transferFrom(address,address,uint256) returns(bool)']);
export const safeAbi=parseAbi(['function nonce() view returns(uint256)','function getOwners() view returns(address[])','function getThreshold() view returns(uint256)','function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)','function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)','function changeThreshold(uint256)','event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)','event ExecutionFailure(bytes32 indexed txHash,uint256 payment)']);
export const db=new pg.Pool({connectionString:'postgresql://postgres@127.0.0.1:5543/alder',max:3,options:'-c default_transaction_read_only=on'});
export const q=async(sql:string,args:any[]=[])=>(await db.query(sql,args)).rows;
export const mine=(n:number)=>chain.request({method:'anvil_mine' as any,params:['0x'+n.toString(16)] as any});
export const rpc=(method:string,params:any[]=[])=>chain.request({method:method as any,params:params as any});
export async function until(fn:()=>Promise<any>,what:string,ms=20000){const t=Date.now();while(Date.now()-t<ms){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,150));}throw Error('TIMEOUT '+what);}
export const balance=(a:string):Promise<bigint>=>chain.readContract({address:d.token,abi:erc20,functionName:'balanceOf',args:[a as Address]});
export const allowance=()=>chain.readContract({address:d.token,abi:erc20,functionName:'allowance',args:[d.safe,d.executor]});
export const newAddress=()=>privateKeyToAccount(generatePrivateKey()).address;
export async function sessions(){return {J:await Session.login('jordan'),P:await Session.login('priya'),O:await Session.login('owner'),A:await Session.login('accountant')};}
export type S=Awaited<ReturnType<typeof sessions>>;
export async function contact(s:S,name:string,address=newAddress(),verify=true){const c=await s.J.post('/contacts',{display_name:name,address,chain_id:'31337'});expect(c.status===200,'contact create',c);
 if(verify){const v=await s.P.post(`/contacts/${c.body.id}/verifications`,{destination_revision:1,second_channel_reference:'round4 phone callback',decision:'approve'},{ifMatch:1});expect(v.status===200,'verify',v);}return {...c.body,address};}
export async function payable(s:S,contactId:string,ref:string,units:string,review=true){const p=await s.J.post('/payables',{contact_id:contactId,external_reference:ref,amount_units:units,attachment_ids:[]});expect(p.status===201,'payable create',p);
 if(review){const r=await s.P.post(`/payables/${p.body.id}/review`,{revision:p.body.revision,policy_revision:await policyRevision(s),reason:'round4 adversarial fixture review'},{ifMatch:p.body.revision});expect(r.status===200,'review',r);}return p.body;}
export async function policyRevision(s:S){return (await s.P.get('/policy')).body.policy.revision;}
export async function op(s:S,id:string){const snap=(await s.O.get('/snapshot')).body;return snap.operations.find((o:any)=>o.id===id);}
export async function sign(s:S,opId:string,ownerIdx:number,mutate?:(t:any)=>any){const o=await op(s,opId);let typed=JSON.parse(JSON.stringify(o.manifest.typedData));if(mutate)typed=mutate(typed);const signature=await owners[ownerIdx].signTypedData(typed);return s.O.post(`/operations/${opId}/signatures`,{owner:owners[ownerIdx].address,scheme:'EIP712_EOA',signature});}
export async function prepare(s:S,opId:string,senderIdx=0){return s.O.post(`/operations/${opId}/attempts`,{sender:owners[senderIdx].address});}
export async function send(s:S,prepared:any,senderIdx=0,observe:'wallet_hash'|'response_unknown'|'none'='wallet_hash'){const w=walletFor(owners[senderIdx]);const hash=await w.sendTransaction({to:prepared.to,data:prepared.data,value:0n,gas:3000000n,nonce:Number(prepared.senderNonce)});
 if(observe!=='none'){const r=await s.O.post(`/attempts/${prepared.attemptId}/observations`,observe==='wallet_hash'?{kind:'wallet_hash',transactionHash:hash}:{kind:'response_unknown'});expect(r.status===200,'observation',r);}return hash;}
export async function resync(s:S){const r=await s.O.post('/resync',{});expect(r.status===200,'resync',r);return r.body;}
export const opState=async(id:string)=>(await q('SELECT state FROM treasury_operations WHERE workspace_id=$1 AND id=$2',[WS,id]))[0]?.state;
export async function allowanceCycle(s:S,ids:string[]){let last:any;for(let round=0;round<2;round++){const a=await s.O.post('/allowances',{ids});expect(a.status===200,'allowance propose',a);
  for(const i of [0,1])expect((await sign(s,a.body.id,i)).status===200,'allowance sign');const p=await prepare(s,a.body.id);expect(p.status===200,'allowance prepare',p);await send(s,p.body);await mine(11);await resync(s);expect(await opState(a.body.id)==='verified','allowance verified');last=a.body;if(!a.body.manifest.reset)break;}return last;}
export async function freeze(s:S,ids:string[]){const f=await s.J.post('/batches',{ids});expect(f.status===200,'freeze',f);return f.body;}
export async function signAll(s:S,opId:string){for(const i of [0,1])expect((await sign(s,opId,i)).status===200,'payout sign');}
// Fresh reviewed payables + exact allowance, ready to freeze.
export async function readyPayables(s:S,tag:string,units:string[]){const out=[];for(let i=0;i<units.length;i++){const c=await contact(s,`${tag} C${i}`);out.push(await payable(s,c.id,`${tag}-P${i}`,units[i]));}await allowanceCycle(s,out.map(p=>p.id));return out;}
export class Report{steps:any[]=[];constructor(public file:string){}
 ok(id:string,clause:string,data:any={}){this.steps.push({id,clause,result:'PASS',at:new Date().toISOString(),...data});console.log('PASS',id,'::',clause,JSON.stringify(data).slice(0,300));}
 bad(id:string,clause:string,data:any={}){this.steps.push({id,clause,result:'FAIL',at:new Date().toISOString(),...data});console.log('FAIL',id,'::',clause,JSON.stringify(data).slice(0,600));}
 note(id:string,clause:string,data:any={}){this.steps.push({id,clause,result:'OBSERVED',at:new Date().toISOString(),...data});console.log('NOTE',id,'::',clause,JSON.stringify(data).slice(0,300));}
 async check(id:string,clause:string,fn:()=>Promise<any>){try{const data=await fn();this.ok(id,clause,data||{});}catch(e:any){this.bad(id,clause,{error:String(e?.message||e).slice(0,1500)});}}
 save(extra:any={}){fs.mkdirSync(this.file.replace(/[\\/][^\\/]+$/,''),{recursive:true});fs.writeFileSync(this.file,JSON.stringify({...extra,steps:this.steps,pass:this.steps.filter(x=>x.result==='PASS').length,fail:this.steps.filter(x=>x.result==='FAIL').length},(_,v)=>typeof v==='bigint'?String(v):v,2));}}
export {Session,expect,WS,encodeFunctionData,zeroAddress};
// Outside-the-app Safe execution by the fixture owners (what any owner quorum can do via other Safe routes).
export const safeTypes={SafeTx:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'},{name:'operation',type:'uint8'},{name:'safeTxGas',type:'uint256'},{name:'baseGas',type:'uint256'},{name:'gasPrice',type:'uint256'},{name:'gasToken',type:'address'},{name:'refundReceiver',type:'address'},{name:'nonce',type:'uint256'}]} as const;
export async function safeNonce(){return chain.readContract({address:d.safe,abi:safeAbi,functionName:'nonce'});}
export async function sigsFor(message:any,signers:number[]){const typed={domain:{chainId:31337,verifyingContract:d.safe},types:safeTypes,primaryType:'SafeTx' as const,message};const sigs=await Promise.all(signers.map(async i=>({a:owners[i].address.toLowerCase(),s:await owners[i].signTypedData(typed as any)})));sigs.sort((x,y)=>x.a.localeCompare(y.a));return ('0x'+sigs.map(x=>x.s.slice(2)).join('')) as Hex;}
export function execData(m:any,signatures:Hex){return encodeFunctionData({abi:safeAbi,functionName:'execTransaction',args:[m.to,BigInt(m.value),m.data,Number(m.operation),BigInt(m.safeTxGas),BigInt(m.baseGas),BigInt(m.gasPrice),m.gasToken,m.refundReceiver,signatures]});}
export async function safeExec(to:Address,data:Hex,signers=[0,1],sender=0){const nonce=await safeNonce();const m={to,value:0n,data,operation:0,safeTxGas:500000n,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce};const sig=await sigsFor(m,signers);const hash=await walletFor(owners[sender]).sendTransaction({to:d.safe,data:execData(m,sig),gas:3000000n});return chain.waitForTransactionReceipt({hash});}
export async function callError(from:Address,to:Address,data:Hex){const r=await (await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{from,to,data,gas:'0x4c4b40'},'latest']})})).json();if(!r.error)return null;const raw=String(r.error.data??'');let reason=raw;if(raw.startsWith('0x08c379a0')){try{reason=Buffer.from(raw.slice(138).replace(/(00)+$/,''),'hex').toString('utf8');}catch{}}return reason||String(r.error.message).slice(0,120);}
