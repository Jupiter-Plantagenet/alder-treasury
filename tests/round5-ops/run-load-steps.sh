#!/usr/bin/env bash
# O5 capacity step test: same mix/sessions as the reference run, at 1/8, 1/4 and 1/2 of the reference rate, 180 s each.
cd /c/Users/user/portfolio-build/alder || exit 1
N=/c/Users/user/AppData/Local/hermes/tools/node-26.7.0-win32-x64/node.exe; L=evidence/round5-ops/load
powershell.exe -NoProfile -File tests/round5-ops/resource-sampler.ps1 -Seconds 1000 -Out $L/resources-steps.csv & S=$!
for step in "2 0.5" "4 1" "8 2"; do set -- $step
  sleep 70
  echo "step r=$1 w=$2 start $(date -u +%FT%TZ)" >> $L/steps.log
  O5_DURATION=180 O5_READ_RPS=$1 O5_WRITE_RPS=$2 O5_BATCH_AT=9999 O5_OUT=$L/step-r$1-w$2 "$N" --import tsx tests/round5-ops/load-run.ts >> $L/steps.log 2>&1
  python -I tests/round5-ops/load-summarize.py $L/step-r$1-w$2/raw.ndjson $L/step-r$1-w$2/summary.json >> $L/steps.log 2>&1
done
kill $S 2>/dev/null; date -u +%FT%TZ > $L/steps.finished
