import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {headerHash,lineageHistoryDigest,validateHighWater,validateStateSnapshot,validateReloadPoints,validateLineageCheckpoints,validateAppReview,validateSourceDelta,validateSourcePins,sha256File} from '../ops/alder-watchdog-guard.mjs';

const policy=JSON.parse(fs.readFileSync('ops/alder-watchdog-policy.json','utf8'));
const state=JSON.parse(fs.readFileSync('chain-state/anvil-8547-state.json','utf8'));
const points=fs.readFileSync('chain-state/reload-points.jsonl','utf8');
const anchorHeader=state.blocks.find(b=>BigInt(b.header.number)===3442n).header;

test('offline state retains pinned genesis hash, head checkpoint, and block-3442 anchor',()=>{
  const result=validateStateSnapshot(state,policy);
  assert.equal(headerHash(state.blocks.find(b=>BigInt(b.header.number)===0n&&b.header.timestamp===policy.lineage.genesisTimestamp).header),policy.lineage.genesis);
  assert.equal(headerHash(anchorHeader),policy.lineage.anchorHash);
  assert.equal(result.pass,true,JSON.stringify(result));
  assert.equal(result.bestHead,'3442');
});

test('offline state below the trusted checkpoint fails closed',()=>{
  const lower={...state,best_block_number:3441};
  const result=validateStateSnapshot(lower,policy);
  assert.equal(result.pass,false);
  assert.ok(result.failures.includes('STATE_HEAD_BELOW_TRUSTED_CHECKPOINT'));
});

test('same-height state with a different canonical anchor fails closed',()=>{
  const wrong={...policy,lineage:{...policy.lineage,anchorHash:'0x'+'11'.repeat(32)}};
  const result=validateStateSnapshot(state,wrong);
  assert.equal(result.pass,false);
  assert.ok(result.failures.includes('STATE_ANCHOR_HASH_MISMATCH'));
});

test('pinned timestamp genesis must also hash to the approved genesis',()=>{
  const changed=structuredClone(state);const genesis=changed.blocks.find(b=>BigInt(b.header.number)===0n&&b.header.timestamp===policy.lineage.genesisTimestamp);genesis.header.gasLimit='0x1c9c381';
  const result=validateStateSnapshot(changed,policy);
  assert.equal(result.pass,false);
  assert.ok(result.failures.includes('STATE_GENESIS_HASH_MISMATCH'));
});

test('legacy reload prefix is immutable and the full history must be monotonic',()=>{
  const valid=validateReloadPoints(points,policy);
  assert.equal(valid.pass,true,JSON.stringify(valid));
  assert.equal(valid.trusted.height,'3442');
  const lines=points.trimEnd().split(/\r?\n/);const last=JSON.parse(lines.at(-1));last.genesis='0x'+'22'.repeat(32);lines[lines.length-1]=JSON.stringify(last);
  const wrongGenesis=validateReloadPoints(lines.join('\n')+'\n',policy);
  assert.equal(wrongGenesis.pass,false);
  assert.ok(wrongGenesis.failures.includes('RELOAD_POINT_GENESIS_MISMATCH'));
  const nonmonotonic=points.trimEnd().split(/\r?\n/).map(JSON.parse);nonmonotonic[6].height='1920';
  const wrongOrder=validateReloadPoints(nonmonotonic.map(JSON.stringify).join('\n')+'\n',policy);
  assert.equal(wrongOrder.pass,false);
  assert.ok(wrongOrder.failures.includes('RELOAD_POINT_HEIGHT_NONMONOTONIC'));
  const deleted=validateReloadPoints(points.trimEnd().split(/\r?\n/).slice(0,-1).join('\n')+'\n',policy);
  assert.equal(deleted.pass,false);
  assert.ok(deleted.failures.includes('RELOAD_POINT_LEGACY_PREFIX_MISSING'));
});

test('new reload rows require anchor and Safe nonce fields',()=>{
  const base=points.trimEnd();const appended={genesis:policy.lineage.genesis,height:'3443',source:'test'};
  const result=validateReloadPoints(base+'\n'+JSON.stringify(appended)+'\n',policy);
  assert.equal(result.pass,false);
  assert.ok(result.failures.includes('RELOAD_POINT_TRUST_FIELDS_MISSING'));
});

