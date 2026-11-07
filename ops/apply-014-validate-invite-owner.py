"""Apply only migration 014 after coordinator backup/lock admission.

The SQL transaction snapshots invite/audit rows, validates the existing check,
journals the exact migration bytes, then refuses to commit unless lineage,
constraint validation, and row preservation all match the preflight state.
"""
import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_012 = '88d34c3a3ce1ccbeab838c183a089191e90eeb20e05d9124710845ae933cf2f9'
EXPECTED_014 = 'cd4e068895f0f0765a2dff1cb44b35c7a44b1e0d1125e7825001f7cdf589a203'
EXPECTED_INVITES = 'd1c647aef816700a117e319a3f904819808c8e9f03fb320f2a941a7bda89cbe7'
EXPECTED_MEMBERSHIP_EVENTS = '92d327b8f5e57d6447ae7ffead48a967a7514b8fe831944c9442c639da907afb'
MIGRATION = ROOT / 'db/014-validate-invite-owner.sql'
DB = 'alder'
SQL_DIAGNOSTIC: Path | None = None


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sql(query: str) -> str:
    result = subprocess.run(
        ['docker', 'exec', '-i', 'alder-postgres', 'psql', '-U', 'postgres',
         '-d', DB, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
        input=query, capture_output=True, text=True, encoding='utf-8')
    if result.returncode:
        if SQL_DIAGNOSTIC is not None:
            with SQL_DIAGNOSTIC.open('ab') as stream:
                stream.write(result.stdout.encode('utf-8', errors='replace'))
                stream.write(result.stderr.encode('utf-8', errors='replace'))
        raise RuntimeError('DATABASE_PREFLIGHT_OR_APPLY_FAILED; inspect private SQL diagnostic')
    return result.stdout.strip()


def snapshot() -> dict:
    query = """SELECT json_build_object(
      'invites',coalesce((SELECT json_agg(to_jsonb(i) ORDER BY i.workspace_id,i.id) FROM public.membership_invites i),'[]'::json),
      'events',coalesce((SELECT json_agg(to_jsonb(e) ORDER BY e.id) FROM public.membership_events e),'[]'::json),
      'counts',(SELECT json_build_object(
        'invite_count',count(*)::int,
        'owner_role_violations',count(*) FILTER(WHERE 'owner'=ANY(i.roles))::int,
        'accepted',count(*) FILTER(WHERE i.accepted_at IS NOT NULL)::int,
        'revoked',count(*) FILTER(WHERE i.revoked_at IS NOT NULL)::int,
        'open',count(*) FILTER(WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL)::int,
        'audit_linked',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM public.membership_events e WHERE e.workspace_id=i.workspace_id AND e.invite_id=i.id))::int,
        'audit_missing',count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM public.membership_events e WHERE e.workspace_id=i.workspace_id AND e.invite_id=i.id))::int)
        FROM public.membership_invites i)
    )::text"""
    value = json.loads(sql(query))
    return {
        **value['counts'],
        'invites_sha256': sha(json.dumps(value['invites'], separators=(',', ':'), ensure_ascii=False).encode()),
        'membership_events_sha256': sha(json.dumps(value['events'], separators=(',', ':'), ensure_ascii=False).encode()),
    }


def resolved_under(path: Path, base: Path) -> Path:
    root_lexical = ROOT.absolute()
    base_lexical = base.absolute()
    candidate_lexical = path.absolute()
    try:
        base_lexical.relative_to(root_lexical)
        candidate_lexical.relative_to(base_lexical)
    except ValueError as exc:
        raise RuntimeError('PATH_OUTSIDE_APPROVED_ALDER_LOCAL_ROOT') from exc
    cursor = candidate_lexical
    while cursor != root_lexical:
        st = os.lstat(cursor)
        if (getattr(st, 'st_file_attributes', 0) & 0x400) or Path(cursor).is_symlink():
            raise RuntimeError('REPARSE_OR_SYMLINK_PATH_REFUSED')
        cursor = cursor.parent
    st = os.lstat(root_lexical)
    if (getattr(st, 'st_file_attributes', 0) & 0x400) or base_lexical.is_symlink():
        raise RuntimeError('REPARSE_OR_SYMLINK_PATH_REFUSED')
    resolved_base = base.resolve(strict=True)
    resolved_path = path.resolve(strict=True)
    try:
        resolved_path.relative_to(resolved_base)
    except ValueError as exc:
        raise RuntimeError('PATH_OUTSIDE_APPROVED_ALDER_LOCAL_ROOT') from exc
    return resolved_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup-receipt', required=True, type=Path)
    parser.add_argument('--result', required=True, type=Path)
    parser.add_argument('--diagnostic', required=True, type=Path)
    args = parser.parse_args()
    global SQL_DIAGNOSTIC
    SQL_DIAGNOSTIC = args.diagnostic
    if SQL_DIAGNOSTIC.exists():
        raise RuntimeError('DIAGNOSTIC_PATH_ALREADY_EXISTS')
    SQL_DIAGNOSTIC.parent.mkdir(parents=True, exist_ok=True)
    SQL_DIAGNOSTIC.touch(exist_ok=False)
    result = {
        'started_at': datetime.now(timezone.utc).isoformat(), 'database': DB,
        'retained_apply': True, 'backup_receipt': str(args.backup_receipt),
        'migration': str(MIGRATION.relative_to(ROOT)), 'applied': False,
    }
    try:
        migration_bytes = MIGRATION.read_bytes()
        migration_sha = sha(migration_bytes)
        if migration_sha != EXPECTED_014:
            raise RuntimeError('SOURCE_014_HASH_CHANGED')
        migration_text = migration_bytes.decode('utf-8')
        source_012_sha = sha((ROOT / 'db/012-round6-access-hardening.sql').read_bytes())
        if source_012_sha != EXPECTED_012:
            raise RuntimeError('SOURCE_012_HASH_CHANGED')
        receipt_path = resolved_under(args.backup_receipt, ROOT / '.local/codex-a1')
        if not receipt_path.is_file():
            raise RuntimeError('FRESH_BACKUP_RECEIPT_MISSING')
        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
        backup = resolved_under(Path(receipt['backup']), ROOT / '.local/backups')
        if not backup.is_dir() or not (backup / 'manifest.json').is_file():
            raise RuntimeError('BACKUP_DIRECTORY_OR_MANIFEST_MISSING')
        backup_dump = resolved_under(backup / 'alder.dump', ROOT / '.local/backups')
        manifest_path = resolved_under(backup / 'manifest.json', ROOT / '.local/backups')
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
        manifest_sha = sha(manifest_bytes)
        dump_sha = sha(backup_dump.read_bytes())
        if manifest_sha != receipt.get('manifest_sha256') or not receipt.get('private_copy_digests_verified'):
            raise RuntimeError('BACKUP_RECEIPT_INTEGRITY_FAILED')
        if dump_sha != receipt.get('dump_sha256') or manifest.get('files', {}).get('alder.dump', {}).get('sha256') != dump_sha:
            raise RuntimeError('BACKUP_DUMP_HASH_MISMATCH')
        if receipt.get('backup_helper_sha256') != manifest.get('backup_helper_sha256'):
            raise RuntimeError('BACKUP_HELPER_PROVENANCE_MISMATCH')
        result['backup_manifest_sha256'] = manifest_sha
        result['backup_directory'] = str(backup)
        result['backup_dump_sha256'] = receipt.get('dump_sha256')
        result['backup_helper_sha256'] = receipt.get('backup_helper_sha256')
        result['migration_sha256'] = migration_sha
        result['source_012_sha256_before'] = source_012_sha

        journal = json.loads(sql("SELECT coalesce(json_agg(json_build_object('sha256',sha256) ORDER BY id),'[]'::json)::text FROM schema_migrations WHERE id='012-round6-access-hardening'"))
        if len(journal) != 1 or journal[0]['sha256'] != EXPECTED_012:
            raise RuntimeError('APPLIED_012_JOURNAL_HASH_MISMATCH')
        already = sql("SELECT count(*) FROM schema_migrations WHERE id='014-validate-invite-owner'")
        if already != '0':
            raise RuntimeError('014_ALREADY_JOURNALED; inspect before retry')
        result['applied_012_journal_sha256_before'] = journal[0]['sha256']
        result['before'] = snapshot()
        if (result['before']['invite_count'] != 10 or result['before']['accepted'] != 7
                or result['before']['revoked'] != 3 or result['before']['open'] != 0
                or result['before']['audit_linked'] != 10 or result['before']['audit_missing'] != 0
                or result['before']['owner_role_violations'] != 0
                or result['before']['invites_sha256'] != EXPECTED_INVITES
                or result['before']['membership_events_sha256'] != EXPECTED_MEMBERSHIP_EVENTS):
            raise RuntimeError('INVITE_BASELINE_GUARD_FAILED')

        # The arrays remain inside PostgreSQL for the whole transaction. No
        # private invite addresses or audit payloads are written to evidence.
        transaction = f"""
BEGIN;
CREATE TEMP TABLE _014_baseline ON COMMIT DROP AS
SELECT
  coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.workspace_id,i.id) FROM public.membership_invites i),'[]'::jsonb) AS invites,
  coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.membership_events e),'[]'::jsonb) AS events;
{migration_text}
INSERT INTO schema_migrations(id,sha256,note)
VALUES('014-validate-invite-owner','{migration_sha}','applied round 6 2026-11-01 under backed product lock; invite rows unchanged');
DO $guard$
DECLARE inv_before jsonb; ev_before jsonb;
BEGIN
 SELECT invites,events INTO inv_before,ev_before FROM _014_baseline;
 IF inv_before IS DISTINCT FROM coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.workspace_id,i.id) FROM public.membership_invites i),'[]'::jsonb)
 THEN RAISE EXCEPTION 'INVITE_ROWS_CHANGED'; END IF;
 IF ev_before IS DISTINCT FROM coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.membership_events e),'[]'::jsonb)
 THEN RAISE EXCEPTION 'INVITE_AUDIT_ROWS_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.membership_invites WHERE 'owner'=ANY(roles))
 THEN RAISE EXCEPTION 'OWNER_INVITE_PRESENT'; END IF;
 IF NOT (SELECT convalidated FROM pg_constraint WHERE conrelid='public.membership_invites'::regclass AND conname='invites_no_owner')
 THEN RAISE EXCEPTION 'CONSTRAINT_NOT_VALIDATED'; END IF;
 IF (SELECT sha256 FROM schema_migrations WHERE id='012-round6-access-hardening') <> '{EXPECTED_012}'
 THEN RAISE EXCEPTION 'APPLIED_012_JOURNAL_CHANGED'; END IF;
 IF (SELECT sha256 FROM schema_migrations WHERE id='014-validate-invite-owner') <> '{migration_sha}'
 THEN RAISE EXCEPTION '014_JOURNAL_HASH_MISMATCH'; END IF;
END $guard$;
COMMIT;
"""
        # Keep PostgreSQL diagnostics in the locked-step raw log, never print
        # any row values to the terminal.
        sql(transaction)
        result.update({
            'applied': True,
            'constraint_validated': sql("SELECT convalidated::text FROM pg_constraint WHERE conrelid='public.membership_invites'::regclass AND conname='invites_no_owner'") == 'true',
            'owner_invite_rows': int(sql("SELECT count(*) FROM public.membership_invites WHERE 'owner'=ANY(roles)")),
            'applied_014_journal_sha256': sql("SELECT sha256 FROM schema_migrations WHERE id='014-validate-invite-owner'"),
            'source_012_sha256_after': sha((ROOT / 'db/012-round6-access-hardening.sql').read_bytes()),
            'applied_012_journal_sha256_after': sql("SELECT sha256 FROM schema_migrations WHERE id='012-round6-access-hardening'"),
            'after': snapshot(),
        })
        result['invite_rows_unchanged'] = (
            result['before']['invite_count'] == result['after']['invite_count']
            and result['before']['invites_sha256'] == result['after']['invites_sha256']
        )
        result['membership_events_unchanged'] = (
            result['before']['membership_events_sha256'] == result['after']['membership_events_sha256']
        )
        result['passed'] = (
            result['constraint_validated'] is True and result['owner_invite_rows'] == 0
            and result['invite_rows_unchanged'] and result['membership_events_unchanged']
            and result['applied_014_journal_sha256'] == migration_sha
            and result['source_012_sha256_after'] == EXPECTED_012
            and result['applied_012_journal_sha256_after'] == EXPECTED_012
        )
        if not result['passed']:
            raise RuntimeError('POST_APPLY_READBACK_MISMATCH')
    except Exception as exc:
        result['passed'] = False
        result['error'] = str(exc)
    result['finished_at'] = datetime.now(timezone.utc).isoformat()
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
    return 0 if result.get('passed') else 1


if __name__ == '__main__':
    sys.exit(main())
