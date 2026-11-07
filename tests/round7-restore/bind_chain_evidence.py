"""Join the prior isolated chain replay to the new manifest-pinned coherent snapshot."""
import hashlib, json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
NEW=ROOT/'.local'/'backups'/'codex-round6-20261103T083915Z'
DB_OLD=ROOT/'.local'/'backups'/'round6-consistent-20261102T125627Z-root-proof'
CHAIN_PROOF=ROOT/'.local'/'round7-restore-20261103-chain2'/'chain-proof.json'
OUT=ROOT/'.local'/'round7-restore-20261103-chain2'/'coherent-snapshot-binding.json'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((NEW/'manifest.json').read_text()); dbm=json.loads((DB_OLD/'manifest.json').read_text())
p=json.loads(CHAIN_PROOF.read_text()); snap=m['chain_snapshot']; binding=dbm['chainBinding']
reload=NEW/'private'/'chain-state'/'reload-points.jsonl'
rows=[json.loads(x) for x in reload.read_text().splitlines() if x.strip()]
anchor=next((x for x in reversed(rows) if x.get('anchorHeight')==snap['head_number']),None)
state=NEW/'anvil-state.json'
results={
 'newBackupChainStateDigestMatchesManifest':sha(state)==m['files']['anvil-state.json']['sha256']==m['chain_files']['private\\chain-state\\anvil-8547-state.json']['sha256'],
 'isolatedRestoreUsedSameBytes':sha(state)==p['stateSha256'],
 'isolatedRestoreLineagePass':p['restorePass'] and p['chainIdMatches'] and p['genesisMatches'] and p['pinnedBlockMatches'],
 'dbSnapshotAndChainSnapshotSameChainId':binding['chainId']==snap['chain_id'],
 'dbSnapshotAndChainSnapshotSameGenesis':binding['genesisHash'].lower()==snap['genesis_hash'].lower(),
 'dbSnapshotAndChainSnapshotSameHead':binding['headNumber']==snap['head_number'],
 'dbSnapshotAndChainSnapshotSameHeadHash':binding['headHash'].lower()==(anchor or {}).get('anchorHash','').lower(),
 'capturedAnchorMatchesChainSnapshot':bool(anchor and anchor.get('genesis')==snap['genesis_hash'] and anchor.get('height')==str(snap['head_number'])),
 'allRequired':True}
results['allRequired']=all(v for k,v in results.items() if k!='allRequired')
report={'schema':'alder.round7-coherent-backup-binding/v1','newBackupManifestSha256':sha(NEW/'manifest.json'),
 'newChainStateSha256':sha(state),'oldConsistentDbManifestSha256':sha(DB_OLD/'manifest.json'),
 'isolatedChainRestoreProofSha256':sha(CHAIN_PROOF),'chainReloadReceiptSha256':sha(reload),
 'snapshot':{'chainId':snap['chain_id'],'genesisHash':snap['genesis_hash'],'headNumber':snap['head_number'],
             'headHash':(anchor or {}).get('anchorHash')},'assertions':results,
 'coherentSnapshotBindingPass':results['allRequired'],
 'scope':'read-only digest and lineage reconciliation; no database or chain service started'}
OUT.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'evidence':str(OUT),'evidenceSha256':sha(OUT),'pass':report['coherentSnapshotBindingPass'],
                  'assertions':results}))
if not report['coherentSnapshotBindingPass']: raise SystemExit(2)