test('checkpoint ledger detects missing or changed appended reload history',()=>{
  const base=policy.lineage.trustedCheckpoint;
  const row={genesis:policy.lineage.genesis,height:'3443',anchorHeight:policy.lineage.anchorHeight,anchorHash:policy.lineage.anchorHash,safeNonce:String(base.safeNonce)};
  const appended=points.trimEnd()+'\n'+JSON.stringify(row)+'\n';
  assert.equal(validateLineageCheckpoints(null,points,policy).pass,true);
  assert.equal(validateLineageCheckpoints(null,appended,policy).pass,false);
  assert.equal(validateLineageCheckpoints(JSON.stringify(row)+'\n',appended,policy).pass,true);
  const wrong={...row,height:'3442'};
  assert.equal(validateLineageCheckpoints(JSON.stringify(wrong)+'\n',appended,policy).pass,false);
});

test('private high-water pointer detects co-truncation of both chain ledgers',()=>{
  const instanceId='a'.repeat(32);const owner={schema:'alder.watchdog.lineage-owner/v1',instanceId,bootstrapState:'seeded'};
  const anchor=policy.lineage.anchorHash;const baselineDigest=lineageHistoryDigest(points,null);
  const baseline={schema:'alder.watchdog.lineage-high-water/v1',instanceId,source:'watchdog-bootstrap',genesis:policy.lineage.genesis,anchorHeight:policy.lineage.anchorHeight,anchorHash:anchor,head:'3442',headHash:anchor,safeNonce:'248',historyDigest:baselineDigest};
  const baselineLine=JSON.stringify(baseline)+'\n';const baselineOwner={...owner,latestReceiptSha256:createHash(baselineLine),latestHead:'3442',latestSafeNonce:'248',latestHistoryDigest:baselineDigest};
  assert.equal(validateHighWater(baselineLine,JSON.stringify(baselineOwner),state,points,null,policy).pass,true);
  const next={...baseline,source:'validated-chain-start',head:'3443',headHash:'0x'+'33'.repeat(32),safeNonce:'249'};
  const nextPoint={genesis:policy.lineage.genesis,height:'3443',anchorHeight:policy.lineage.anchorHeight,anchorHash:anchor,safeNonce:'249'};
  const extendedReload=points.trimEnd()+'\n'+JSON.stringify(nextPoint)+'\n';const extendedCheckpoint=JSON.stringify(nextPoint)+'\n';
  next.historyDigest=lineageHistoryDigest(extendedReload,extendedCheckpoint);const nextLine=JSON.stringify(next)+'\n';
  const extendedOwner={...owner,latestReceiptSha256:createHash(nextLine),latestHead:'3443',latestSafeNonce:'249',latestHistoryDigest:next.historyDigest};
  const rolledBack=validateHighWater(baselineLine+'\n'+nextLine,JSON.stringify(extendedOwner),state,points,null,policy);
  assert.equal(rolledBack.pass,false);
  assert.ok(rolledBack.failures.includes('HIGH_WATER_HISTORY_DIGEST_MISMATCH'));
  assert.ok(rolledBack.failures.includes('HIGH_WATER_HEAD_NOT_LATEST_RELOAD'));
});

test('lineage validation distinguishes absent private anchors and never invents a baseline',()=>{
  const missing=validateHighWater(null,null,state,points,null,policy);
  assert.equal(missing.pass,false);
  assert.ok(missing.failures.includes('LINEAGE_OWNER_MISSING'));
  const prepared=JSON.stringify({schema:'alder.watchdog.lineage-owner/v1',instanceId:'b'.repeat(32),bootstrapState:'prepared'});
  const noReceipt=validateHighWater('',prepared,state,points,null,policy);
  assert.equal(noReceipt.pass,false);
  assert.ok(noReceipt.failures.includes('HIGH_WATER_MISSING'));
});

