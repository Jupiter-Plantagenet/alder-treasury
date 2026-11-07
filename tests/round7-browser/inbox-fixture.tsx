// Authored API responses for browser rendering only. No API, database, chain, or wallet is contacted.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Workspace} from '../../apps/web/App.tsx';
import '../../apps/web/style.css';

declare global { interface Window { round7Calls: any[] } }
window.round7Calls=[];
const contact={id:'contact-r7',display_name:'Round 7 fixture contact',revision:1,verification_state:'pending'};
const rows=Array.from({length:100},(_,i)=>({id:`payable-${i+1}`,display_reference:`R7-${String(i+1).padStart(3,'0')}`,contact:contact.display_name,recipient:'0x0000000000000000000000000000000000000001',amount_units:String((i+1)*1000001),review_state:'destination_hold'}));
const totalUnits=rows.reduce((sum,row)=>sum+BigInt(row.amount_units),0n).toString();
async function api(path:string,body?:any,key?:string){
 window.round7Calls.push({path,body,key});
 if(path==='/views/payables' || path.startsWith('/views/payables?')){
  const u=new URL(path,'http://fixture');const q=u.searchParams.get('q')||'';const limit=Number(u.searchParams.get('limit')||25);const cursor=Number(u.searchParams.get('cursor')||0);
  const matching=q==='no-match'?[]:rows;const items=matching.slice(cursor,cursor+limit);
  return {items,total_count:matching.length,snapshot_version:'round7-authored-snapshot',next_cursor:cursor+limit<matching.length?String(cursor+limit):null,totals_by_asset:q==='no-match'?[]:[{token_identity:{chain_id:'31337',address:'0x0000000000000000000000000000000000000002'},total_units:totalUnits,count:String(rows.length)}]};
 }
 if(path==='/payables/imports/preview')return {row_count:2,valid_count:0,error_count:2,total_units:'0',digest:'round7-duplicate-fixture',committable:false,already_imported:null,file_errors:[],rows:[
  {row:2,external_reference:'DUPLICATE-REF',errors:['duplicate_external_reference_in_file']},
  {row:3,external_reference:'DUPLICATE-REF',errors:['duplicate_external_reference_in_file']}
 ]};
 throw Error(`Unexpected fixture API request: ${path}`);
}
function Fixture(){const snapshot={payables:rows,contacts:[contact],batches:[],signatures:[],events:[],roles:['preparer'],user:{id:'round7',name:'Round 7 fixture'},deployment:{},balance:null,allowance:null,chainError:'CHAIN_UNAVAILABLE'};return <Workspace workspaceId="round7-fixture" screen="payables" snapshot={snapshot} businessApi={api} onNavigate={()=>{}} onRefresh={async()=>{}}/>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
