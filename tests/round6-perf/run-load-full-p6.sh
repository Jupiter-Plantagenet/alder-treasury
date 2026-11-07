#!/usr/bin/env bash
# P6 reference LOAD: 30-min open-loop load plus resource sampling and a mid-run vitals probe.
# New P6_RUN_ID executions keep every output under the run's private C: scratch directory.
set -u
cd /c/Users/user/portfolio-build/alder || exit 1
if [[ -n "${P6_RUN_ID:-}" ]] && [[ ! "$P6_RUN_ID" =~ ^p6-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{4,20}$ ]]; then echo 'P6_RUN_ID_INVALID' >&2; exit 2; fi
N=/c/Users/user/portfolio-build/alder/.local/runtime/node-v26.7.0/node.exe
EXPECTED_NODE_SHA256=e921fe5307e29bf6fd00000dd594356affd3a7b044e52720c7f10decbdc305b9
if [[ ! -f "$N" ]]; then echo 'P6_NODE_RUNTIME_MISSING' >&2; exit 2; fi
ACTUAL_NODE_SHA256=$(sha256sum "$N" | awk '{print $1}')
if [[ "$ACTUAL_NODE_SHA256" != "$EXPECTED_NODE_SHA256" ]] || [[ "$("$N" --version)" != 'v26.7.0' ]]; then echo 'P6_NODE_RUNTIME_PIN_MISMATCH' >&2; exit 2; fi
L=.local/scratch-r6/load
RUNROOT=.local/scratch-r6
if [[ -n "${P6_RUN_ID:-}" ]]; then
  RUNROOT=".local/scratch-r6/runs/$P6_RUN_ID"
  L="$RUNROOT/load"
  [[ -f "$RUNROOT/P6-RUN.json" ]] || { echo 'P6_RUN_MARKER_MISSING' >&2; exit 2; }
  grep -Fq "\"runId\": \"$P6_RUN_ID\"" "$RUNROOT/P6-RUN.json" || { echo 'P6_RUN_MARKER_MISMATCH' >&2; exit 2; }
fi
mkdir -p "$L"
DUR=${P6_DURATION:-1800}
if ! [[ "$DUR" =~ ^[0-9]+$ ]] || (( DUR < 1 )); then echo 'P6_DURATION_INVALID' >&2; exit 2; fi
RUN="$L/full-${DUR}s"
STARTED="$L/full-run.started"; FINISHED="$L/full-run.finished"
RESOURCES="$L/resources-full.csv"; PROBE_LOG="$L/web-vitals-under-load.log"; PROBE_DIR="$L/web-vitals-under-load"
STATUS="$L/run-status.json"; LOAD_LOG="$L/full-${DUR}s.log"; ABORT_MARKER="$L/resource-abort.json"
if [[ -n "${P6_RUN_ID:-}" ]]; then
  for p in "$RUN" "$STARTED" "$FINISHED" "$RESOURCES" "$PROBE_LOG" "$PROBE_DIR" "$STATUS" "$LOAD_LOG" "$ABORT_MARKER"; do
    [[ ! -e "$p" ]] || { echo 'P6_RUN_OUTPUT_ALREADY_EXISTS_USE_NEW_RUN_ID' >&2; exit 2; }
  done
