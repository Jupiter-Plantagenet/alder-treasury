// O5 (round-5 ops) helpers for the ISOLATED stack: API 9103 -> scratch PG 15543 -> O5 proxy 18547 -> Anvil 18548.
// Parameterised copy of tests/round4/{api-client,flow-lib}.ts. Credentials from .local/accounts.json, never printed.
// Test-controller chain actions (mining, wallet sends, ground-truth reads) go DIRECTLY to Anvil 18548, never via the proxy,
// so the app's (possibly lied-to) view and the ground truth are kept separate.
import fs from 'node:fs';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,zeroAddress,type Hex,type Address} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {anvil} from 'viem/chains';
import {estimatePreparedOuterGas} from '../../packages/prepared.ts';
export const API=process.env.O5_API||'http://127.0.0.1:9103';export const ORIGIN='http://127.0.0.1:5103';
export const TRUTH='http://127.0.0.1:18548';export const PROXY='http://127.0.0.1:18547';
export const accounts=JSON.parse(fs.readFileSync('.local/accounts.json','utf8'));export const WS:string=accounts.workspace;
export type Who='jordan'|'priya'|'owner'|'accountant';
export class Session{cookie='';csrf='';constructor(public who:string,public requestTimeoutMs?:number){}
 static async login(who:string,pass?:string,localAddress?:string,timeoutMs?:number){const s=new Session(who);const email=who.includes('@')?who:`${who}@alder.local`;if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0))throw Error('REQUEST_TIMEOUT_INVALID');const signal=timeoutMs===undefined?undefined:AbortSignal.timeout(timeoutMs);const r=await fetch(API+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({email,password:pass??accounts.password}),signal} as any);if(r.status!==200)throw Error('LOGIN_FAILED '+who+' '+r.status);s.cookie=(r.headers.get('set-cookie')||'').split(';')[0];s.csrf=(await r.json()).csrf;return s;}
 async req(method:string,path:string,body?:any,opts:{key?:string,ifMatch?:string|number,ws?:string,origin?:string|null,csrf?:string|null,timeoutMs?:number,signal?:AbortSignal}={}){const headers:any={cookie:this.cookie};const o=opts.origin===undefined?ORIGIN:opts.origin;if(o)headers.origin=o;
  if(method!=='GET'){headers['x-csrf-token']=opts.csrf===undefined?this.csrf:(opts.csrf??'');headers['idempotency-key']=opts.key||randomUUID();if(body!==undefined)headers['content-type']='application/json';}
  if(opts.ifMatch!==undefined)headers['if-match']=`"${opts.ifMatch}"`;
  const url=API+(path.startsWith('/api/')||path.startsWith('/health')?path:`/api/v1/workspaces/${opts.ws||WS}${path}`);
  if(opts.timeoutMs!==undefined&&(!Number.isFinite(opts.timeoutMs)||opts.timeoutMs<=0))throw Error('REQUEST_TIMEOUT_INVALID');
  const requestTimeoutMs=opts.timeoutMs??this.requestTimeoutMs;
  const signal=opts.signal??(requestTimeoutMs===undefined?undefined:AbortSignal.timeout(requestTimeoutMs));
  const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal});const text=await r.text();let json:any;try{json=JSON.parse(text);}catch{json=text;}return {status:r.status,body:json,headers:r.headers};}
 get=(p:string,o?:any)=>this.req('GET',p,undefined,o);post=(p:string,b:any,o?:any)=>this.req('POST',p,b,o);put=(p:string,b:any,o?:any)=>this.req('PUT',p,b,o);}
