#!/usr/bin/env bash
# W5 fault hook: restart only the API PID previously created by this private Compose episode.
set -euo pipefail
[[ ${ALDER_REPRO_NAMESPACE:-} == 1 && ${ALDER_REPRO_PROJECT:-} == alder-repro-* ]] || { echo 'REPRO_NAMESPACE_REQUIRED' >&2; exit 2; }
PID_FILE=${ALDER_W5_API_PID_FILE:-/proof/private/api.pid}
[[ "$PID_FILE" == /proof/private/api.pid && -f "$PID_FILE" ]] || { echo 'OWNED_API_PID_FILE_REQUIRED' >&2; exit 2; }
pid=$(cat "$PID_FILE"); [[ "$pid" =~ ^[0-9]+$ ]] || { echo 'BAD_API_PID' >&2; exit 2; }
cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
[[ "$cmd" == *'apps/api/main.ts'* ]] || { echo 'API_PID_OWNERSHIP_MISMATCH' >&2; exit 2; }
kill -TERM "$pid"
for _ in $(seq 1 40); do
  state=$(ps -p "$pid" -o stat= 2>/dev/null || true)
  [[ -z "$state" || "$state" == Z* ]] && break
  sleep .25
done
state=$(ps -p "$pid" -o stat= 2>/dev/null || true)
[[ -z "$state" || "$state" == Z* ]] || kill -KILL "$pid"
node --import tsx apps/api/main.ts >>/proof/private/api.log 2>&1 &
new_pid=$!; printf '%s\n' "$new_pid" > "$PID_FILE"
printf 'restarted_owned_api old_pid=%s new_pid=%s\n' "$pid" "$new_pid"
