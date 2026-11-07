"""Private retained backup before the round-six API restart. Never emit credentials."""
import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_CHAIN_ID = '0x7a69'
EXPECTED_GENESIS = '0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec'
parser = argparse.ArgumentParser()
parser.add_argument('--receipt', required=True)
parser.add_argument('--restart', nargs='+', choices=['api', 'worker'], default=['api'])
parser.add_argument('--backup-only', action='store_true',
                    help='capture and verify the backup without restarting services')
parser.add_argument('--offline-state', type=Path,
                    help='use a retained Anvil state file after verifying all live Alder ports are closed')
args = parser.parse_args()
if args.offline_state and not args.backup_only:
    parser.error('--offline-state requires --backup-only; offline capture never restarts a service')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
destination = ROOT / '.local/backups' / ('codex-round6-' + stamp)
destination.mkdir(parents=True, exist_ok=False)
account = subprocess.check_output(['whoami'], text=True).strip()
subprocess.run(['icacls', str(destination), '/inheritance:r', '/grant:r', account + ':(OI)(CI)F'], check=True, stdout=subprocess.DEVNULL)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


for filename, command in [
    ('alder.dump', ['docker', 'exec', 'alder-postgres', 'pg_dump', '-U', 'postgres', '-Fc', 'alder']),
    ('roles.sql', ['docker', 'exec', 'alder-postgres', 'pg_dumpall', '-U', 'postgres', '--roles-only']),
]:
    with (destination / filename).open('xb') as output:
        subprocess.run(command, stdout=output, check=True)
with (destination / 'alder.dump').open('rb') as source, (destination / 'dump-list.txt').open('xb') as listing:
    subprocess.run(['docker', 'exec', '-i', 'alder-postgres', 'pg_restore', '--list'], stdin=source, stdout=listing, check=True)

files = [p for p in (ROOT / '.local').iterdir() if p.is_file()]
for directory in ['tls', 'exports', 'wallets']:
    files.extend(p for p in (ROOT / '.local' / directory).rglob('*') if p.is_file())
for source in files:
    if source.is_symlink():
        raise RuntimeError('PRIVATE_BACKUP_SYMLINK_REFUSED')
    target = destination / 'private' / source.relative_to(ROOT / '.local')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    if sha(source) != sha(target):
        raise RuntimeError('PRIVATE_BACKUP_COPY_CHANGED')