test('all 43 reviewed source bytes are compared and current drift blocks the guard',()=>{
  const review=JSON.parse(fs.readFileSync('docs/independent-review-current-finish-20261102.json','utf8')).current_source_sha256;
  const supply=JSON.parse(fs.readFileSync('evidence/round6-perf/supply-current-20261102/report.json','utf8')).review_source_pins_verified;
  assert.deepEqual(Object.keys(policy.approvedAppReview.reviewedSourcePins).sort(),Object.keys(review).sort());
  assert.deepEqual(Object.keys(policy.approvedAppReview.reviewedSourcePins).sort(),Object.keys(supply).sort());
  for(const [name,digest] of Object.entries(review)){assert.equal(policy.approvedAppReview.reviewedSourcePins[name],digest);assert.equal(supply[name],digest);assert.equal(policy.sourcePins[name],digest);}
  const result=validateAppReview(process.cwd(),policy);
  assert.equal(result.reviewCount,43);
  assert.equal(result.supplyCount,43);
  assert.equal(result.approvedCount,43);
  assert.equal(result.pass,true,JSON.stringify(result));
  assert.deepEqual(result.mismatches,[]);
  assert.ok(result.approvedDeltas.some(d=>d.path==='services/treasury-indexer.ts'&&d.currentSha256===policy.pendingSourceDeltas['services/treasury-indexer.ts'].candidateSha256));
  const incomplete={...policy,sourcePins:{...policy.sourcePins}};delete incomplete.sourcePins['services/lease.ts'];
  const missing=validateAppReview(process.cwd(),incomplete);
  assert.ok(missing.mismatches.some(m=>m.path==='services/lease.ts'&&m.reason==='POLICY_REVIEW_PIN_MISMATCH'));
});

test('pending source delta is exact and an approved receipt binds the complete candidate bytes',()=>{
  const name='services/treasury-indexer.ts',base='1'.repeat(64),candidate='2'.repeat(64);
  const pending={pendingSourceDeltas:{[name]:{baseSha256:base,candidateSha256:candidate,deltaPath:'docs/indexer-source-delta-pending-20261102.json'}}};
  assert.equal(validateSourceDelta(process.cwd(),pending,name,base,candidate).reason,'SOURCE_DELTA_REVIEW_PENDING');
  assert.equal(validateSourceDelta(process.cwd(),pending,name,base,'3'.repeat(64)).reason,'SOURCE_DELTA_APPROVAL_MISSING');
  const temp=fs.mkdtempSync(path.join(process.cwd(),'.local','source-delta-test-'));
  const receiptPath=path.relative(process.cwd(),path.join(temp,'approval.json'));
  const absolute=path.resolve(process.cwd(),receiptPath);
  const receipt={schema:'alder.independent-source-delta-approval/v1',decision:'APPROVED',path:name,baseSha256:base,newSha256:candidate,reviewedSourceSha256:candidate};
  fs.writeFileSync(absolute,JSON.stringify(receipt));
  const receiptSha256=crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  const approved={approvedSourceDeltas:{[name]:{baseSha256:base,newSha256:candidate,receiptPath,receiptSha256}}};
  assert.equal(validateSourceDelta(process.cwd(),approved,name,base,candidate).pass,true);
  fs.rmSync(temp,{recursive:true,force:true});
});

