import {localRpcUrl,rpc} from '../../packages/intent.ts';
import {manifestDigest} from '../../services/verifier.ts';
import {INVALIDATION_VERIFIER_VERSION} from '../../services/invalidation-verifier.ts';

export type HoldLineage={chainId:number;genesisHash:string;chainKey:string;headNumber:string;headHash:string;checkpoint:any};
const eq=(a:any,b:any)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const integer=(v:any)=>{try{return BigInt(String(v));}catch{return null;}};

let lineageCache:{at:number,p:Promise<Omit<HoldLineage,'checkpoint'>>}|null=null;
export async function readCurrentHoldLineage(forceFresh=false):Promise<Omit<HoldLineage,'checkpoint'>>{
 if(!forceFresh&&lineageCache&&Date.now()-lineageCache.at<500)return lineageCache.p;
 const p=(async()=>{const [chainId,genesis,head]=await Promise.all([rpc.getChainId(),rpc.getBlock({blockNumber:0n}),rpc.getBlock()]);
  return {chainId,genesisHash:genesis.hash,chainKey:`${localRpcUrl}:${genesis.hash}`,headNumber:String(head.number),headHash:head.hash};})();
 if(!forceFresh)lineageCache={at:Date.now(),p};return p;
}

function reportIsCurrentCanonical(proof:any,lineage:HoldLineage){
 const r=proof?.report,latest=proof?.latestReport,reportBlock=integer(r?.blockNumber),head=integer(lineage.headNumber);
 let digestMatches=false;try{digestMatches=!!proof?.invalidationManifest&&r?.manifestDigest===manifestDigest(proof.invalidationManifest);}catch{}
 return proof?.producedBy==='alder_indexer'
  &&!!r&&String(proof.reportId)===String(proof.releaseReportId)
  &&String(latest?.id)===String(proof.reportId)&&latest?.report?.state==='verified'
  &&r.state==='verified'&&r.kind==='invalidation'&&r.verifierVersion===INVALIDATION_VERIFIER_VERSION&&digestMatches&&r.targetCannotExecute===true&&r.paid===false
  &&typeof r.transactionHash==='string'&&/^0x[0-9a-f]{64}$/i.test(r.transactionHash)
  &&typeof r.blockHash==='string'&&/^0x[0-9a-f]{64}$/i.test(r.blockHash)
  &&integer(r.depth)!==null&&integer(r.depth)! >= 12n&&reportBlock!==null&&head!==null&&reportBlock<=head&&head-reportBlock+1n >= 12n
  &&String(proof.reportHeader?.number)===String(r.blockNumber)
  &&proof.reportHeader?.canonical===true&&eq(proof.reportHeader?.hash,r.blockHash)
  &&proof.checkpoint?.chainKey===lineage.chainKey&&proof.checkpoint?.paused===false
  &&String(proof.checkpoint.number)===lineage.headNumber&&eq(proof.checkpoint.hash,lineage.headHash)
  &&proof.checkpointHeader?.canonical===true&&eq(proof.checkpointHeader?.hash,lineage.headHash)
  &&lineage.chainId===31337&&proof.targetManifest?.genesis===lineage.genesisHash;
}

const paymentId=(v:any)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v)?v.toLowerCase():null;
function samePaymentIdList(targetIds:any,items:any){
 if(!Array.isArray(targetIds)||!Array.isArray(items)||items.length===0||targetIds.length!==items.length)return false;
 const expected=items.map((x:any)=>paymentId(x?.paymentId)),actual=targetIds.map((x:any)=>paymentId(x?.paymentId??x));
 return expected.every((x:string|null)=>x!==null)&&actual.every((x:string|null)=>x!==null)
  &&new Set(expected).size===expected.length&&new Set(actual).size===actual.length
  &&expected.every((x:string|null,i:number)=>x===actual[i]);
}
function releaseSetMatchesTarget(targetManifest:any,proofs:any[]){
 const items=targetManifest?.items;
 if(!Array.isArray(items)||items.length===0||proofs.length!==items.length)return false;
 const expected=items.map((x:any)=>paymentId(x?.paymentId)).filter((x:string|null):x is string=>x!==null);
 const releasedPaymentIds=proofs.map((x:any)=>paymentId(x?.releasedPaymentId)).filter((x:string|null):x is string=>x!==null);
 const releasedPayableIds=proofs.map((x:any)=>typeof x?.releasedPayableId==='string'?x.releasedPayableId.toLowerCase():null).filter((x:string|null):x is string=>x!==null);
 return expected.length===items.length&&releasedPaymentIds.length===proofs.length&&releasedPayableIds.length===proofs.length
  &&new Set(expected).size===expected.length&&new Set(releasedPaymentIds).size===releasedPaymentIds.length
  &&new Set(releasedPayableIds).size===releasedPayableIds.length
  &&expected.length===releasedPaymentIds.length&&expected.every((x:string)=>releasedPaymentIds.includes(x));
}

