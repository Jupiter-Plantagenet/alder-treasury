// SSR rendering checks for Policy/Settings screens (authored data; not API/PG/browser interaction evidence).
import {test} from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {Workspace} from '../apps/web/App.tsx';
import {PolicyView,PolicyScreen,explain,buildConditions} from '../apps/web/Policy.tsx';
import {SettingsView} from '../apps/web/Settings.tsx';
const ASSET={chain_id:'31337',address:'0x5FbDB2315678afecb367f032d93F642f64180aa3',profile:'ALDER_FIXED_SUPPLY_6_DECIMALS'};
const CUSTODY={managed_in_app:false,change_route:'Only a Safe owner/threshold transaction authorized by the current Safe owner quorum, executed on-chain outside this application.',external_ability:'Current Safe owners can still authorize transfers through other Safe routes outside this application.'};
const impact=[{id:'a',display_reference:'INV-1',contact:'Ada',amount_units:'9007199254740993',revision:2,matched_rules:[],status:'unmatched_hold'},{id:'b',display_reference:'INV-2',contact:'Bo',amount_units:'1000000',revision:1,matched_rules:['SMALL'],status:'rereview_required'},{id:'c',display_reference:'INV-3',contact:'Cy',amount_units:'5',revision:1,matched_rules:['SMALL'],status:'reserved_unchanged'}];
const policy={id:'pol',revision:3,digest:'f'.repeat(64),changed_by:'u',reason:'Tighten',conditions:{schema_version:1,mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,rules:[{id:'SMALL',label:'Small payouts',asset:ASSET,min_units:'1',max_units:'5000000000',contact_ids:null}]}};
const base={policy:null,revisions:[],impact,workspace_asset:ASSET,can_edit:false,custody:CUSTODY};

test('no policy renders an explicit hold, locked mandatory gates and the custody boundary',()=>{
 const html=renderToStaticMarkup(<PolicyView data={base} onReload={()=>{}}/>);
 assert.match(html,/No review policy · every payable is held/);
 assert.equal((html.match(/<input type="checkbox"[^>]*>/g)||[]).filter(t=>t.includes('checked=""')&&t.includes('disabled=""')).length,3,'three locked mandatory gates');
 assert.match(html,/server rejects any attempt to disable or reduce them/);
 assert.match(html,/outside this application/);assert.match(html,/Custody authorization is separate/);
 assert.match(html,/Read only/);assert.doesNotMatch(html,/Save policy revision|Create policy revision/);
});
test('status is text, not color only; exact raw units and unmatched/re-review/reserved states are named',()=>{
 const html=renderToStaticMarkup(<PolicyView data={{...base,policy}} onReload={()=>{}}/>);
 assert.match(html,/Business review policy · revision 3/);assert.match(html,/9007199254740993/);
 for(const text of ['Held · no matching rule','Re-review required under current revision','Reserved · frozen intent unchanged'])assert(html.includes(text),text);
 assert.match(html,/Hold · never auto-approve/);
});
test('reviewer/admin editor has labelled exact-unit fields, change reason, preview and revision-bound save',()=>{
 const html=renderToStaticMarkup(<PolicyView data={{...base,policy,can_edit:true}} api={async()=>({})} contacts={[{id:'c1',display_name:'Ada'}]} onReload={()=>{}}/>);
 for(const label of ['Rule ID','Rule label','Minimum · base units','Maximum · base units (blank = no upper bound)','Restrict to contacts (optional)','Change reason'])assert(html.includes(label),label);
 assert.match(html,/Save policy revision 4/);assert.match(html,/Preview impact/);assert.match(html,/= 5000 ALDR \(inclusive\)/);
 const created=renderToStaticMarkup(<PolicyView data={{...base,can_edit:true}} api={async()=>({})} onReload={()=>{}}/>);assert.match(created,/Create policy revision 1/);
 const noAsset=renderToStaticMarkup(<PolicyView data={{...base,can_edit:true,workspace_asset:null}} onReload={()=>{}}/>);assert.match(noAsset,/Editing unavailable/);
});
test('client always submits the mandatory floor; it offers no control to disable review',()=>{
 const c=buildConditions([{id:'A',label:'x',min_units:'1',max_units:'',contact_ids:[]}],ASSET);
 assert.deepEqual([c.mandatory_review,c.required_reviewer_role,c.mandatory_destination_check],[true,'reviewer',true]);assert.equal(c.rules[0].max_units,null);assert.equal('contact_ids' in c.rules[0],false);
});
test('typed server errors are explained: bypass, conflict, custody, schema, session',()=>{
 assert.match(explain({code:'MANDATORY_REVIEW'}),/cannot be disabled or reduced by any role/);
 assert.match(explain({code:'STALE_REVISION'}),/Revision conflict/);
 assert.match(explain({code:'CUSTODY_CHANGE_OUTSIDE_APP'}),/on-chain, outside this app/);
 assert.match(explain({code:'POLICY_SCHEMA_REQUIRED'}),/migration 008/);
 assert.match(explain({code:'SESSION_EXPIRED'}),/revoked/);
});
test('policy screen without an API renders an accessible error with no fabricated policy',()=>{
 const html=renderToStaticMarkup(<PolicyScreen/>);assert.match(html,/role="alert"/);assert.match(html,/Review policy unavailable/);assert.doesNotMatch(html,/POL-03/);
});
test('settings: no role switcher, self preferences, custody change request and explanation',()=>{
 const html=renderToStaticMarkup(<SettingsView data={{user:{name:'Ada'},roles:['admin'],role_impersonation:false,preferences:{revision:2,pending_reminders:true,default_redaction:false},policy:{id:'pol',revision:3},workspace:{chain_id:'31337',asset:ASSET,safe:'0x000000000000000000000000000000000000aAaA'},custody:CUSTODY}} api={async()=>({})} onReload={()=>{}} onLogout={()=>{}}/>);
 assert.doesNotMatch(html,/View role/);assert.doesNotMatch(html,/<select/);
 assert.match(html,/Server-resolved roles<\/dt><dd>admin/);assert.match(html,/Revision 3 · mandatory independent review/);
 assert.match(html,/Show pending custody and recovery reminders/);assert.match(html,/Preference revision 2/);
 assert.match(html,/Request Safe owner or threshold change/);assert.match(html,/cannot add, remove or swap Safe owners/);assert.match(html,/outside this application/);
});
test('payable review form is held with an explanation when no policy exists and binds the revision when one does',()=>{
 const p={id:'p',contact:'Ada',display_reference:'INV-1',service:'Manual payable',amount_units:'1000000',recipient:'0x0000000000000000000000000000000000000991',revision:2,verified:true,prepared_by:'prep',contact_id:'c'};
 const s:any={roles:['reviewer'],user:{id:'rev',name:'Reviewer'},payables:[p],contacts:[],batches:[],events:[],operations:[],destinationHolds:[]};
 const held=renderToStaticMarkup(<Workspace screen="payable" snapshot={{...s,policy:null}}/>);assert.match(held,/No current review policy: this payable is held/);
 const bound=renderToStaticMarkup(<Workspace screen="payable" snapshot={{...s,policy:{id:'pol',revision:3}}}/>);assert.match(bound,/Binds payable revision 2 to review policy revision 3/);
});
