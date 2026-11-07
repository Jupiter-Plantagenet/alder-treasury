#!/usr/bin/env bash
# Start a fully private, per-run shared network namespace. No port is published to the host and
# no pre-existing container, volume, source folder, chain state, or database is removed/reused.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P); cd "$ROOT"
fail(){ echo "STACK_REFUSED $1" >&2; exit 2; }
[[ $(uname -s) == Linux ]] || fail 'LINUX_HOST_REQUIRED'
for c in docker python3 sha256sum; do command -v "$c" >/dev/null || fail "MISSING_$c"; done
docker compose version >/dev/null 2>&1 || fail 'DOCKER_COMPOSE_V2_REQUIRED'
SRC=${ALDER_REPRO_SOURCE_ARCHIVE:-}; TOOL=${ALDER_REPRO_TOOLCHAIN_DIR:-}; ACQ=${ALDER_REPRO_ACQUISITION_DIR:-}
IMAGE=${ALDER_REPRO_IMAGE:-}
[[ -f "$SRC" && -d "$TOOL" && -d "$ACQ" && -n "$IMAGE" ]] || fail 'ARCHIVE_TOOLCHAIN_IMAGE_AND_ACQUISITION_PATHS_REQUIRED'
SRC=$(realpath -e "$SRC"); TOOL=$(realpath -e "$TOOL"); ACQ=$(realpath -e "$ACQ")
[[ "$SRC" == "$ROOT/.local/repro/"* ]] || fail 'SOURCE_ARCHIVE_MUST_BE_UNDER_IGNORED_LOCAL_REPRO'
SOURCE_MANIFEST="$(dirname "$SRC")/source-manifest.json"
[[ -f "$SOURCE_MANIFEST" ]] || fail 'SOURCE_FILE_MANIFEST_REQUIRED'
python3 - "$SOURCE_MANIFEST" "$SRC" <<'PY'
import hashlib,json,sys
m=json.load(open(sys.argv[1],encoding='utf8'));h=hashlib.sha256(open(sys.argv[2],'rb').read()).hexdigest()
if m.get('archive_sha256')!=h: raise SystemExit('SOURCE_MANIFEST_ARCHIVE_DIGEST_MISMATCH')
PY
[[ -x "$TOOL/foundry/forge" && -x "$TOOL/foundry/anvil" && -x "$TOOL/solc-0.8.24" && -d "$TOOL/npm-cache" && -f "$TOOL/toolchain.json" ]] || fail 'VERIFIED_TOOLCHAIN_LAYOUT_REQUIRED'
[[ $(sha256sum "$TOOL/foundry-v1.5.1-linux-amd64.tar.gz" | awk '{print $1}') == 73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88 ]] || fail 'FOUNDRY_ARCHIVE_PIN_MISMATCH'
[[ $(sha256sum "$TOOL/solc-0.8.24" | awk '{print $1}') == fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f ]] || fail 'SOLC_BINARY_PIN_MISMATCH'
[[ -f "$ACQ/metamask-chrome-13.50.0.zip" && -d "$ACQ/metamask-chrome-13.50.0-unpacked" && -x "$ACQ/chrome-linux64/chrome" && -f "$ACQ/chrome-linux64.zip" && -f "$ACQ/browser-linux.json" ]] || fail 'LOCAL_BROWSER_AND_WALLET_ACQUISITION_REQUIRED'
[[ $(sha256sum "$ACQ/metamask-chrome-13.50.0.zip" | awk '{print $1}') == b759caca275dec1a10edfebb9d1de1d26589a92104d8b0523ec442930e20e47c ]] || fail 'METAMASK_ZIP_PIN_MISMATCH'
python3 - "$ACQ/metamask-chrome-13.50.0-unpacked/manifest.json" <<'PY'
import json,sys
if json.load(open(sys.argv[1],encoding='utf8')).get('version')!='13.50.0':
    raise SystemExit('STACK_REFUSED METAMASK_UNPACKED_VERSION_MISMATCH')
PY
python3 - "$ACQ/browser-linux.json" "$ACQ/chrome-linux64/chrome" "$ACQ/chrome-linux64.zip" <<'PY'
import base64,hashlib,json,sys
m=json.load(open(sys.argv[1],encoding='utf8'))
if m.get('name')!='Chrome for Testing' or m.get('version')!='151.0.7922.34' or m.get('source_url','').find('googlechromelabs.github.io/chrome-for-testing')<0:
    raise SystemExit('STACK_REFUSED BROWSER_PROVENANCE_FIELDS')
with open(sys.argv[2],'rb') as f: h=hashlib.file_digest(f,'sha256').hexdigest()
if h!=m.get('linux_x64_executable_sha256'): raise SystemExit('STACK_REFUSED BROWSER_EXECUTABLE_DIGEST_MISMATCH')
with open(sys.argv[3],'rb') as f: archive=hashlib.file_digest(f,'sha256').hexdigest()
if archive!=m.get('linux_x64_archive_sha256'): raise SystemExit('STACK_REFUSED BROWSER_ARCHIVE_DIGEST_MISMATCH')
if m.get('google_storage_object',{}).get('md5_base64'):
    with open(sys.argv[3],'rb') as f: md5=base64.b64encode(hashlib.file_digest(f,'md5').digest()).decode()
    if md5!=m['google_storage_object']['md5_base64']: raise SystemExit('STACK_REFUSED BROWSER_STORAGE_MD5_MISMATCH')
