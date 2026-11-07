"""Restore an exact snapshot-consistent Alder backup in an isolated scratch PG.

The helper never connects to the retained source database or chain. It uses a
unique scratch database, the source initial role, a pinned image, no network/ports/volumes, and compares
the restored database only to the backup-time baseline bound by manifest hash.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

import psutil
import round6_restore_baseline as baseline

ROOT = Path(__file__).resolve().parents[1]
BACKUP_ROOT = ROOT / '.local' / 'backups'
IMAGE = 'sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
EXPECTED_CHAIN_ID = '0x7a69'
EXPECTED_GENESIS = '0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec'
EXPECTED_HEAD = 3442


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def under(path: Path, parent: Path) -> Path:
    if path.is_symlink():
        raise RuntimeError('PRIVATE_PATH_SYMLINK_REFUSED')
    resolved = path.resolve(strict=False)
    if resolved.drive.upper() != 'C:' or not resolved.is_relative_to(parent.resolve()):
        raise RuntimeError('PRIVATE_PATH_OUTSIDE_C_ROOT')
    if resolved.exists() or resolved.is_symlink():
        raise RuntimeError('OUTPUT_PATH_ALREADY_EXISTS_OR_IS_LINK')
    return resolved


def run(args: list[str], *, timeout: int = 60, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, input=input_bytes, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, check=False)


def resource_snapshot() -> dict:
    free_c = shutil.disk_usage('C:/').free
    available_ram = psutil.virtual_memory().available
    commit_available = True
    try:
        counters = json.loads(subprocess.check_output(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
             'Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object CommittedBytes,CommitLimit,PercentCommittedBytesInUse | ConvertTo-Json -Compress'],
            text=True, timeout=5).strip())
        used, limit, percent = int(counters['CommittedBytes']), int(counters['CommitLimit']), float(counters['PercentCommittedBytesInUse'])
        if limit <= 0 or used < 0 or used > limit or not 0 <= percent <= 100:
            raise ValueError('invalid commit counters')
    except Exception as exc:
        commit_available = False
        used, limit, percent = None, None, None
    override = os.environ.get('ALDER_OPERATOR_MEMORY_OVERRIDE') == '20261102-user-directed'
    sample = {'atUtc': datetime.now(timezone.utc).isoformat(), 'freeCBytes': free_c,
              'availableRamBytes': available_ram, 'commitCounterAvailable': commit_available,
              'commitPercent': percent, 'commitUsedBytes': used, 'commitLimitBytes': limit,
              'ramGatePass': available_ram >= 6 * 1024**3,
              'commitGatePass': commit_available and percent < 85,
              'operatorMemoryOverridePresent': override,
              'diskGatePass': free_c >= 50_000_000_000,
              'strictHostGatesPass': free_c >= 50_000_000_000 and available_ram >= 6 * 1024**3 and commit_available and percent < 85}
    if not sample['diskGatePass']:
        raise RuntimeError('RESTORE_HOST_DISK_GATE_FAILED')
    if not sample['strictHostGatesPass'] and not override:
        raise RuntimeError('RESTORE_HOST_MEMORY_GATE_FAILED_NO_OVERRIDE')
    return sample


def docker(args: list[str], *, timeout: int = 60, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return run(['docker', *args], timeout=timeout, input_bytes=input_bytes)


def private_log(raw: Path, name: str, result: subprocess.CompletedProcess) -> None:
    (raw / name).write_bytes(result.stdout + result.stderr)


def require_success(raw: Path, name: str, result: subprocess.CompletedProcess, code: str) -> None:
    private_log(raw, name, result)
    if result.returncode:
        raise RuntimeError(code)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--backup-dir', type=Path, required=True)
    ap.add_argument('--expected-manifest-sha256', required=True)
    ap.add_argument('--baseline', type=Path, required=True)
    ap.add_argument('--evidence', type=Path, required=True)
    ap.add_argument('--raw', type=Path, required=True)
    args = ap.parse_args()
    if not re.fullmatch(r'[0-9a-f]{64}', args.expected_manifest_sha256.lower()):
        ap.error('--expected-manifest-sha256 must be a full SHA-256 digest')
    backup = args.backup_dir.resolve(strict=True)
    if args.backup_dir.is_symlink() or backup.drive.upper() != 'C:' or not backup.is_relative_to(BACKUP_ROOT.resolve()):
        raise RuntimeError('BACKUP_DIRECTORY_OUTSIDE_PRIVATE_ROOT')
    baseline_path = args.baseline.resolve(strict=True)
    if baseline_path != (backup / 'baseline.json').resolve(strict=True):
        raise RuntimeError('BASELINE_MUST_BE_EXACT_BACKUP_FILE')
    manifest_path = (backup / 'manifest.json').resolve(strict=True)
    manifest_bytes = manifest_path.read_bytes()
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    if manifest_sha != args.expected_manifest_sha256.lower():
        raise RuntimeError('BACKUP_MANIFEST_SHA256_MISMATCH')
    manifest = json.loads(manifest_bytes)
    if manifest.get('schema') != 'alder.round6-consistent-backup/v1':
        raise RuntimeError('BACKUP_MANIFEST_SCHEMA_MISMATCH')
    if manifest.get('expectedTableCount') != baseline.EXPECTED_PUBLIC_TABLES:
        raise RuntimeError('BACKUP_TABLE_COUNT_PIN_MISMATCH')
    if sha(Path(__file__)) != manifest.get('restoreHelperSha256'):
        raise RuntimeError('RESTORE_HELPER_SOURCE_PIN_MISMATCH')
    if sha(ROOT / 'ops' / 'round6_consistent_backup.py') != manifest.get('backupHelperSha256'):
        raise RuntimeError('BACKUP_HELPER_SOURCE_PIN_MISMATCH')
    if sha(Path(baseline.__file__)) != manifest.get('baselineModuleSha256'):
        raise RuntimeError('BASELINE_MODULE_SOURCE_PIN_MISMATCH')
    source_binding = manifest.get('chainBinding', {})
    if (source_binding.get('chainId') != EXPECTED_CHAIN_ID or
            source_binding.get('genesisHash', '').lower() != EXPECTED_GENESIS or
            source_binding.get('headNumber') != EXPECTED_HEAD or not source_binding.get('headHash')):
        raise RuntimeError('BACKUP_CHAIN_BINDING_INVALID')
    baseline_bytes = baseline_path.read_bytes()
    if hashlib.sha256(baseline_bytes).hexdigest() != manifest.get('baselineSha256'):
        raise RuntimeError('BACKUP_BASELINE_SHA256_MISMATCH')
    source_baseline = json.loads(baseline_bytes)
    source_identity = source_baseline.get('databaseIdentity', {})
    if (source_identity != manifest.get('sourceIdentity') or
            source_identity.get('database') != 'alder' or
            source_baseline.get('tableCount') != baseline.EXPECTED_PUBLIC_TABLES):
        raise RuntimeError('BACKUP_BASELINE_IDENTITY_MISMATCH')

    evidence = under(args.evidence, ROOT / '.local')
    raw = under(args.raw, ROOT / '.local')
    if evidence.parent != raw.parent or evidence.parent.exists():
        raise RuntimeError('EVIDENCE_AND_RAW_REQUIRE_ONE_NEW_PRIVATE_RUN_DIRECTORY')
    evidence.parent.mkdir(parents=True, exist_ok=False)
    raw.mkdir(parents=True, exist_ok=False)
    account = subprocess.check_output(['whoami'], text=True, timeout=10).strip()
    subprocess.run(['icacls', str(evidence.parent), '/inheritance:r', '/grant:r', account + ':(OI)(CI)F'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    report: dict = {'schema': 'alder.round6-consistent-restore/v1',
                    'startedAtUtc': datetime.now(timezone.utc).isoformat(),
                    'manifestSha256': manifest_sha, 'backupDirectory': str(backup),
                    'baselineSha256': manifest.get('baselineSha256'),
                    'retainedDatabaseWrite': False, 'chainOrServiceWrite': False,
    'externalNetwork': 'none', 'publishedPorts': 0, 'persistentVolumes': 0,
                    'broadcastBarrier': 'no app/API/worker/chain service invoked; scratch PostgreSQL has no network or published port',
                    'cleanup': 'pending'}
    container = 'alder-r6-restore-' + datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S') + '-' + os.urandom(3).hex()
    owner = os.urandom(16).hex()
    label_owner = 'com.portfolio.restore-owner'
    bootstrap = 'alder_rt_' + os.urandom(8).hex()
    bootstrap_role = 'postgres'
    created = False
    started = time.monotonic()
    rto_deadline = started + 1800

    def bounded_docker(command: list[str], *, timeout: int = 60,
                       input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
        remaining = rto_deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('ISOLATED_RESTORE_RTO_DEADLINE')
        return docker(command, timeout=max(1, min(timeout, int(remaining))), input_bytes=input_bytes)

    def save_evidence() -> None:
        report['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
        report.setdefault('rtoSeconds', round(time.monotonic() - started, 3))
        report['rtoLimitSeconds'] = 1800
        report.setdefault('rtoPass', report['rtoSeconds'] <= 1800)
        evidence.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')

    try:
        report['restoreResourceSnapshot'] = resource_snapshot()
        checked = 0
        private_artifact_count = 0
        private_artifact_bytes = 0
        private_artifact_root = raw / 'private-artifact-restore'
        for relative, item in manifest.get('files', {}).items():
            if time.monotonic() >= rto_deadline:
                raise RuntimeError('ISOLATED_RESTORE_RTO_DEADLINE')
            rel = Path(relative)
            if rel.is_absolute() or '..' in rel.parts:
                raise RuntimeError('BACKUP_ARTIFACT_PATH_INVALID')
            original_candidate = backup / rel
            if original_candidate.is_symlink():
                raise RuntimeError('BACKUP_ARTIFACT_PATH_INVALID')
            candidate = original_candidate.resolve(strict=True)
            if not candidate.is_relative_to(backup) or not candidate.is_file():
                raise RuntimeError('BACKUP_ARTIFACT_PATH_INVALID')
            checked += 1
            if candidate.stat().st_size != item.get('bytes') or sha(candidate) != item.get('sha256'):
                raise RuntimeError('BACKUP_ARTIFACT_DIGEST_MISMATCH')
            if rel.parts[:2] == ('private', '.local'):
                staged = private_artifact_root.joinpath(*rel.parts[2:])
                staged.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(candidate, staged)
                if staged.stat().st_size != item.get('bytes') or sha(staged) != item.get('sha256'):
                    raise RuntimeError('PRIVATE_ARTIFACT_RESTORE_DIGEST_MISMATCH')
                private_artifact_count += 1
                private_artifact_bytes += staged.stat().st_size
        if checked != len(manifest.get('files', {})):
            raise RuntimeError('BACKUP_ARTIFACT_INVENTORY_MISMATCH')
        dump = backup / 'alder.dump'
        roles = backup / 'roles.sql'
        listing_source = backup / 'pg-restore-list.txt'
        if not dump.is_file() or not roles.is_file() or not listing_source.is_file():
            raise RuntimeError('BACKUP_REQUIRED_FILE_MISSING')
        report['artifactCountVerified'] = checked
        report['privateArtifactRestore'] = {'files': private_artifact_count,
                                            'bytes': private_artifact_bytes,
                                            'allDigestsMatch': (private_artifact_count == manifest.get('privateArtifactCount') and
                                                                private_artifact_bytes == manifest.get('privateArtifactTotalBytes'))}
        if not report['privateArtifactRestore']['allDigestsMatch']:
            raise RuntimeError('PRIVATE_ARTIFACT_RESTORE_COUNT_MISMATCH')
        report['dumpSha256'] = sha(dump)
        report['rolesSha256'] = sha(roles)
        probe = bounded_docker(['inspect', container], timeout=10)
        if probe.returncode == 0:
            raise RuntimeError('SCRATCH_CONTAINER_NAME_COLLISION')
        created_result = bounded_docker(['create', '--name', container, '--network', 'none',
                                 '--memory', '512m', '--cpus', '2', '--pids-limit', '64',
                                 '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=512m',
                                 '--env', f'POSTGRES_USER={bootstrap_role}',
                                 '--env', f'POSTGRES_DB={bootstrap}',
                                 '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
                                 '--label', f'{label_owner}={owner}', '--label', 'com.portfolio.product=alder',
                                 IMAGE], timeout=30)
        require_success(raw, 'container-create.private.log', created_result, 'SCRATCH_CONTAINER_CREATE_FAILED')
        container_id = created_result.stdout.decode(errors='replace').strip()
        if len(container_id) < 12:
            raise RuntimeError('SCRATCH_CONTAINER_ID_INVALID')
        created = True
        report['containerIdPrefix'] = container_id[:12]
        report['bootstrapRole'] = bootstrap_role
        # initdb owns built-in plpgsql and the pg_monitor memberships. Using
        # the source's original initial role preserves those owners/grantors.
        if sum(r.get('name') == bootstrap_role for r in source_baseline['catalog']['roles']) != 1:
            raise RuntimeError('SOURCE_INITIAL_POSTGRES_ROLE_MISSING')
        role_lines = roles.read_bytes().splitlines(keepends=True)
        initial_create = b'CREATE ROLE postgres;'
        if sum(line.rstrip(b'\r\n') == initial_create for line in role_lines) != 1:
            raise RuntimeError('EXPECTED_INITIAL_ROLE_CREATE_NOT_UNIQUE')
        # Exactly one known role already exists from initdb. Keep the source
        # archive intact; feed all ALTERs/grants and other CREATEs strictly.
        role_import_bytes = b''.join(line for line in role_lines if line.rstrip(b'\r\n') != initial_create)
        (raw / 'roles-import-derived.private.sql').write_bytes(role_import_bytes)
        report['initialRoleImport'] = {
            'preexistingRole': bootstrap_role, 'knownCreateStatementsOmitted': 1,
            'derivedImportSha256': hashlib.sha256(role_import_bytes).hexdigest(),
            'sourceArchiveUnchanged': sha(roles) == report['rolesSha256'],
            'allOtherStatementsOnErrorStop': True,
        }
        isolation = bounded_docker(['inspect', '--format',
                            '{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}|{{json .HostConfig.Tmpfs}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.PidsLimit}}',
                            container_id], timeout=10)
        require_success(raw, 'container-isolation.private.log', isolation, 'SCRATCH_ISOLATION_INSPECT_FAILED')
        parts = isolation.stdout.decode(errors='replace').strip().split('|')
        try:
            mounts = json.loads(parts[2]) if len(parts) == 7 else None
            tmpfs = json.loads(parts[3]) if len(parts) == 7 else None
        except json.JSONDecodeError:
            mounts, tmpfs = None, None
        mount_types = [mount.get('Type') for mount in mounts] if isinstance(mounts, list) else []
        report['isolationAssertions'] = {
            'networkNone': len(parts) == 7 and parts[0] == 'none',
            'noPublishedPorts': len(parts) == 7 and json.loads(parts[1]) in (None, [], {}),
            'noPersistentHostVolumes': len(parts) == 7 and isinstance(mounts, list) and
                all(kind == 'tmpfs' for kind in mount_types) and all(not mount.get('Source') for mount in mounts),
            'ephemeralTmpfsOnly': len(parts) == 7 and isinstance(mounts, list) and
                all(kind == 'tmpfs' for kind in mount_types) and isinstance(tmpfs, dict) and
                set(tmpfs) == {'/var/lib/postgresql/data'} and
                set(tmpfs['/var/lib/postgresql/data'].split(',')) ==
                    {'rw', 'nosuid', 'nodev', 'noexec', 'size=512m'},
            'memory512MiB': len(parts) == 7 and parts[4] == str(512 * 1024 * 1024),
            'cpuLimitTwo': len(parts) == 7 and parts[5] == str(2 * 1_000_000_000),
            'pidsLimit64': len(parts) == 7 and parts[6] == '64',
        }
        if not all(report['isolationAssertions'].values()):
            raise RuntimeError('SCRATCH_ISOLATION_ASSERTION_FAILED')
        started_result = bounded_docker(['start', container_id], timeout=30)
        require_success(raw, 'container-start.private.log', started_result, 'SCRATCH_CONTAINER_START_FAILED')
        ready = False
        for _ in range(90):
            state = bounded_docker(['inspect', '--format', '{{.State.Running}}|{{.State.ExitCode}}', container_id], timeout=5)
            if state.returncode or not state.stdout.decode(errors='replace').strip().startswith('true|'):
                logs = bounded_docker(['logs', container_id], timeout=10)
                private_log(raw, 'postgres-startup.private.log', logs)
                raise RuntimeError('SCRATCH_POSTGRES_EXITED')
            probe = bounded_docker(['exec', container_id, 'pg_isready', '-U', bootstrap_role, '-d', bootstrap], timeout=5)
            if probe.returncode == 0:
                ready = True
                break
            time.sleep(1)
        report['postgresReady'] = ready
        if not ready:
            raise RuntimeError('SCRATCH_POSTGRES_READY_TIMEOUT')

        listing = bounded_docker(['exec', '-i', container_id, 'pg_restore', '--list'], timeout=60,
                         input_bytes=dump.read_bytes())
        require_success(raw, 'pg-restore-list.private.log', listing, 'BACKUP_ARCHIVE_LIST_FAILED')
        if listing.stdout != listing_source.read_bytes():
            raise RuntimeError('BACKUP_ARCHIVE_LIST_CHANGED')
        report['pgRestoreListExit'] = listing.returncode
        report['pgRestoreListBytes'] = len(listing.stdout)

        role_import = bounded_docker(['exec', '-i', container_id, 'psql', '-U', bootstrap_role, '-d', bootstrap,
                              '-X', '-v', 'ON_ERROR_STOP=1'], timeout=180, input_bytes=role_import_bytes)
        require_success(raw, 'roles-restore.private.log', role_import, 'SCRATCH_ROLES_RESTORE_FAILED')
        report['rolesRestoreExit'] = role_import.returncode
        restore = bounded_docker(['exec', '-i', container_id, 'pg_restore', '-U', bootstrap_role,
                          '--create', '--exit-on-error', '--dbname', bootstrap], timeout=1200,
                         input_bytes=dump.read_bytes())
        require_success(raw, 'pg-restore.private.log', restore, 'SCRATCH_PG_RESTORE_FAILED')
        report['restoreExit'] = restore.returncode

        target_baseline = baseline.capture_baseline(docker, container_id, 'alder',
                                                    user=bootstrap_role)
        target_baseline_path = raw / 'restored-baseline.private.json'
        target_baseline_path.write_text(json.dumps(target_baseline, sort_keys=True, separators=(',', ':')) + '\n', encoding='utf-8')
        report['restoredBaselineSha256'] = sha(target_baseline_path)
        identity_fields = ('database', 'versionNum')
        source_identity = source_baseline['databaseIdentity']
        target_identity = target_baseline['databaseIdentity']
        identity_equal = all(source_identity.get(k) == target_identity.get(k) for k in identity_fields)
        cluster_identity_distinct = (bool(source_identity.get('systemIdentifier')) and
                                     target_identity.get('systemIdentifier') != source_identity.get('systemIdentifier'))
        table_equal = source_baseline['tables'] == target_baseline['tables']
        catalog_equal = source_baseline['catalog'] == target_baseline['catalog']
        roles_equal = source_baseline['globalRoleCatalogMd5'] == target_baseline['globalRoleCatalogMd5']
        report['comparison'] = {'backupTimeBaselineOnly': True,
                                'sourceWasRequeried': False,
                                'tableCountSource': source_baseline['tableCount'],
                                'tableCountRestored': target_baseline['tableCount'],
                                'tableRowHashesAndCountsEqual': table_equal,
                                'catalogMetadataEqual': catalog_equal,
                                'globalRoleCatalogEqual': roles_equal,
                                'logicalDatabaseIdentityEqual': identity_equal,
                                'sourceClusterSystemIdentifierRecorded': bool(source_identity.get('systemIdentifier')),
                                'sourceDatabaseOidRecorded': bool(source_identity.get('databaseOid')),
                                'targetClusterSystemIdentifierDiffers': cluster_identity_distinct,
                                'sourceDatabaseOid': source_identity.get('databaseOid'),
                                'targetDatabaseOid': target_identity.get('databaseOid')}
        report['tableMismatches'] = [a.get('name') for a, b in zip(source_baseline['tables'], target_baseline['tables']) if a != b]
        report['catalogMismatches'] = [key for key in source_baseline['catalog']
                                       if source_baseline['catalog'][key] != target_baseline['catalog'].get(key)]
        indexes = bounded_docker(['exec', container_id, 'psql', '-U', bootstrap_role, '-d', 'alder', '-X', '-At',
                          '-v', 'ON_ERROR_STOP=1', '-c',
                          'SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready'], timeout=30)
        require_success(raw, 'index-validity.private.log', indexes, 'RESTORE_INDEX_VALIDITY_QUERY_FAILED')
        report['invalidIndexCount'] = int(indexes.stdout.decode().strip())
        constraints = bounded_docker(['exec', container_id, 'psql', '-U', bootstrap_role, '-d', 'alder', '-X', '-At',
                              '-v', 'ON_ERROR_STOP=1', '-c',
                              "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated"], timeout=30)
        require_success(raw, 'constraint-validation.private.log', constraints, 'RESTORE_CONSTRAINT_QUERY_FAILED')
        report['unvalidatedConstraintCount'] = int(constraints.stdout.decode().strip())
        report['restorePass'] = (identity_equal and cluster_identity_distinct and table_equal and catalog_equal and roles_equal and
                                 report['invalidIndexCount'] == 0 and report['unvalidatedConstraintCount'] == 0 and
                                 all(report['isolationAssertions'].values()))
        report['broadcastOutcome'] = 'not_executed; no API, worker, RPC signer, or transaction sender ran'
        report['rpoContext'] = {'sourceSnapshotCreatedAtUtc': manifest.get('postgresSnapshot', {}).get('snapshotCreatedAtUtc'),
                                'restoreStartedAtUtc': report['startedAtUtc'],
                                'maximumRpoSeconds': 60,
                                'snapshotToRestoreStartSeconds': round((datetime.fromisoformat(report['startedAtUtc']) - datetime.fromisoformat(manifest['postgresSnapshot']['snapshotCreatedAtUtc'])).total_seconds(), 3)}
        report['rpoPass'] = report['rpoContext']['snapshotToRestoreStartSeconds'] <= 60
        report['rtoScope'] = 'isolated PostgreSQL restore, exact backup-time baseline comparison, and bounded cleanup; no application/chain service recovery claimed'
        report['restoreCompletedAtUtc'] = datetime.now(timezone.utc).isoformat()
        report['rtoSeconds'] = round(time.monotonic() - started, 3)
        report['rtoLimitSeconds'] = 1800
        report['rtoPass'] = report['rtoSeconds'] <= 1800
        if not report['rpoPass']:
            report['restorePass'] = False
            report['rpoFailure'] = 'BACKUP_TO_RESTORE_START_EXCEEDED_60_SECONDS'
        if not report['rtoPass']:
            report['restorePass'] = False
            report['rtoFailure'] = 'ISOLATED_RESTORE_EXCEEDED_1800_SECONDS'
    except Exception as exc:
        report['errorCategory'] = str(exc) if str(exc).isupper() else type(exc).__name__
        report['restorePass'] = False
    finally:
        try:
            inspect = docker(['inspect', '--format', '{{ index .Config.Labels "' + label_owner + '" }}', container], timeout=10)
            owned = inspect.returncode == 0 and inspect.stdout.decode(errors='replace').strip() == owner
            report['containerOwnerVerifiedBeforeCleanup'] = owned
            if owned:
                removed = docker(['rm', '-f', container], timeout=30)
                private_log(raw, 'container-remove.private.log', removed)
                report['cleanup'] = 'removed_exact_owned_container' if removed.returncode == 0 else 'owned_container_remove_failed'
            elif created:
                report['cleanup'] = 'refused_unverified_container'
            else:
                report['cleanup'] = 'no_owned_container_created'
        except Exception as exc:
            report['cleanup'] = 'ownership_or_cleanup_command_failed_no_further_removal'
            report['cleanupErrorCategory'] = str(exc) if str(exc).isupper() else type(exc).__name__
        report['evidencePath'] = str(evidence)
        try:
            save_evidence()
        except Exception:
            report['evidenceWriteFailed'] = True
        print(json.dumps({'evidence': str(evidence), 'rawDirectory': str(raw),
                          'restorePass': report.get('restorePass', False),
                          'rpoPass': report.get('rpoPass'), 'rtoSeconds': report.get('rtoSeconds'),
                          'errorCategory': report.get('errorCategory'), 'cleanup': report.get('cleanup')}))
    return 0 if report.get('restorePass') and report.get('rtoPass') else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({'status': 'FAILED', 'errorCategory': str(exc) if str(exc).isupper() else type(exc).__name__}))
        sys.exit(2)
