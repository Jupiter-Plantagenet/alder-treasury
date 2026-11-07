// Resolve only the existing, already frozen P6 allowance operation. This does
// not create payables or mutate rows outside the normal owner/API flow.
import fs from 'node:fs';
import {keccak256,type Hex} from 'viem';
import * as L from '../round5-ops/o5-lib.ts';
import {p6OutputPath} from './p6-output.ts';

const EXPECTED_AMOUNT='100004950';
const EXPECTED_ITEMS=100;
const EXPECTED_OPERATION_ID='8463b35d-02a7-4392-91f1-591171839834';
const EXPECTED_NONCE=123n;
const MIN_HEAD=10161n;
const R=new L.Report(p6OutputPath('allowance-resolution/execute.json','.local/scratch-r6/allowance-resolution-p6/execute.json'));
let s:any,op:any,txHash:string|undefined;
const safeManifest=(v:any)=>typeof v==='string'?JSON.parse(v):v;
const msgNonce=(m:any)=>m?.typedData?.message?.nonce??m?.message?.nonce??m?.nonce;
try {
  const deployment=JSON.parse(fs.readFileSync('evidence/round5-ops/isolated-deployment.json','utf8'));
  const candidates=await L.q("SELECT id,kind,state,manifest FROM treasury_operations WHERE workspace_id=$1 AND kind='allowance' AND state='frozen' ORDER BY created_at DESC",[L.WS]);
  const matching=[];
  for(const row of candidates){
    if(String(row.id)!==EXPECTED_OPERATION_ID)continue;
    const manifest=safeManifest(row.manifest),ids=Array.isArray(manifest?.ids)?manifest.ids:[];
    if(ids.length!==EXPECTED_ITEMS||String(manifest?.requestedCap)!==EXPECTED_AMOUNT||String(manifest?.cap)!==EXPECTED_AMOUNT||manifest?.reset===true)continue;
    const totals=await L.q('SELECT count(*)::int n,COALESCE(sum(amount_units),0)::text total FROM payables WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[L.WS,ids]);
    if(totals[0]?.n===EXPECTED_ITEMS&&String(totals[0]?.total)===EXPECTED_AMOUNT)matching.push({row,manifest,ids});
  }
  L.expect(matching.length===1,'exactly one existing frozen 100-payable allowance matches the admitted cap');
  const picked=matching[0];
  L.expect(String(picked.row.id)===EXPECTED_OPERATION_ID,'frozen allowance is the exact previously approved operation',{operationId:picked.row.id});
  op={...picked.row,manifest:picked.manifest,ids:picked.ids};
  const m=op.manifest,manifestNonce=msgNonce(m);
  const [chainId,head,genesis,safeNonce,allowance]=await Promise.all([L.chain.getChainId(),L.chain.getBlockNumber(),L.chain.getBlock({blockNumber:0n}),L.safeNonce(),L.allowance()]);
  L.expect(chainId===31337,'isolated chain ID is 31337',{chainId});
  L.expect(genesis.hash===deployment.genesis&&genesis.hash===L.d.genesis,'isolated genesis matches the original deployment');
  L.expect(head>=MIN_HEAD,'isolated chain head has not fallen below the saved head',{head:String(head),minimum:String(MIN_HEAD)});
  L.expect(safeNonce===EXPECTED_NONCE,'Safe nonce is still the frozen operation nonce',{safeNonce:String(safeNonce)});
  L.expect(manifestNonce===undefined||BigInt(manifestNonce)===EXPECTED_NONCE,'frozen manifest nonce matches current Safe nonce',{manifestNonce:String(manifestNonce??'not-present')});
  L.expect(allowance===0n,'current token allowance is zero before signing',{allowance:String(allowance)});
  const [sigRows,attemptRows,invalidationRows]=await Promise.all([
    L.q('SELECT count(*)::int n FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[L.WS,op.id]),
    L.q('SELECT count(*)::int n FROM treasury_attempts WHERE workspace_id=$1 AND operation_id=$2',[L.WS,op.id]),
    L.q('SELECT count(*)::int n FROM operation_invalidations WHERE workspace_id=$1 AND target_operation_id=$2',[L.WS,op.id])
  ]);
  L.expect(Number(sigRows[0].n)===0&&Number(attemptRows[0].n)===0&&Number(invalidationRows[0].n)===0,'operation is unsigned, unattempted, and has no open invalidation',{signatures:sigRows[0].n,attempts:attemptRows[0].n,invalidations:invalidationRows[0].n});
  const baseline={operationId:op.id,kind:op.kind,state:op.state,payableCount:op.ids.length,aggregateAmountUnits:EXPECTED_AMOUNT,cap:EXPECTED_AMOUNT,reset:m.reset===true,chainId,genesis:genesis.hash,head:String(head),safeNonce:String(safeNonce),allowanceBefore:String(allowance),signaturesBefore:Number(sigRows[0].n),attemptsBefore:Number(attemptRows[0].n),invalidationsBefore:Number(invalidationRows[0].n),deploymentGenesis:deployment.genesis};
  R.ok('P6-ALLOWANCE-PREFLIGHT','exact saved frozen allowance and chain preconditions match; no reset/reseed',{baseline});

  s=await L.sessions(10000,30000);
  for(const i of [0,1]){const signed=await L.sign(s,op.id,i);L.expect(signed.status===200,'authorized owner signature accepted',{ownerIndex:i,status:signed.status,code:signed.body?.error?.code??null});R.ok('P6-ALLOWANCE-SIGN','one authorized Safe owner signature accepted',{ownerIndex:i,status:signed.status});}
  const signaturesAfter=(await L.q('SELECT count(*)::int n FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[L.WS,op.id]))[0].n;
  L.expect(Number(signaturesAfter)===2,'two owner signatures are stored',{signatures:Number(signaturesAfter)});
  const prepared=await L.prepare(s,op.id);
  L.expect(prepared.status===200,'normal API prepare succeeds',{status:prepared.status,code:prepared.body?.error?.code??null});
  L.expect(prepared.body?.to?.toLowerCase()===L.d.safe.toLowerCase(),'prepared transaction targets the deployed Safe');
  L.expect(prepared.body?.chainId==='0x7a69','prepared transaction is bound to chain 31337');
  const calldataKeccak=keccak256(prepared.body.data as Hex);
  R.ok('P6-ALLOWANCE-PREPARE','normal owner API prepare succeeded',{status:prepared.status,attemptId:prepared.body.attemptId,operationId:op.id,chainId:prepared.body.chainId,to:prepared.body.to,calldataKeccak});

  const estimate=await L.chain.estimateGas({account:L.owners[0].address,to:prepared.body.to,data:prepared.body.data});
  const wallet=L.walletFor(L.owners[0]);
  const sentHash=await wallet.sendTransaction({to:prepared.body.to,data:prepared.body.data,value:0n,gas:estimate,nonce:Number(prepared.body.senderNonce)});
  if(!/^0x[0-9a-fA-F]{64}$/.test(sentHash))throw Error('ALLOWANCE_TX_HASH_INVALID');
  txHash=sentHash;
  R.ok('P6-ALLOWANCE-BROADCAST','single exact prepared Safe transaction broadcast from the authorized scratch owner',{txHash:sentHash,estimateGas:String(estimate),senderNonce:String(prepared.body.senderNonce)});
  const observation=await s.O.post(`/attempts/${prepared.body.attemptId}/observations`,{kind:'wallet_hash',transactionHash:sentHash});
  L.expect(observation.status===200,'wallet transaction hash observation accepted',{status:observation.status,code:observation.body?.error?.code??null});
  const receipt=await L.chain.waitForTransactionReceipt({hash:sentHash,timeout:120000,pollingInterval:500});
  L.expect(receipt.status==='success','Safe allowance transaction receipt succeeded',{status:receipt.status,blockNumber:String(receipt.blockNumber)});
  const minedTx=await L.chain.getTransaction({hash:sentHash});
  L.expect(minedTx.to?.toLowerCase()===prepared.body.to.toLowerCase()&&minedTx.input===prepared.body.data,'mined transaction exactly matches the prepared Safe calldata',{calldataKeccak});
  const safeNonceAfter=await L.safeNonce(),allowanceAfter=await L.allowance();
  L.expect(safeNonceAfter===EXPECTED_NONCE+1n,'Safe nonce advanced exactly once',{safeNonce:String(safeNonceAfter)});
  L.expect(allowanceAfter===BigInt(EXPECTED_AMOUNT),'on-chain Safe allowance equals the frozen cap',{allowance:String(allowanceAfter)});
  await L.mine(12);
  const headAfter=await L.chain.getBlockNumber(),depth=headAfter-receipt.blockNumber+1n;
  L.expect(depth>=12n,'receipt reached 12-block confirmation depth',{receiptBlock:String(receipt.blockNumber),head:String(headAfter),depth:String(depth)});
  const completed={...baseline,signaturesAfter:Number(signaturesAfter),attemptId:prepared.body.attemptId,to:prepared.body.to,calldataKeccak,txHash,receiptStatus:receipt.status,receiptBlock:String(receipt.blockNumber),headAfter:String(headAfter),depth:String(depth),safeNonceAfter:String(safeNonceAfter),allowanceAfter:String(allowanceAfter),workerVerificationPending:true};
  R.ok('P6-ALLOWANCE-CHAIN-PROOF','receipt, exact allowance, nonce advance and 12 confirmations verified; worker verification remains pending',{completed});
} catch(error:any) {
  R.bad('P6-ALLOWANCE-RESOLUTION','normal allowance workflow stopped at its first failed/uncertain step; do not retry broadcast or clean up until outcome is resolved',{error:String(error?.message||error).slice(0,1200),operationId:op?.id??null,txHash:txHash??null});
} finally {
  try{await L.db.end();}catch(error:any){R.bad('P6-ALLOWANCE-RESOLUTION','read-only verification pool closed',{error:String(error?.message||error).slice(0,300)});}
  R.save({run:'P6-ALLOWANCE-RESOLUTION',txHash:txHash??null});
  const fail=R.steps.filter((x:any)=>x.result==='FAIL').length;
  console.log(JSON.stringify({pass:R.steps.filter((x:any)=>x.result==='PASS').length,fail,txHash:txHash??null}));
  process.exitCode=fail?1:0;
}
