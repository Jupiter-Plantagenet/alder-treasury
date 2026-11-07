#!/usr/bin/env bash
# O5 TR-T-RESTORE drill: continuous WAL archiving (archive_timeout=60s) + base backup + hard crash + point-in-time recovery
# into a NEW isolated PostgreSQL container from an age-ENCRYPTED backup bundle. Scratch containers only
# (alder-o5-pg on 15543 = source, alder-o5-pitr on 15545 = restore target); the live alder-postgres is never touched.
# The age identity (private key) lives only in .local/o5/age-identity.txt and is never printed.
set -euo pipefail
cd /c/Users/user/portfolio-build/alder
AGE=/c/Users/user/AppData/Local/Microsoft/WinGet/Packages/FiloSottile.age_Microsoft.Winget.Source_8wekyb3d8bbwe/age
OUT=evidence/round5-ops/restore; mkdir -p $OUT .local/o5/backups .cache/o5/pitr
IMG=postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
TS=$(date -u +%Y%m%dT%H%M%SZ); LOG=$OUT/pitr-$TS.log; exec > >(tee -a $LOG) 2>&1
now(){ date -u +%s.%N; }
psqlsrc(){ docker exec alder-o5-pg psql -U postgres -d alder -Atc "$1"; }
if [ -n "${RESTORE_ONLY:-}" ]; then TS=$RESTORE_ONLY; TCRASH=$RESTORE_TCRASH; ENC_SHA=$(sha256sum .local/o5/backups/pitr-bundle-$TS.tar.age | cut -c1-64); PLAIN_SHA=$RESTORE_PLAIN_SHA; echo "== O5 PITR RESTORE-ONLY rerun from existing encrypted bundle $TS (first restore attempt aborted: max_connections lower than primary)"; fi
echo "== O5 PITR drill $TS"
[ -f .local/o5/age-identity.txt ] || "$AGE/age-keygen.exe" -o .local/o5/age-identity.txt 2> .local/o5/age-keygen.stderr
RECIP=$(grep -o 'age1[0-9a-z]*' .local/o5/age-identity.txt | head -1); echo "age recipient (public key) $RECIP"
[ -n "${RESTORE_ONLY:-}" ] || echo "archive settings: $(psqlsrc "select string_agg(name||'='||setting,' ') from pg_settings where name in ('wal_level','archive_mode','archive_timeout','archive_command')")"
[ -n "${RESTORE_ONLY:-}" ] || psqlsrc "CREATE TABLE IF NOT EXISTS o5_pitr_markers(seq int PRIMARY KEY, client_at timestamptz NOT NULL, server_at timestamptz NOT NULL DEFAULT clock_timestamp())" >/dev/null
if [ -z "${RESTORE_ONLY:-}" ]; then
# 1. base backup (tar, gzip, WAL streamed) into the archive volume
T0=$(now); docker exec alder-o5-pg sh -c "rm -rf /archive/base-$TS && pg_basebackup -U postgres -D /archive/base-$TS -Ft -z -Xs -c fast" ; T1=$(now)
echo "base backup done in $(awk "BEGIN{print $T1-$T0}") s; files: $(MSYS_NO_PATHCONV=1 docker exec alder-o5-pg ls -la /archive/base-$TS | tail -n +2 | awk '{print $5, $9}' | tr '\n' ' ')"
# 2. workload after the base backup: one committed marker every ~2 s for 150 s (commit time recorded client- and server-side)
for i in $(seq 1 75); do psqlsrc "INSERT INTO o5_pitr_markers(seq,client_at) VALUES($i,'$(date -u +%FT%T.%NZ)')" >/dev/null; sleep 1.6; done
LAST=$(psqlsrc "select max(seq)||' '||max(server_at) from o5_pitr_markers"); echo "last committed marker before crash: $LAST"
docker exec alder-o5-pg psql -U postgres -d alder -Atc "select row_to_json(t) from (select archived_count,last_archived_wal,last_archived_time,failed_count from pg_stat_archiver) t"
# 3. hard crash (SIGKILL) immediately after the last commit; the source data volume is then treated as LOST
TCRASH=$(now); docker kill alder-o5-pg >/dev/null; echo "CRASH (SIGKILL) at $(date -u +%FT%T.%NZ)"
# 4. backup bundle = base backup + archived WAL only (what survives off-host), encrypted with age; plaintext removed
TB0=$(now)
docker run --rm -v alder-o5-walarchive:/archive:ro -v "$(cygpath -w $PWD/.cache/o5/pitr)":/out alpine:latest sh -c "cd /archive && B=\$(ls *.backup | sort | tail -1) && START=\${B%%.*} && echo start-segment \$START && tar -cf /out/bundle-$TS.tar base-$TS \$B \$(ls | grep -E '^[0-9A-F]{24}$' | awk -v s=\$START '\$0>=s') \$(ls | grep -E '\.history$' || true)"
"$AGE/age.exe" -r "$RECIP" -o .local/o5/backups/pitr-bundle-$TS.tar.age .cache/o5/pitr/bundle-$TS.tar
PLAIN_SHA=$(sha256sum .cache/o5/pitr/bundle-$TS.tar | cut -c1-64); rm -f .cache/o5/pitr/bundle-$TS.tar
ENC_SHA=$(sha256sum .local/o5/backups/pitr-bundle-$TS.tar.age | cut -c1-64); echo "encrypted bundle .local/o5/backups/pitr-bundle-$TS.tar.age sha256 $ENC_SHA (plaintext sha256 $PLAIN_SHA, plaintext deleted)"
head -c 40 .local/o5/backups/pitr-bundle-$TS.tar.age | grep -q "age-encryption.org/v1" && echo "ciphertext header: age-encryption.org/v1 (not plaintext tar)"
fi
# 5. RESTORE (RTO clock starts): decrypt with the identity file, build a new data volume, recover to end of archived WAL
TR0=$(now)
docker rm -f alder-o5-pitr >/dev/null 2>&1 || true; docker volume rm alder-o5-pitr-data alder-o5-pitr-wal >/dev/null 2>&1 || true
docker volume create alder-o5-pitr-data >/dev/null; docker volume create alder-o5-pitr-wal >/dev/null
"$AGE/age.exe" -d -i .local/o5/age-identity.txt -o .cache/o5/pitr/restore-$TS.tar .local/o5/backups/pitr-bundle-$TS.tar.age
[ "$(sha256sum .cache/o5/pitr/restore-$TS.tar | cut -c1-64)" = "$PLAIN_SHA" ] && echo "decrypted bundle sha256 matches plaintext digest"
docker run --rm -v "$(cygpath -w $PWD/.cache/o5/pitr)":/in:ro -v alder-o5-pitr-data:/data -v alder-o5-pitr-wal:/wal alpine:latest sh -c "
 set -e; mkdir -p /tmp/b && tar -xf /in/restore-$TS.tar -C /tmp/b; tar -xzf /tmp/b/base-$TS/base.tar.gz -C /data; mkdir -p /data/pg_wal; tar -xzf /tmp/b/base-$TS/pg_wal.tar.gz -C /data/pg_wal;
 for f in /tmp/b/*; do case \$(basename \$f) in base-*) ;; *) cp \$f /wal/;; esac; done
 echo \"restore_command = 'cp /wal/%f %p'\" >> /data/postgresql.auto.conf; echo \"recovery_target_timeline = 'latest'\" >> /data/postgresql.auto.conf; touch /data/recovery.signal; chown -R 70:70 /data /wal; chmod 700 /data; ls /wal | wc -l"
rm -f .cache/o5/pitr/restore-$TS.tar
# Round 6 (review F-L12 / O5 runbook gotcha): recovery refuses to start when max_connections, max_worker_processes,
# max_wal_senders, max_prepared_transactions or max_locks_per_transaction is LOWER than on the primary. Read the
# primary's values from the restored base backup's control file and start the target with exactly those (never lower).
HS=$(docker run --rm -v alder-o5-pitr-data:/data $IMG sh -c 'pg_controldata /data' | awk -F: '/max_connections setting/{c=$2}/max_worker_processes setting/{w=$2}/max_wal_senders setting/{s=$2}/max_prepared_xacts setting/{p=$2}/max_locks_per_xact setting/{l=$2}END{gsub(/ /,"",c);gsub(/ /,"",w);gsub(/ /,"",s);gsub(/ /,"",p);gsub(/ /,"",l);printf "-c max_connections=%s -c max_worker_processes=%s -c max_wal_senders=%s -c max_prepared_transactions=%s -c max_locks_per_transaction=%s",c,w,s,p,l}')
case "$HS" in *max_connections=[0-9]*) echo "restore target hot-standby parameters from control file: $HS";; *) echo "CONTROLDATA_READ_FAILED"; exit 4;; esac
docker run -d --name alder-o5-pitr -p 127.0.0.1:15545:5432 -v alder-o5-pitr-data:/var/lib/postgresql/data -v alder-o5-pitr-wal:/wal --label purpose=alder-round5-ops-pitr $IMG -c archive_mode=off $HS -c shared_buffers=256MB >/dev/null
for i in $(seq 1 120); do if docker exec alder-o5-pitr psql -U postgres -d alder -Atc "select not pg_is_in_recovery()" 2>/dev/null | grep -q t; then break; fi; sleep 1; done
TR1=$(now); echo "restored instance ready (recovery complete, promoted) RTO=$(awk "BEGIN{print $TR1-$TR0}") s (decrypt + volume build + WAL replay)"
REST=$(docker exec alder-o5-pitr psql -U postgres -d alder -Atc "select max(seq)||' '||max(server_at) from o5_pitr_markers"); echo "last marker recovered: $REST"
docker logs alder-o5-pitr 2>&1 | grep -E "redo done|archive recovery complete|selected new timeline|consistent recovery|restored log file" | tail -6
# 6. ground truth: restart the crashed source (its own pg_wal intact) and compare
docker start alder-o5-pg >/dev/null; for i in $(seq 1 60); do docker exec alder-o5-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
python -I tests/round5-ops/pitr-compare.py "$TS" "$TCRASH" "$TR0" "$TR1" "$ENC_SHA" "$PLAIN_SHA" | tee $OUT/pitr-$TS.json
echo "== done"
