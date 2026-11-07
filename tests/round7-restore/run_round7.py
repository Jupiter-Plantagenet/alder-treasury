"""Run fresh isolated restore drills and record the precise acceptance boundary."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
RUN = os.environ.get('ALDER_ROUND7_RUN', '20261103-r7b')
WAL_RUN_ID = ('r7' + re.sub(r'[^a-z0-9-]', '', RUN.lower()))[:24]
PRIVATE = ROOT / '.local' / ('round7-restore-' + RUN)
WAL_PRIVATE = ROOT / '.local' / 'backups' / 'wal-archive' / ('round7-' + RUN)
BACKUP = ROOT / '.local' / 'backups' / 'round6-consistent-20261102T125627Z-root-proof'


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def run(argv: list[str], timeout: int, env: dict | None = None) -> dict:
    start = datetime.now(timezone.utc).isoformat()
    p = subprocess.run(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=timeout, check=False)
    # Tool output can include private paths or credentials; retain only category and exit.
    (PRIVATE / ('command-' + str(len(list(PRIVATE.glob('command-*.json')))) + '.private.json')).write_text(
        json.dumps({'argv': argv, 'exitCode': p.returncode,
                    'stdoutSha256': hashlib.sha256(p.stdout).hexdigest(),
                    'stderrSha256': hashlib.sha256(p.stderr).hexdigest()}, indent=2))
    result = {'startedAtUtc': start, 'exitCode': p.returncode,
            'stdoutSha256': hashlib.sha256(p.stdout).hexdigest(),
            'stderrSha256': hashlib.sha256(p.stderr).hexdigest()}
    try:
        result['structuredOutput'] = json.loads(p.stdout.decode().strip())
    except (json.JSONDecodeError, UnicodeDecodeError):
        result['outputParse'] = 'not_json'
    return result


def main() -> int:
    PRIVATE.mkdir(parents=True, exist_ok=False)
    WAL_PRIVATE.mkdir(parents=True, exist_ok=False)
    manifest = BACKUP / 'manifest.json'
    backup_hash = sha(manifest)
    report = {'schema': 'alder.restore-round7/v1', 'startedAtUtc': datetime.now(timezone.utc).isoformat(),
              'retainedDatabaseOrChainMutation': False, 'existingBackupDeleted': False,
              'backupManifestSha256': backup_hash, 'checks': {}}

    wal_cmd = [sys.executable, 'ops/wal-archive.py', 'scratch-rehearsal', '--run-id', WAL_RUN_ID]
    wal = run(wal_cmd, 900)
    report['checks']['currentSourceEncryptedBaseWalPitr'] = wal
    proof_path = ROOT / '.local' / 'backups' / 'wal-archive' / ('scratch-' + WAL_RUN_ID) / 'proof.json'
    # The helper's validated run-id determines its own archive path; preserve it as evidence.
    if proof_path.exists():
        proof = json.loads(proof_path.read_text())
        report['checks']['currentSourceEncryptedBaseWalPitr'].update({
            'proofPath': str(proof_path), 'proofSha256': sha(proof_path),
            'markerRecovered': proof.get('markerRecovered'),
            'segmentCount': len(proof.get('segments', [])),
            'cleanup': proof.get('cleanup')})
        (WAL_PRIVATE / 'proof.json').write_bytes(proof_path.read_bytes())
        report['checks']['currentSourceEncryptedBaseWalPitr']['scopedEvidencePath'] = str(WAL_PRIVATE / 'proof.json')

    cadence = run([sys.executable, 'tests/round7-restore/continuous_wal.py'], 900)
    cadence_path = WAL_PRIVATE / 'continuous' / 'continuous-proof.json'
    report['checks']['twoCycleContinuousWalRpo'] = cadence
    if cadence_path.exists():
        cp = json.loads(cadence_path.read_text())
        report['checks']['twoCycleContinuousWalRpo'].update({
            'proofPath': str(cadence_path), 'proofSha256': sha(cadence_path),
            'rpoPass': cp.get('rpoPass'), 'cycleDelays': [x.get('commitToAuthenticatedArchiveSeconds') for x in cp.get('cycles', [])],
            'bothMarkersRecovered': cp.get('bothCommittedMarkersRecovered'),
            'cleanup': cp.get('cleanup'), 'errorCategory': cp.get('errorCategory')})

    # The consistent helper insists its output is under .local. This authorized runner
    # uses its exact existing immutable backup and records only hashes of subprocess output.
    bundled_python = ROOT / '.local' / 'codex-a1' / 'authorized-wrapper-env' / 'Scripts' / 'python.exe'
    restore_python = str(bundled_python if bundled_python.is_file() else Path(sys.executable))
    consistent = [restore_python, 'ops/round6_consistent_restore.py',
                  '--backup-dir', str(BACKUP), '--expected-manifest-sha256', backup_hash,
                  '--baseline', str(BACKUP / 'baseline.json'),
                  '--evidence', str(PRIVATE / 'consistent-report.json'),
                  '--raw', str(PRIVATE / 'consistent-raw')]
    restore_env = os.environ.copy()
    restore_env['ALDER_OPERATOR_MEMORY_OVERRIDE'] = '20261102-user-directed'
    report['checks']['consistentIsolatedDatabaseRestore'] = run(consistent, 1800, restore_env)
    consistent_path = PRIVATE / 'consistent-report.json'
    if consistent_path.exists():
        c = json.loads(consistent_path.read_text())
        report['checks']['consistentIsolatedDatabaseRestore'].update({
            'evidencePath': str(consistent_path), 'evidenceSha256': sha(consistent_path),
            'restorePass': c.get('restorePass'), 'tableCount': c.get('comparison', {}).get('tableCountRestored'),
            'artifactCountVerified': c.get('artifactCountVerified'),
            'privateArtifactRestore': c.get('privateArtifactRestore'),
            'rtoSeconds': c.get('rtoSeconds'), 'rtoScope': c.get('rtoScope'),
            'broadcastOutcome': c.get('broadcastOutcome'),
            'hostGates': c.get('restoreResourceSnapshot', {}).get('strictHostGatesPass'),
            'recordedMemoryOverrideApplied': c.get('restoreResourceSnapshot', {}).get('operatorMemoryOverridePresent')})

    report['remainingAssertions'] = {
        'continuousRpoAtMost60Seconds': ('pass: two-cycle scratch measurements and marker recovery are in ' + str(cadence_path)) if cadence_path.exists() and json.loads(cadence_path.read_text()).get('rpoPass') else ('not established: see ' + str(cadence_path) + ' for measured cycle outcomes; sustained production uptime remains untested'),
        'applicationRestore': 'not established: isolated restore did not start API, worker, signer, or UI against restored state and prove health/read-only hold',
        'chainDerivedRebuild': 'not established: deployment addresses and pinned block hashes were not replayed into a fresh restored application index; canonical retained chain remains untouched',
        'releaseRtoAtMost30Minutes': 'not established: DB-only RTO excludes app and chain-derived recovery'
    }
    report['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
    out = PRIVATE / 'report.json'
    out.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(out), 'reportSha256': sha(out),
                      'walExit': wal['exitCode'],
                      'cadenceExit': cadence['exitCode'],
                      'consistentExit': report['checks']['consistentIsolatedDatabaseRestore']['exitCode'],
                      'rpoContinuous': bool(cadence_path.exists() and json.loads(cadence_path.read_text()).get('rpoPass')),
                      'appChainRestore': False}, indent=2))
    return 0 if wal['exitCode'] == 0 and cadence['exitCode'] == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
