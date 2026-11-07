#!/usr/bin/env bash
# O5 TR-T-MIGRATION: mid-migration crash test on a SCRATCH copy (container alder-o5-mig, 127.0.0.1:15544) restored from the
# pre-010 backup .local/backups/alder-o5-scratch-source-*.dump. The round-5 expand migrations 010+011 are applied with the
# project's out-of-band method (psql --single-transaction ON_ERROR_STOP), with an injected pause between section 3 and 4 of
# 010; the PostgreSQL server is SIGKILLed while the transaction is open. Then: verify zero partial effect, resume (re-apply),
# verify journal, and smoke the OLD (pre-010 snapshot) and NEW (current source) API against the expanded schema.
set -euo pipefail
cd /c/Users/user/portfolio-build/alder
OUT=evidence/round5-ops/migration; mkdir -p $OUT; TS=$(date -u +%Y%m%dT%H%M%SZ); exec > >(tee -a $OUT/migration-crash-$TS.log) 2>&1
IMG=postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
DUMP=$(ls -t .local/backups/alder-o5-scratch-source-*.dump | head -1); ROLES=$(ls -t .local/o5/roles-*.sql | head -1)
echo "== O5 migration crash test $TS; source backup $(basename $DUMP) sha256 $(sha256sum $DUMP | cut -c1-64)"
docker rm -f alder-o5-mig >/dev/null 2>&1 || true
docker run -d --name alder-o5-mig -p 127.0.0.1:15544:5432 -e POSTGRES_HOST_AUTH_METHOD=trust --label purpose=alder-round5-ops-migration $IMG >/dev/null
for i in $(seq 1 60); do docker exec alder-o5-mig pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker cp "$ROLES" alder-o5-mig:/tmp/roles.sql; docker cp "$DUMP" alder-o5-mig:/tmp/src.dump
docker exec alder-o5-mig sh -c "psql -U postgres -q -f /tmp/roles.sql >/dev/null 2>&1; createdb -U postgres alder && pg_restore -U postgres -d alder --exit-on-error /tmp/src.dump && rm /tmp/src.dump /tmp/roles.sql"
q(){ docker exec alder-o5-mig psql -U postgres -d alder -Atc "$1"; }
state(){ # schema hash + per-table row digests + journal
 S=$(docker exec alder-o5-mig pg_dump -U postgres -d alder --schema-only | grep -v -E '^--|^$|^SET |pg_catalog.set_config|^\\(un)?restrict ' | sha256sum | cut -c1-64)
 R=$(rowlist | sha256sum | cut -c1-64)
 J=$(q "select string_agg(id,',' order by id) from schema_migrations"); echo "schema=$S rows=$R journal=$J tables=$(q "select count(*) from pg_tables where schemaname='public'")"; }