fi
export ALDER_DEPLOYMENT_FILE=evidence/round5-ops/isolated-deployment.json ALDER_RPC_URL=http://127.0.0.1:18547
LOAD_RC=-1; PROBE_RC=-1; SAMPLER_RC=-1; SUMMARY_RC=-1; INTERRUPTED=0; CANCEL_REASON=''
SAMPLER_PID=''; PROBE_PID=''; LOAD_PID=''
write_status(){
  printf '{"load_exit":%s,"probe_exit":%s,"sampler_exit":%s,"summary_exit":%s,"interrupted":%s,"cleanup_reason":"%s","finished_at":"%s"}\n' \
    "$LOAD_RC" "$PROBE_RC" "$SAMPLER_RC" "$SUMMARY_RC" "$([[ $INTERRUPTED -eq 1 ]] && echo true || echo false)" "$CANCEL_REASON" "$(date -u +%FT%TZ)" > "$STATUS"
}
stop_owned(){
  local p="$1"
  [[ -n "$p" ]] || return 0
  kill -0 "$p" 2>/dev/null && kill "$p" 2>/dev/null || true
  wait "$p" 2>/dev/null || true
}
cancel_owned(){
  local reason="$1"; CANCEL_REASON="$reason"
  stop_owned "$LOAD_PID"; stop_owned "$PROBE_PID"; stop_owned "$SAMPLER_PID"
  if (( LOAD_RC == -1 )); then LOAD_RC=125; fi
  if (( PROBE_RC == -1 )); then PROBE_RC=125; fi
  if (( SAMPLER_RC == -1 )); then SAMPLER_RC=125; fi
  date -u +%FT%TZ > "$FINISHED"
  if [[ -f "$RUN/raw.ndjson" ]]; then
    python tests/round5-ops/load-summarize.py "$RUN/raw.ndjson" "$RUN/summary.json" > "$RUN/summary.txt" 2>&1
    SUMMARY_RC=$?
  else SUMMARY_RC=2; fi
  write_status
}
on_interrupt(){
  trap - INT TERM
  INTERRUPTED=1
  cancel_owned 'signal_interrupt'
  exit 130
}
trap on_interrupt INT TERM

P6_RUN_ID="${P6_RUN_ID:-}" O5_DURATION=$DUR O5_OUT="$RUN" "$N" --import tsx tests/round6-perf/load-run-p6.ts > "$LOAD_LOG" 2>&1 &
LOAD_PID=$!
SAMPLER_CONTAINER="${P6_SAMPLER_CONTAINER:-alder-p6-20261101t235425z-a2stack-pg}"
SAMPLER_DATABASE="${P6_SAMPLER_DATABASE:-alder}"
P6_SAMPLER_CONTAINER="$SAMPLER_CONTAINER" P6_SAMPLER_DATABASE="$SAMPLER_DATABASE" \
powershell.exe -NoProfile -File tests/round6-perf/resource-sampler-p6.ps1 -Seconds $((DUR+120)) \
  -Container "$SAMPLER_CONTAINER" -Database "$SAMPLER_DATABASE" -Out "$RESOURCES" -AbortMarker "$ABORT_MARKER" &
SAMPLER_PID=$!
( sleep 720; exec env P6_RUN_ID="${P6_RUN_ID:-}" P6_VITALS_OUT="$PROBE_DIR" "$N" --import tsx "${P6_VITALS_RUNNER:-tests/round6-perf/vitals-p6.ts}" 5 ) > "$PROBE_LOG" 2>&1 &
PROBE_PID=$!
date -u +%FT%TZ > "$STARTED"

while kill -0 "$LOAD_PID" 2>/dev/null; do
  if [[ -f "$ABORT_MARKER" ]]; then
    cancel_owned 'resource_gate_abort'
    exit 1
  fi
  sleep 2
done
if wait "$LOAD_PID"; then LOAD_RC=0; else LOAD_RC=$?; fi
if [[ -f "$ABORT_MARKER" ]]; then
  cancel_owned 'resource_gate_abort'
  exit 1
fi
if (( LOAD_RC != 0 )); then
  CANCEL_REASON="load_exit_$LOAD_RC"
  stop_owned "$PROBE_PID"; stop_owned "$SAMPLER_PID"
  PROBE_RC=130; SAMPLER_RC=130
else
  if wait "$PROBE_PID"; then PROBE_RC=0; else PROBE_RC=$?; fi
  if wait "$SAMPLER_PID"; then SAMPLER_RC=0; else SAMPLER_RC=$?; fi
fi
date -u +%FT%TZ > "$FINISHED"
if [[ -f "$RUN/raw.ndjson" ]]; then
  python tests/round5-ops/load-summarize.py "$RUN/raw.ndjson" "$RUN/summary.json" > "$RUN/summary.txt" 2>&1
  SUMMARY_RC=$?
else
  SUMMARY_RC=2
fi
write_status
if (( LOAD_RC != 0 || PROBE_RC != 0 || SAMPLER_RC != 0 || SUMMARY_RC != 0 )); then exit 1; fi
exit 0
