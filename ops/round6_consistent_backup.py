"""Create a private snapshot-consistent PostgreSQL backup and row baseline.

Read-only against the source database and RPC. Does not restart services or
write to the retained database/chain. Run only after the Round 6 restore gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import itertools
from datetime import datetime, timezone
from urllib.request import Request, urlopen

import round6_restore_baseline as baseline

ROOT = Path(__file__).resolve().parents[1]
BACKUP_ROOT = ROOT / '.local' / 'backups'
SOURCE_CONTAINER = 'alder-postgres'
SOURCE_DATABASE = 'alder'
RPC_URL = 'http://127.0.0.1:8547'
EXPECTED_CHAIN_ID = '0x7a69'
EXPECTED_GENESIS = '0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec'


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def require_private_c_path(path: Path) -> Path:
    absolute = path.resolve(strict=False)
    if (BACKUP_ROOT.is_symlink() or (ROOT / '.local').is_symlink() or absolute.drive.upper() != 'C:'
            or not absolute.is_relative_to(BACKUP_ROOT.resolve())):
        raise RuntimeError('BACKUP_PATH_MUST_BE_PRIVATE_C_BACKUP_ROOT')
    if absolute.exists() or absolute.is_symlink():
        raise RuntimeError('BACKUP_DESTINATION_ALREADY_EXISTS_OR_IS_LINK')
    return absolute


def run_docker(args: list[str], *, timeout: int = 60, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(['docker', *args], input=input_bytes, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, check=False)


def write_private_log(path: Path, result: subprocess.CompletedProcess) -> None:
    path.write_bytes(result.stdout + result.stderr)


def ensure_acl(path: Path) -> None:
    account = subprocess.check_output(['whoami'], text=True, timeout=10).strip()
    subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', account + ':(OI)(CI)F'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)


def rpc(method: str, params: list) -> object:
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    req = Request(RPC_URL, data=body, headers={'content-type': 'application/json'})
    with urlopen(req, timeout=8) as response:
        value = json.loads(response.read())
    if value.get('error'):
        raise RuntimeError('CHAIN_RPC_READ_FAILED')
    return value.get('result')


def chain_binding(expected_head: int) -> dict:
    chain_id = rpc('eth_chainId', [])
    genesis = rpc('eth_getBlockByNumber', ['0x0', False])
    head = rpc('eth_blockNumber', [])
    if chain_id != EXPECTED_CHAIN_ID or not isinstance(genesis, dict) or genesis.get('hash', '').lower() != EXPECTED_GENESIS:
        raise RuntimeError('CHAIN_ID_OR_GENESIS_BINDING_MISMATCH')
    if not isinstance(head, str) or not head.startswith('0x') or int(head, 16) != expected_head:
        raise RuntimeError('CHAIN_HEAD_NOT_EXPECTED_EXACT_3442')
    block = rpc('eth_getBlockByNumber', [head, False])
    if not isinstance(block, dict) or not block.get('hash'):
        raise RuntimeError('CHAIN_HEAD_HASH_UNAVAILABLE')
    return {'rpc': RPC_URL, 'chainId': chain_id, 'genesisHash': genesis['hash'].lower(),
            'headNumber': int(head, 16), 'headHash': block['hash'].lower()}


def capture_private_artifacts(destination: Path) -> dict[str, dict]:
    """Mirror the legacy backup scope without importing its top-level script."""
    local_root = ROOT / '.local'
    if local_root.is_symlink():
        raise RuntimeError('PRIVATE_ARTIFACT_ROOT_LINK_REFUSED')
    artifact_root = destination / 'private' / '.local'
    selected: list[Path] = [path for path in local_root.iterdir() if path.is_file()]
    for name in ('tls', 'exports', 'wallets'):
        directory = local_root / name
        if not directory.exists():
            continue
        if directory.is_symlink() or not directory.resolve().is_relative_to(local_root.resolve()):
            raise RuntimeError('PRIVATE_ARTIFACT_DIRECTORY_LINK_REFUSED')
        for path in directory.rglob('*'):
            if path.is_symlink():
                raise RuntimeError('PRIVATE_ARTIFACT_SYMLINK_REFUSED')
            if path.is_file():
                selected.append(path)
    digests: dict[str, dict] = {}
    for source in selected:
        if source.is_symlink() or not source.resolve(strict=True).is_relative_to(local_root.resolve()):
            raise RuntimeError('PRIVATE_ARTIFACT_PATH_INVALID')
        relative = source.relative_to(local_root)
        target = artifact_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        source_hash = sha_file(source)
        if target.stat().st_size != source.stat().st_size or sha_file(target) != source_hash:
            raise RuntimeError('PRIVATE_ARTIFACT_COPY_DIGEST_MISMATCH')
        digests[str(Path('private') / '.local' / relative).replace('\\', '/')] = {
            'sha256': source_hash, 'bytes': source.stat().st_size}
    return digests


class SnapshotTransaction:
    """Keep an exported PostgreSQL snapshot valid across pg_dump and baseline reads."""
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.stderr_thread: threading.Thread | None = None
        self.stdout_thread: threading.Thread | None = None
        self.exported_at_utc: str | None = None

    def _abort(self) -> None:
        if not self.proc:
            return
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
            try:
                self.proc.wait(timeout=5)
            except Exception:
                pass

    def __enter__(self) -> str:
        command = ['docker', 'exec', '-i', SOURCE_CONTAINER, 'psql', '-U', 'postgres',
                   '-d', SOURCE_DATABASE, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, encoding='utf-8',
                                     errors='replace', bufsize=1)

        def read_stdout() -> None:
            assert self.proc and self.proc.stdout
            for line in self.proc.stdout:
                self.lines.put(line.rstrip('\r\n'))
            self.lines.put(None)

        def drain_stderr() -> None:
            assert self.proc and self.proc.stderr
            for _ in self.proc.stderr:
                pass

        self.stdout_thread = threading.Thread(target=read_stdout, daemon=True)
        self.stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
        self.stdout_thread.start()
        self.stderr_thread.start()
        assert self.proc.stdin
        self.proc.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n')
        self.proc.stdin.flush()
        try:
            line = self.lines.get(timeout=20)
        except queue.Empty as exc:
            self._abort()
            raise RuntimeError('EXPORTED_SNAPSHOT_TIMEOUT') from exc
        if line is None or not baseline.SNAPSHOT_RE.fullmatch(line):
            self._abort()
            raise RuntimeError('EXPORTED_SNAPSHOT_TOKEN_INVALID')
        self.exported_at_utc = datetime.now(timezone.utc).isoformat()
        return line

    def __exit__(self, exc_type, exc, tb) -> None:
        if not self.proc:
            return
        code = None
        failed = False
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.write('COMMIT;\n\\q\n')
                self.proc.stdin.flush()
                self.proc.stdin.close()
            code = self.proc.wait(timeout=20)
        except Exception:
            failed = True
            self.proc.kill()
            try:
                self.proc.wait(timeout=10)
            except Exception:
                pass
        finally:
            if self.stdout_thread:
                self.stdout_thread.join(timeout=2)
            if self.stderr_thread:
                self.stderr_thread.join(timeout=2)
        if exc_type is None and (failed or code != 0):
            raise RuntimeError('EXPORTED_SNAPSHOT_TRANSACTION_EXIT_NONZERO')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--output-name', required=True,
                    help='unique child directory of .local/backups; no absolute paths')
    ap.add_argument('--expected-head', required=True, type=int)
    ap.add_argument('--expected-system-identifier', required=True)
    ap.add_argument('--expected-database-oid', required=True)
    args = ap.parse_args()
    if args.expected_head != 3442:
        ap.error('--expected-head must be the pinned canonical Alder head 3442')
    if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}', args.output_name):
        ap.error('--output-name must be UTC-stamped and unique')
    if not args.expected_system_identifier.isdigit() or not args.expected_database_oid.isdigit():
        ap.error('system identifier and database OID must be decimal integers')
    destination = require_private_c_path(BACKUP_ROOT / ('round6-consistent-' + args.output_name))
    destination.mkdir(parents=True, exist_ok=False)
    ensure_acl(destination)
    raw = destination / 'private-logs'
    raw.mkdir()
    ensure_acl(raw)
    private_artifact_digests = capture_private_artifacts(destination)
    helper_sha = sha_file(Path(__file__))
    baseline_module_sha = sha_file(Path(baseline.__file__))
    restore_helper_sha = sha_file(ROOT / 'ops' / 'round6_consistent_restore.py')
    start_chain = chain_binding(args.expected_head)
    files: dict[str, dict] = dict(private_artifact_digests)
    query_log_index = itertools.count(1)

    def logged_docker(command: list[str], *, timeout: int = 60,
                      input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
        result = run_docker(command, timeout=timeout, input_bytes=input_bytes)
        write_private_log(raw / f'psql-read-{next(query_log_index):03d}.private.log', result)
        return result

    def log_and_check(name: str, result: subprocess.CompletedProcess, code: str) -> None:
        write_private_log(raw / name, result)
        if result.returncode:
            raise RuntimeError(code)

    snapshot = SnapshotTransaction()
    with snapshot as snapshot_id:
        source_baseline = baseline.capture_baseline(
            logged_docker, SOURCE_CONTAINER, SOURCE_DATABASE, snapshot_id=snapshot_id)
        identity = source_baseline.get('databaseIdentity', {})
        if (identity.get('systemIdentifier') != args.expected_system_identifier or
                identity.get('databaseOid') != args.expected_database_oid or
                identity.get('database') != SOURCE_DATABASE):
            raise RuntimeError('SOURCE_CLUSTER_OR_DATABASE_IDENTITY_MISMATCH')
        role_before = baseline.read_global_role_hash(logged_docker, SOURCE_CONTAINER, SOURCE_DATABASE)
        if role_before != source_baseline.get('globalRoleCatalogMd5'):
            raise RuntimeError('ROLE_CATALOG_CHANGED_SINCE_EXPORTED_SNAPSHOT')

        dump_path = destination / 'alder.dump'
        with dump_path.open('xb') as dump_file:
            dump = subprocess.run(['docker', 'exec', '-i', SOURCE_CONTAINER, 'pg_dump', '-U', 'postgres',
                                   '--format=custom', '--snapshot', snapshot_id, '--dbname', SOURCE_DATABASE],
                                  stdout=dump_file, stderr=subprocess.PIPE, timeout=900, check=False)
        (raw / 'pg-dump.private.log').write_bytes(dump.stderr)
        if dump.returncode:
            raise RuntimeError('SNAPSHOT_BOUND_PG_DUMP_FAILED')

        # Sequence values are outside PostgreSQL's MVCC snapshot. Compare the
        # source values after pg_dump with the baseline captured before it;
        # if any sequence advanced during the dump, refuse this backup rather
        # than claim a point-in-time sequence restore that pg_export_snapshot
        # cannot provide.
        post_dump_sequence_states = baseline.capture_sequence_states(
            logged_docker, SOURCE_CONTAINER, SOURCE_DATABASE)
        if post_dump_sequence_states != source_baseline['catalog']['sequence_states']:
            raise RuntimeError('SEQUENCE_STATE_CHANGED_DURING_BACKUP')

        roles_path = destination / 'roles.sql'
        with roles_path.open('xb') as roles_file:
            roles = subprocess.run(['docker', 'exec', SOURCE_CONTAINER, 'pg_dumpall', '-U', 'postgres', '--roles-only'],
                                   stdout=roles_file, stderr=subprocess.PIPE, timeout=180, check=False)
        (raw / 'roles-dump.private.log').write_bytes(roles.stderr)
        if roles.returncode:
            raise RuntimeError('GLOBAL_ROLES_DUMP_FAILED')
        role_after = baseline.read_global_role_hash(logged_docker, SOURCE_CONTAINER, SOURCE_DATABASE)
        if role_after != role_before:
            raise RuntimeError('GLOBAL_ROLE_CATALOG_CHANGED_DURING_BACKUP')

        listing_path = destination / 'pg-restore-list.txt'
        with dump_path.open('rb') as stream:
            listing = run_docker(['exec', '-i', SOURCE_CONTAINER, 'pg_restore', '--list'], timeout=60,
                                 input_bytes=stream.read())
        log_and_check('pg-restore-list-command.private.log', listing, 'PG_RESTORE_LIST_FAILED')
        listing_path.write_bytes(listing.stdout)
        baseline_path = destination / 'baseline.json'
        baseline_bytes = (json.dumps(source_baseline, sort_keys=True, separators=(',', ':')) + '\n').encode()
        with baseline_path.open('xb') as stream:
            stream.write(baseline_bytes)
            stream.flush()
            os.fsync(stream.fileno())

    end_chain = chain_binding(args.expected_head)
    if end_chain != start_chain:
        raise RuntimeError('CHAIN_BINDING_CHANGED_DURING_BACKUP')
    for path in destination.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('BACKUP_SYMLINK_REFUSED')
        if path.is_file() and path.name != 'manifest.json':
            files[str(path.relative_to(destination)).replace('\\', '/')] = {
                'sha256': sha_file(path), 'bytes': path.stat().st_size}
    manifest = {
        'schema': 'alder.round6-consistent-backup/v1',
        'createdAtUtc': datetime.now(timezone.utc).isoformat(),
        'database': SOURCE_DATABASE,
        'sourceContainer': SOURCE_CONTAINER,
        'sourceIdentity': source_baseline['databaseIdentity'],
        'postgresSnapshot': {'mode': 'repeatable-read-read-only-exported-snapshot',
                             'snapshotCreatedAtUtc': snapshot.exported_at_utc,
                             'snapshotTokenSha256': sha_bytes(snapshot_id.encode()),
                             'heldAcross': ['baseline.json', 'pg_dump --snapshot'],
                             'sequenceConsistency': 'baseline-sequence-state-equal-to-post-pg_dump-read; aborts-on-change'},
        'chainBinding': start_chain,
        'expectedTableCount': baseline.EXPECTED_PUBLIC_TABLES,
        'privateArtifactCount': len(private_artifact_digests),
        'privateArtifactTotalBytes': sum(item['bytes'] for item in private_artifact_digests.values()),
        'globalRoleCatalogMd5BeforeAndAfter': role_before,
        'baselineSha256': sha_file(destination / 'baseline.json'),
        'backupHelperSha256': helper_sha,
        'restoreHelperSha256': restore_helper_sha,
        'baselineModuleSha256': baseline_module_sha,
        'files': files,
    }
    manifest_path = destination / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    receipt = {'schema': 'alder.round6-consistent-backup-receipt/v1',
               'backupDirectory': str(destination), 'manifestSha256': sha_file(manifest_path),
               'dumpSha256': sha_file(destination / 'alder.dump'),
               'baselineSha256': manifest['baselineSha256'], 'fileCount': len(files),
               'sourceSystemIdentifier': identity['systemIdentifier'],
               'sourceDatabaseOid': identity['databaseOid'], 'tableCount': source_baseline['tableCount'],
               'chainHead': start_chain['headNumber'], 'chainHeadHash': start_chain['headHash'],
               'roleCatalogUnchanged': role_before == role_after,
               'databaseWrites': False, 'chainWrites': False}
    receipt_path = destination / 'receipt.json'
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({'status': 'FAILED', 'errorCategory': str(exc) if str(exc).isupper() else type(exc).__name__}))
        sys.exit(2)
