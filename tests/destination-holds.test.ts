import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isDestinationHoldResolved} from '../apps/api/destination-holds.ts';
import {manifestDigest} from '../services/verifier.ts';
import {INVALIDATION_VERIFIER_VERSION} from '../services/invalidation-verifier.ts';

const lineage:any={chainId:31337,genesisHash:'0x'+'11'.repeat(32),chainKey:'http://127.0.0.1:8547:0x'+'11'.repeat(32),headNumber:'3418',headHash:'0x'+'22'.repeat(32)};
const fixture=()=>{
 const targetId='11111111-1111-4111-8111-111111111111',invalidationId='22222222-2222-4222-8222-222222222222',batch='0x'+'33'.repeat(32),batchUuid='66666666-6666-4666-8666-666666666666',payableId='77777777-7777-4777-8777-777777777777',payment='0x'+'aa'.repeat(32),safeHash='0x'+'44'.repeat(32),reportId='4059';
 const hold={operation_id:targetId,operation_state:'invalidated',reservation_count:0,release_count:1,batch_item_count:1};
 const invalidationManifest={safeTxHash:'0x'+'99'.repeat(32),calldata:'0x1234',items:[],method:'executor_cancel',target:{operationId:targetId,kind:'payout',safeTxHash:safeHash,nonce:'7',batchId:batch,paymentIds:[payment]}};
 const report={state:'verified',kind:'invalidation',verifierVersion:INVALIDATION_VERIFIER_VERSION,manifestDigest:manifestDigest(invalidationManifest),targetCannotExecute:true,paid:false,transactionHash:'0x'+'55'.repeat(32),blockHash:'0x'+'66'.repeat(32),blockNumber:'2108',depth:'12',targetOperationId:targetId,targetSafeTxHash:safeHash,targetNonce:'7',targetBatchId:batch};
 const proof={release:{targetOperationId:targetId,invalidationOperationId:invalidationId,batchId:batchUuid,reportId,fence:'21'},invalidationId,invalidationKind:'invalidation',invalidationState:'verified',invalidationTargetId:targetId,invalidationMethod:'executor_cancel',targetKind:'payout',targetBatchUuid:batchUuid,targetSafeTxHash:safeHash,targetNonce:'7',targetBatchId:batch,
  releasedPayableId:payableId,releasedPaymentId:payment,
  targetManifest:{kind:'payout',genesis:lineage.genesisHash,safeTxHash:safeHash,batchId:batch,message:{nonce:'7'},items:[{paymentId:payment}]},
  targetBatchManifest:{items:[{paymentId:payment}]},
  invalidationManifest,
  reportId,releaseReportId:reportId,producedBy:'alder_indexer',report,latestReport:{id:reportId,report},
  reportHeader:{number:'2108',hash:report.blockHash,canonical:true},
  checkpoint:{chainKey:lineage.chainKey,number:lineage.headNumber,hash:lineage.headHash,paused:false},
  checkpointHeader:{hash:lineage.headHash,canonical:true}};
 return {hold,proof};
};

test('destination hold resolves only with exact verified invalidation, release archive, canonical headers and current unpaused lineage',()=>{
 const {hold,proof}=fixture();assert.equal(isDestinationHoldResolved(hold,[proof],{...lineage,checkpoint:proof.checkpoint}),true);
});

test('nonce_consumed state alone never resolves a destination hold',()=>{
 const {hold,proof}=fixture();hold.operation_state='nonce_consumed';assert.equal(isDestinationHoldResolved(hold,[proof],{...lineage,checkpoint:proof.checkpoint}),false);
});

test('a remaining reservation or incomplete release set keeps the hold unresolved',()=>{
 const {hold,proof}=fixture();hold.reservation_count=1;assert.equal(isDestinationHoldResolved(hold,[proof],{...lineage,checkpoint:proof.checkpoint}),false);
 hold.reservation_count=0;hold.release_count=2;assert.equal(isDestinationHoldResolved(hold,[proof],{...lineage,checkpoint:proof.checkpoint}),false);
});

