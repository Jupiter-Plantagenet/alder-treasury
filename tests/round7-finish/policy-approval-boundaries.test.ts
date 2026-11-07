// Bounded TR-T-REVIEW/TR-T-POLICY verification. Exercises the current policy matcher and
// payable disposition function only; it does not claim PostgreSQL/API persistence evidence.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classify,matchPolicy,validatePolicyConditions} from '../../apps/api/policy.ts';

const contactA='11111111-1111-4111-8111-111111111111';
const contactB='22222222-2222-4222-8222-222222222222';
const token={chain_id:'31337',address:'0x5FbDB2315678afecb367f032d93F642f64180aa3',profile:'ALDER_FIXED_SUPPLY_6_DECIMALS'};
const otherToken={...token,address:'0x0000000000000000000000000000000000000001'};
const conditions=validatePolicyConditions({
 schema_version:1,mandatory_review:true,required_reviewer_role:'reviewer',mandatory_destination_check:true,
 rules:[{id:'A-BOUNDED',label:'Contact A bounded',asset:token,min_units:'100',max_units:'500',contact_ids:[contactA]}]
});
const row=(extra:any={})=>({id:'p1',display_reference:'PAY-1',contact:'Fixture',amount_units:'250',revision:7,contact_id:contactA,token_identity:token,reserved:false,destination_current:true,reviewed_by:null,approved_policy_revisions:[],...extra});
const policy={revision:4,conditions};

test('TR-T-REVIEW: only a current matching rule can enter reviewer flow; unmatched facts remain held',()=>{
 assert.deepEqual(matchPolicy(conditions,{amount_units:'250',contact_id:contactA,token_identity:token}),['A-BOUNDED']);
 const noRuleFacts=[
  {amount_units:'99',contact_id:contactA,token_identity:token},
  {amount_units:'501',contact_id:contactA,token_identity:token},
  {amount_units:'250',contact_id:contactB,token_identity:token},
  {amount_units:'250',contact_id:contactA,token_identity:otherToken},
  {amount_units:'250',contact_id:null,token_identity:token},
  {amount_units:'250',contact_id:contactA,token_identity:null}
 ];
 for(const facts of noRuleFacts){
  assert.deepEqual(matchPolicy(conditions,facts),[]);
  assert.equal(classify(row(facts),policy).status,'unmatched_hold');
 }
});

test('TR-T-REVIEW: an unmatched payable stays held even if stale review metadata exists',()=>{
 const held=classify(row({amount_units:'900',reviewed_by:'reviewer-id',approved_policy_revisions:[4]}),policy);
 assert.equal(held.status,'unmatched_hold');
 assert.deepEqual(held.matched_rules,[]);
});

test('TR-T-REVIEW: a match needs a current independent review and current destination',()=>{
 assert.equal(classify(row(),policy).status,'review_pending');
 assert.equal(classify(row({reviewed_by:'reviewer-id',approved_policy_revisions:[3]}),policy).status,'rereview_required');
 assert.equal(classify(row({reviewed_by:'reviewer-id',approved_policy_revisions:[4]}),policy).status,'approved_current');
 assert.equal(classify(row({destination_current:false,reviewed_by:'reviewer-id',approved_policy_revisions:[4]}),policy).status,'destination_hold');
});

test('TR-T-REVIEW: reserved payable disposition is unchanged before policy classification',()=>{
 assert.equal(classify(row({reserved:true,amount_units:'900'}),policy).status,'reserved_unchanged');
});
