"""Build a staged Alder release, archive the old dist, and refresh HTTPS 5113.

Run only under the coordinator-approved Alder product lock and heavy-job slot.
The old dist is kept inside the same fresh private backup used for migration 014.
"""
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NODE = ROOT / '.local/runtime/node-v26.7.0/node.exe'
EXPECTED_NODE = 'e921fe5307e29bf6fd00000dd594356affd3a7b044e52720c7f10decbdc305b9'
EXPECTED_GENESIS = '0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec'
EXPECTED_RESTORE_RECEIPT = 'c5a11c12710d30619035b98f045f07605a24d931aad8ffeaf66aad714b968200'
SOURCE_FILES = [
    'apps/api/destination-holds.ts', 'apps/api/reads.ts', 'apps/api/destinations.ts',
    'apps/api/treasury.ts', 'apps/web/Destinations.tsx', 'apps/web/App.tsx',
    'ops/round4-services.ps1', 'ops/release-server.ts', 'index.html', 'vite.config.ts',
    'package.json', 'tsconfig.json',
    'apps/web/App.tsx', 'apps/web/main.tsx', 'apps/web/Attachments.tsx',
    'apps/web/Inbox.tsx', 'apps/web/Policy.tsx', 'apps/web/Destinations.tsx',
    'apps/web/Recovery.tsx', 'apps/web/Settings.tsx', 'apps/web/wallet-provider.ts',
    'apps/web/screens.json', 'apps/web/style.css', 'packages/gas.ts',
    'packages/intent.ts', 'packages/prepared.ts', 'packages/units.ts', 'package-lock.json',
    'tests/round6/inbox-attachment-browser.ts', 'tests/round6/release-smoke.ts',
    'tests/round5-ops/o5-lib.ts', 'tests/round6-perf/resolve-frozen-allowance-p6.ts',
    'tests/round6-repro/bootstrap-db.ts',
]


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def source_manifest(root: Path) -> dict:
    return {name: sha_file(root / name) for name in SOURCE_FILES}


def tree_manifest(path: Path) -> dict:
    rows = []
    total = 0
    for item in sorted(path.rglob('*'), key=lambda p: p.relative_to(path).as_posix().lower()):
        item_stat = item.lstat()
        if item.is_symlink() or getattr(item_stat, 'st_file_attributes', 0) & 0x400:
            raise RuntimeError('DIST_REPARSE_OR_SYMLINK_REFUSED')
        if item.is_file():
            rel = item.relative_to(path).as_posix()
            size = item.stat().st_size
            digest = sha_file(item)
            rows.append({'path': rel, 'bytes': size, 'sha256': digest})
            total += size
    canonical = json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()
    return {'file_count': len(rows), 'total_bytes': total,
            'tree_sha256': sha_bytes(canonical), 'files': rows}


def refuse_reparse_path(path: Path, root: Path, allow_missing_leaf: bool = False) -> Path:
    root = root.resolve(strict=True)
    absolute = path.absolute()
    try:
        absolute.relative_to(root)
    except ValueError as exc:
        raise RuntimeError('PATH_OUTSIDE_ALDER_ROOT') from exc
    current = absolute
    while current != root:
        if current.exists() or current.is_symlink():
            info = current.lstat()
            if current.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise RuntimeError('REPARSE_POINT_REFUSED')
        elif not (allow_missing_leaf and current == absolute):
            raise RuntimeError('EXPECTED_PATH_COMPONENT_MISSING')
        current = current.parent
    return absolute


def rpc(method: str, params: list):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    request = urllib.request.Request('http://127.0.0.1:8547', data=body,
                                     headers={'content-type': 'application/json'})
    with urllib.request.urlopen(request, timeout=5) as response:
        value = json.loads(response.read())
    if value.get('error'):
        raise RuntimeError('CHAIN_RPC_VERIFY_FAILED')
    return value.get('result')


def https_json(url: str, context: ssl.SSLContext):
    with urllib.request.urlopen(url, timeout=8, context=context) as response:
        return response.status, json.loads(response.read())


def service(action: str, which: str):
    result = subprocess.run(['powershell', '-NoProfile', '-File', 'ops/round4-services.ps1', action, which],
                            cwd=ROOT)
    if result.returncode:
        raise RuntimeError(f'RELEASE_SERVICE_{action.upper()}_FAILED')


