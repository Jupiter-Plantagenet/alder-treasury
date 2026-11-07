"""Bounded isolated restore of the retained Round 6 Alder backup.

The target is a new, no-network PostgreSQL container with no host port or volume.
The retained Alder database is queried read-only for digest comparison only.
Raw command output stays in the private run directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

EXPECTED_MANIFEST = 'd2ae2e7c23933e84b1151233eafcae71bc3b8c7a668d46ceae38df9d951a40db'
EXPECTED_DUMP = 'd827c791'
EXPECTED_GENESIS = '0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec'
EXPECTED_CHAIN_ID = '0x7a69'
EXPECTED_HEAD_FLOOR = 3442
IMAGE = 'sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
ROOT = Path(__file__).resolve().parents[1]
BACKUP = ROOT / '.local/backups/codex-round6-20261102T090300Z'


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run(args: list[str], *, timeout: int = 60, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=timeout, check=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--evidence', type=Path, required=True)
    ap.add_argument('--raw', type=Path, required=True)
    args = ap.parse_args()
    evidence = args.evidence.resolve()
    raw = args.raw.resolve()
    if not evidence.is_relative_to(ROOT / '.local') or not raw.is_relative_to(ROOT / '.local'):
        raise RuntimeError('EVIDENCE_PATH_OUTSIDE_PRIVATE_LOCAL')
    evidence.parent.mkdir(parents=True, exist_ok=True)
    raw.mkdir(parents=True, exist_ok=False)
    container = 'alder-tr-restore-' + datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    owner = 'alder-round6-restore-' + os.urandom(8).hex()
    label_owner = 'com.portfolio.restore-owner'
    created = False
    report: dict = {'scope': 'isolated PostgreSQL restore and read-only comparison',
                    'started_at': datetime.now(timezone.utc).isoformat(),
                    'retained_database_write': False, 'chain_or_service_write': False,
                    'network': 'none', 'published_ports': 0, 'host_volumes': 0,
                    'cleanup': 'pending'}

    def save_log(name: str, result: subprocess.CompletedProcess) -> None:
        (raw / name).write_bytes(result.stdout + result.stderr)

    def docker(args_: list[str], *, timeout: int = 60, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
        result = run(['docker', *args_], timeout=timeout, input_bytes=input_bytes)
        return result

    try:
        manifest_path = BACKUP / 'manifest.json'
        manifest_bytes = manifest_path.read_bytes()
        report['manifest_sha256'] = hashlib.sha256(manifest_bytes).hexdigest()
        if report['manifest_sha256'] != EXPECTED_MANIFEST:
            raise RuntimeError('BACKUP_MANIFEST_PIN_MISMATCH')
        manifest = json.loads(manifest_bytes)
        if manifest.get('database') != 'alder' or manifest.get('chain_snapshot', {}).get('capture_mode') != 'offline-state-file':
            raise RuntimeError('BACKUP_SCOPE_OR_CHAIN_CAPTURE_MISMATCH')
        chain = manifest['chain_snapshot']
        report['chain_snapshot'] = {k: chain.get(k) for k in
                                    ('capture_mode', 'chain_id', 'genesis_hash', 'head_number',
                                     'best_block_number', 'block_count', 'source_state_sha256')}
        if (chain.get('chain_id') != EXPECTED_CHAIN_ID or chain.get('genesis_hash', '').lower() != EXPECTED_GENESIS
                or int(chain.get('head_number', -1)) < EXPECTED_HEAD_FLOOR
                or int(chain.get('best_block_number', -1)) < EXPECTED_HEAD_FLOOR):
            raise RuntimeError('BACKUP_CHAIN_LINEAGE_INVALID')

        # Verify every manifest-pinned artifact without disclosing file contents or names.
        checked = 0
        mismatches = 0
        for relative, item in manifest.get('files', {}).items():
            candidate = (BACKUP / Path(relative)).resolve(strict=True)
            if not candidate.is_relative_to(BACKUP.resolve()) or candidate.is_symlink() or not candidate.is_file():
                mismatches += 1
                continue
            checked += 1
            if candidate.stat().st_size != item.get('bytes') or sha(candidate) != item.get('sha256'):
                mismatches += 1
        report['artifact_file_count'] = checked
        report['artifact_digest_mismatches'] = mismatches
        if checked != len(manifest.get('files', {})) or mismatches:
            raise RuntimeError('BACKUP_ARTIFACT_DIGEST_MISMATCH')
        dump = BACKUP / 'alder.dump'
        roles = BACKUP / 'roles.sql'
        if not dump.is_file() or not roles.is_file() or not sha(dump).startswith(EXPECTED_DUMP):
            raise RuntimeError('BACKUP_DUMP_OR_ROLES_INVALID')
        report['dump_sha256'] = sha(dump)
        report['roles_sha256'] = sha(roles)
        listing = docker(['exec', '-i', 'alder-postgres', 'pg_restore', '--list'], timeout=30,
                         input_bytes=dump.read_bytes())
        save_log('pg-restore-list.private.log', listing)
        if listing.returncode:
            raise RuntimeError('BACKUP_ARCHIVE_LIST_FAILED')
        report['pg_restore_list_exit'] = listing.returncode
        report['pg_restore_list_bytes'] = len(listing.stdout)

        # Recheck target uniqueness and bind the disposable container to this owner token.
        inspect = docker(['inspect', container], timeout=10)
        if inspect.returncode == 0:
            raise RuntimeError('SCRATCH_CONTAINER_NAME_COLLISION')
        created_result = docker(['create', '--name', container, '--network', 'none',
                                 '--memory', '512m', '--cpus', '2', '--pids-limit', '64',
                                 '--env', 'POSTGRES_USER=alder_restore_admin',
                                 '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
                                 '--label', f'{label_owner}={owner}', '--label', 'com.portfolio.product=alder',
                                 IMAGE], timeout=30)
        save_log('container-create.private.log', created_result)
        if created_result.returncode:
            raise RuntimeError('SCRATCH_CONTAINER_CREATE_FAILED')
        container_id = created_result.stdout.decode(errors='replace').strip()
        if len(container_id) < 12:
            raise RuntimeError('SCRATCH_CONTAINER_ID_INVALID')
        created = True
        report['container_id_prefix'] = container_id[:12]
        isolation = docker(['inspect', '--format',
                            '{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}',
                            container_id], timeout=10)
        if isolation.returncode:
            raise RuntimeError('SCRATCH_ISOLATION_INSPECT_FAILED')
        isolation_parts = isolation.stdout.decode(errors='replace').strip().split('|')
        report['container_isolation_assertions'] = {
            'network_none': len(isolation_parts) == 3 and isolation_parts[0] == 'none',
            'no_published_ports': len(isolation_parts) == 3 and isolation_parts[1] in ('null', '[]'),
            'no_host_mounts': len(isolation_parts) == 3 and isolation_parts[2] == '[]',
        }
        if not all(report['container_isolation_assertions'].values()):
            raise RuntimeError('SCRATCH_ISOLATION_ASSERTION_FAILED')
        started = docker(['start', container_id], timeout=30)
        save_log('container-start.private.log', started)
        if started.returncode:
            raise RuntimeError('SCRATCH_CONTAINER_START_FAILED')

        ready = False
        for _ in range(60):
            state = docker(['inspect', '--format', '{{.State.Running}}|{{.State.ExitCode}}', container_id], timeout=5)
            if state.returncode or not state.stdout.decode(errors='replace').strip().startswith('true|'):
                logs = docker(['logs', container_id], timeout=10)
                save_log('postgres-startup.private.log', logs)
                raise RuntimeError('SCRATCH_POSTGRES_EXITED')
            probe = docker(['exec', container_id, 'pg_isready', '-U', 'alder_restore_admin', '-d', 'postgres'], timeout=5)
            if probe.returncode == 0:
                ready = True
                break
            time.sleep(1)
        report['postgres_ready'] = ready
        if not ready:
            raise RuntimeError('SCRATCH_POSTGRES_READY_TIMEOUT')

        # Restore only into the new container. Keep potentially sensitive SQL output private.
        pre_roles_result = docker(['exec', container_id, 'psql', '-U', 'alder_restore_admin', '-d', 'postgres',
                                   '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
                                   'SELECT rolname FROM pg_roles ORDER BY rolname'], timeout=30)
        if pre_roles_result.returncode:
            raise RuntimeError('SCRATCH_PREIMPORT_ROLE_SNAPSHOT_FAILED')
        role_result = docker(['exec', '-i', container_id, 'psql', '-U', 'alder_restore_admin', '-d', 'postgres',
                              '-X', '-v', 'ON_ERROR_STOP=1'],
                             timeout=90, input_bytes=roles.read_bytes())
        save_log('roles-restore.private.log', role_result)
        report['roles_restore_exit'] = role_result.returncode
        if role_result.returncode:
            raise RuntimeError('SCRATCH_ROLES_RESTORE_FAILED')
        target_db = 'alder_round6_restore'
        createdb = docker(['exec', container_id, 'createdb', '-U', 'alder_restore_admin', '-T', 'template0', target_db], timeout=30)
        save_log('createdb.private.log', createdb)
        if createdb.returncode:
            raise RuntimeError('SCRATCH_DATABASE_CREATE_FAILED')
        with dump.open('rb') as stream:
            restore = docker(['exec', '-i', container_id, 'pg_restore', '-U', 'alder_restore_admin',
                              '--exit-on-error', '--dbname', target_db], timeout=600,
                             input_bytes=stream.read())
        save_log('pg-restore.private.log', restore)
        report['restore_exit'] = restore.returncode
        if restore.returncode:
            raise RuntimeError('SCRATCH_PG_RESTORE_FAILED')

        def query(cid: str, db: str, sql: str, *, timeout: int = 60) -> str:
            user = 'alder_restore_admin' if cid == container_id else 'postgres'
            result = docker(['exec', cid, 'psql', '-U', user, '-d', db, '-X', '-At',
                             '-v', 'ON_ERROR_STOP=1', '-c', sql], timeout=timeout)
            if result.returncode:
                raise RuntimeError('READONLY_DIGEST_QUERY_FAILED')
            return result.stdout.decode(errors='replace').strip()

        tables_sql = "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        target_tables = query(container_id, target_db, tables_sql).splitlines()
        source_tables = query('alder-postgres', 'alder', tables_sql).splitlines()
        report['restored_public_table_count'] = len(target_tables)
        report['source_public_table_count'] = len(source_tables)
        if target_tables != source_tables:
            raise RuntimeError('PUBLIC_TABLE_SET_MISMATCH')

        def table_digests(cid: str, db: str, names: list[str]) -> dict[str, str]:
            values: dict[str, str] = {}
            for name in names:
                ident = '"' + name.replace('"', '""') + '"'
                sql = (f"SELECT count(*)::text||':'||coalesce(md5(string_agg(md5(t::text),'' "
                       f"ORDER BY md5(t::text))),'') FROM public.{ident} t")
                values[name] = query(cid, db, sql, timeout=120)
            return values

        source_digests = table_digests('alder-postgres', 'alder', source_tables)
        target_digests = table_digests(container_id, target_db, target_tables)
        mismatched = [name for name in target_tables if source_digests[name] != target_digests[name]]
        report['table_digest_count'] = len(target_tables)
        report['table_digest_mismatch_count'] = len(mismatched)
        report['table_digest_mismatch_names'] = mismatched

        acl_sql = ("SELECT string_agg(relname||'|'||coalesce(relacl::text,'')||'|'||relrowsecurity||'|'||"
                   "relforcerowsecurity,E'\\n' ORDER BY relname) FROM pg_class c JOIN pg_namespace n "
                   "ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind IN ('r','v','S')")
        policy_sql = ("SELECT string_agg(tablename||'|'||policyname||'|'||array_to_string(roles,',')||'|'||cmd||'|'||"
                      "coalesce(qual,'')||'|'||coalesce(with_check,''),E'\\n' ORDER BY tablename,policyname) FROM pg_policies")
        role_sql = ("SELECT string_agg(rolname||'|'||rolsuper||'|'||rolbypassrls||'|'||rolcanlogin||'|'||"
                    "rolinherit||'|'||rolcreaterole||'|'||rolcreatedb,E'\\n' ORDER BY rolname) FROM pg_roles "
                    "WHERE rolname LIKE 'alder%' OR rolname='postgres'")
        grants_sql = ("SELECT string_agg(grantee||'|'||table_schema||'|'||table_name||'|'||privilege_type||'|'||"
                      "is_grantable,E'\\n' ORDER BY grantee,table_schema,table_name,privilege_type) "
                      "FROM information_schema.role_table_grants WHERE grantee LIKE 'alder%'")
        metadata: dict[str, bool] = {}
        for label, sql in (('acl_rls', acl_sql), ('policies', policy_sql), ('roles', role_sql), ('role_table_grants', grants_sql)):
            src = query('alder-postgres', 'alder', f'SELECT md5(coalesce(({sql}),\'\'))')
            dst = query(container_id, target_db, f'SELECT md5(coalesce(({sql}),\'\'))')
            metadata[label] = src == dst
        report['metadata_digests_equal'] = metadata
        report['invalid_indexes'] = int(query(container_id, target_db,
            'SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready'))
        report['unvalidated_constraints'] = int(query(container_id, target_db,
            "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated"))
        report['table_digests_equal'] = not mismatched
        report['restore_pass'] = (report['table_digests_equal'] and all(metadata.values())
                                  and report['invalid_indexes'] == 0 and report['unvalidated_constraints'] == 0)
        report['broadcast_execution'] = 'not_run; no application or chain service was started'
    except Exception as exc:
        report['error_category'] = str(exc) if str(exc).isupper() else type(exc).__name__
        report['restore_pass'] = False
    finally:
        if created:
            inspect = docker(['inspect', '--format', '{{ index .Config.Labels "' + label_owner + '" }}', container], timeout=10)
            owned = inspect.returncode == 0 and inspect.stdout.decode(errors='replace').strip() == owner
            report['container_owner_verified_before_cleanup'] = owned
            if owned:
                removed = docker(['rm', '-f', container], timeout=30)
                save_log('container-remove.private.log', removed)
                report['cleanup'] = 'removed_exact_owned_container' if removed.returncode == 0 else 'owned_container_remove_failed'
            else:
                report['cleanup'] = 'refused_unverified_container'
        else:
            report['cleanup'] = 'no_container_created'
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        evidence.parent.mkdir(parents=True, exist_ok=True)
        with evidence.open('x', encoding='utf-8') as stream:
            json.dump(report, stream, indent=2)
        print(json.dumps({'evidence': str(evidence), 'raw_directory': str(raw),
                          'restore_pass': report.get('restore_pass'),
                          'error_category': report.get('error_category'),
                          'cleanup': report.get('cleanup')}))
    return 0 if report.get('restore_pass') else 2


if __name__ == '__main__':
    sys.exit(main())
