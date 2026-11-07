#!/usr/bin/env bash
# Single entry point after the separately reviewed, checksum-pinned local acquisition step.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P); cd "$ROOT"
fail(){ echo "REPRO_REFUSED $1" >&2; exit 2; }
for c in docker python3 sha256sum; do command -v "$c" >/dev/null || fail "MISSING_$c"; done
RUN_ID=${ALDER_REPRO_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}
RUN_ID=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')
[[ "$RUN_ID" =~ ^[a-z0-9-]{8,64}$ ]] || fail 'INVALID_RUN_ID'
PROJECT="alder-repro-$RUN_ID"
RUN_DIR="$ROOT/.local/repro/$RUN_ID"
mkdir -p "$RUN_DIR"
export ALDER_REPRO_RUN_ID="$RUN_ID"
if [[ ! -f "$RUN_DIR/source.tar.gz" ]]; then
  bash tests/round6-repro/source-bundle-linux.sh
fi
export ALDER_REPRO_SOURCE_ARCHIVE="$RUN_DIR/source.tar.gz"
export ALDER_REPRO_PROJECT="$PROJECT"
export ALDER_REPRO_TOOLCHAIN_DIR=${ALDER_REPRO_TOOLCHAIN_DIR:-"$ROOT/.local/repro-acquisition/linux-x86_64/toolchain"}
export ALDER_REPRO_ACQUISITION_DIR=${ALDER_REPRO_ACQUISITION_DIR:-"$ROOT/.local/repro-acquisition/linux-x86_64/browser"}
export ALDER_REPRO_IMAGE=${ALDER_REPRO_IMAGE:-"alder-repro:$RUN_ID"}
[[ -d "$ALDER_REPRO_TOOLCHAIN_DIR" && -d "$ALDER_REPRO_ACQUISITION_DIR" ]] || fail 'RUN_CHECKSUMMED_ACQUISITION_STEP_FIRST'
[[ -f "$RUN_DIR/image.json" ]] || fail 'BUILD_AND_RECORD_LOCAL_RUNNER_IMAGE_FIRST'
IMAGE_ID=$(docker image inspect "$ALDER_REPRO_IMAGE" --format '{{.Id}}' 2>/dev/null) || fail 'RUNNER_IMAGE_NOT_PRESENT_NO_PULL_OR_BUILD_HERE'
[[ $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image_id"])' "$RUN_DIR/image.json") == "$IMAGE_ID" ]] || fail 'RUNNER_IMAGE_RECEIPT_MISMATCH'
export ALDER_REPRO_IMAGE
bash tests/round6-repro/stack-start-linux.sh
docker compose --project-name "$PROJECT" -f tests/round6-repro/compose.yaml exec --no-TTY hub bash -lc \
  'mkdir -p /tmp/repro-entry && tar -xzf /input/source.tar.gz -C /tmp/repro-entry tests/round6-repro/run-internal-linux.sh && bash /tmp/repro-entry/tests/round6-repro/run-internal-linux.sh'
docker compose --project-name "$PROJECT" -f tests/round6-repro/compose.yaml cp hub:/proof/public/artifact-manifest.json "$RUN_DIR/artifact-manifest.json"
python3 - "$RUN_DIR/stack.json" "$RUN_DIR/artifact-manifest.json" <<'PY'
import json,sys,datetime
stack=json.load(open(sys.argv[1],encoding='utf8'));art=json.load(open(sys.argv[2],encoding='utf8'))
out={'schema_version':'1','run_id':stack['run_id'],'compose_project':stack['compose_project'],'source_archive_sha256':stack['source_archive_sha256'],'runner_image_id':stack['runner_image_id'],'public_artifact_manifest_sha256':__import__('hashlib').sha256(open(sys.argv[2],'rb').read()).hexdigest(),'private_raw_proof_location':f"docker volume owned by {stack['compose_project']} project; contents not copied into source or public packet",'status':'driver exited successfully; acceptance reconciliation remains an independent step','artifact_count':len(art['artifacts']),'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(sys.argv[1].replace('stack.json','run-completion.json'),'x',encoding='utf8') as f:json.dump(out,f,indent=2);f.write('\n')
PY
printf 'REPRO_RUN=%s\nPUBLIC_ARTIFACT_MANIFEST=%s\nPRIVATE_RAW_PROOF=Compose project %s proof volume (preserved)\n' "$RUN_ID" "$RUN_DIR/artifact-manifest.json" "$PROJECT"
