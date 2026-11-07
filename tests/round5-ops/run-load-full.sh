#!/usr/bin/env bash
# O5 orchestrator: resource sampler + 30-min reference load + mid-run browser vitals probe (all isolated stack).
cd /c/Users/user/portfolio-build/alder || exit 1
N=/c/Users/user/AppData/Local/hermes/tools/node-26.7.0-win32-x64/node.exe
L=evidence/round5-ops/load
powershell.exe -NoProfile -File tests/round5-ops/resource-sampler.ps1 -Seconds 1920 -Out $L/resources-full.csv &
SAMPLER=$!
date -u +%FT%TZ > $L/full-run.started
( sleep 720; O5_RUNS=10 O5_OUT=$L/web-vitals-under-load "$N" --import tsx tests/round5-ops/web-vitals-probe.ts > $L/web-vitals-under-load.log 2>&1 ) &
PROBE=$!
O5_DURATION=1800 O5_OUT=$L/full-1800s "$N" --import tsx tests/round5-ops/load-run.ts > $L/full-1800s.log 2>&1
echo "exit $?" >> $L/full-1800s.log
wait $PROBE; wait $SAMPLER
date -u +%FT%TZ > $L/full-run.finished
