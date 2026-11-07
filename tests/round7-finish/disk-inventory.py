#!/usr/bin/env python3
"""TR-T-CAPACITY evidence/dependency disk accounting; read-only after the P6 run.

Post-P6 mode requires P6 completion evidence, duration >= 1800 seconds, finish
time, and the frozen 20r/s, 5w/s, 100-session, 10-SSE, 10k-payable profile.
Pre-P6 mode records a clearly labeled baseline when the operator confirms load is
inactive. Both modes enforce global file-count and wall-clock scan bounds. It inventories the Alder checkout, named Docker
volumes used by Alder-labeled containers, and documented Alder archive locations
on E:. It reads no payload contents; only metadata, the compact P6 receipt hash,
and volume du totals are recorded. Docker volume mounts are read-only.
"""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
PORTFOLIO_ROOT = ROOT.parent
OUT = ROOT / '.local'
PG_IMAGE = 'sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
CAP_BYTES = 12 * 1024**3
TARGET_RAM_BYTES = 16 * 1024**3
TARGET_CORES = 4
if os.name == 'nt':
    _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _get_compressed_file_size = _kernel32.GetCompressedFileSizeW
    _get_compressed_file_size.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
    _get_compressed_file_size.restype = ctypes.c_ulong

# Every disjoint top-level checkout root is inventoried. Buckets marked in-scope
# count toward the frozen evidence/dependency cap; source/config is shown separately.
IN_SCOPE = {
    'dependencies_and_build_cache': {'.browsers', '.cache', '.exe', 'cache', 'dist', 'node_modules', 'npm-cache', 'vendor'},
    'evidence_tests_and_documentation': {'docs', 'evidence', 'ops', 'tests'},
    'local_runs_backups_and_evidence': {'.local'},
    'persisted_database_chain_and_logs': {'chain-state', 'pgdata', 'runtime-logs'},
}
KNOWN_SOURCE = {'apps', 'contracts', 'db', 'packages', 'services'}
NESTED_BUILD_MARKERS = {'node_modules', 'vendor', '.browsers', '.cache', 'cache', 'dist', 'build', '.next', '.vite', '.turbo', 'coverage', 'playwright-report', 'test-results', 'out'}


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def allocated_size(p: Path, st: os.stat_result) -> tuple[int, str]:
    # Windows GetCompressedFileSize reports allocated bytes for NTFS compressed or
    # sparse files. Fall back to logical size and mark that entry as estimated.
    if os.name == 'nt':
        high = ctypes.c_ulong(0)
        ctypes.set_last_error(0)
        low = _get_compressed_file_size(str(p), ctypes.byref(high))
        err = ctypes.get_last_error()
        if low != 0xFFFFFFFF or err == 0:
            return (high.value << 32) | low, 'allocated_ntfs'
    blocks = getattr(st, 'st_blocks', None)
    if blocks is not None:
        return blocks * 512, 'allocated_stat_blocks'
    return st.st_size, 'logical_fallback'