export function verifiedHoldRelease(hold:any,proof:any,lineage:HoldLineage){
 const m=proof?.targetManifest,i=proof?.invalidationManifest,t=i?.target,r=proof?.report;
 if(!m||!i||!t||!r||!reportIsCurrentCanonical(proof,lineage))return false;
 const targetId=String(hold.operation_id);
 return hold.operation_state==='invalidated'
  &&proof.release?.targetOperationId===targetId
  &&proof.release?.invalidationOperationId===proof.invalidationId
  &&String(proof.release?.batchId)===String(proof.targetBatchUuid)
  &&integer(proof.release?.fence)!==null&&integer(proof.release?.fence)! > 0n
  &&proof.invalidationKind==='invalidation'&&proof.invalidationState==='verified'
  &&proof.invalidationTargetId===targetId
  &&i.method===proof.invalidationMethod
  &&i.target?.operationId===targetId
  &&samePaymentIdList(i.target?.paymentIds,m.items)
  &&samePaymentIdList(proof.targetBatchManifest?.items,m.items)
  &&proof.targetKind==='payout'
  &&eq(i.target?.safeTxHash,m.safeTxHash)
  &&String(i.target?.nonce)===String(m.message?.nonce)
  &&eq(i.target?.batchId,m.batchId)
  &&eq(proof.targetSafeTxHash,m.safeTxHash)
  &&String(proof.targetNonce)===String(m.message?.nonce)
  &&eq(proof.targetBatchId,m.batchId)
  &&eq(r.targetOperationId,targetId)
  &&eq(r.targetSafeTxHash,m.safeTxHash)
  &&String(r.targetNonce)===String(m.message?.nonce)
  &&eq(r.targetBatchId,m.batchId)
  &&proof.releaseReportId!==undefined;
}

export function isDestinationHoldResolved(hold:any,proofs:any[],lineage:HoldLineage){
 const reservations=integer(hold.reservation_count),releaseCount=integer(hold.release_count),itemCount=integer(hold.batch_item_count);
 if(reservations!==0n||releaseCount===null||itemCount===null||itemCount<=0n||releaseCount!==itemCount)return false;
 if(!Array.isArray(proofs)||BigInt(proofs.length)!==releaseCount)return false;
 if(!releaseSetMatchesTarget(proofs[0]?.targetManifest,proofs))return false;
 return proofs.every(p=>verifiedHoldRelease(hold,p,lineage));
}

