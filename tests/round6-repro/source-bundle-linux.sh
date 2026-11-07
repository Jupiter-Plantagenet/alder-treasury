#!/usr/bin/env bash
# Build an allow-listed source-only archive for TR-T-REPRO. No evidence, local profiles, runtime data,
# compiled artifacts, dependency trees, browser bytes, or source-control metadata are included.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
[[ -f package.json && -f package-lock.json && -f tests/round6-repro/toolchain.json ]] || { echo 'NOT_ALDER_SOURCE_ROOT' >&2; exit 2; }
command -v sha256sum >/dev/null || { echo 'sha256sum required' >&2; exit 2; }
TAR_VERSION=$(tar --version | head -1); GZIP_VERSION=$(gzip --version | head -1)
[[ "$TAR_VERSION" == 'tar (GNU tar)'* ]] || { echo "GNU_TAR_REQUIRED got '$TAR_VERSION'" >&2; exit 2; }
RUN_ID=${ALDER_REPRO_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}
[[ "$RUN_ID" =~ ^[A-Za-z0-9-]{8,64}$ ]] || { echo 'INVALID_RUN_ID' >&2; exit 2; }
OUT=${ALDER_REPRO_OUT:-"$ROOT/.local/repro/$RUN_ID"}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd -P)
case "$OUT/" in "$ROOT/.local/repro/"*) ;; *) echo 'OUTPUT_MUST_BE_UNDER_IGNORED_LOCAL_REPRO' >&2; exit 2;; esac
[[ ! -e "$OUT/source.tar.gz" && ! -e "$OUT/source.sha256" ]] || { echo 'REFUSING_OUTPUT_OVERWRITE' >&2; exit 2; }
TAR="$OUT/source.tar.gz"
FILES=(apps packages services db ops tests contracts/src contracts/test vendor docs/licenses docs/CUSTODY.md docs/acceptance.json docs/inputs/treasury-blueprint.md docs/inputs/PORTFOLIO-QUALITY-CHARTER.md docs/TR-T-REPRO-LINUX.md package.json package-lock.json tsconfig.json vite.config.ts index.html foundry.toml README.md RELEASE.md .gitignore)
for f in "${FILES[@]}"; do [[ -e "$f" ]] || { echo "SOURCE_INPUT_MISSING $f" >&2; exit 2; }; done
tar --format=gnu --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner \
  --exclude='*/node_modules' --exclude='node_modules' --exclude='*/.local' --exclude='.local' \
  --exclude='*/evidence' --exclude='evidence' --exclude='*/contracts/out' --exclude='contracts/out' \
  --exclude='*/dist' --exclude='dist' --exclude='*/.cache' --exclude='.cache' \
  -cf - "${FILES[@]}" | gzip -n > "$TAR"
if tar -tzf "$TAR" | grep -Ei '(^|/)(\.local|evidence|node_modules|\.cache|dist|out)(/|$)|(^|/)(accounts|database|wallet|profile)([^/]*\.(json|key|pem|sqlite|db))$'; then
  rm -f "$TAR"; echo 'SENSITIVE_OR_NON_SOURCE_PATH_IN_BUNDLE' >&2; exit 3
fi
sha256sum "$TAR" | awk '{print $1}' > "$OUT/source.sha256"
sha256sum package-lock.json tests/round6-repro/toolchain.json > "$OUT/pins.sha256"
{
  printf '{\n  "schema_version":"1",\n  "run_id":"%s",\n  "archive":"source.tar.gz",\n  "archive_sha256":"%s",\n  "package_lock_sha256":"%s",\n  "toolchain_metadata_sha256":"%s",\n  "archive_member_count":%s,\n  "source_commit":"%s",\n  "private_runtime_material_included":false,\n  "created_utc":"%s"\n}\n' \
    "$RUN_ID" "$(cat "$OUT/source.sha256")" \
    "$(sha256sum package-lock.json | awk '{print $1}')" \
    "$(sha256sum tests/round6-repro/toolchain.json | awk '{print $1}')" \
    "$(tar -tzf "$TAR" | wc -l | tr -d ' ')" \
    "$(git rev-parse HEAD 2>/dev/null || printf 'uncommitted-source')" \
    "$(date -u +%FT%TZ)"
} > "$OUT/source-manifest.json"
python3 - "$OUT/source-manifest.json" "$TAR_VERSION" "$GZIP_VERSION" "$TAR" <<'PY'
import hashlib,json,sys,tarfile
p=sys.argv[1];d=json.load(open(p,encoding='utf8'));d['archive_tools']={'tar':sys.argv[2],'gzip':sys.argv[3]};d['source_commit_note']='archive SHA256 is authoritative; the working tree may include uncommitted edits'
files=[]
with tarfile.open(sys.argv[4],'r:gz') as z:
    for m in z.getmembers():
        if not m.isfile(): continue
        src=z.extractfile(m)
        if src is None: raise SystemExit('SOURCE_ARCHIVE_MEMBER_READ_FAILED '+m.name)
        h=hashlib.sha256()
        while True:
            b=src.read(1024*1024)
            if not b: break
            h.update(b)
        files.append({'path':m.name,'sha256':h.hexdigest(),'bytes':m.size})
d['files']=files
with open(p,'w',encoding='utf8') as f:json.dump(d,f,indent=2);f.write('\n')
PY
printf 'SOURCE_ARCHIVE=%s\nSOURCE_SHA256=%s\nSOURCE_MANIFEST=%s\n' "$TAR" "$(cat "$OUT/source.sha256")" "$OUT/source-manifest.json"