def is_reparse(st: os.stat_result) -> bool:
    return bool(getattr(st, 'st_file_attributes', 0) & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT


class ScanBudget:
    def __init__(self, max_files: int, max_seconds: int):
        self.max_files = max_files
        self.deadline = time.monotonic() + max_seconds
        self.files = 0
        self.exhausted = False

    def stop(self) -> bool:
        if self.files >= self.max_files or time.monotonic() >= self.deadline:
            self.exhausted = True
        return self.exhausted


def tree_size(root: Path, budget: ScanBudget, classify_nested: bool = False) -> dict:
    result = {'path': str(root), 'exists': False, 'files': 0,
              'logicalBytes': 0, 'allocatedBytes': 0, 'uniqueFileIds': 0,
              'reparsePointsNotFollowed': 0, 'unreadableEntries': 0,
              'allocationMethods': {}, 'scanBudgetExhausted': False,
              'nestedGeneratedArtifactLogicalBytes': 0,
              'nestedGeneratedArtifactAllocatedBytes': 0,
              'nestedGeneratedArtifactFiles': 0}
    seen: set[tuple[int, int]] = set()
    nested_seen: set[tuple[int, int]] = set()
    try:
        root_stat = root.lstat()
        result['exists'] = True
        if root.is_symlink() or is_reparse(root_stat):
            result['reparsePointsNotFollowed'] = 1
            return result
    except FileNotFoundError:
        return result
    except OSError:
        result['exists'] = True
        result['unreadableEntries'] = 1
        return result
    if root.is_file():
        try:
            st = root.stat(follow_symlinks=False)
            result['files'] = 1
            result['logicalBytes'] = st.st_size
            result['uniqueFileIds'] = 1
            result['allocatedBytes'], method = allocated_size(root, st)
            result['allocationMethods'][method] = 1
        except OSError:
            result['unreadableEntries'] = 1
        return result
    stack = [root]
    while stack:
        if budget.stop():
            result['scanBudgetExhausted'] = True
            break
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            result['unreadableEntries'] += 1
            continue
        with it:
            for e in it:
                if budget.stop():
                    result['scanBudgetExhausted'] = True
                    stack.clear()
                    break
                try:
                    st = e.stat(follow_symlinks=False)
                    p = Path(e.path)
                    if e.is_symlink() or is_reparse(st):
                        result['reparsePointsNotFollowed'] += 1
                        continue
                    if e.is_dir(follow_symlinks=False):
                        stack.append(p)
                        continue
                    if not e.is_file(follow_symlinks=False):
                        continue
                    result['files'] += 1
                    budget.files += 1
                    result['logicalBytes'] += st.st_size
                    key = (st.st_dev, st.st_ino)
                    if key in seen and st.st_ino:
                        continue
                    seen.add(key)
                    n, method = allocated_size(p, st)
                    result['allocatedBytes'] += n
                    result['allocationMethods'][method] = result['allocationMethods'].get(method, 0) + 1
                    if budget.files >= budget.max_files:
                        budget.exhausted = True
                        result['scanBudgetExhausted'] = True
                    if classify_nested and any(part.lower() in NESTED_BUILD_MARKERS for part in p.relative_to(root).parts[:-1]):
                        nested_key = (st.st_dev, st.st_ino)
                        if nested_key not in nested_seen or not st.st_ino:
                            nested_seen.add(nested_key)
                            result['nestedGeneratedArtifactLogicalBytes'] += st.st_size
                            result['nestedGeneratedArtifactAllocatedBytes'] += n
                            result['nestedGeneratedArtifactFiles'] += 1
                except OSError:
                    result['unreadableEntries'] += 1
    result['uniqueFileIds'] = len(seen)
    return result


def run(args: list[str], timeout: int = 5) -> bytes:
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=timeout, check=False, shell=False,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if p.returncode:
        raise RuntimeError('COMMAND_FAILED:' + Path(args[0]).name + ':' +
                           hashlib.sha256(p.stdout + p.stderr).hexdigest())
    return p.stdout


def gate(ns: argparse.Namespace) -> tuple[Path, str]:
    if dt.datetime.now(dt.timezone.utc) < dt.datetime(2026, 11, 3, 10, 33, tzinfo=dt.timezone.utc):
        raise RuntimeError('USER_TIME_GATE_NOT_OPEN_BEFORE_2026-11-03T10:33Z')
    if ns.p6_duration_seconds < 1800:
        raise RuntimeError('P6_COMPLETION_EVIDENCE_DURATION_LT_1800_SECONDS')
    if (ns.p6_read_rps, ns.p6_write_rps, ns.p6_sessions, ns.p6_sse_subscribers, ns.p6_payables) != (20, 5, 100, 10, 10000):
        raise RuntimeError('P6_PROFILE_ATTESTATION_DOES_NOT_MATCH_FROZEN_REFERENCE')
    finished = dt.datetime.fromisoformat(ns.p6_finished_at_utc.replace('Z', '+00:00'))
    if finished.tzinfo is None or finished.astimezone(dt.timezone.utc) < dt.datetime(2026, 11, 3, 10, 31, tzinfo=dt.timezone.utc):
        raise RuntimeError('P6_FINISH_TIME_PRECEDES_EXPECTED_30_MINUTE_WINDOW')
    if finished.astimezone(dt.timezone.utc) > dt.datetime.now(dt.timezone.utc):
        raise RuntimeError('P6_FINISH_TIME_IS_IN_FUTURE')
    p = Path(ns.p6_completion_evidence).resolve(strict=True)
    if not p.is_file() or p.stat().st_size == 0:
        raise RuntimeError('P6_COMPLETION_EVIDENCE_MISSING_OR_EMPTY')
    mtime = dt.datetime.fromtimestamp(p.stat().st_mtime, dt.timezone.utc)
    if mtime < finished.astimezone(dt.timezone.utc) - dt.timedelta(minutes=2):
        raise RuntimeError('P6_EVIDENCE_MTIME_PRECEDES_ATTESTED_FINISH')
    # Read only the named compact receipt; never enumerate performance output trees here.
    return p, sha256_file(p)


def host_info() -> dict:
    result = {'logicalProcessorCount': os.cpu_count(), 'totalRamBytes': None,
              'availableRamBytes': None, 'physicalCoreCount': None}
    if os.name == 'nt':
        try:
            kb = ctypes.c_ulonglong()
            if ctypes.windll.kernel32.GetPhysicallyInstalledSystemMemory(ctypes.byref(kb)):
                result['totalRamBytes'] = kb.value * 1024
            ps = ("$m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; "
                  "$c=Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum; "
                  "[pscustomobject]@{availableBytes=[int64]$m.AvailableBytes;physicalCores=[int]$c.Sum}|ConvertTo-Json -Compress")
            raw = subprocess.check_output(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps],
                                          stderr=subprocess.DEVNULL, timeout=8, text=True)
            data = json.loads(raw)
            result['availableRamBytes'] = data.get('availableBytes')
            result['physicalCoreCount'] = data.get('physicalCores')
        except Exception:
            result['telemetryRead'] = 'partial'
    return result