def port_listening(port: int) -> bool:
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5):
            return True
    except OSError:
        return False


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit('usage: refresh-reviewed-release.py BACKUP_RECEIPT RESULT_JSON PRIVATE_LOG')
    receipt_path = Path(sys.argv[1]).resolve(strict=True)
    result_path = Path(sys.argv[2])
    private_log = Path(sys.argv[3])
    if result_path.exists() or private_log.exists():
        raise RuntimeError('EVIDENCE_PATH_COLLISION')
    result = {'started_at': datetime.now(timezone.utc).isoformat(), 'service': 'Alder release 5113',
              'build_runtime': str(NODE.relative_to(ROOT)), 'old_dist_archived': False,
              'release_restarted': False, 'passed': False}
    backup = None
    old_dist_moved = False
    new_dist_installed = False
    release_stopped = False
    try:
        if sha_file(NODE) != EXPECTED_NODE:
            raise RuntimeError('ALDER_NODE_RUNTIME_HASH_MISMATCH')
        version = subprocess.check_output([str(NODE), '--version'], cwd=ROOT, text=True).strip()
        if version != 'v26.7.0':
            raise RuntimeError('ALDER_NODE_RUNTIME_VERSION_MISMATCH')
        result['node_version'] = version
        result['node_sha256'] = EXPECTED_NODE

        backups_root = (ROOT / '.local/backups').resolve(strict=True)
        codex_receipts = (ROOT / '.local/codex-a1').resolve(strict=True)
        watchdog_receipts = (ROOT / '.local/alder-watchdog/receipts').resolve(strict=True)
        try:
            receipt_path.relative_to(codex_receipts)
            receipt_kind = 'reference'
        except ValueError:
            receipt_path.relative_to(watchdog_receipts)
            receipt_kind = 'restore'
        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
        if receipt_kind == 'restore':
            if sha_file(receipt_path) != EXPECTED_RESTORE_RECEIPT or receipt.get('status') != 'PASS':
                raise RuntimeError('CANONICAL_RESTORE_RECEIPT_MISMATCH')
            restore_backup = receipt.get('backup') or {}
            backup_receipt_path = Path(restore_backup['receipt'])
            if not backup_receipt_path.is_absolute():
                backup_receipt_path = ROOT / backup_receipt_path
            backup_receipt_path = backup_receipt_path.resolve(strict=True)
            backup_receipt_path.relative_to(watchdog_receipts)
            if sha_file(backup_receipt_path) != restore_backup.get('receiptSha256'):
                raise RuntimeError('CANONICAL_BACKUP_RECEIPT_HASH_MISMATCH')
            verified_backup = json.loads(backup_receipt_path.read_text(encoding='utf-8'))
            if verified_backup.get('backup') != restore_backup.get('backupPath'):
                raise RuntimeError('CANONICAL_BACKUP_PATH_MISMATCH')
            if verified_backup.get('manifest_sha256') != restore_backup.get('manifestSha256'):
                raise RuntimeError('CANONICAL_BACKUP_MANIFEST_PIN_MISMATCH')
            if verified_backup.get('dump_sha256') != restore_backup.get('dumpSha256'):
                raise RuntimeError('CANONICAL_BACKUP_DUMP_PIN_MISMATCH')
            receipt = verified_backup
        backup = Path(receipt['backup']).resolve(strict=True)
        backup.relative_to(backups_root)
        if (backup / 'manifest.json').is_symlink() or (backup / 'alder.dump').is_symlink():
            raise RuntimeError('BACKUP_REPARSE_REFUSED')
        if sha_file(backup / 'manifest.json') != receipt.get('manifest_sha256'):
            raise RuntimeError('BACKUP_MANIFEST_HASH_MISMATCH')
        if sha_file(backup / 'alder.dump') != receipt.get('dump_sha256'):
            raise RuntimeError('BACKUP_DUMP_HASH_MISMATCH')
        result['backup_directory'] = str(backup)
        result['backup_manifest_sha256'] = receipt['manifest_sha256']
        result['backup_dump_sha256'] = receipt['dump_sha256']

        dist = refuse_reparse_path(ROOT / 'dist', ROOT)
        prebuilt_receipt_env = os.environ.get('ALDER_PREBUILT_BUILD_RECEIPT')
        prebuilt_sha_env = os.environ.get('ALDER_PREBUILT_BUILD_RECEIPT_SHA256')
        prebuilt = None
        if prebuilt_receipt_env or prebuilt_sha_env:
            if not prebuilt_receipt_env or not prebuilt_sha_env:
                raise RuntimeError('PREBUILT_BUILD_RECEIPT_AND_SHA_REQUIRED')
            prebuilt_path = Path(prebuilt_receipt_env).resolve(strict=True)
            prebuilt_path.relative_to(codex_receipts)
            if sha_file(prebuilt_path) != prebuilt_sha_env.lower():
                raise RuntimeError('PREBUILT_BUILD_RECEIPT_HASH_MISMATCH')
            prebuilt = json.loads(prebuilt_path.read_text(encoding='utf-8'))
            if prebuilt.get('schema') != 'alder.isolated-source-pinned-build/v1' or not prebuilt.get('passed'):
                raise RuntimeError('PREBUILT_CANDIDATE_RECEIPT_INVALID')
            candidate = refuse_reparse_path(Path(prebuilt['candidate']), ROOT)
            candidate.relative_to(codex_receipts)
        else:
            candidate = refuse_reparse_path(ROOT / '.local/codex-a1/62-dist-candidate', ROOT, True)
        archived = refuse_reparse_path(backup / 'dist-before-reviewed-refresh', ROOT, True)
        if (prebuilt is None and candidate.exists()) or (prebuilt is not None and not candidate.is_dir()) or archived.exists() or not dist.is_dir():
            raise RuntimeError('DIST_OR_ARCHIVE_PATH_STATE_UNEXPECTED')
        result['old_dist'] = tree_manifest(dist)
        result['source_pins'] = source_manifest(ROOT)
        result['source_pin_set_sha256'] = sha_bytes(json.dumps(result['source_pins'], sort_keys=True,
                                                               separators=(',', ':')).encode())
        if prebuilt is not None:
            prebuilt_pins = prebuilt.get('source_pins') or prebuilt.get('source_files') or {}
            if (prebuilt_pins != result['source_pins'] or
                    prebuilt.get('source_pin_set_sha256') != result['source_pin_set_sha256'] or
                    prebuilt.get('tsc_exit') != 0 or prebuilt.get('vite_exit') != 0 or
                    prebuilt.get('old_dist_before', {}).get('tree_sha256') != result['old_dist']['tree_sha256']):
                raise RuntimeError('PREBUILT_SOURCE_OR_BASELINE_BINDING_MISMATCH')
            result['prebuilt_candidate_receipt'] = str(prebuilt_path)
            result['prebuilt_candidate_receipt_sha256'] = prebuilt_sha_env.lower()
            result['tsc_exit'] = prebuilt['tsc_exit']
            result['vite_exit'] = prebuilt['vite_exit']
        else:
            tsc = subprocess.run([str(NODE), 'node_modules/typescript/bin/tsc', '--noEmit'], cwd=ROOT)
            result['tsc_exit'] = tsc.returncode
            if tsc.returncode:
                raise RuntimeError('TSC_FAILED; old dist and release service remain untouched')
            if source_manifest(ROOT) != result['source_pins']:
                raise RuntimeError('SOURCE_CHANGED_DURING_TSC; old dist and release service remain untouched')
            build = subprocess.run([str(NODE), 'node_modules/vite/bin/vite.js', 'build',
                                    '--outDir', str(candidate.relative_to(ROOT))], cwd=ROOT)
            result['vite_exit'] = build.returncode
            if build.returncode:
                raise RuntimeError('VITE_BUILD_FAILED; old dist and release service remain untouched')
            if source_manifest(ROOT) != result['source_pins']:
                raise RuntimeError('SOURCE_CHANGED_DURING_VITE; old dist and release service remain untouched')
        result['candidate_dist'] = tree_manifest(candidate)
        result['candidate_index_sha256'] = sha_file(candidate / 'index.html')
        if prebuilt is not None and (result['candidate_dist'] != prebuilt.get('candidate_dist') or
                                    result['candidate_index_sha256'] != prebuilt.get('candidate_index_sha256')):
            raise RuntimeError('PREBUILT_CANDIDATE_BYTES_MISMATCH')
        if source_manifest(ROOT) != result['source_pins']:
            raise RuntimeError('SOURCE_CHANGED_BEFORE_PUBLISH; old dist and release service remain untouched')

        # Refuse reparse points and ensure the exact preserved package moves into
        # the fresh backup before the candidate becomes the release directory.
        service('stop', 'release')
        release_stopped = True
        if source_manifest(ROOT) != result['source_pins']:
            service('start', 'release')
            release_stopped = False
            raise RuntimeError('SOURCE_CHANGED_AFTER_RELEASE_STOP; old dist remains untouched')
        shutil.move(str(dist), str(archived))
        old_dist_moved = True
        result['archived_dist'] = str(archived)
        result['old_dist_archived'] = True
        shutil.move(str(candidate), str(dist))
        new_dist_installed = True
        result['installed_dist'] = tree_manifest(dist)
        if result['installed_dist']['tree_sha256'] != result['candidate_dist']['tree_sha256']:
            raise RuntimeError('INSTALLED_DIST_HASH_MISMATCH')

        service('start', 'release')
        release_stopped = False
        result['release_restarted'] = True
        ca = ROOT / '.local/tls/ca.pem'
        context = ssl.create_default_context(cafile=str(ca))
        health_status, health = https_json('https://127.0.0.1:5113/health', context)
        metadata_status, metadata = https_json('https://127.0.0.1:5113/__release.json', context)
        served_index = metadata.get('dist_index_sha256')
        if health_status != 200 or metadata_status != 200:
            raise RuntimeError('RELEASE_HTTPS_STATUS_FAILED')
        if served_index != result['candidate_index_sha256']:
            raise RuntimeError('RELEASE_METADATA_INDEX_MISMATCH')
        result['https_health_status'] = health_status
        result['release_metadata_status'] = metadata_status
        result['served_index_sha256'] = served_index
        result['metadata_matches_candidate'] = True

        api_status, api = https_json('https://127.0.0.1:8103/health', context)
        worker_status, worker = https_json('http://127.0.0.1:8113/status', context)
        chain_id = rpc('eth_chainId', [])
        genesis = rpc('eth_getBlockByNumber', ['0x0', False])
        head = rpc('eth_blockNumber', [])
        if api_status != 200 or worker_status != 200:
            raise RuntimeError('POST_REFRESH_SERVICE_HEALTH_FAILED')
        if chain_id != '0x7a69' or genesis.get('hash', '').lower() != EXPECTED_GENESIS:
            raise RuntimeError('PRESERVED_CHAIN_IDENTITY_CHANGED')
        result['api_health_status'] = api_status
        result['api_health_chain_id'] = api.get('chainId')
        result['worker_health_status'] = worker_status
        result['worker_summary'] = {k: worker.get(k) for k in ('role', 'fence', 'phase', 'passes', 'consecutive_failures')}
        result['chain'] = {'chain_id': chain_id, 'genesis_hash': genesis['hash'], 'head': head}
        result['passed'] = True
    except Exception as exc:
        result['error'] = str(exc)
        # If activation failed after the old package was moved, restore the exact
        # archived dist while still under the same product lock.
        if old_dist_moved and backup is not None:
            try:
                if not release_stopped:
                    service('stop', 'release')
                    release_stopped = True
                if port_listening(5113):
                    raise RuntimeError('ROLLBACK_REFUSED_RELEASE_LISTENER_STILL_ACTIVE')
                current = ROOT / 'dist'
                if current.exists():
                    failed = ROOT / '.local/codex-a1' / ('failed-dist-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
                    if failed.exists():
                        raise RuntimeError('FAILED_CANDIDATE_ARCHIVE_COLLISION')
                    shutil.move(str(current), str(failed))
                    result['failed_candidate_preserved'] = str(failed)
                shutil.move(str(backup / 'dist-before-reviewed-refresh'), str(ROOT / 'dist'))
                result['old_dist_restored'] = True
                restored = tree_manifest(ROOT / 'dist')
                result['restored_dist_tree_sha256'] = restored['tree_sha256']
                if restored['tree_sha256'] != result.get('old_dist', {}).get('tree_sha256'):
                    raise RuntimeError('ROLLBACK_DIST_HASH_MISMATCH')
                try:
                    service('start', 'release')
                except Exception as start_error:
                    result['prior_release_restarted'] = False
                    result['rollback_release_start_error'] = str(start_error)
                else:
                    result['prior_release_restarted'] = True
                    release_stopped = False
                    ca = ROOT / '.local/tls/ca.pem'
                    context = ssl.create_default_context(cafile=str(ca))
                    try:
                        metadata_status, metadata = https_json('https://127.0.0.1:5113/__release.json', context)
                        expected_old_index = result.get('old_dist', {}).get('files', [])
                        expected_old_index = next((item['sha256'] for item in expected_old_index if item['path'] == 'index.html'), None)
                        result['rollback_metadata_status'] = metadata_status
                        result['rollback_metadata_index_sha256'] = metadata.get('dist_index_sha256')
                        result['rollback_metadata_matches_restored_dist'] = (
                            metadata_status == 200 and metadata.get('dist_index_sha256') == expected_old_index)
                        if not result['rollback_metadata_matches_restored_dist']:
                            result['rollback_metadata_error'] = 'ROLLBACK_RELEASE_METADATA_MISMATCH'
                    except Exception as metadata_error:
                        result['rollback_metadata_error'] = str(metadata_error)
                    try:
                        health_status, _ = https_json('https://127.0.0.1:5113/health', context)
                        result['rollback_release_health_status'] = health_status
                    except Exception as health_error:
                        result['rollback_release_health_error'] = str(health_error)
            except Exception as recovery:
                result['recovery_error'] = str(recovery)
        elif release_stopped:
            try:
                service('start', 'release')
                result['prior_release_restarted'] = True
                release_stopped = False
            except Exception as recovery:
                result['recovery_error'] = str(recovery)
    finally:
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        private_log.write_text('No private HTTP headers or response bodies captured.\n', encoding='utf-8')
        print(json.dumps(result))
    return 0 if result.get('passed') else 1


if __name__ == '__main__':
    sys.exit(main())
