import '../tls-trust.ts';// @ts-nocheck -- live-stack runner library; product types are checked in apps/, packages/, services/
// Round-5 runner library. LIVE stack only: UI origin 127.0.0.1:5103 (Vite proxy) -> API 8103 -> PostgreSQL `alder`
// -> Anvil 8547. Runs in the dedicated B5 verification workspace with its own users (ops/provision-round5-workspace.ts)
// so the primary workspace's policy revision and batches are never touched. Credentials come from .local and are never
// printed. DB assertions use a read-only superuser connection; chain helpers reuse the round-4 fixture owner keys.
import fs from 'node:fs';import {randomUUID} from 'node:crypto';import {execFileSync,spawn} from 'node:child_process';
import * as L from '../round4/flow-lib.ts';
export const ORIGIN='https://127.0.0.1:5103';export const NODE='C:/Users/user/AppData/Local/hermes/tools/node-26.7.0-win32-x64/node.exe';
const acct=JSON.parse(fs.readFileSync('.local/round5-accounts.json','utf8'));export const WS5:string=acct.workspace;export const USERS5=acct.users;
export type Who5='b5-preparer'|'b5-reviewer'|'b5-owner'|'b5-accountant'|'b5-admin'|'b5-invitee'|'b5-invitee2';
export class S5{cookie='';csrf='';constructor(public who:Who5,public ws=WS5){}
 static async login(who:Who5){const s=new S5(who);const r=await fetch(ORIGIN+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({email:`${who}@alder.local`,password:acct.password})});if(r.status!==200)throw Error('LOGIN_FAILED '+who+' '+r.status);s.cookie=(r.headers.get('set-cookie')||'').split(';')[0];s.csrf=(await r.json()).csrf;return s;}
 async req(method:string,path:string,body?:any,opts:any={}){const headers:any={cookie:this.cookie,origin:ORIGIN};if(method!=='GET'){headers['x-csrf-token']=this.csrf;headers['idempotency-key']=opts.key||randomUUID();if(body!==undefined)headers['content-type']='application/json';}if(opts.ifMatch!==undefined)headers['if-match']=`"${opts.ifMatch}"`;
  const url=ORIGIN+(path.startsWith('/api/')||path.startsWith('/health')?path:`/api/v1/workspaces/${this.ws}${path}`);const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let json:any;try{json=JSON.parse(text);}catch{json=text;}return {status:r.status,body:json};}
 get=(p:string,o?:any)=>this.req('GET',p,undefined,o);post=(p:string,b:any,o?:any)=>this.req('POST',p,b,o);}
export const {chain,d,mine,rpc,owners,expect,Report,until,safeAbi,callError,execData,walletFor,newAddress,encodeFunctionData}=L as any;
export const q=L.q;export const db=L.db;
export async function sessions5(){return {J:await S5.login('b5-preparer'),P:await S5.login('b5-reviewer'),O:await S5.login('b5-owner'),A:await S5.login('b5-accountant'),ADM:await S5.login('b5-admin')};}
export async function ensurePolicy(s:any){const before=await s.P.get('/policy');expect(before.status===200,'policy read',before);if(before.body.policy)return before.body.policy;const asset=before.body.workspace_asset;
 const conditions={mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,rules:[{id:'STANDARD',label:'B5 standard payable up to 10,000 ALDR',asset,min_units:'1',max_units:'10000000000'}]};
 const r=await s.P.post('/policies',{conditions,reason:'B5 round-5 verification workspace policy (isolated from the primary workspace).'});expect(r.status===200,'policy create',r);return (await s.P.get('/policy')).body.policy;}
export async function contact(s:any,name:string,address=newAddress(),verify=true){const c=await s.J.post('/contacts',{display_name:name,address,chain_id:'31337'});expect(c.status===200,'contact create',c);
 if(verify){const v=await s.P.post(`/contacts/${c.body.id}/verifications`,{destination_revision:1,second_channel_reference:'B5 phone callback',decision:'approve'},{ifMatch:1});expect(v.status===200,'verify',v);}return {...c.body,address};}