test('bound independent receipt clears the exact indexer candidate in both whole source guards',()=>{
  const receiptPath='docs/independent-review-watchdog-indexer-final-20261102.json';
  const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  const approval=policy.approvedSourceDeltas?.[receipt.path];
  assert.ok(approval,'policy must bind the reviewed receipt');
  assert.equal(approval.receiptPath,receiptPath);
  assert.equal(approval.receiptSha256,crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex'));
  assert.equal(receipt.decision,'APPROVED');
  assert.equal(receipt.newSha256,sha256File(path.resolve(receipt.path)));
  const app=validateAppReview(process.cwd(),policy);
  assert.equal(app.pass,true,JSON.stringify(app));
  assert.ok(app.approvedDeltas.some(d=>d.path===receipt.path&&d.receiptSha256===approval.receiptSha256));
  const candidatePolicy=structuredClone(policy);
  candidatePolicy.sourcePins['ops/alder-watchdog-guard.mjs']=sha256File('ops/alder-watchdog-guard.mjs');
  candidatePolicy.sourcePins['ops/alder-watchdog.ps1']=sha256File('ops/alder-watchdog.ps1');
  const all=validateSourcePins(process.cwd(),candidatePolicy);
  assert.equal(all.pass,true,JSON.stringify(all));
  assert.deepEqual(all.mismatches,[]);
  assert.ok(all.approvedDeltas.some(d=>d.path===receipt.path&&d.receiptSha256===approval.receiptSha256));
});

test('native PowerShell bootstrap and recovery keep task mutation behind source checks and owner commit',()=>{
  const ps=fs.readFileSync('ops/alder-watchdog.ps1','utf8');
  const launcher=fs.readFileSync('ops/round4-services.ps1','utf8');
  const scriptHash=ps.indexOf("Get-Hash $scriptPath");
  const policyLoad=ps.indexOf("Get-Content -Raw -LiteralPath $policyPath");
  const pinLoop=ps.indexOf('foreach($entry in @(');
  const addType=ps.indexOf('Add-Type -Path $processIdentityPath');
  assert.ok(scriptHash>=0&&scriptHash<policyLoad&&policyLoad<pinLoop&&pinLoop<addType);
  assert.ok(launcher.indexOf('ALDER_SCRIPT_HASH_MISMATCH_BEFORE_POLICY_LOAD')<launcher.indexOf('Get-Content -Raw -LiteralPath $policyPath'));
  const launcherPin=launcher.indexOf('PIN_MISMATCH_BEFORE_HELPER');
  assert.ok(launcherPin>=0&&launcherPin<launcher.indexOf('Add-Type -Path $identitySource'));
  const register=ps.indexOf('Register-ScheduledTask');
  const disabled=ps.lastIndexOf('$settings.Enabled=$false',register);
  const ownerCommit=ps.indexOf("Save-TaskOwnerRecord $owner $ownerFile",register);
  const enable=ps.indexOf('Enable-ScheduledTask',ownerCommit);
  assert.ok(disabled>=0&&disabled<register&&register<ownerCommit&&ownerCommit<enable);
  assert.match(ps,/recover-install/);
  const recovery=ps.indexOf("  'recover-install' {");
  assert.ok(recovery>enable&&ps.indexOf('Disable-ScheduledTask',recovery)>recovery);
  const floor=ps.indexOf('function Get-VerifiedBootstrapFloor');
  const complete=ps.indexOf('function Complete-PreparedHighWater');
  const postBootstrapRecheck=ps.indexOf("$verify=Invoke-Guard 'lineage'",complete);
  const returnAnchor=ps.indexOf('return [string]$owner.instanceId',complete);
  assert.ok(floor>=0&&complete>floor&&postBootstrapRecheck>complete&&returnAnchor>postBootstrapRecheck);
  assert.ok(ps.includes('WATCHDOG_PREPARED_HIGH_WATER_RECEIPT_MISMATCH'));
  const identityStart=ps.indexOf('function Test-TaskOwnerIdentity');
  const identityEnd=ps.indexOf('function Find-TaskOwnerRecord',identityStart);
  const identity=ps.slice(identityStart,identityEnd);
  assert.ok((identity.match(/Test-SamePrincipalIdentity/g)||[]).length>=2);
  assert.ok(identity.includes('DisallowStartIfOnBatteries')&&identity.includes('StopIfGoingOnBatteries'));
  assert.ok(!identity.includes('$settings.AllowStartIfOnBatteries')&&!identity.includes('$settings.DontStopIfGoingOnBatteries'));
});

test('legacy operator-stop absence has an explicit, fail-closed migration record',()=>{
  assert.equal(policy.legacyOperatorStopMigration.schema,'alder.operator-stop-migration/v1');
  assert.equal(policy.legacyOperatorStopMigration.noLegacyMarkerFound,true);
  assert.deepEqual(policy.legacyOperatorStopMigration.legacyMarkerPaths,[]);
});

function createHash(text){return crypto.createHash('sha256').update(text,'utf8').digest('hex');}
