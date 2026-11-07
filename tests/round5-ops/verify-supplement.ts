// O5 TR-T-VERIFY supplement (re-run of the 3 cases whose FIRST attempt failed for test-oracle reasons; the failed attempt
// is preserved in evidence/round5-ops/verify/report.json and verify-campaign.log, not relabelled):
//  S1 wrong chain id at signature submission (precondition fixed: the op is proposed immediately before the lie).
//  S3 INCONSISTENT single-block historical hash lie (child hash unchanged) - records actual behaviour (finding probe).
//  S2 CONSISTENT alternative history from block K (provider disagrees with recorded canonical chain) => pause, sticky, rebuild.
import fs from 'node:fs';import {pathToFileURL} from 'node:url';import * as L from './o5-lib.ts';
process.env.ALDER_RPC_URL='http://127.0.0.1:18547';
const OUT='evidence/round5-ops/verify';const R=new L.Report(`${OUT}/report-supplement.json`);const s=await L.sessions();
const CK=`http://127.0.0.1:18547:${L.d.genesis}`;const checkpoint=async()=>(await L.q('SELECT number::text n,hash,paused FROM treasury_checkpoints WHERE chain_key=$1',[CK]))[0];
const notPaid=async(opId:string)=>{const st=await L.opState(opId);const set=await L.settlementsFor(opId);const rep=await L.lastReport(opId);if(st==='verified'||set.some((x:any)=>x.state==='verified'))throw Error('PAID_UNDER_ATTACK '+JSON.stringify({st,set}));return {opState:st,settlements:set.length,reportState:rep?.state,reason:rep?.reason};};
const verifiedCount=async()=>(await L.q("SELECT count(*)::int n FROM treasury_settlements WHERE workspace_id=$1 AND state='verified'",[L.WS]))[0].n;
await L.proxy([]);await L.resyncOk(s);
// ---------- S1 ----------
{await settleOutstandingAtCurrentNonce();const ps=await L.readyPayables(s,'O5-S1',['2100000']);const a=await s.O.post('/allowances',{ids:ps.map((p:any)=>p.id)});
 await L.proxy([{kind:'chainid',value:'0x1'}]);const sg=await L.sign(s,a.body.id,0);const pr=await L.prepare(s,a.body.id);await L.proxy([]);
 await R.check('TR-T-VERIFY','S1 wrong chain id (eth_chainId=0x1) at owner signature submission => 409 CHAIN_INSTANCE_MISMATCH, no signature stored; prepare also refused',async()=>{const n=(await L.q('SELECT count(*)::int n FROM treasury_signatures WHERE workspace_id=$1 AND operation_id=$2',[L.WS,a.body.id]))[0].n;if(sg.status!==409||sg.body?.error?.code!=='CHAIN_INSTANCE_MISMATCH'||n!==0||pr.status!==409)throw Error(JSON.stringify({sg:sg.body,pr:pr.body,n}));return {sign:[sg.status,sg.body.error.code],prepare:[pr.status,pr.body.error.code],storedSignatures:n,opStateBefore:'frozen'};});
 const ok=await L.sign(s,a.body.id,0);R.note('TR-T-VERIFY','S1 control: same signature accepted with honest RPC',{status:ok.status});}
// Resolve any outstanding app allowance op at the CURRENT Safe nonce by executing its exact SafeTx off-app with two owner
// signatures (what owners can always do outside the app); the indexer then reconciles it from the chain.
async function settleOutstandingAtCurrentNonce(){const n=await L.safeNonce();const ops=await L.q("SELECT id,kind,state,manifest FROM treasury_operations WHERE workspace_id=$1 AND manifest->>'genesis'=$2 AND manifest->'message'->>'nonce'=$3 AND state<>'verified'",[L.WS,L.d.genesis,String(n)]);
 for(const o of ops){const m=o.manifest.message;const sig=await L.sigsFor({...m,value:BigInt(m.value),safeTxGas:BigInt(m.safeTxGas),baseGas:BigInt(m.baseGas),gasPrice:BigInt(m.gasPrice),nonce:BigInt(m.nonce)},[0,1]);const h=await L.walletFor(L.owners[0]).sendTransaction({to:L.d.safe,data:L.execData(m,sig),gas:3000000n});const r=await L.chain.waitForTransactionReceipt({hash:h});await L.mine(12);await L.resyncOk(s);R.note('SETUP','outstanding app operation at the current Safe nonce executed off-app with its exact SafeTx; indexer reconciled it',{op:o.id,kind:o.kind,priorState:o.state,tx:h,status:r.status,nowState:await L.opState(o.id)});return;}}
