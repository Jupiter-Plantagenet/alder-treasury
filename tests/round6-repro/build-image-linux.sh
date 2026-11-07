#!/usr/bin/env bash
# Build the local runner image from exact Node and Debian snapshot inputs. Never pulls implicitly.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P); cd "$ROOT"
command -v docker >/dev/null || { echo 'DOCKER_REQUIRED' >&2; exit 2; }
docker image inspect 'node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32' >/dev/null 2>&1 || { echo 'PINNED_NODE_IMAGE_NOT_PRESENT_NO_PULL' >&2; exit 2; }
RUN_ID=${ALDER_REPRO_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
[[ "$RUN_ID" =~ ^[A-Za-z0-9-]{8,64}$ ]] || { echo 'INVALID_RUN_ID' >&2; exit 2; }
TAG="alder-repro:$RUN_ID"
CTX="$ROOT/.local/repro/$RUN_ID/image-build-context"
mkdir -p "$CTX"; [[ ! -e "$CTX/Dockerfile" ]] || { echo 'IMAGE_BUILD_CONTEXT_EXISTS_REFUSING_OVERWRITE' >&2; exit 2; }
cp tests/round6-repro/Dockerfile "$CTX/Dockerfile"
# The Docker build context contains exactly the Dockerfile; no .local credentials, evidence,
# application source, browser files, or unrelated product workspace is sent to the daemon.
docker build --pull=false --file "$CTX/Dockerfile" --tag "$TAG" "$CTX"
IMAGE_ID=$(docker image inspect "$TAG" --format '{{.Id}}')
META="$ROOT/.local/repro/$RUN_ID/image.json"; mkdir -p "$(dirname "$META")"; [[ ! -e "$META" ]] || { echo 'IMAGE_MANIFEST_EXISTS_REFUSING_OVERWRITE' >&2; exit 2; }
python3 - "$META" "$RUN_ID" "$TAG" "$IMAGE_ID" <<'PY'
import datetime,json,sys
out,run,tag,image=sys.argv[1:]
d={'schema_version':'1','run_id':run,'image_tag':tag,'image_id':image,'base':'node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32','debian_snapshot':'20261102T000000Z','dockerfile':'tests/round6-repro/Dockerfile','status':'locally_built_for_this_run','licenses':['Node MIT','Debian component licenses; notices retained in image','Google Chrome is a locally mounted separately acquired binary, not redistributed in this image'] ,'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(out,'x',encoding='utf8') as f:json.dump(d,f,indent=2);f.write('\n')
PY
printf 'ALDER_REPRO_IMAGE=%s\nIMAGE_MANIFEST=%s\n' "$TAG" "$META"
