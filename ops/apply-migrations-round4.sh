#!/usr/bin/env bash
# Round-4 out-of-band migration: applies 006,007,008,009 in ONE transaction as the local docker postgres
# migration authority (same method as ops/provision-db.ts), journaling file SHA-256 into schema_migrations.
# Usage: ops/apply-migrations-round4.sh <database>   (alder | alder_round4_backupcheck)
set -euo pipefail
db="$1"; cd "$(dirname "$0")/.."
{
  for f in db/006-payable-intake.sql db/007-private-attachments.sql db/008-review-policy.sql db/009-chain-lineage-2.sql; do cat "$f"; echo; done
  for f in db/001.sql db/002.sql db/003-roles.sql db/004-constraints.sql db/005-destinations.sql; do
    echo "INSERT INTO schema_migrations(id,sha256,note) VALUES('$(basename $f .sql)','$(sha256sum $f|cut -c1-64)','pre-journal: applied before round 4; recorded, not re-applied');"; done
  for f in db/006-payable-intake.sql db/007-private-attachments.sql db/008-review-policy.sql db/009-chain-lineage-2.sql; do
    echo "INSERT INTO schema_migrations(id,sha256,note) VALUES('$(basename $f .sql)','$(sha256sum $f|cut -c1-64)','applied round 4 2026-10-30 single transaction');"; done
} | docker exec -i alder-postgres psql -U postgres -d "$db" -v ON_ERROR_STOP=1 --single-transaction -q
echo "MIGRATED $db"