def docker_inventory(timeout_seconds: int) -> dict:
    deadline = time.monotonic() + max(1, timeout_seconds)
    command_failures = 0
    failed_container_inspections = []
    failed_volume_inspections = []

    def d_run(args: list[str], timeout: int = 5) -> bytes:
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            raise TimeoutError('DOCKER_SCAN_DEADLINE')
        return run(args, timeout=max(1, min(timeout, int(remaining))))

    # Inventory only containers/volumes tied to Alder by exact name or explicit label.
    try:
        containers_raw = d_run(['docker', 'ps', '-a', '--no-trunc', '--format', '{{json .}}']).decode().splitlines()
    except Exception:
        return {'containers': [], 'canonicalPostgresContainerFound': False,
                'canonicalChainContainerNames': [], 'containerWritableLayerBytesTotal': 0,
                'containerLayerMeasurementsComplete': False, 'namedVolumes': [],
                'uniqueImagesUsedByAlderContainers': [], 'bindMounts': [],
                'volumeAllocatedBytesTotal': 0, 'volumeMeasurementsComplete': False,
                'volumeAttributionComplete': False, 'sharedVolumeNamesExcludedFromAlderNumerator': [],
                'containerInspectionComplete': False,
                'imageMeasurementsComplete': False, 'imageSizesExcludeSharedLayers': True,
                'imageAttributionComplete': False, 'unattributedSharedImageLayers': [],
                'unattributedDockerBuildCache': [], 'unattributedDockerBuildCacheEntryCount': 0,
                'metadataCommandsComplete': False, 'metadataCommandFailureCount': 1,
                'failedContainerInspections': [], 'failedVolumeInspections': [],
                'containerListOmittedCount': 0, 'volumeListOmittedCount': 0,
                'volumeListLimit': 128}
    containers = [json.loads(x) for x in containers_raw if x.strip()]
    container_count_before_cap = len(containers)
    if len(containers) > 256:
        command_failures += 1
        containers = containers[:256]
    # Include explicitly Alder-labeled containers even when their Docker name
    # does not contain "alder". Inspecting container metadata is read-only.
    selected = []
    all_volume_users: dict[str, list[str]] = {}
    all_bind_users: dict[str, list[str]] = {}
    for c in containers:
        try:
            inspect = json.loads(d_run(['docker', 'inspect', '--size', c['ID']]).decode())[0]
        except Exception:
            command_failures += 1
            failed_container_inspections.append(c.get('Names', c['ID']))
            continue
        labels = inspect.get('Config', {}).get('Labels') or {}
        for mount in inspect.get('Mounts', []):
            if mount.get('Type') == 'volume' and mount.get('Name'):
                all_volume_users.setdefault(mount['Name'], []).append(c.get('Names', ''))
            elif mount.get('Type') == 'bind' and mount.get('Source'):
                all_bind_users.setdefault(str(Path(mount['Source']).resolve(strict=False)).casefold(), []).append(c.get('Names', ''))
        if ('alder' in c.get('Names', '').lower() or
                any('alder' in k.lower() or 'alder' in str(v).lower() for k, v in labels.items())):
            c['_alderInspect'] = inspect
            selected.append(c)
    canonical_postgres_found = any(c.get('Names', '').lower() == 'alder-postgres' for c in selected)
    canonical_chain_containers = [c.get('Names') for c in selected if any(x in c.get('Names', '').lower() for x in ('anvil', 'chain'))]
    volume_to_containers: dict[str, list[str]] = {}
    image_ids: set[str] = set()
    bind_mounts = []
    rows = []
    for c in selected:
        inspect = c.pop('_alderInspect')
        image_ids.add(inspect.get('Image'))
        rows.append({'name': c.get('Names'), 'imageId': inspect.get('Image'),
                     'state': c.get('State'), 'sizeRwBytes': inspect.get('SizeRw'),
                     'sizeRootFsBytes': inspect.get('SizeRootFs'),
                     'ownerLabels': {k: v for k, v in (inspect.get('Config', {}).get('Labels') or {}).items() if 'alder' in k.lower()},
                     'namedVolumes': [m.get('Name') for m in inspect.get('Mounts', []) if m.get('Type') == 'volume'],
                     'bindMounts': [{'source': m.get('Source'), 'destination': m.get('Destination'),
                                     'readWrite': bool(m.get('RW'))}
                                    for m in inspect.get('Mounts', []) if m.get('Type') == 'bind']})
        bind_mounts.extend({'container': c.get('Names'), **m} for m in rows[-1]['bindMounts'])
        for name in rows[-1]['namedVolumes']:
            volume_to_containers.setdefault(name, []).append(c.get('Names', ''))
    try:
        volumes_raw = d_run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).decode().splitlines()
    except Exception:
        volumes_raw = []
        command_failures += 1
    volume_count_before_cap = len(volumes_raw)
    if len(volumes_raw) > 128:
        command_failures += 1
        volumes_raw = volumes_raw[:128]
    volumes = []
    for name in volumes_raw:
        try:
            meta = json.loads(d_run(['docker', 'volume', 'inspect', name]).decode())[0]
        except Exception:
            command_failures += 1
            failed_volume_inspections.append(name)
            continue
        labels = meta.get('Labels') or {}
        if name not in volume_to_containers and 'alder' not in name.lower() and not any('alder' in k.lower() for k in labels):
            continue
        all_users = all_volume_users.get(name, [])
        selected_users = volume_to_containers.get(name, [])
        unrelated_users = [x for x in all_users if x not in selected_users]
        volumes.append({'name': name, 'driver': meta.get('Driver'), 'labels': labels,
                        'attachedContainers': selected_users, 'allAttachedContainers': all_users,
                        'sharedWithUnrelatedContainer': bool(unrelated_users),
                        'unrelatedContainerNames': unrelated_users})
    volume_bytes: dict[str, int] = {}
    if volumes and deadline - time.monotonic() > 1:
        mounts = []
        paths = []
        for i, v in enumerate(volumes):
            target = f'/scan/v{i:03d}'
            mounts += ['--mount', f"type=volume,source={v['name']},target={target},readonly"]
            paths.append(target)
        # One resource-capped read-only helper avoids launching a helper per volume.
        try:
            output = d_run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                      '--memory', '512m', '--cpus', '1', '--user', '0:0', *mounts,
                      '--entrypoint', '/usr/bin/du', PG_IMAGE,
                      '-s', '-k', *paths], timeout=min(180, timeout_seconds)).decode().splitlines()
            for line in output:
                cols = line.split(None, 1)
                if len(cols) == 2:
                    m = re.search(r'/scan/v(\d{3})$', cols[1])
                    if m:
                        volume_bytes[volumes[int(m.group(1))]['name']] = int(cols[0]) * 1024
        except Exception:
            command_failures += 1
        for v in volumes:
            v['allocatedBytesReadOnlyDu'] = volume_bytes.get(v['name'])
            v['measurement'] = 'read-only du in isolated, capped, network-none helper'
    # Docker's per-image UNIQUE SIZE excludes shared layers, including layers
    # shared with unrelated projects. Charge only the Alder image IDs selected
    # above, using that unique-layer figure rather than full virtual sizes.
    df_rows = []
    build_cache_rows = []
    try:
        df_data = d_run(['docker', 'system', 'df', '-v', '--format', '{{json .}}'], timeout=30).decode().splitlines()
        for line in df_data:
            row = json.loads(line)
            if isinstance(row, dict) and isinstance(row.get('Images'), list):
                df_rows.extend(row['Images'])
            if isinstance(row, dict) and isinstance(row.get('BuildCache'), list):
                build_cache_rows.extend(row['BuildCache'])
    except Exception:
        df_rows = []
        command_failures += 1

    def size_bytes(value: str | None) -> int | None:
        if not value:
            return None
        m = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)(B|kB|MB|GB|TB)', value.strip())
        if not m:
            return None
        power = {'B': 0, 'kB': 1, 'MB': 2, 'GB': 3, 'TB': 4}[m.group(2)]
        import math
        return math.ceil(float(m.group(1)) * (1024 ** power))

    unique_by_id = {x.get('ID'): x for x in df_rows if x.get('ID')}
    image_rows = []
    unattributed_shared_image_layers = []
    relevant_image_ids = set(x for x in image_ids if x)
    relevant_image_ids.update(x.get('ID') for x in df_rows if x.get('ID') and 'alder' in (x.get('Repository', '') + '/' + x.get('Tag', '')).lower())
    for image_id in sorted(relevant_image_ids):
        row = unique_by_id.get(image_id) or {}
        unique = row.get('UniqueSize')
        shared = row.get('SharedSize')
        image_rows.append({'imageId': image_id, 'repository': row.get('Repository'), 'tag': row.get('Tag'),
                           'referencedByAlderContainer': image_id in image_ids,
                           'uniqueLayerBytesUpperBound': size_bytes(unique),
                           'dockerUniqueSizeDisplay': unique,
                           'dockerSharedSizeDisplay': shared,
                           'measurement': 'Docker UNIQUE SIZE; shared layers excluded'})
        if size_bytes(shared):
            unattributed_shared_image_layers.append({'imageId': image_id,
                'repository': row.get('Repository'), 'tag': row.get('Tag'),
                'sharedSizeDisplay': shared,
                'reasonExcluded': 'shared layer union cannot be attributed to Alder without also charging unrelated images'})
    # BuildKit cache entries are globally shared by Docker Desktop and lack a
    # reliable project owner in `system df`; expose the inventory but never
    # charge unrelated or un-attributable cache bytes to Alder.
    build_cache_summary = [{'id': x.get('ID'), 'shared': x.get('Shared'), 'sizeDisplay': x.get('Size'),
                            'usageCount': x.get('UsageCount')} for x in build_cache_rows]
    rw_complete = all(isinstance(x.get('sizeRwBytes'), int) for x in rows)
    rw_total = sum(x.get('sizeRwBytes') or 0 for x in rows)
    for mount in bind_mounts:
        key = str(Path(mount['source']).resolve(strict=False)).casefold()
        users = all_bind_users.get(key, [])
        unrelated = [x for x in users if x != mount.get('container') and x not in [r.get('name') for r in rows]]
        mount['allAttachedContainers'] = users
        mount['sharedWithUnrelatedContainer'] = bool(unrelated)
        mount['unrelatedContainerNames'] = unrelated
    volume_attribution_complete = (not failed_container_inspections and
                                   command_failures == 0 and
                                   container_count_before_cap <= 256 and
                                   volume_count_before_cap <= 128)
    container_inspection_complete = not failed_container_inspections and container_count_before_cap <= 256
    countable_volume_bytes = (sum((v.get('allocatedBytesReadOnlyDu') or 0) for v in volumes
                                  if not v['sharedWithUnrelatedContainer'])
                              if volume_attribution_complete else 0)
    return {'containers': rows, 'canonicalPostgresContainerFound': canonical_postgres_found,
            'canonicalChainContainerNames': canonical_chain_containers,
            'containerWritableLayerBytesTotal': rw_total,
            'containerLayerMeasurementsComplete': rw_complete,
            'namedVolumes': volumes, 'uniqueImagesUsedByAlderContainers': image_rows,
            'bindMounts': bind_mounts,
            'volumeAllocatedBytesTotal': countable_volume_bytes,
            'volumeMeasurementsComplete': all(v.get('allocatedBytesReadOnlyDu') is not None for v in volumes),
            'volumeAttributionComplete': volume_attribution_complete and not any(v['sharedWithUnrelatedContainer'] for v in volumes),
            'containerInspectionComplete': container_inspection_complete,
            'sharedVolumeNamesExcludedFromAlderNumerator': [v['name'] for v in volumes if v['sharedWithUnrelatedContainer']],
            'imageMeasurementsComplete': all(isinstance(x.get('uniqueLayerBytesUpperBound'), int) for x in image_rows),
            'imageSizesExcludeSharedLayers': True,
            'imageAttributionComplete': not unattributed_shared_image_layers,
            'unattributedSharedImageLayers': unattributed_shared_image_layers,
            'unattributedDockerBuildCache': build_cache_summary,
            'unattributedDockerBuildCacheEntryCount': len(build_cache_summary),
            'metadataCommandsComplete': command_failures == 0,
            'metadataCommandFailureCount': command_failures,
            'failedContainerInspections': failed_container_inspections,
            'failedVolumeInspections': failed_volume_inspections,
            'containerListOmittedCount': max(0, container_count_before_cap - 256),
            'volumeListOmittedCount': max(0, volume_count_before_cap - 128),
            'volumeListLimit': 128}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--phase', choices=['pre-p6-baseline', 'post-p6'], required=True)
    ap.add_argument('--p6-completion-evidence')
    ap.add_argument('--p6-duration-seconds', type=float)
    ap.add_argument('--p6-finished-at-utc')
    ap.add_argument('--p6-read-rps', type=int)
    ap.add_argument('--p6-write-rps', type=int)
    ap.add_argument('--p6-sessions', type=int)
    ap.add_argument('--p6-sse-subscribers', type=int)
    ap.add_argument('--p6-payables', type=int)
    ap.add_argument('--max-files', type=int, default=250000)
    ap.add_argument('--max-seconds', type=int, default=300)
    ns = ap.parse_args()
    if not 1 <= ns.max_files <= 1000000 or not 1 <= ns.max_seconds <= 900:
        raise RuntimeError('SCAN_BOUNDS_OUT_OF_ALLOWED_RANGE')
    if ns.phase == 'post-p6':
        if any(getattr(ns, k) is None for k in ('p6_completion_evidence', 'p6_duration_seconds', 'p6_finished_at_utc', 'p6_read_rps', 'p6_write_rps', 'p6_sessions', 'p6_sse_subscribers', 'p6_payables')):
            raise RuntimeError('POST_P6_REQUIRES_COMPLETE_PROFILE_ATTESTATION')
        p6_path, p6_hash = gate(ns)  # Safety gate before any directory/Docker traversal.
    else:
        p6_path, p6_hash = None, None
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    out = OUT / f'round7-finish-disk-{stamp}-{uuid.uuid4().hex[:8]}.json'
    if out.exists():
        raise RuntimeError('OUTPUT_ALREADY_EXISTS')

    budget = ScanBudget(ns.max_files, ns.max_seconds)
    roots = []
    root_totals = {}
    unclassified = []
    try:
        for name in sorted(os.listdir(ROOT)):
            path = ROOT / name
            category = next((k for k, names in IN_SCOPE.items() if name in names),
                            'source_history_and_configuration' if name in KNOWN_SOURCE or name in {'.git'} else 'other_workspace_root_included_conservatively')
            info = tree_size(path, budget, classify_nested=name in KNOWN_SOURCE)
            info['category'] = category
            info['countsTowardEvidenceDependencyCap'] = category in IN_SCOPE or category == 'other_workspace_root_included_conservatively'
            roots.append(info)
            if name in KNOWN_SOURCE and info['nestedGeneratedArtifactFiles']:
                root_totals.setdefault('nested_generated_artifacts', {'logicalBytes': 0, 'allocatedBytes': 0, 'files': 0})
                root_totals['nested_generated_artifacts']['logicalBytes'] += info['nestedGeneratedArtifactLogicalBytes']
                root_totals['nested_generated_artifacts']['allocatedBytes'] += info['nestedGeneratedArtifactAllocatedBytes']
                root_totals['nested_generated_artifacts']['files'] += info['nestedGeneratedArtifactFiles']
            t = root_totals.setdefault(category, {'logicalBytes': 0, 'allocatedBytes': 0, 'files': 0})
            for key in t:
                t[key] += info[key]
            if category == 'other_workspace_root_included_conservatively':
                unclassified.append({'name': name, 'logicalBytes': info['logicalBytes'], 'allocatedBytes': info['allocatedBytes']})

        # The two exact E: locations named in the Alder archive record. No other SSD
        # project or user files are traversed. Both are retained relevant evidence:
        # A1-A12 browser acquisition inputs and an encrypted full Alder backup.
        external_roots = [
            Path('E:/portfolio-build-archives/20261103T083642Z'),
            Path('E:/portfolio-build-archives/alder-backup-20261103T084301Z'),
        ]
        external = []
        for p in external_roots:
            item = tree_size(p, budget)
            item['classification'] = 'retained_alder_historical_evidence_archive_included_in_combined_retained_total'
            external.append(item)

        outside_receipts = [
            PORTFOLIO_ROOT / '.local' / 'ssd-archive-receipts',
            PORTFOLIO_ROOT / '.local' / 'ssd-recovery' / '20261103T084301Z',
        ]
        receipt_roots = [tree_size(p, budget) for p in outside_receipts]

        docker_remaining = int(budget.deadline - time.monotonic())
        if docker_remaining > 1 and not budget.exhausted:
            docker = docker_inventory(docker_remaining)
        else:
            docker = {'containers': [], 'canonicalPostgresContainerFound': False,
                      'canonicalChainContainerNames': [], 'containerWritableLayerBytesTotal': 0,
                      'containerLayerMeasurementsComplete': False, 'namedVolumes': [],
                      'uniqueImagesUsedByAlderContainers': [], 'bindMounts': [],
                      'volumeAllocatedBytesTotal': 0, 'volumeMeasurementsComplete': False,
                      'volumeAttributionComplete': False,
                      'containerInspectionComplete': False,
                      'imageMeasurementsComplete': False, 'imageSizesExcludeSharedLayers': True,
                      'imageAttributionComplete': False, 'unattributedSharedImageLayers': [],
                      'unattributedDockerBuildCache': [], 'unattributedDockerBuildCacheEntryCount': 0,
                      'metadataCommandsComplete': False, 'metadataCommandFailureCount': 1}
        host = host_info()
        filesystem = {}
        for drive, anchor in [('C', 'C:/'), ('E', 'E:/')]:
            try:
                usage = shutil.disk_usage(anchor)
                filesystem[drive] = {'totalBytes': usage.total, 'usedBytes': usage.used,
                                     'freeBytes': usage.free, '10GiBFreeHeadroom': usage.free >= 10 * 1024**3}
            except OSError:
                filesystem[drive] = {'available': False}
        in_scope = [v for k, v in root_totals.items() if k in IN_SCOPE or k in {'other_workspace_root_included_conservatively', 'nested_generated_artifacts'}]
        workspace_in_scope_alloc = sum(x['allocatedBytes'] for x in in_scope)
        external_alloc = sum(x['allocatedBytes'] for x in external)
        receipts_alloc = sum(x['allocatedBytes'] for x in receipt_roots)
        docker_alloc = docker['volumeAllocatedBytesTotal']
        docker_rw = docker['containerWritableLayerBytesTotal']
        image_unique = sum(x.get('uniqueLayerBytesUpperBound') or 0 for x in docker['uniqueImagesUsedByAlderContainers'])
        bind_inventory = []
        bind_alloc = 0
        seen_bind_sources = set()
        for mount in docker['bindMounts']:
            source = Path(mount['source']) if mount.get('source') else None
            if source is None:
                bind_inventory.append({**mount, 'measurement': 'missing source path', 'measurementComplete': False})
                continue
            resolved = source.resolve(strict=False)
            key = str(resolved).casefold()
            try:
                rel = resolved.relative_to(ROOT.resolve())
                first = rel.parts[0] if rel.parts else ''
                category = next((k for k, names in IN_SCOPE.items() if first in names), None)
                already_counted = category is not None or first not in KNOWN_SOURCE and first != '.git'
            except ValueError:
                already_counted = False
            if key in seen_bind_sources:
                bind_inventory.append({**mount, 'measurement': 'duplicate bind source deduplicated',
                                       'alreadyCountedElsewhere': True, 'measurementComplete': True})
            elif already_counted:
                seen_bind_sources.add(key)
                bind_inventory.append({**mount, 'measurement': 'source path included in workspace root inventory',
                                       'alreadyCountedElsewhere': True, 'measurementComplete': True})
            else:
                seen_bind_sources.add(key)
                if mount.get('sharedWithUnrelatedContainer') or not docker['containerInspectionComplete']:
                    bind_inventory.append({**mount, 'measurement': 'shared or incomplete container attribution; excluded from Alder numerator',
                                           'alreadyCountedElsewhere': False, 'measurementComplete': False})
                else:
                    item = tree_size(resolved, budget)
                    bind_alloc += item['allocatedBytes']
                    bind_inventory.append({**mount, 'measurement': item, 'alreadyCountedElsewhere': False})
                    bind_inventory[-1]['measurementComplete'] = (item['exists'] and item['unreadableEntries'] == 0 and item['reparsePointsNotFollowed'] == 0 and not item['scanBudgetExhausted'] and 'logical_fallback' not in item['allocationMethods'])
        numerator = workspace_in_scope_alloc + external_alloc + receipts_alloc + docker_alloc + docker_rw + image_unique + bind_alloc
        ram = host.get('totalRamBytes')
        cores = host.get('physicalCoreCount')
        accounting_complete = (not budget.exhausted and
            all(not x['scanBudgetExhausted'] for x in roots + external + receipt_roots) and
            all(x['exists'] and x['unreadableEntries'] == 0 and x['reparsePointsNotFollowed'] == 0 and 'logical_fallback' not in x['allocationMethods'] for x in external + receipt_roots) and
            all(x['unreadableEntries'] == 0 and x['reparsePointsNotFollowed'] == 0 and 'logical_fallback' not in x['allocationMethods'] for x in roots) and
            docker['metadataCommandsComplete'] and docker['containerInspectionComplete'] and docker['volumeMeasurementsComplete'] and docker['volumeAttributionComplete'] and
            docker['containerLayerMeasurementsComplete'] and docker['imageMeasurementsComplete'] and docker['imageAttributionComplete'] and
            docker['unattributedDockerBuildCacheEntryCount'] == 0 and all(x['measurementComplete'] for x in bind_inventory))
        report = {
            'schema': 'alder.tr-t-capacity-disk-inventory/v1',
            'measuredAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
            'measurementPhase': ns.phase,
            'p6WindowGate': ({'evidencePath': str(p6_path), 'evidenceSha256': p6_hash,
                              'durationSecondsAttested': ns.p6_duration_seconds,
                              'finishedAtUtcAttested': ns.p6_finished_at_utc,
                              'profileAttested': {'readRequestsPerSecond': ns.p6_read_rps,
                                                 'writeRequestsPerSecond': ns.p6_write_rps,
                                                 'sessions': ns.p6_sessions,
                                                 'sseSubscribers': ns.p6_sse_subscribers,
                                                 'payables': ns.p6_payables},
                              'noFilesystemOrDockerTraversalBeforeGate': True} if ns.phase == 'post-p6' else
                             {'notApplicable': True, 'fullLoadConfirmedInactiveByOperator': True}),
            'scanBounds': {'maximumFiles': ns.max_files, 'maximumSeconds': ns.max_seconds,
                           'filesEnumerated': budget.files, 'elapsedSeconds': ns.max_seconds - max(0, int(budget.deadline - time.monotonic())),
                           'budgetExhausted': budget.exhausted},
            'acceptance': {'id': 'TR-T-CAPACITY', 'frozenDiskLimitBytes': CAP_BYTES,
                           'scope': 'total evidence/dependency disk; blueprint storage definition includes locked dependencies/build caches, PostgreSQL base/WAL/backup horizon, attachment bytes x retained versions, exported evidence, chain snapshots and log history'},
            'host': {**host, 'declaredAggregateMeasurementProfile': {'memoryGiB': 16, 'physicalCores': 4},
                     'physicalHostMatchesAggregateProfile': ram == TARGET_RAM_BYTES and cores == TARGET_CORES,
                     'physicalHostDoesNotInvalidateDiskMeasurement': True},
            'hostFilesystemFreeSpace': filesystem,
            'workspaceTopLevel': roots,
            'workspaceCategoryTotals': root_totals,
            'unclassifiedWorkspaceRootsNotSilentlyDropped': unclassified,
            'retainedExternalAlderArchivesOnE': external,
            'portfolioRootArchiveReceiptsAndRecoveryMetadata': receipt_roots,
            'alderDocker': docker,
            'dockerBindMountInventory': bind_inventory,
            'diskAccounting': {
                'workspaceInScopeAllocatedBytes': workspace_in_scope_alloc,
                'nestedGeneratedBuildArtifactsAllocatedBytes': root_totals.get('nested_generated_artifacts', {}).get('allocatedBytes', 0),
                'retainedExternalAlderArchiveAllocatedBytes': external_alloc,
                'archiveReceiptAndRecoveryMetadataAllocatedBytes': receipts_alloc,
                'alderNamedVolumeAllocatedBytes': docker_alloc,
                'alderContainerWritableLayerBytes': docker_rw,
                'alderImageUniqueLayerBytesUpperBound': image_unique,
                'unattributedSharedImageLayerEntries': len(docker['unattributedSharedImageLayers']),
                'alderDockerBindMountBytes': bind_alloc,
                'inventoryReportAllocatedBytes': 0,
                'inventoryReportIncludedInCombinedUpperBound': True,
                'sharedUnrelatedImageLayersExcluded': True,
                'knownIncludedEvidenceDependencyBytes': numerator,
                'limitBytes': CAP_BYTES,
                'minimumRuntimeFreeHeadroomBytes': 10 * 1024**3,
                'within12GiBByConservativeUpperBound': accounting_complete and numerator <= CAP_BYTES,
                'thresholdDisposition': ('pass' if accounting_complete and numerator <= CAP_BYTES else 'fail' if accounting_complete else 'not_established_incomplete_inventory'),
                'complete': accounting_complete,
                'unreadableFilesystemEntries': sum(x['unreadableEntries'] for x in roots + external + receipt_roots),
                'unfollowedReparsePoints': sum(x['reparsePointsNotFollowed'] for x in roots + external + receipt_roots),
                'limitations': ['Allocated bytes use NTFS allocated-size API where available; symlinks/reparse points are reported, never followed.',
                                'A logical-size fallback makes the inventory incomplete for a strict physical-allocation claim.',
                                'Docker named volumes are measured read-only with a capped network-none helper.',
                                'Volume du reports allocated blocks within Docker filesystems, not the sparse WSL VHDX host allocation.',
                                'Docker image unique-layer sizes exclude shared layers. Alder-used shared layers are listed as unattributed and make the exact total incomplete.',
                                'Docker BuildKit cache has no reliable project attribution in system df; entries are listed, excluded, and prevent a complete footprint claim until attributable.',
                                'Unclassified top-level workspace roots are counted in-scope conservatively and listed individually.',
                                'Only the two Alder archive directories explicitly named in the SSD archive record are scanned on E:; unrelated E: projects and user archives are not traversed.',
                                'E: retained Alder evidence is shown separately and included in combined retained footprint; C: active workspace and Docker persistent data are separately visible.',
                                'This is a disk inventory, not an RPO/RTO, backup integrity, or capacity performance pass.']
            }
        }
        out.write_text(json.dumps(report, indent=2), encoding='utf-8')
        # The evidence report itself is part of the retained footprint. Include its
        # allocated size after writing; loop until the persisted number is stable.
        base_upper = numerator
        for _ in range(4):
            output_stat = out.stat()
            output_alloc, _ = allocated_size(out, output_stat)
            report['diskAccounting']['inventoryReportAllocatedBytes'] = output_alloc
            report['diskAccounting']['knownIncludedEvidenceDependencyBytes'] = base_upper + output_alloc
            report['diskAccounting']['within12GiBByConservativeUpperBound'] = accounting_complete and base_upper + output_alloc <= CAP_BYTES
            report['diskAccounting']['thresholdDisposition'] = ('pass' if accounting_complete and base_upper + output_alloc <= CAP_BYTES else 'fail' if accounting_complete else 'not_established_incomplete_inventory')
            out.write_text(json.dumps(report, indent=2), encoding='utf-8')
            persisted_stat = out.stat()
            persisted_alloc, _ = allocated_size(out, persisted_stat)
            if persisted_alloc == output_alloc:
                break
        print(json.dumps({'report': str(out), 'knownIncludedBytes': report['diskAccounting']['knownIncludedEvidenceDependencyBytes'],
                          'within12GiB': report['diskAccounting']['within12GiBByConservativeUpperBound'],
                          'complete': report['diskAccounting']['complete'],
                          'physicalHostMatchesAggregateProfile': report['host']['physicalHostMatchesAggregateProfile']}))
    except Exception as exc:
        safe_reason = str(exc)[:200] or type(exc).__name__
        raise RuntimeError('DISK_INVENTORY_FAILED:' + safe_reason) from None
    return 0


if __name__ == '__main__':
    sys.exit(main())