export async function projectDestinationHolds(db:any,ws:string,lineage:Omit<HoldLineage,'checkpoint'>|null,operationId?:string,limit=500,forceFresh=false){
 const holds=(await db.query(`SELECT h.workspace_id,h.operation_id,h.contact_id,h.destination_revision,h.at,
  o.kind,o.state AS operation_state,o.manifest,
  (SELECT count(*)::int FROM reservations r JOIN batches b ON b.workspace_id=r.workspace_id AND b.id=r.batch_id WHERE b.workspace_id=o.workspace_id AND b.operation_id=o.id) AS reservation_count,
  COALESCE(jsonb_array_length(o.manifest->'items'),0)::int AS batch_item_count
  FROM destination_operation_holds h JOIN treasury_operations o ON o.workspace_id=h.workspace_id AND o.id=h.operation_id
  WHERE h.workspace_id=$1 AND ($2::uuid IS NULL OR h.operation_id=$2::uuid) ORDER BY h.at,h.operation_id,h.contact_id,h.destination_revision LIMIT $3`,[ws,operationId??null,limit])).rows;
 if(!holds.length)return [];
 let current=lineage;
 if(!current)try{current=await readCurrentHoldLineage(forceFresh);}catch{current=null;}
 const ids=[...new Set(holds.map((h:any)=>h.operation_id))];
 let releaseCounts:any[]=[];
 try{releaseCounts=(await db.query('SELECT target_operation_id::text,count(*)::int AS count FROM reservation_releases WHERE workspace_id=$1 AND target_operation_id=ANY($2::uuid[]) GROUP BY target_operation_id',[ws,ids])).rows;}catch(e:any){if(!['42P01','42703'].includes(e?.code))throw e;}
 const releaseCountByTarget=new Map<string,number>(releaseCounts.map((r:any)=>[r.target_operation_id,Number(r.count)]));
 let proofRows:any[]=[];
 try{proofRows=(await db.query(`SELECT rr.workspace_id,rr.target_operation_id,rr.invalidation_operation_id,rr.batch_id,rr.payable_id::text AS released_payable_id,p.payment_id AS released_payment_id,rr.report_id::text AS release_report_id,rr.fence::text AS release_fence,
  i.method AS invalidation_method,i.target_operation_id::text AS invalidation_target_id,i.target_safe_tx_hash AS target_safe_tx_hash,
  i.target_nonce::text AS target_nonce,i.target_batch_id AS target_batch_id,
  inv.kind AS invalidation_kind,inv.state AS invalidation_state,inv.manifest AS invalidation_manifest,
  target.kind AS target_kind,target.manifest AS target_manifest,b.manifest AS target_batch_manifest,b.id::text AS target_batch_uuid,
  report.id::text AS report_id,report.produced_by,report.report,
  latest.id::text AS latest_report_id,latest.report AS latest_report,
  th.number::text AS report_header_number,th.hash AS report_header_hash,th.canonical AS report_header_canonical,
  cp.chain_key AS checkpoint_chain_key,cp.number::text AS checkpoint_number,cp.hash AS checkpoint_hash,cp.paused AS checkpoint_paused,
  ch.hash AS checkpoint_header_hash,ch.canonical AS checkpoint_header_canonical
  FROM reservation_releases rr
  JOIN treasury_operations target ON target.workspace_id=rr.workspace_id AND target.id=rr.target_operation_id
  JOIN payables p ON p.workspace_id=rr.workspace_id AND p.id=rr.payable_id
  JOIN batches b ON b.workspace_id=rr.workspace_id AND b.id=rr.batch_id AND b.operation_id=rr.target_operation_id
  JOIN operation_invalidations i ON i.workspace_id=rr.workspace_id AND i.operation_id=rr.invalidation_operation_id AND i.target_operation_id=rr.target_operation_id
  JOIN treasury_operations inv ON inv.workspace_id=i.workspace_id AND inv.id=i.operation_id
  JOIN treasury_reports report ON report.workspace_id=rr.workspace_id AND report.operation_id=rr.invalidation_operation_id AND report.id=rr.report_id
  JOIN LATERAL (SELECT tr.id,tr.report FROM treasury_reports tr WHERE tr.workspace_id=rr.workspace_id AND tr.operation_id=rr.invalidation_operation_id ORDER BY tr.id DESC LIMIT 1) latest ON true
  LEFT JOIN treasury_headers th ON th.chain_key=$2 AND th.number::text=report.report->>'blockNumber' AND th.hash=report.report->>'blockHash'
  LEFT JOIN treasury_checkpoints cp ON cp.chain_key=$2
  LEFT JOIN treasury_headers ch ON ch.chain_key=cp.chain_key AND ch.number=cp.number AND ch.hash=cp.hash
  WHERE rr.workspace_id=$1 AND rr.target_operation_id=ANY($3::uuid[]) ORDER BY rr.target_operation_id,rr.batch_id,rr.payable_id,rr.invalidation_operation_id`,[ws,current?.chainKey??'',ids])).rows;}catch(e:any){
  if(!['42P01','42703'].includes(e?.code))throw e;
  // Older isolated episodes may not have the round-5 proof tables. Fail closed; schema absence never resolves a hold.
  proofRows=[];
 }
 const byTarget=new Map<string,any[]>();for(const p of proofRows){const x=byTarget.get(p.target_operation_id)||[];x.push({
  release:{targetOperationId:p.target_operation_id,invalidationOperationId:p.invalidation_operation_id,batchId:p.batch_id,reportId:p.release_report_id,fence:p.release_fence},
  releasedPayableId:p.released_payable_id,releasedPaymentId:p.released_payment_id,
  invalidationId:p.invalidation_operation_id,invalidationKind:p.invalidation_kind,invalidationState:p.invalidation_state,invalidationTargetId:p.invalidation_target_id,invalidationMethod:p.invalidation_method,
  targetSafeTxHash:p.target_safe_tx_hash,targetNonce:p.target_nonce,targetBatchId:p.target_batch_id,
  targetKind:p.target_kind,targetBatchUuid:p.target_batch_uuid,targetManifest:p.target_manifest,targetBatchManifest:p.target_batch_manifest,invalidationManifest:p.invalidation_manifest,reportId:p.report_id,releaseReportId:p.release_report_id,producedBy:p.produced_by,report:p.report,
  latestReport:{id:p.latest_report_id,report:p.latest_report},reportHeader:{number:p.report_header_number,hash:p.report_header_hash,canonical:p.report_header_canonical},
  checkpoint:{chainKey:p.checkpoint_chain_key,number:p.checkpoint_number,hash:p.checkpoint_hash,paused:p.checkpoint_paused},checkpointHeader:{hash:p.checkpoint_header_hash,canonical:p.checkpoint_header_canonical}
 });byTarget.set(p.target_operation_id,x);}
 return holds.map((h:any)=>{const proofs=byTarget.get(h.operation_id)||[],releaseCount=releaseCountByTarget.get(h.operation_id)||0;
  const record={...h,reservation_count:Number(h.reservation_count),release_count:releaseCount};const resolved=!!current&&isDestinationHoldResolved(record,proofs,{...current,checkpoint:proofs[0]?.checkpoint});
  const {manifest:_manifest,...publicRecord}=record;
  return {...publicRecord,resolution:resolved?'resolved':'unresolved',resolution_report_ids:resolved?[...new Set(proofs.map(p=>p.reportId))]:[]};});
}