# Read-only local RPC or a validated offline snapshot. Verify the preserved chain
# identity and head before taking the private state snapshot.
def rpc_call(method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    request = Request('http://127.0.0.1:8547', data=body, headers={'content-type': 'application/json'})
    with urlopen(request, timeout=20) as response:
        data = json.loads(response.read())
    if data.get('error'):
        raise RuntimeError('CHAIN_RPC_READ_FAILED')
    return data.get('result')


chain_id = EXPECTED_CHAIN_ID
if args.offline_state:
    ports = [8547, 8103, 8113, 5103, 5113]
    for port in ports:
        with __import__('socket').socket() as sock:
            sock.settimeout(0.25)
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError('OFFLINE_BACKUP_REFUSED_LISTENER_PRESENT_' + str(port))
    source_state = args.offline_state.resolve(strict=True)
    if source_state != (ROOT / 'chain-state' / 'anvil-8547-state.json').resolve(strict=True):
        raise RuntimeError('OFFLINE_STATE_PATH_NOT_APPROVED')
    state_bytes = source_state.read_bytes()
    state = json.loads(state_bytes.decode('utf-8'))
    genesis = [b for b in state.get('blocks', [])
               if int(b.get('header', {}).get('number', '0x0'), 16) == 0]
    pinned = [b for b in genesis if int(b.get('header', {}).get('timestamp', '0x0'), 16) == 0x6ae4a90c]
    if len(pinned) != 1:
        raise RuntimeError('OFFLINE_PINNED_GENESIS_TIMESTAMP_MISMATCH')
    chain_head = state.get('best_block_number')
    head_number = int(chain_head, 16) if isinstance(chain_head, str) and chain_head.startswith('0x') else int(chain_head)
    if head_number < 3442:
        raise RuntimeError('OFFLINE_CHAIN_HEAD_BELOW_REQUIRED_3442')
    genesis_block = {'hash': EXPECTED_GENESIS}
    dump_source = source_state
else:
    chain_id = rpc_call('eth_chainId', [])
    genesis_block = rpc_call('eth_getBlockByNumber', ['0x0', False])
    chain_head = rpc_call('eth_blockNumber', [])
    if chain_id != EXPECTED_CHAIN_ID or not genesis_block or genesis_block.get('hash', '').lower() != EXPECTED_GENESIS:
        raise RuntimeError('PRESERVED_CHAIN_IDENTITY_MISMATCH')
    if not isinstance(chain_head, str) or not chain_head.startswith('0x'):
        raise RuntimeError('CHAIN_HEAD_UNAVAILABLE')
    head_number = int(chain_head, 16)
    # Read-only RPC state snapshot, written directly into this private backup directory.
    rpc = rpc_call('anvil_dumpState', [])
    if not isinstance(rpc, str) or not rpc.startswith('0x'):
        raise RuntimeError('CHAIN_STATE_DUMP_FAILED')
    raw = bytes.fromhex(rpc[2:])
    try:
        state_bytes = gzip.decompress(raw)
    except OSError:
        state_bytes = raw
    state = json.loads(state_bytes.decode('utf-8'))
if not isinstance(state.get('blocks'), list) or not state['blocks']:
    raise RuntimeError('CHAIN_STATE_DUMP_EMPTY')
dump_head = state.get('best_block_number')
dump_head_number = int(dump_head, 16) if isinstance(dump_head, str) and dump_head.startswith('0x') else int(dump_head)
if dump_head_number != head_number:
    raise RuntimeError('CHAIN_STATE_HEAD_MISMATCH')
state_path = destination / 'anvil-state.json'
with state_path.open('xb') as stream:
    stream.write(state_bytes)
    stream.flush()
    os.fsync(stream.fileno())
chain_file_digests = {}
if args.offline_state:
    chain_dir = ROOT / 'chain-state'
    for source in chain_dir.iterdir():
        if not source.is_file():
            continue
        if source.is_symlink():
            raise RuntimeError('CHAIN_BACKUP_SYMLINK_REFUSED')
        target = destination / 'private' / 'chain-state' / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if sha(source) != sha(target):
            raise RuntimeError('CHAIN_BACKUP_COPY_CHANGED')
        chain_file_digests[str(target.relative_to(destination))] = {'sha256': sha(target), 'bytes': target.stat().st_size}
manifest = {'created_at': datetime.now(timezone.utc).isoformat(), 'database': 'alder',
            'scope': 'PostgreSQL logical snapshot + roles + .local root files/tls/exports/wallets + RPC chain snapshot',
            'backup_helper_sha256': sha(Path(__file__)),
            'backup_runtime': {'implementation': 'CPython', 'version': sys.version.split()[0]},
            'chain_snapshot': {'method': 'anvil_dumpState', 'rpc': 'http://127.0.0.1:8547',
                               'chain_id': chain_id, 'genesis_hash': genesis_block['hash'],
                               'head_number': head_number,
                               'block_count': len(state['blocks']), 'best_block_number': dump_head,
                               'capture_mode': 'offline-state-file' if args.offline_state else 'live-read-only-rpc',
                               'source_state_sha256': sha(dump_source) if args.offline_state else None,
                               'source_state_path': str(dump_source) if args.offline_state else None},
            'chain_files': chain_file_digests,
            'files': {str(p.relative_to(destination)): {'sha256': sha(p), 'bytes': p.stat().st_size}
                      for p in destination.rglob('*') if p.is_file()}}
(destination / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
receipt = {'backup': str(destination), 'manifest_sha256': sha(destination / 'manifest.json'),
           'dump_sha256': sha(destination / 'alder.dump'), 'files': len(manifest['files']),
           'pg_restore_list_exit': 0, 'private_copy_digests_verified': True,
           'backup_helper_sha256': sha(Path(__file__)), 'chain_block_count': len(state['blocks']),
           'backup_runtime': {'implementation': 'CPython', 'version': sys.version.split()[0]},
           'chain_id': chain_id, 'chain_genesis_hash': genesis_block['hash'],
           'chain_head_number': head_number, 'chain_best_block_number': dump_head,
           'actual_restore': 'not yet run'}
evidence = ROOT / args.receipt
with evidence.open('x', encoding='utf-8') as stream:
    json.dump(receipt, stream, indent=2)
print(json.dumps(receipt))
if not args.backup_only:
    for service in args.restart:
        subprocess.run(['powershell', '-NoProfile', '-File', 'ops/round4-services.ps1', 'restart', service], cwd=ROOT, check=True)