export function expect(cond:any,msg:string,detail?:any){if(!cond)throw Error('ASSERTION '+msg+(detail===undefined?'':' :: '+JSON.stringify(detail,(_,v)=>typeof v==='bigint'?String(v):v).slice(0,800)));}
export const chain=createPublicClient({transport:http(TRUTH),cacheTime:0});
export const owners=[101,202,303].map(n=>privateKeyToAccount(('0x'+n.toString(16).padStart(64,'0')) as Hex));
export const outsider=privateKeyToAccount(('0x'+(404).toString(16).padStart(64,'0')) as Hex);
export const walletFor=(a:ReturnType<typeof privateKeyToAccount>)=>createWalletClient({account:a,chain:anvil,transport:http(TRUTH)});
export const d=JSON.parse(fs.readFileSync(process.env.ALDER_DEPLOYMENT_FILE||'evidence/round5-ops/isolated-deployment.json','utf8'));
export const erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)','function transferFrom(address,address,uint256) returns(bool)']);
export const safeAbi=parseAbi(['function nonce() view returns(uint256)','function getOwners() view returns(address[])','function getThreshold() view returns(uint256)','function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)','function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)','event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)','event ExecutionFailure(bytes32 indexed txHash,uint256 payment)']);
export const db=new pg.Pool({connectionString:'postgresql://postgres@127.0.0.1:15543/alder',max:3,options:'-c default_transaction_read_only=on'});
export const q=async(sql:string,args:any[]=[])=>(await db.query(sql,args)).rows;
export const mine=(n:number)=>chain.request({method:'anvil_mine' as any,params:['0x'+n.toString(16)] as any});
export const rpc=(method:string,params:any[]=[])=>chain.request({method:method as any,params:params as any});
export async function proxy(rules:any[]){const r=await fetch(PROXY+'/__o5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rules})});return r.json();}
export async function proxyStats(){return (await fetch(PROXY+'/__o5')).json();}
export const balance=(a:string)=>chain.readContract({address:d.token,abi:erc20,functionName:'balanceOf',args:[a as Address]});
export const allowance=()=>chain.readContract({address:d.token,abi:erc20,functionName:'allowance',args:[d.safe,d.executor]});
export const newKey=()=>generatePrivateKey();export const newAddress=()=>privateKeyToAccount(generatePrivateKey()).address;
export async function sessions(loginTimeoutMs?:number,requestTimeoutMs?:number){return {J:Object.assign(await Session.login('jordan',undefined,undefined,loginTimeoutMs),{requestTimeoutMs}),P:Object.assign(await Session.login('priya',undefined,undefined,loginTimeoutMs),{requestTimeoutMs}),O:Object.assign(await Session.login('owner',undefined,undefined,loginTimeoutMs),{requestTimeoutMs}),A:Object.assign(await Session.login('accountant',undefined,undefined,loginTimeoutMs),{requestTimeoutMs})};}
export type S=Awaited<ReturnType<typeof sessions>>;
export async function contact(s:S,name:string,address=newAddress(),verify=true){const c=await s.J.post('/contacts',{display_name:name,address,chain_id:'31337'});expect(c.status===200,'contact create',c.body);
 if(verify){const v=await s.P.post(`/contacts/${c.body.id}/verifications`,{destination_revision:1,second_channel_reference:'O5 phone callback (simulated)',decision:'approve'},{ifMatch:1});expect(v.status===200,'verify',v.body);}return {...c.body,address};}
export async function policyRevision(s:S){return (await s.P.get('/policy')).body.policy.revision;}
export const RUN=Date.now().toString(36).toUpperCase();
export async function payable(s:S,contactId:string,ref:string,units:string,review=true,pr?:number){const p=await s.J.post('/payables',{contact_id:contactId,external_reference:ref+'-'+RUN,amount_units:units,attachment_ids:[]});expect(p.status===201,'payable create',p.body);
 if(review){const r=await s.P.post(`/payables/${p.body.id}/review`,{revision:p.body.revision,policy_revision:pr??await policyRevision(s),reason:'O5 isolated fixture review'},{ifMatch:p.body.revision});expect(r.status===200,'review',r.body);}return p.body;}
export async function op(s:S,id:string){const snap=(await s.O.get('/snapshot')).body;return snap.operations.find((o:any)=>o.id===id);}
export async function opRow(id:string){return (await q('SELECT id,kind,state,manifest FROM treasury_operations WHERE workspace_id=$1 AND id=$2',[WS,id]))[0];}
export async function sign(s:S,opId:string,ownerIdx:number){const o=await opRow(opId);const signature=await owners[ownerIdx].signTypedData(o.manifest.typedData);return s.O.post(`/operations/${opId}/signatures`,{owner:owners[ownerIdx].address,scheme:'EIP712_EOA',signature});}
export async function prepare(s:S,opId:string,senderIdx=0){return s.O.post(`/operations/${opId}/attempts`,{sender:owners[senderIdx].address});}
export async function preparedOuterGas(provider:any,account:string,manifest:any,prepared:any){return estimatePreparedOuterGas(provider,account,manifest,{...prepared,senderNonce:prepared.senderNonce});}
export async function send(s:S,prepared:any,senderIdx=0,observe:'wallet_hash'|'none'='wallet_hash'){const w=walletFor(owners[senderIdx]);const row=await opRow(prepared.id);expect(row,'prepared operation manifest',prepared.id);const {gasLimit}=await preparedOuterGas(chain,owners[senderIdx].address,row.manifest,prepared);const hash=await w.sendTransaction({to:prepared.to,data:prepared.data,value:0n,gas:gasLimit,nonce:Number(prepared.senderNonce)});
 if(observe!=='none'){const r=await s.O.post(`/attempts/${prepared.attemptId}/observations`,{kind:'wallet_hash',transactionHash:hash});expect(r.status===200,'observation',r.body);}return hash as Hex;}
export async function resync(s:S){return s.O.post('/resync',{});}
export async function resyncOk(s:S){const r=await resync(s);expect(r.status===200,'resync',r.body);return r.body;}
export const opState=async(id:string)=>(await q('SELECT state FROM treasury_operations WHERE workspace_id=$1 AND id=$2',[WS,id]))[0]?.state;
export const settlementsFor=async(id:string)=>q('SELECT payable_id,state FROM treasury_settlements WHERE workspace_id=$1 AND operation_id=$2',[WS,id]);
export const lastReport=async(id:string)=>(await q('SELECT report FROM treasury_reports WHERE workspace_id=$1 AND operation_id=$2 ORDER BY id DESC LIMIT 1',[WS,id]))[0]?.report;
export async function runAllowanceStages<T extends {manifest:{reset?:boolean}}>(propose:()=>Promise<T>,executeAndVerify:(op:T)=>Promise<void>):Promise<T>{let op=await propose();await executeAndVerify(op);if(op.manifest.reset){op=await propose();expect(op.manifest.reset!==true,'bounded allowance follows zero reset',op.manifest);await executeAndVerify(op);}return op;}
export async function allowanceCycle(s:S,ids:string[]){expect(ids.length>0&&new Set(ids).size===ids.length,'allowance ids unique');const propose=async()=>{const a=await s.O.post('/allowances',{ids});expect(a.status===200,'allowance propose',a.body);return a.body;};const executeAndVerify=async(a:any)=>{for(const i of [0,1])expect((await sign(s,a.id,i)).status===200,'allowance sign');const p=await prepare(s,a.id);expect(p.status===200,'allowance prepare',p.body);await send(s,p.body);await mine(11);await resyncOk(s);expect(await opState(a.id)==='verified','allowance verified',await lastReport(a.id));};return runAllowanceStages(propose,executeAndVerify);}
export async function freeze(s:S,ids:string[]){const f=await s.J.post('/batches',{ids});expect(f.status===200,'freeze',f.body);return f.body;}
export async function signAll(s:S,opId:string){for(const i of [0,1]){const r=await sign(s,opId,i);expect(r.status===200,'payout sign',r.body);}}
export async function readyPayables(s:S,tag:string,units:string[],recipients?:`0x${string}`[]){const out=[];for(let i=0;i<units.length;i++){const c=await contact(s,`${tag} C${i}`,recipients?.[i]??newAddress());out.push(await payable(s,c.id,`${tag}-P${i}`,units[i]));}await allowanceCycle(s,out.map(p=>p.id));return out;}
// Freeze + 2 signatures + prepare; returns the prepared outer transaction WITHOUT sending it.
export async function preparedPayout(s:S,tag:string,units:string[],recipients?:`0x${string}`[]){const ps=await readyPayables(s,tag,units,recipients);const f=await freeze(s,ps.map(p=>p.id));await signAll(s,f.operationId);const p=await prepare(s,f.operationId);expect(p.status===200,'payout prepare',p.body);return {payables:ps,freeze:f,opId:f.operationId as string,prepared:p.body,manifest:f.manifest};}
export class Report{steps:any[]=[];constructor(public file:string){}
 ok(id:string,clause:string,data:any={}){this.steps.push({id,clause,result:'PASS',at:new Date().toISOString(),...data});console.log('PASS',id,'::',clause,JSON.stringify(data,(_,v)=>typeof v==='bigint'?String(v):v).slice(0,400));}
 bad(id:string,clause:string,data:any={}){this.steps.push({id,clause,result:'FAIL',at:new Date().toISOString(),...data});console.log('FAIL',id,'::',clause,JSON.stringify(data,(_,v)=>typeof v==='bigint'?String(v):v).slice(0,900));}
 note(id:string,clause:string,data:any={}){this.steps.push({id,clause,result:'OBSERVED',at:new Date().toISOString(),...data});console.log('NOTE',id,'::',clause,JSON.stringify(data,(_,v)=>typeof v==='bigint'?String(v):v).slice(0,400));}
 async check(id:string,clause:string,fn:()=>Promise<any>){try{const data=await fn();this.ok(id,clause,data||{});}catch(e:any){this.bad(id,clause,{error:String(e?.message||e).slice(0,1500)});}}
 save(extra:any={}){fs.mkdirSync(this.file.replace(/[\\/][^\\/]+$/,''),{recursive:true});fs.writeFileSync(this.file,JSON.stringify({...extra,steps:this.steps,pass:this.steps.filter(x=>x.result==='PASS').length,fail:this.steps.filter(x=>x.result==='FAIL').length},(_,v)=>typeof v==='bigint'?String(v):v,2));}}
export const safeTypes={SafeTx:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'},{name:'operation',type:'uint8'},{name:'safeTxGas',type:'uint256'},{name:'baseGas',type:'uint256'},{name:'gasPrice',type:'uint256'},{name:'gasToken',type:'address'},{name:'refundReceiver',type:'address'},{name:'nonce',type:'uint256'}]} as const;
export async function safeNonce(safe:Address=d.safe){return chain.readContract({address:safe,abi:safeAbi,functionName:'nonce'});}
export async function sigsFor(message:any,signers:number[],safe:Address=d.safe){const typed={domain:{chainId:31337,verifyingContract:safe},types:safeTypes,primaryType:'SafeTx' as const,message};const sigs=await Promise.all(signers.map(async i=>({a:owners[i].address.toLowerCase(),s:await owners[i].signTypedData(typed as any)})));sigs.sort((x,y)=>x.a.localeCompare(y.a));return ('0x'+sigs.map(x=>x.s.slice(2)).join('')) as Hex;}
export function execData(m:any,signatures:Hex){return encodeFunctionData({abi:safeAbi,functionName:'execTransaction',args:[m.to,BigInt(m.value),m.data,Number(m.operation),BigInt(m.safeTxGas),BigInt(m.baseGas),BigInt(m.gasPrice),m.gasToken,m.refundReceiver,signatures]});}
export async function safeExec(to:Address,data:Hex,{signers=[0,1],sender=0,safe=d.safe as Address,operation=0,safeTxGas=500000n}:{signers?:number[],sender?:number,safe?:Address,operation?:number,safeTxGas?:bigint}={}){const nonce=await safeNonce(safe);const m={to,value:0n,data,operation,safeTxGas,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce};const sig=await sigsFor(m,signers,safe);const hash=await walletFor(owners[sender]).sendTransaction({to:safe,data:execData(m,sig),gas:5000000n});return chain.waitForTransactionReceipt({hash});}
export const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export {encodeFunctionData,zeroAddress};
export async function callError(from:Address,to:Address,data:Hex){const r=await (await fetch(TRUTH,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{from,to,data,gas:'0x4c4b40'},'latest']})})).json();if(!r.error)return null;const raw=String(r.error.data??'');let reason=raw;if(raw.startsWith('0x08c379a0')){try{reason=Buffer.from(raw.slice(138).replace(/(00)+$/,''),'hex').toString('utf8');}catch{}}return reason||String(r.error.message).slice(0,160);}
