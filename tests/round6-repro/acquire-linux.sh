#!/usr/bin/env bash
# Explicit online acquisition phase for a future isolated replay. All downloaded bytes stay in ignored .local storage.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P); cd "$ROOT"
fail(){ echo "ACQUIRE_REFUSED $1" >&2; exit 2; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'LINUX_X86_64_ACQUISITION_HOST_REQUIRED'
for c in curl sha256sum tar unzip python3 node npm; do command -v "$c" >/dev/null || fail "MISSING_$c"; done
[[ $(node --version) == v26.7.0 && $(npm --version) == 11.19.0 ]] || fail 'NODE_NPM_PIN_MISMATCH'
TARGET="$ROOT/.local/repro-acquisition/linux-x86_64"
mkdir -p "$TARGET/toolchain/foundry" "$TARGET/toolchain/npm-cache" "$TARGET/browser"
TARGET=$(cd "$TARGET" && pwd -P)
[[ "$TARGET" == "$ROOT/.local/repro-acquisition/"* ]] || fail 'ACQUISITION_TARGET_OUTSIDE_PRIVATE_LOCAL_STORAGE'
tmp="$TARGET/.acquire-$$"; mkdir -m 700 "$tmp"; trap 'rm -rf "$tmp"' EXIT
foundry_url='https://github.com/foundry-rs/foundry/releases/download/v1.5.1/foundry_v1.5.1_linux_amd64.tar.gz'
curl --fail --location --silent --show-error "$foundry_url" -o "$tmp/foundry.tgz"
[[ $(sha256sum "$tmp/foundry.tgz" | awk '{print $1}') == 73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88 ]] || fail 'FOUNDRY_ARCHIVE_SHA256_MISMATCH'
cp "$tmp/foundry.tgz" "$TARGET/toolchain/foundry-v1.5.1-linux-amd64.tar.gz"
tar -xzf "$tmp/foundry.tgz" -C "$TARGET/toolchain/foundry" forge anvil
solc_url='https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.24+commit.e11b9ed9'
curl --fail --location --silent --show-error "$solc_url" -o "$TARGET/toolchain/solc-0.8.24"
[[ $(sha256sum "$TARGET/toolchain/solc-0.8.24" | awk '{print $1}') == fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f ]] || fail 'SOLC_BINARY_SHA256_MISMATCH'
chmod 0755 "$TARGET/toolchain/solc-0.8.24" "$TARGET/toolchain/foundry/forge" "$TARGET/toolchain/foundry/anvil"
wallet_url='https://github.com/MetaMask/metamask-extension/releases/download/v13.50.0/metamask-chrome-13.50.0.zip'
curl --fail --location --silent --show-error "$wallet_url" -o "$TARGET/browser/metamask-chrome-13.50.0.zip"
[[ $(sha256sum "$TARGET/browser/metamask-chrome-13.50.0.zip" | awk '{print $1}') == b759caca275dec1a10edfebb9d1de1d26589a92104d8b0523ec442930e20e47c ]] || fail 'METAMASK_ZIP_SHA256_MISMATCH'
mkdir "$TARGET/browser/metamask-chrome-13.50.0-unpacked"
unzip -q "$TARGET/browser/metamask-chrome-13.50.0.zip" -d "$TARGET/browser/metamask-chrome-13.50.0-unpacked"
chrome_url='https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/linux64/chrome-linux64.zip'
chrome_metadata_url='https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json'
curl --fail --location --silent --show-error "$chrome_metadata_url" -o "$tmp/cft-known-good.json"
python3 - "$tmp/cft-known-good.json" "$chrome_url" <<'PY'
import json,sys
d=json.load(open(sys.argv[1],encoding='utf8'))
matches=[v for v in d['versions'] if v.get('version')=='151.0.7922.34']
urls=[x['url'] for v in matches for x in v.get('downloads',{}).get('chrome',[]) if x.get('platform')=='linux64']
if len(urls)!=1 or urls[0]!=sys.argv[2]: raise SystemExit('CHROME_VERSION_OR_URL_NOT_IN_OFFICIAL_CFT_METADATA')
PY
curl --fail --location --silent --show-error --head "$chrome_url" -o "$tmp/chrome-headers.txt"
python3 - "$tmp/chrome-headers.txt" "$tmp/chrome-object-metadata.json" <<'PY'
import json,sys
h={}
for line in open(sys.argv[1],encoding='latin1'):
    if ':' in line:
        k,v=line.split(':',1);h[k.strip().lower()]=v.strip()
hashes=[x.strip() for x in h.get('x-goog-hash','').split(',')]
md5=next((x.split('=',1)[1] for x in hashes if x.startswith('md5=')),None)
if not md5 or not h.get('x-goog-generation') or not h.get('etag'): raise SystemExit('GOOGLE_STORAGE_OBJECT_METADATA_INCOMPLETE')
with open(sys.argv[2],'w',encoding='utf8') as f:json.dump({'etag':h['etag'].strip('"'),'generation':h['x-goog-generation'],'md5_base64':md5,'content_length':int(h['content-length'])},f,indent=2);f.write('\n')
PY
curl --fail --location --silent --show-error "$chrome_url" -o "$tmp/chrome-linux64.zip"
python3 - "$tmp/chrome-linux64.zip" "$tmp/chrome-object-metadata.json" <<'PY'
import base64,hashlib,json,os,sys
m=json.load(open(sys.argv[2],encoding='utf8'))
if os.path.getsize(sys.argv[1])!=m['content_length']: raise SystemExit('CHROME_CFT_CONTENT_LENGTH_MISMATCH')
with open(sys.argv[1],'rb') as f: md5=hashlib.file_digest(f,'md5').digest()
if base64.b64encode(md5).decode()!=m['md5_base64']: raise SystemExit('CHROME_CFT_GOOGLE_STORAGE_MD5_MISMATCH')
PY
chrome_archive_sha=$(sha256sum "$tmp/chrome-linux64.zip" | awk '{print $1}')
cp "$tmp/chrome-linux64.zip" "$TARGET/browser/chrome-linux64.zip"
cp "$tmp/cft-known-good.json" "$TARGET/browser/known-good-versions-with-downloads.json"
mkdir "$tmp/chrome"; unzip -q "$tmp/chrome-linux64.zip" -d "$tmp/chrome"
[[ -x "$tmp/chrome/chrome-linux64/chrome" ]] || fail 'CHROME_ARCHIVE_LAYOUT_MISMATCH'
cp -a "$tmp/chrome/chrome-linux64" "$TARGET/browser/chrome-linux64"
python3 - "$TARGET/browser/browser-linux.json" "$chrome_archive_sha" "$tmp/cft-known-good.json" "$tmp/chrome-object-metadata.json" <<'PY'
import hashlib,json,sys,datetime
cft=json.load(open(sys.argv[3],encoding='utf8'))
d={'name':'Chrome for Testing','version':'151.0.7922.34','source_url':'https://googlechromelabs.github.io/chrome-for-testing/','official_version_metadata_url':'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json','official_version_metadata_timestamp':cft.get('timestamp'),'official_version_metadata_sha256':hashlib.sha256(open(sys.argv[3],'rb').read()).hexdigest(),'download_url':'https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/linux64/chrome-linux64.zip','linux_x64_archive_sha256':sys.argv[2],'linux_x64_executable_sha256':None,'google_storage_object':json.load(open(sys.argv[4],encoding='utf8')),'digest_scope':'archive SHA256 computed locally after HTTPS download; Google Storage MD5, ETag and generation are verified/recorded as object metadata, not a publisher signature','redistribution':'not included in Alder source bundle','license':'Google Chrome Terms of Service','acquired_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(sys.argv[1],'x',encoding='utf8') as f:json.dump(d,f,indent=2);f.write('\n')
PY
python3 - "$TARGET/browser/browser-linux.json" "$TARGET/browser/chrome-linux64/chrome" <<'PY'
import hashlib,json,sys
p=sys.argv[1];d=json.load(open(p,encoding='utf8'));d['linux_x64_executable_sha256']=hashlib.sha256(open(sys.argv[2],'rb').read()).hexdigest()
with open(p,'w',encoding='utf8') as f:json.dump(d,f,indent=2);f.write('\n')
PY
# Populate an offline npm content cache against the immutable lockfile in a disposable source tree.
src="$ROOT/.local/repro-acquisition/npm-source"; [[ ! -e "$src" ]] || fail 'NPM_SOURCE_STAGE_ALREADY_EXISTS'
mkdir -p "$src"; tar -xzf "${ALDER_REPRO_SOURCE_ARCHIVE:?set sanitized source archive}" -C "$src"
cd "$src"; npm ci --ignore-scripts --no-audit --no-fund --cache "$TARGET/toolchain/npm-cache"
rm -rf "$src/node_modules"; cd "$ROOT"
cp tests/round6-repro/toolchain.json "$TARGET/toolchain/toolchain.json"
printf 'ACQUIRED PRIVATE LOCAL TOOLCHAIN: %s\n' "$TARGET"
printf 'Browser SHA is recorded in browser/browser-linux.json; browser and wallet bytes are excluded from source releases.\n'