// ---------- S0 (defect probe): a resync while signatures are being collected ----------
{await settleOutstandingAtCurrentNonce();const ps=await L.readyPayables(s,'O5-S0',['2150000']);const f=await L.freeze(s,ps.map((p:any)=>p.id));const s1=await L.sign(s,f.operationId,0);const before=await L.opState(f.operationId);
 await L.resyncOk(s);const mid=await L.opState(f.operationId);const s2=await L.sign(s,f.operationId,1);
 const rec={op:f.operationId,firstSignature:s1.status,stateAfterFirstSignature:before,stateAfterUnrelatedResync:mid,secondSignature:[s2.status,s2.body?.error?.code]};
 if(s2.status===200)R.ok('TR-T-VERIFY','S0 a resync while owner signatures are being collected does not disturb an unbroadcast operation',rec);
 else R.note('TR-T-VERIFY','S0 DEFECT (reported, not fixed here: services/treasury-indexer.ts is owned by the concurrent build agent): any resync marks every not-yet-broadcast frozen/signed/prepared operation "uncertain" (no matching Safe success), after which signing/prepare return 409 OPERATION_HELD. Fail-safe (never paid) but blocks the normal flow; a same-nonce duplicate proposal then returns 500 (operation_exact_intent unique violation not mapped to 409).',rec);
 await settleOutstandingAtCurrentNonce();}
// ---------- S3 (probe) ----------
{await settleOutstandingAtCurrentNonce();await L.mine(20);await L.resyncOk(s);const cp=await checkpoint();const K=BigInt(cp.n)-15n;const before=await verifiedCount();
 const x=await L.preparedPayout(s,'O5-S3',['2200000']);const h=await L.send(s,x.prepared);await L.mine(12);
 await L.proxy([{kind:'block-hash',number:String(K)}]);const rs=await L.resync(s);const after=await checkpoint();
 const stored=(await L.q('SELECT hash,canonical FROM treasury_headers WHERE chain_key=$1 AND number=$2 ORDER BY canonical DESC',[CK,String(K)]));
 const st=await L.opState(x.opId);await L.proxy([]);const rs2=await L.resync(s);const stored2=(await L.q('SELECT hash,canonical FROM treasury_headers WHERE chain_key=$1 AND number=$2 ORDER BY canonical DESC',[CK,String(K)]));
 const rec={K:String(K),checkpointBefore:cp,resyncUnderLie:rs.body,checkpointAfter:after,storedHeaderKUnderLie:stored,opStateUnderLie:st,tx:h,resyncHonest:rs2.body,storedHeaderKAfterHonest:stored2,verifiedSettlementsBefore:before,verifiedSettlementsAfter:await verifiedCount()};
 if(rs.body?.paused===true)R.ok('TR-T-VERIFY','S3 inconsistent historical header lie (block K hash changed, child hash unchanged) => paused',rec);
 else R.note('TR-T-VERIFY','S3 FINDING: inconsistent historical header lie (provider changes hash of recorded block K=checkpoint-15 while the checkpoint hash is unchanged) is NOT treated as disagreement: no pause, the lie is written as canonical header K; the operation whose own evidence is honest is processed normally',rec);}
// ---------- S2 ----------
{await L.mine(20);await L.resyncOk(s);const cp=await checkpoint();const K=BigInt(cp.n)-15n;const safeLogs=await L.chain.getLogs({address:L.d.safe,fromBlock:K,toBlock:BigInt(cp.n)});
 const x=await L.preparedPayout(s,'O5-S2',['2300000']);const h=await L.send(s,x.prepared);await L.mine(12);
 const vBefore=await verifiedCount();await L.proxy([{kind:'rewrite-from',from:String(K)}]);const rs=await L.resync(s);
 await R.check('TR-T-VERIFY','S2 provider disagreement: RPC serves a CONSISTENT alternative history from block K (checkpoint-15; hashes, parent links, logs and receipts all rewritten) => deep-reorg PAUSE and the real executed payout is NOT paid',async()=>{if(safeLogs.length)throw Error('Safe logs inside rewritten range');if(rs.status!==200||rs.body.paused!==true)throw Error('not paused '+JSON.stringify(rs.body));return {K:String(K),checkpointBefore:cp,resync:rs.body,tx:h,verifiedSettlementsBefore:vBefore,verifiedSettlementsAfter:await verifiedCount(),...await notPaid(x.opId)};});
 await L.proxy([]);const rs2=await L.resync(s);
 await R.check('TR-T-VERIFY','S2 pause is sticky after the provider is honest again (no automatic resume), payout still not paid',async()=>{if(rs2.body?.paused!==true)throw Error('auto-resumed '+JSON.stringify(rs2.body));return {resync:rs2.body,...await notPaid(x.opId)};});
 const {reconcileApplication}=await import(pathToFileURL(process.env.O5_SRC_ABS+'/services/treasury-indexer.ts').href);const pg=(await import('pg')).default;const ip=new pg.Pool({connectionString:'postgresql://alder_indexer@127.0.0.1:15543/alder',max:1});
 const rb=await reconcileApplication(ip,{rebuild:true});await ip.end();
 await R.check('TR-T-VERIFY','S2 operator rebuild (not exposed over HTTP) against the honest provider clears the pause and the payout is verified; no previously verified settlement lost',async()=>{const st=await L.opState(x.opId);if(st!=='verified')throw Error('not verified '+st);return {rebuild:rb,opState:st,verifiedSettlements:await verifiedCount(),before:vBefore};});}
R.save({run:'O5-VERIFY-SUPPLEMENT',stats:await L.proxyStats()});console.log(JSON.stringify({pass:R.steps.filter(x=>x.result==='PASS').length,fail:R.steps.filter(x=>x.result==='FAIL').length}));await L.db.end();process.exit(0);