export async function review(s:any,p:any){const pol=(await s.P.get('/policy')).body.policy;const r=await s.P.post(`/payables/${p.id}/review`,{revision:p.revision,policy_revision:pol.revision,reason:'B5 independent review'},{ifMatch:p.revision});expect(r.status===200,'review',r);return r.body;}
export async function payable(s:any,contactId:string,ref:string,units:string,doReview=true){const p=await s.J.post('/payables',{contact_id:contactId,external_reference:ref,amount_units:units,attachment_ids:[]});expect(p.status===201,'payable create',p);if(doReview)await review(s,p.body);return p.body;}
export async function snap(s:any){const r=await s.O.get('/snapshot');expect(r.status===200,'snapshot',r);return r.body;}
export async function opRow(id:string){return (await q('SELECT id,kind,state,manifest FROM treasury_operations WHERE workspace_id=$1 AND id=$2',[WS5,id]))[0];}
export const opState=async(id:string)=>(await opRow(id))?.state;
export async function sign(s:any,opId:string,i:number){const o=await opRow(opId);const signature=await owners[i].signTypedData(o.manifest.typedData);return s.O.post(`/operations/${opId}/signatures`,{owner:owners[i].address,scheme:'EIP712_EOA',signature});}
export async function signAll(s:any,opId:string){for(const i of [0,1]){const r=await sign(s,opId,i);expect(r.status===200,'sign '+i,r);}}
export const prepare=(s:any,opId:string,senderIdx=0)=>s.O.post(`/operations/${opId}/attempts`,{sender:owners[senderIdx].address});
export async function send(s:any,prepared:any,{senderIdx=0,observe='wallet_hash',gas=3000000n}:any={}){const hash=await walletFor(owners[senderIdx]).sendTransaction({to:prepared.to,data:prepared.data,value:0n,gas,nonce:Number(prepared.senderNonce)});
 if(observe!=='none'){const r=await s.O.post(`/attempts/${prepared.attemptId}/observations`,observe==='wallet_hash'?{kind:'wallet_hash',transactionHash:hash}:{kind:observe});expect(r.status===200,'observation',r);}return hash;}
export async function resync(s:any){const r=await s.O.post('/resync',{});expect(r.status===200,'resync',r);return r.body;}
// Wait for the continuous worker (not a manual resync) to project a state.
export async function waitState(id:string,states:string[],ms=60000){return until(async()=>{const st=await opState(id);return states.includes(st)?st:null;},`op ${id} -> ${states}`,ms);}
export async function allowanceCycle(s:any,ids:string[]){let last:any;for(let round=0;round<2;round++){const a=await s.O.post('/allowances',{ids});expect(a.status===200,'allowance propose',a);await signAll(s,a.body.id);const p=await prepare(s,a.body.id);expect(p.status===200,'allowance prepare',p);await send(s,p.body);await mine(12);await waitState(a.body.id,['verified']);last=a.body;if(!a.body.manifest.reset)break;}return last;}
export async function freeze(s:any,ids:string[]){const f=await s.J.post('/batches',{ids});expect(f.status===200,'freeze',f);return f.body;}
export async function readyPayables(s:any,tag:string,units:string[]){const out=[];for(let i=0;i<units.length;i++){const c=await contact(s,`${tag} C${i}`);out.push({...(await payable(s,c.id,`${tag}-P${i}`,units[i])),contact:c});}await allowanceCycle(s,out.map(p=>p.id));return out;}
export const reservedCount=async(opId:string)=>(await q('SELECT count(*)::int n FROM reservations r JOIN batches b ON b.workspace_id=r.workspace_id AND b.id=r.batch_id WHERE b.operation_id=$1',[opId]))[0].n;
export const workerStatus=async(port=8113)=>{try{return await (await fetch(`http://127.0.0.1:${port}/status`)).json();}catch{return null;}};
export function services(action:string,which:string){return execFileSync('powershell',['-NoProfile','-File','ops/round4-services.ps1',action,which],{encoding:'utf8'});}
// Separately launched worker instance (test-owned) on a non-service status port, optionally with a fault point.
export function launchWorker(port:number,env:any={},logFile=`runtime-logs/b5-worker-${port}-${Date.now()}.log`){const out=fs.openSync(logFile,'a');const p=spawn(NODE,['--import','tsx','services/indexer-worker.ts'],{env:{...process.env,ALDER_WORKER_PORT:String(port),ALDER_WORKER_ROLE:'b5test',ALDER_WORKER_LOG:`runtime-logs/b5-worker-${port}.jsonl`,...env},stdio:['ignore',out,out],detached:true,windowsHide:true});if(!p.pid)throw Error('WORKER_SPAWN_FAILED');p.unref();return {pid:p.pid,logFile};}
export function kill9(pid:number){try{execFileSync('taskkill',['/F','/T','/PID',String(pid)],{stdio:'pipe'});return true;}catch{return false;}}
export function suspend(pid:number,resume=false){const fn=resume?'NtResumeProcess':'NtSuspendProcess';const ps=`$s=@'\nusing System;using System.Runtime.InteropServices;public static class B5P{[DllImport("ntdll.dll")]public static extern int ${fn}(IntPtr h);[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(int a,bool b,int p);}\n'@;Add-Type -TypeDefinition $s;$h=[B5P]::OpenProcess(0x0800,$false,${pid});[B5P]::${fn}($h)`;return execFileSync('powershell',['-NoProfile','-Command',ps],{encoding:'utf8'});}
export const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export {L};