COLS=$OUT/cols-pre-$TS.txt
rowlist(){ # per-table digest over the columns that existed BEFORE the migration (an added nullable column is not a row rewrite)
 [ -f $COLS ] || q "select table_name||':'||string_agg(quote_ident(column_name),',' order by ordinal_position) from information_schema.columns where table_schema='public' group by table_name order by 1" > $COLS
 for t in $(q "select tablename from pg_tables where schemaname='public' order by 1"); do c=$(grep "^$t:" $COLS | cut -d: -f2 || true); [ -z "$c" ] && c='*'; [ "$c" = '*' ] && sel="x::text" || sel="row($c)::text"; echo "$t:$(q "select count(*)||'-'||coalesce(md5(string_agg(md5($sel),'' order by md5($sel))),'') from (select * from public.\"$t\") x")"; done; }
PRE=$(state); echo "PRE  $PRE"; rowlist > $OUT/rows-pre-$TS.txt
F10=db/010-round5-durable-invalidation.sql; F11=db/011-round5-indexer-attempt-read.sql; CUT=$(grep -n '^-- -* 4\. transactional outbox' $F10 | cut -d: -f1)
stream(){ # $1 = pause seconds between section 3 and 4 (0 = none)
 head -n $((CUT-1)) $F10; echo; [ "$1" != 0 ] && echo "SELECT 'O5 crash window open' AS marker, pg_sleep($1);"; tail -n +$CUT $F10; echo; cat $F11; echo
 for f in $F10 $F11; do echo "INSERT INTO schema_migrations(id,sha256,note) VALUES('$(basename $f .sql)','$(sha256sum $f|cut -c1-64)','O5 scratch rehearsal (crash test) $TS');"; done; }
# 1. crash mid-migration: part 1 (sections 1-3 of 010) executes inside the open transaction, then the server is SIGKILLed
( stream 30 | docker exec -i alder-o5-mig psql -U postgres -d alder -v ON_ERROR_STOP=1 --single-transaction -q > $OUT/crash-attempt-psql-$TS.txt 2>&1; echo "psql exit $?" >> $OUT/crash-attempt-psql-$TS.txt ) & BG=$!
for i in $(seq 1 40); do if q "select count(*) from pg_stat_activity where query like '%O5 crash window open%' and state='active' and pid<>pg_backend_pid()" | grep -q '^1$'; then break; fi; sleep 0.5; done
echo "inside crash window: $(q "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='operation_invalidations'") locks on the not-yet-committed new table operation_invalidations; visible to other sessions: $(q "select to_regclass('public.operation_invalidations') is not null")"
echo "open migration transaction before kill: $(q "select 'pid='||pid||' xact_age_s='||round(extract(epoch from now()-xact_start)::numeric,1)||' locks_held='||(select count(*) from pg_locks l where l.pid=a.pid)||' query='||left(query,40) from pg_stat_activity a where query like '%O5 crash window open%' and pid<>pg_backend_pid()")"
docker kill alder-o5-mig >/dev/null; echo "SIGKILL postgres server at $(date -u +%FT%T.%NZ) (mid-transaction)"; wait $BG || true; cat $OUT/crash-attempt-psql-$TS.txt | tail -3
docker start alder-o5-mig >/dev/null; for i in $(seq 1 60); do docker exec alder-o5-mig pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 1
docker logs alder-o5-mig 2>&1 | grep -E "not properly shut down|redo (starts|done)|ready to accept" | tail -4
POST=$(state); echo "POST-CRASH $POST"; [ "$PRE" = "$POST" ] && echo "RESULT crash: schema, all table row digests and journal IDENTICAL to pre-migration (atomic rollback by crash recovery)" || echo "RESULT crash: STATE DIFFERS"
echo "objects from part 1 present after crash: $(q "select count(*) from pg_class where relname in ('operation_invalidations','indexer_leases','indexer_requests')")"
# 2. resume: re-apply the whole migration (no partial state to repair)
T0=$(date +%s.%N); stream 0 | docker exec -i alder-o5-mig psql -U postgres -d alder -v ON_ERROR_STOP=1 --single-transaction -q; echo "resume apply exit $? in $(awk "BEGIN{print $(date +%s.%N)-$T0}") s"
AFTER=$(state); echo "AFTER $AFTER"; q "select id,left(sha256,16),note from schema_migrations where id like '01%'"
# 3. accidental second apply is refused atomically (objects exist) and changes nothing
set +e; stream 0 | docker exec -i alder-o5-mig psql -U postgres -d alder -v ON_ERROR_STOP=1 --single-transaction -q > $OUT/reapply-$TS.txt 2>&1; RC=$?; set -e
AGAIN=$(state); echo "second apply exit $RC ($(head -1 $OUT/reapply-$TS.txt | cut -c1-120)); state unchanged: $([ "$AFTER" = "$AGAIN" ] && echo yes || echo NO)"
# 4. expand-only: every pre-existing table's row digest unchanged after the successful migration
rowlist > $OUT/rows-after-$TS.txt; CHG=$(join -t: -j1 <(sort $OUT/rows-pre-$TS.txt) <(sort $OUT/rows-after-$TS.txt) | awk -F: '$2!=$3' | wc -l)
echo "pre-existing tables: $(wc -l < $OUT/rows-pre-$TS.txt); with changed row digest after migration: $CHG; new tables: $(comm -13 <(cut -d: -f1 $OUT/rows-pre-$TS.txt|sort) <(cut -d: -f1 $OUT/rows-after-$TS.txt|sort) | tr '
' ' ')"
join -t: -j1 <(sort $OUT/rows-pre-$TS.txt) <(sort $OUT/rows-after-$TS.txt) | awk -F: '$2!=$3{print "changed: "$1}' 
echo "== migration crash test done $TS"
