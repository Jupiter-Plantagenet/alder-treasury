#!/usr/bin/env bash
# Stop only a run whose project name and private run manifest agree. Volumes are preserved by default.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P); cd "$ROOT"
RUN_ID=${1:-}; [[ "$RUN_ID" =~ ^[a-z0-9-]{8,64}$ ]] || { echo 'RUN_ID_REQUIRED' >&2; exit 2; }
RUN_DIR="$ROOT/.local/repro/$RUN_ID"; MANIFEST="$RUN_DIR/stack.json"
[[ -f "$MANIFEST" ]] || { echo 'OWNED_RUN_MANIFEST_MISSING' >&2; exit 2; }
PROJECT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["compose_project"])' "$MANIFEST")
[[ "$PROJECT" == "alder-repro-$RUN_ID" ]] || { echo 'PROJECT_MANIFEST_MISMATCH' >&2; exit 2; }
case ${2:-} in ''|--delete-owned-disposable-volume) ;; *) echo 'UNKNOWN_OPTION' >&2; exit 2;; esac
export ALDER_REPRO_PROJECT="$PROJECT"
export ALDER_REPRO_SOURCE_ARCHIVE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["source_archive_path"])' "$MANIFEST")
export ALDER_REPRO_TOOLCHAIN_DIR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["toolchain_directory"])' "$MANIFEST")
export ALDER_REPRO_ACQUISITION_DIR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["acquisition_directory"])' "$MANIFEST")
export ALDER_REPRO_IMAGE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runner_image_tag"])' "$MANIFEST")
docker compose --project-name "$PROJECT" -f tests/round6-repro/compose.yaml stop
if [[ ${2:-} == --delete-owned-disposable-volume ]]; then
  echo "Deleting only Compose project $PROJECT and its per-run volumes after proof export."
  docker compose --project-name "$PROJECT" -f tests/round6-repro/compose.yaml down --volumes --remove-orphans
fi
