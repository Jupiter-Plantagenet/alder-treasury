// Authored command/authorization schedules ONLY. No real API, DB or chain.
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Workspace} from '../apps/web/App.tsx';import '../apps/web/style.css';
const row={id:'p',display_reference:'ROUND2-EXACT',contact:'Authored contractor',recipient:'0x0000000000000000000000000000000000000991',amount_units:'9007199254740993',review_state:'destination_hold',revision:1,service:'Manual payable',contact_id:'c',prepared_by:'u',payment_id:'fixture-payment'};
const fallback={...row,id:'fallback',display_reference:'PAY-1043',contact:'Must not substitute'};
type Schedule={mode:string,denial:number|null,failRefresh:boolean,omitSelected:boolean,defaultReference?:string,calls:any[],effects:number,settle?:()=>void,workspace:string,user:string};
declare global{interface Window{schedule:Schedule;}}
window.schedule={mode:'lost',denial:403,failRefresh:false,omitSelected:false,calls:[],effects:0,workspace:'w',user:'u'};
const receipts=new Map<string,any>();
async function api(path:string,body?:any,key?:string){
 const f=window.schedule;
 if(!body)return {items:[row],total_count:'1',snapshot_version:'authored-round2',next_cursor:null,totals_by_asset:[]};
 f.calls.push({path,body:JSON.parse(JSON.stringify(body)),key});
 if(f.mode==='definite')throw Object.assign(Error('Authored first validation denial'),{statusCode:422});
 if(f.mode==='held')return new Promise(resolve=>{f.settle=()=>{f.effects++;receipts.set(key!,row);resolve(row);};});
 if(!receipts.has(key!)){f.effects++;receipts.set(key!,row);throw Error('Authored lost response after modeled commit');}
 if(f.denial!==null){if(f.denial===0)throw Error('Authored authentication refusal');throw Object.assign(Error('Authored authorization refusal '+f.denial),{statusCode:f.denial});}
 return receipts.get(key!);
}
function Fixture(){
 const [screen,setScreen]=useState('payables'),[revision,setRevision]=useState(0),[omitted,setOmitted]=useState(false);
 const f=window.schedule;const alternative={...fallback,display_reference:f.defaultReference||fallback.display_reference};const s={workspace_id:f.workspace,payables:omitted?[alternative]:[row,alternative],contacts:[{id:'c',display_name:'Authored contractor',revision:1,verification_state:'pending'}],batches:[],signatures:[],events:[],roles:['preparer','reviewer'],user:{id:f.user,name:'Authored user'},deployment:{},balance:null,allowance:null,chainError:'CHAIN_UNAVAILABLE'};
 return <><button onClick={()=>setScreen('policy')}>Leave fixture</button><button onClick={()=>{setScreen('payables');setRevision(n=>n+1);}}>Return fixture</button><button onClick={()=>setRevision(n=>n+1)}>Rerender fixture identity</button><Workspace workspaceId={f.workspace} screen={screen} snapshot={s} businessApi={api} onNavigate={setScreen} onRefresh={async()=>{if(f.failRefresh)throw Error('Authored refresh failure');setOmitted(f.omitSelected);setRevision(n=>n+1);}}/><output hidden>{revision}</output></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
