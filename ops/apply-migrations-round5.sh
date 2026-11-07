#!/usr/bin/env bash
# Round-5 out-of-band migration: applies db/010 (or the file given as $2) in ONE transaction as the local docker postgres migration authority and
# journals its SHA-256 in schema_migrations. Usage: ops/apply-migrations-round5.sh <database>
set -euo pipefail
db="$1"; cd "$(dirname "$0")/.."
f=${2:-db/010-round5-durable-invalidation.sql}
{ cat "$f"; echo; echo "INSERT INTO schema_migrations(id,sha256,note) VALUES('$(basename $f .sql)','$(sha256sum $f|cut -c1-64)','applied round 5 2026-10-31 single transaction, expand-only');"; } \
 | docker exec -i alder-postgres psql -U postgres -d "$db" -v ON_ERROR_STOP=1 --single-transaction -q
echo "MIGRATED $db"