test('release projection requires exact payable/payment ID set, rejecting same-count substitutions and duplicates',()=>{
 const base=fixture();base.proof.releasedPaymentId='0x'+'bb'.repeat(32);base.proof.releasedPayableId='88888888-8888-4888-8888-888888888888';
 assert.equal(isDestinationHoldResolved(base.hold,[base.proof],{...lineage,checkpoint:base.proof.checkpoint}),false);
 const x=fixture(),payment2='0x'+'cc'.repeat(32),payment3='0x'+'dd'.repeat(32),payable2='88888888-8888-4888-8888-888888888888';
 x.hold.batch_item_count=2;x.hold.release_count=2;x.proof.targetManifest.items.push({paymentId:payment2});x.proof.targetBatchManifest.items.push({paymentId:payment2});x.proof.invalidationManifest.target.paymentIds.push(payment2);
 const second=structuredClone(x.proof);second.releasedPayableId=payable2;second.releasedPaymentId=payment2;second.release.batchId=x.proof.release.batchId;
 assert.equal(isDestinationHoldResolved(x.hold,[x.proof,second],{...lineage,checkpoint:x.proof.checkpoint}),true);
 second.releasedPaymentId=payment3;assert.equal(isDestinationHoldResolved(x.hold,[x.proof,second],{...lineage,checkpoint:x.proof.checkpoint}),false);
 second.releasedPaymentId=x.proof.releasedPaymentId;assert.equal(isDestinationHoldResolved(x.hold,[x.proof,second],{...lineage,checkpoint:x.proof.checkpoint}),false);
 const duplicated=fixture();duplicated.proof.invalidationManifest.target.paymentIds=['0x'+'aa'.repeat(32),'0x'+'aa'.repeat(32)];duplicated.proof.targetManifest.items.push({paymentId:'0x'+'aa'.repeat(32)});duplicated.hold.batch_item_count=2;duplicated.hold.release_count=2;
 assert.equal(isDestinationHoldResolved(duplicated.hold,[duplicated.proof,{...structuredClone(duplicated.proof),releasedPayableId:payable2}],{...lineage,checkpoint:duplicated.proof.checkpoint}),false);
});

test('missing, mismatched or superseded invalidation evidence remains unresolved',()=>{
 const {hold,proof}=fixture(),context={...lineage,checkpoint:proof.checkpoint};
 assert.equal(isDestinationHoldResolved(hold,[],context),false);
 for(const mutate of [
  (p:any)=>p.producedBy='alder_verifier',
  (p:any)=>p.report.verifierVersion='old-verifier',
  (p:any)=>p.report.manifestDigest='0'.repeat(64),
  (p:any)=>p.report.targetCannotExecute=false,
  (p:any)=>p.report.depth='11',
  (p:any)=>p.report.targetOperationId='other',
  (p:any)=>p.report.targetSafeTxHash='0x'+'77'.repeat(32),
  (p:any)=>p.report.targetNonce='8',
  (p:any)=>p.report.targetBatchId='0x'+'77'.repeat(32),
  (p:any)=>p.latestReport={id:'9999',report:{state:'retracted'}},
  (p:any)=>p.reportHeader.canonical=false,
  (p:any)=>p.reportHeader.hash='0x'+'77'.repeat(32),
  (p:any)=>p.checkpoint.paused=true,
  (p:any)=>p.checkpoint.hash='0x'+'77'.repeat(32),
  (p:any)=>p.checkpointHeader.canonical=false,
  (p:any)=>p.release.invalidationOperationId='other',
  (p:any)=>p.invalidationManifest.method='nonce_consumption',
  (p:any)=>p.invalidationManifest.target.paymentIds[0]='0x'+'77'.repeat(32),
  (p:any)=>p.targetBatchManifest.items[0].paymentId='0x'+'77'.repeat(32),
 ]){const x=fixture();mutate(x.proof);assert.equal(isDestinationHoldResolved(x.hold,[x.proof],{...lineage,checkpoint:x.proof.checkpoint}),false);}
});

test('stale or foreign chain lineage cannot resolve a hold',()=>{
 const {hold,proof}=fixture();assert.equal(isDestinationHoldResolved(hold,[proof],{...lineage,chainId:31338,checkpoint:proof.checkpoint}),false);
 assert.equal(isDestinationHoldResolved(hold,[proof],{...lineage,genesisHash:'0x'+'88'.repeat(32),checkpoint:proof.checkpoint}),false);
 assert.equal(isDestinationHoldResolved(hold,[proof],{...lineage,headNumber:'3417',checkpoint:proof.checkpoint}),false);
});

