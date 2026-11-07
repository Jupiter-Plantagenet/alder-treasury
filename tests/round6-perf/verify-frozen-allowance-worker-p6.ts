// Observe the single-writer worker's independent proof for the existing P6 allowance.
import fs from 'node:fs';
import * as L from '../round5-ops/o5-lib.ts';
import {p6OutputPath} from './p6-output.ts';

const EXEC=process.env.P6_ALLOWANCE_EXECUTION_FILE||p6OutputPath('allowance-resolution/execute.json','.local/scratch-r6/allowance-resolution-p6/execute.json');
const OUT=process.env.P6_ALLOWANCE_VERIFICATION_OUTPUT||p6OutputPath('allowance-resolution/worker-verification.json','.local/scratch-r6/allowance-resolution-p6/worker-verification.json');
const R=new L.Report(OUT);
const request=async()=>{const response=await fetch('http://127.0.0.1:9113/status',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('P6_WORKER_STATUS_HTTP_'+response.status);return response.json();};
try {
  const execution=JSON.parse(fs.readFileSync(EXEC,'utf8'));
  const proof=execution.steps?.find((step:any)=>step.id==='P6-ALLOWANCE-CHAIN-PROOF'&&step.result==='PASS');
  const completed=proof?.completed;
  L.expect(Boolean(completed?.operationId&&completed?.txHash&&BigInt(completed?.depth??0)>=12n&&completed?.safeNonceAfter==='124'),'successful bounded chain proof exists before worker start');
  const reportMatchesTarget=(report:any)=>Boolean(report?.state==='verified'&&report?.kind==='allowance'&&String(report?.transactionHash).toLowerCase()===String(completed?.txHash).toLowerCase()&&String(report?.blockNumber)===String(completed?.receiptBlock)&&String(report?.cap)==='100004950'&&report?.paid===false&&BigInt(report?.depth??0)>=12n);
  let current=await request();
  L.expect(current.role==='active'&&current.lease?.name==='indexer'&&current.fence!=null&&current.consecutive_failures===0&&!current.retry_exhausted,'scoped P6 worker is active with an indexer lease and no failures',{role:current.role,lease:current.lease,fence:current.fence,failures:current.consecutive_failures,retryExhausted:current.retry_exhausted});
  const initialPasses=Number(current.passes??0),deadline=performance.now()+180000;
  let state=await L.opState(completed.operationId),lastReport:any=await L.lastReport(completed.operationId);
  const alreadyVerifiedAtFirstObservation=state==='verified'&&reportMatchesTarget(lastReport);
  while(state!=='verified'&&performance.now()<deadline){await L.sleep(1000);current=await request();state=await L.opState(completed.operationId);lastReport=await L.lastReport(completed.operationId);}
  const [head,nonce,allowance]=await Promise.all([L.chain.getBlockNumber(),L.safeNonce(),L.allowance()]);
  const depth=head-BigInt(completed.receiptBlock)+1n;
  const finalWorker=await request();
  L.expect(state==='verified'&&reportMatchesTarget(lastReport),'worker independently classified the exact transaction and block verified',{state,reportState:lastReport?.state,reportTxHash:lastReport?.transactionHash,reportBlock:lastReport?.blockNumber,expectedTxHash:completed.txHash,expectedBlock:completed.receiptBlock,reportDepth:lastReport?.depth,reportCap:lastReport?.cap});
  L.expect(Number(finalWorker.passes)>=initialPasses&&Number(finalWorker.passes)>0,'worker pass counter is monotonic and its durable exact-operation report is present',{initialPasses,finalPasses:Number(finalWorker.passes),alreadyVerifiedAtFirstObservation});
  L.expect(finalWorker.role==='active'&&finalWorker.lease?.name==='indexer'&&finalWorker.fence!=null&&finalWorker.consecutive_failures===0&&!finalWorker.retry_exhausted,'worker remains healthy after verification',{role:finalWorker.role,lease:finalWorker.lease,fence:finalWorker.fence,failures:finalWorker.consecutive_failures,retryExhausted:finalWorker.retry_exhausted});
  L.expect(head>=BigInt(completed.receiptBlock)+11n&&depth>=12n,'confirmation depth remains at least 12',{head:String(head),receiptBlock:completed.receiptBlock,depth:String(depth)});
  L.expect(nonce===124n&&allowance===100004950n,'Safe nonce and exact allowance remain correct after worker verification',{nonce:String(nonce),allowance:String(allowance)});
  R.ok('P6-ALLOWANCE-WORKER-VERIFICATION','scoped worker independently verified the exact allowance transaction at confirmation depth 12+',{operationId:completed.operationId,txHash:completed.txHash,opState:state,reportState:lastReport.state,reportBlock:lastReport.blockNumber,reportDepth:lastReport.depth,reportCap:lastReport.cap,alreadyVerifiedAtFirstObservation,workerPasses:Number(finalWorker.passes),workerFence:finalWorker.fence,head:String(head),receiptBlock:completed.receiptBlock,depth:String(depth),safeNonce:String(nonce),allowance:String(allowance)});
} catch(error:any) {
  R.bad('P6-ALLOWANCE-WORKER-VERIFICATION','bounded worker verification failed or remains unresolved; preserve the live operation, worker and stack for inspection; do not reset or clean up',{error:String(error?.message||error).slice(0,1200)});
} finally {
  try{await L.db.end();}catch(error:any){R.bad('P6-ALLOWANCE-WORKER-VERIFICATION','read-only verification pool closed',{error:String(error?.message||error).slice(0,300)});}
  R.save({run:'P6-ALLOWANCE-WORKER-VERIFICATION'});
  const fail=R.steps.filter((x:any)=>x.result==='FAIL').length;
  console.log(JSON.stringify({pass:R.steps.filter((x:any)=>x.result==='PASS').length,fail}));
  process.exitCode=fail?1:0;
}
