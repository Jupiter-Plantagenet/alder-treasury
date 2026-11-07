// Authored API responses ONLY. No real API, PostgreSQL, RLS or chain. Exercises the actual
// Workspace -> PolicyScreen/SettingsScreen components in a browser.
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Workspace} from '../apps/web/App.tsx';import '../apps/web/style.css';
const ASSET={chain_id:'31337',address:'0x5FbDB2315678afecb367f032d93F642f64180aa3',profile:'ALDER_FIXED_SUPPLY_6_DECIMALS'};
const CUSTODY={managed_in_app:false,change_route:'Only a Safe owner/threshold transaction authorized by the current Safe owner quorum, executed on-chain outside this application.',external_ability:'Current Safe owners can still authorize transfers through other Safe routes outside this application.'};
type PolicySchedule={revision:number,conflict:boolean,preferences:number,calls:any[]};
declare global{interface Window{policySchedule:PolicySchedule;navigate:(id:string)=>void}}
window.policySchedule={revision:3,conflict:false,preferences:2,calls:[]};
const rules=()=>[{id:'SMALL',label:'Small payouts r'+window.policySchedule.revision,asset:ASSET,min_units:'1',max_units:'5000000000',contact_ids:null}];
const impact=[{id:'a',display_reference:'INV-1',contact:'Ada',amount_units:'9007199254740993',revision:2,matched_rules:[],status:'unmatched_hold'},{id:'b',display_reference:'INV-2',contact:'Bo',amount_units:'1000000',revision:1,matched_rules:['SMALL'],status:'rereview_required'},{id:'c',display_reference:'INV-3',contact:'Cy-with-a-deliberately-long-contractor-name-for-narrow-layouts',amount_units:'5',revision:1,matched_rules:['SMALL'],status:'reserved_unchanged'}];
const refusal=(statusCode:number,code:string)=>Object.assign(Error(code),{statusCode,code});
async function api(path:string,body?:any,key?:string,method?:string){
 const f=window.policySchedule;await new Promise(r=>setTimeout(r,20));
 if(body!==undefined)f.calls.push({path,body:JSON.parse(JSON.stringify(body)),key:key??null,method:method??'POST'});
 if(path==='/policy')return {policy:{id:'pol',revision:f.revision,digest:'f'.repeat(64),changed_by:'u',reason:'Authored revision',conditions:{schema_version:1,mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,rules:rules()}},revisions:[{revision:f.revision,digest:'f'.repeat(64),reason:'Authored'},{revision:f.revision-1,digest:'e'.repeat(64),reason:'Older'}],impact,workspace_asset:ASSET,can_edit:true,custody:CUSTODY};
 if(path==='/policies/preview')return {proposed_revision:f.revision+1,digest:'d'.repeat(64),impact:impact.map(x=>x.id==='a'?{...x,matched_rules:['ALL'],status:'review_pending'}:x),not_saved:true};
 if(path==='/policies/pol/revisions'){if(f.conflict){f.revision++;throw refusal(412,'STALE_REVISION');}f.revision++;return {policy_id:'pol',policy_revision:f.revision,digest:'c'.repeat(64),affected_draft_ids:['b'],outstanding_reserved_ids:['c'],reserved_intents_replaced:false};}
 if(path==='/settings')return {user:{id:'u',name:'Authored admin'},roles:['admin'],role_impersonation:false,preferences:{revision:f.preferences,pending_reminders:true,default_redaction:false},policy:{id:'pol',revision:f.revision},workspace:{chain_id:'31337',asset:ASSET,safe:'0x000000000000000000000000000000000000aAaA'},custody:CUSTODY};
 if(path==='/preferences'){f.preferences++;return {revision:f.preferences,saved_preferences:{pending_reminders:body.pending_reminders,default_redaction:body.default_redaction},custody_owner_set_unchanged:true};}
 if(path==='/custody/owner-changes')throw refusal(403,'CUSTODY_CHANGE_OUTSIDE_APP');
 throw refusal(404,'NOT_FOUND');
}
const snapshot={payables:[],contacts:[{id:'c1',display_name:'Ada'}],batches:[],signatures:[],events:[],operations:[],destinationHolds:[],roles:['admin'],user:{id:'u',name:'Authored admin'},deployment:{},balance:null,allowance:null,chainError:'CHAIN_UNAVAILABLE',policy:{id:'pol',revision:3}};
function Fixture(){const [screen,setScreen]=useState('policy');window.navigate=setScreen;return <Workspace workspaceId="w" screen={screen} snapshot={snapshot} businessApi={api} onNavigate={setScreen}/>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