PY
python3 - "$ACQ/browser-linux.json" "$ACQ/known-good-versions-with-downloads.json" <<'PY'
import hashlib,json,sys
m=json.load(open(sys.argv[1],encoding='utf8'))
with open(sys.argv[2],'rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
if h!=m.get('official_version_metadata_sha256'): raise SystemExit('STACK_REFUSED_CFT_METADATA_DIGEST_MISMATCH')
d=json.load(open(sys.argv[2],encoding='utf8'))
urls=[x['url'] for v in d['versions'] if v.get('version')==m.get('version') for x in v.get('downloads',{}).get('chrome',[]) if x.get('platform')=='linux64']
if urls!=[m.get('download_url')]: raise SystemExit('STACK_REFUSED_CFT_METADATA_URL_MISMATCH')
PY
for image in "$IMAGE" 'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "PINNED_IMAGE_NOT_PRESENT_NO_PULL_PERMITTED $image"
done
RUN_ID=${ALDER_REPRO_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}
RUN_ID=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')
[[ "$RUN_ID" =~ ^[A-Za-z0-9-]{8,64}$ ]] || fail 'INVALID_RUN_ID'
PROJECT="alder-repro-$RUN_ID"
RUN_DIR="$ROOT/.local/repro/$RUN_ID"
mkdir -p "$RUN_DIR"
[[ ! -e "$RUN_DIR/stack.json" ]] || fail 'RUN_MANIFEST_ALREADY_EXISTS'
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT") ]] || fail 'COMPOSE_PROJECT_ALREADY_EXISTS_REFUSING_REUSE'
[[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT") ]] || fail 'COMPOSE_VOLUME_ALREADY_EXISTS_REFUSING_REUSE'
export ALDER_REPRO_PROJECT="$PROJECT" ALDER_REPRO_SOURCE_ARCHIVE="$SRC" ALDER_REPRO_TOOLCHAIN_DIR="$TOOL" ALDER_REPRO_ACQUISITION_DIR="$ACQ" ALDER_REPRO_IMAGE="$IMAGE"
python3 - "$RUN_DIR/stack.json" "$RUN_ID" "$PROJECT" "$SRC" "$SOURCE_MANIFEST" "$TOOL" "$ACQ" "$IMAGE" "$(docker image inspect "$IMAGE" --format '{{.Id}}')" <<'PY'
import datetime,json,sys
out,run,project,src,source_manifest,tool,acq,image,image_id=sys.argv[1:]
d={'schema_version':'1','run_id':run,'compose_project':project,'status':'starting_or_partial_failure','source_archive_path':src,'source_manifest_path':source_manifest,'toolchain_directory':tool,'acquisition_directory':acq,'runner_image_tag':image,'runner_image_id':image_id,'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(out,'x',encoding='utf8') as f:json.dump(d,f,indent=2);f.write('\n')
PY
docker compose --project-name "$PROJECT" -f tests/round6-repro/compose.yaml up --pull never --detach hub postgres anvil
for svc in hub postgres anvil; do
  for _ in $(seq 1 60); do
    state=$(docker compose --project-name "$PROJECT" -f tests/round6-repro/compose.yaml ps --format json "$svc" | python3 -c 'import json,sys;x=json.load(sys.stdin);print(x.get("Health", ""))')
    [[ "$state" == healthy ]] && break
    sleep 1
  done
  [[ "$state" == healthy ]] || fail "SERVICE_NOT_HEALTHY $svc"
done
while IFS= read -r cid; do
  [[ -n "$cid" ]] || continue
  bindings=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$cid")
  [[ "$bindings" == null || "$bindings" == '{}' ]] || fail "HOST_PORT_BINDING_PRESENT $cid"
done < <(docker compose --project-name "$PROJECT" -f tests/round6-repro/compose.yaml ps --quiet)
python3 - "$RUN_DIR/stack.json" "$RUN_ID" "$PROJECT" "$SRC" "$SOURCE_MANIFEST" "$TOOL" "$ACQ" "$IMAGE" "$(docker image inspect "$IMAGE" --format '{{.Id}}')" <<'PY'
import hashlib,json,os,platform,sys,datetime
out,run,project,src,source_manifest,tool,acq,image,image_id=sys.argv[1:]
sha=lambda p:hashlib.sha256(open(p,'rb').read()).hexdigest()
browser=json.load(open(os.path.join(acq,'browser-linux.json'),encoding='utf8'))
d={'schema_version':'1','run_id':run,'compose_project':project,'status':'isolated_namespace_started_only','source_archive_path':src,'source_manifest_path':source_manifest,'source_manifest_sha256':sha(source_manifest),'toolchain_directory':tool,'acquisition_directory':acq,'runner_image_tag':image,'runner_image_id':image_id,'host_kernel':platform.release(),'architecture':platform.machine(),'network_mode':'hub: none; postgres/anvil share hub network namespace','anvil_hardfork':'shanghai','published_host_ports':[],'internal_endpoints':{'postgres':'127.0.0.1:5543','wallet_and_truth_anvil':'127.0.0.1:8547','API':'127.0.0.1:8103','dev_UI':'127.0.0.1:5103','release_UI':'127.0.0.1:5113','worker':'127.0.0.1:8113'},'source_archive_sha256':sha(src),'runner_image_base':'node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32','postgres_image':'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777','toolchain_metadata_sha256':sha(os.path.join(tool,'toolchain.json')),'browser':browser,'wallet_zip_sha256':sha(os.path.join(acq,'metamask-chrome-13.50.0.zip')),'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(out,'w',encoding='utf8') as f:json.dump(d,f,indent=2);f.write('\n')
PY
printf 'ALDER_REPRO_RUN_ID=%s\nALDER_REPRO_PROJECT=%s\nSTACK_MANIFEST=%s\n' "$RUN_ID" "$PROJECT" "$RUN_DIR/stack.json"
