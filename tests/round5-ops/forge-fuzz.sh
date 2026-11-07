#!/usr/bin/env bash
# O5 TR-T-FUZZ + SUPPLY compiler gate under the shared build lock: forge build, the full suite at 10000 fuzz runs/property with a
# FIXED recorded seed and failure-persist directories redirected into evidence (retained seeds), invariant 1000 x 128 from
# foundry.toml, then forge coverage (per-property coverage audit). Lock: atomic mkdir, owner recorded, never stolen, released.
set -uo pipefail
cd /c/Users/user/portfolio-build/alder
LOCK=/c/Users/user/portfolio-build/.cache/product-build.lock; OUT=evidence/round5-ops/fuzz; mkdir -p $OUT/seeds/fuzz $OUT/seeds/invariant
FORGE=/c/Users/user/.foundry/bin/forge.exe; SEED=0x05a1de2026103105
if ! mkdir $LOCK 2>/dev/null; then echo "LOCK BUSY: $(cat $LOCK/owner 2>/dev/null)"; exit 75; fi
printf 'owner=alder-round5-ops-O5\nlabel=forge-fuzz-coverage\npid=%s\nstarted=%s\n' $$ "$(date -u +%FT%TZ)" > $LOCK/owner
trap 'rm -rf $LOCK; echo "lock released $(date -u +%FT%TZ)"' EXIT
echo "lock acquired $(date -u +%FT%TZ)"; $FORGE --version | head -2
$FORGE build 2>&1 | tail -3 | tee $OUT/forge-build.log
export FOUNDRY_FUZZ_FAILURE_PERSIST_DIR=$OUT/seeds/fuzz FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR=$OUT/seeds/invariant
T0=$(date +%s); $FORGE test --fuzz-runs 10000 --fuzz-seed $SEED -vv > $OUT/forge-test-fuzz10000.log 2>&1; RC=$?; echo "forge test exit $RC in $(( $(date +%s)-T0 )) s (seed $SEED)" | tee -a $OUT/forge-test-fuzz10000.log
grep -E "^\[(PASS|FAIL)|Suite result|Ran [0-9]+ test suites" $OUT/forge-test-fuzz10000.log
T0=$(date +%s); timeout 1200 $FORGE coverage --report summary --fuzz-runs 256 --fuzz-seed $SEED > $OUT/forge-coverage.log 2>&1; echo "forge coverage exit $? in $(( $(date +%s)-T0 )) s" | tee -a $OUT/forge-coverage.log
grep -E "BatchExecutor|ReferenceToken|Total" $OUT/forge-coverage.log | head
find $OUT/seeds -type f | head; echo "seed dirs: $(find $OUT/seeds -type f | wc -l) files (empty = no failure was ever minimized/persisted)"
cp -r cache/fuzz $OUT/seeds/cache-fuzz-copy 2>/dev/null; cp -r cache/invariant $OUT/seeds/cache-invariant-copy 2>/dev/null; true
