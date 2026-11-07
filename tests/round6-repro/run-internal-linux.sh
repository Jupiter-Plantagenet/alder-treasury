#!/usr/bin/env bash
# Complete Linux replay inside a fresh private hub network namespace.
set -euo pipefail
fail(){ echo "REPLAY_REFUSED $1" >&2; exit 2; }
[[ ${ALDER_REPRO_NAMESPACE:-} == 1 && ${ALDER_REPRO_PROJECT:-} == alder-repro-* ]] || fail 'OWNED_REPRO_NAMESPACE_MARKER_REQUIRED'
[[ $(uname -s) == Linux && $(node --version) == v26.7.0 && $(npm --version) == 11.19.0 ]] || fail 'NODE_OR_LINUX_TOOLCHAIN_MISMATCH'
python3 - <<'PY'
interfaces=[line.split(':',1)[0].strip() for line in open('/proc/net/dev').read().splitlines()[2:]]
routes=open('/proc/net/route').read().splitlines()[1:]
if interfaces!=['lo'] or routes: raise SystemExit('REPLAY_REFUSED NETWORK_NAMESPACE_NOT_LOOPBACK_ONLY')
PY
[[ -f /input/source.tar.gz && -x /opt/toolchain/foundry/forge && -x /opt/toolchain/foundry/anvil && -x /opt/toolchain/solc-0.8.24 ]] || fail 'PINNED_SOURCE_OR_TOOLCHAIN_MISSING'
[[ -x /opt/acquisition/chrome-linux64/chrome && -d /opt/acquisition/metamask-chrome-13.50.0-unpacked ]] || fail 'PINNED_BROWSER_OR_WALLET_MISSING'
[[ $(sha256sum /opt/acquisition/metamask-chrome-13.50.0.zip | awk '{print $1}') == b759caca275dec1a10edfebb9d1de1d26589a92104d8b0523ec442930e20e47c ]] || fail 'WALLET_ARCHIVE_PIN_MISMATCH'
[[ -d /opt/toolchain/npm-cache ]] || fail 'OFFLINE_NPM_CACHE_REQUIRED'
[[ ! -e /work/package.json && ! -e /work/.local && ! -e /work/evidence ]] || fail 'REFUSING_REUSED_WORK_VOLUME'
mkdir -p /work /proof/private /proof/public
tar -xzf /input/source.tar.gz -C /work
cd /work
[[ ! -e .local && ! -e evidence ]] || fail 'SOURCE_ARCHIVE_CONTAINS_RUNTIME_STATE'
mkdir -m 700 .local evidence runtime-logs
export ALDER_REPRO_SOURCE_ROOT=/work ALDER_REPRO_RUN_ID=${ALDER_REPRO_PROJECT#alder-repro-}
export ALDER_DB_PORT=5543 ALDER_CHAIN_RPC_URL=http://127.0.0.1:8547 ALDER_RPC_URL=http://127.0.0.1:18547
export ALDER_API_ORIGIN=https://127.0.0.1:8103 ALDER_ORIGIN=https://127.0.0.1:5113
export ALDER_W5_BROWSER=/opt/acquisition/chrome-linux64/chrome ALDER_ACCOUNTS_FILE=.local/accounts.json
export ALDER_DEPLOYMENT_FILE=evidence/app-deployment.json ALDER_PUBLIC_ORIGINS=https://127.0.0.1:5103,https://127.0.0.1:5113
export ALDER_RELEASE_PORT=5113 ALDER_WORKER_PORT=8113 ALDER_WORKER_LOG=runtime-logs/indexer-worker.jsonl
export ALDER_ISOLATED_WORKER_DB=postgresql://alder_indexer@127.0.0.1:15543/alder ALDER_EMAIL_PREFIX=''
export ALDER_W5_API_PID_FILE=/proof/private/api.pid W5_API_RESTART=1
mkdir -p .local/wallets/metamask-chrome-13.50.0
cp /opt/acquisition/metamask-chrome-13.50.0.zip .local/wallets/metamask-chrome-13.50.0/metamask-chrome-13.50.0.zip
mkdir .local/wallets/metamask-chrome-13.50.0/unpacked
cp -a /opt/acquisition/metamask-chrome-13.50.0-unpacked/. .local/wallets/metamask-chrome-13.50.0/unpacked/
export PATH=/opt/toolchain/foundry:$PATH
LOG=/proof/private/replay.log
exec > >(tee -a "$LOG") 2>&1
printf 'ALDER_REPRO_EPISODE=%s\n' "$ALDER_REPRO_RUN_ID"
printf 'SOURCE_SHA256=%s\n' "$(sha256sum /input/source.tar.gz | awk '{print $1}')"
printf 'WALLET_SHA256=%s\n' "$(sha256sum .local/wallets/metamask-chrome-13.50.0/metamask-chrome-13.50.0.zip | awk '{print $1}')"
printf 'CHROME_EXECUTABLE_SHA256=%s\n' "$(sha256sum "$ALDER_W5_BROWSER" | awk '{print $1}')"
echo 'PHASE offline-dependency-install'
npm ci --offline --ignore-scripts --no-audit --no-fund --cache /opt/toolchain/npm-cache
[[ $(sha256sum package-lock.json | awk '{print $1}') == 195104c5b7187ef47ebfd14fd435aac386ede27f86ecfc8bded3d02d31aac965 ]] || fail 'PACKAGE_LOCK_SHA_MISMATCH'
echo 'PHASE offline-compilation-and-unit-tests'
npm run build
npm run test:unit
echo 'PHASE contract-compilation-and-tests'
forge build --use /opt/toolchain/solc-0.8.24
forge test --use /opt/toolchain/solc-0.8.24 --fuzz-runs 1000
echo 'PHASE disposable-database-bootstrap-and-fixtures'
node --import tsx tests/round6-repro/bootstrap-db.ts
node --import tsx ops/seed.ts
echo 'PHASE fresh-anvil-deployment'
ALDER_RPC_URL=http://127.0.0.1:8547 node --import tsx tests/round6-repro/deploy-fresh-chain.ts
echo 'PHASE isolated-loopback-aliases'
node tests/round6-repro/loopback-proxy.mjs 15543 5543 >/proof/private/db-bridge.log 2>&1 & echo $! > /proof/private/db-bridge.pid
node tests/round6-repro/loopback-proxy.mjs 18547 8547 >/proof/private/rpc-bridge.log 2>&1 & echo $! > /proof/private/rpc-bridge.pid
echo 'PHASE private-local-tls'
bash ops/local-tls.sh >/proof/private/tls-bootstrap.log 2>&1
echo 'PHASE trust-episode-local-ca-in-disposable-chrome-user'
mkdir -p "$HOME/.pki/nssdb"
certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password >/dev/null 2>&1 || true
certutil -A -d "sql:$HOME/.pki/nssdb" -n 'Alder disposable episode CA' -t 'C,,' -i .local/tls/ca.pem
echo 'PHASE start-api-worker-and-compiled-release-ui'
node --import tsx apps/api/main.ts >/proof/private/api.log 2>&1 & echo $! > /proof/private/api.pid
node --import tsx services/indexer-worker.ts >/proof/private/worker.log 2>&1 & echo $! > /proof/private/worker.pid
ALDER_RELEASE_PORT=5113 node --import tsx ops/release-server.ts >/proof/private/release.log 2>&1 & echo $! > /proof/private/release.pid
for entry in 'api https://127.0.0.1:8103/health' 'release-ui https://127.0.0.1:5113/__release.json'; do
  read -r name url <<<"$entry"; ready=0
  for _ in $(seq 1 90); do if curl --fail --silent --cacert .local/tls/ca.pem "$url" >/dev/null; then ready=1; break; fi; sleep .5; done
  [[ $ready == 1 ]] || fail "SERVICE_NOT_READY_$name"
done
ready=0; for _ in $(seq 1 60); do if curl --fail --silent http://127.0.0.1:8113/status >/dev/null; then ready=1; break; fi; sleep .5; done
[[ $ready == 1 ]] || fail 'SERVICE_NOT_READY_worker'
echo 'PHASE compiled-release-http-security-tests'
ALDER_HTTP_SECURITY_ORIGIN=https://127.0.0.1:5113 npm run test:http
echo 'PHASE browser-wallet-real-extension-success-failure-reorg-and-verifier'
node --import tsx tests/round5/e2e-extension-wallet.ts
echo 'PHASE independent-verifier-failure-and-replay'
ALDER_LEGACY_PROOF=1 ALDER_DATABASE_URL=postgresql://postgres@127.0.0.1:5543/alder_v2_test ALDER_PROOF_EVIDENCE_DIR="evidence/legacy-proof-$ALDER_REPRO_RUN_ID" node --import tsx tests/chain-proof.ts
echo 'PHASE sanitized-public-proof-index'
python3 - <<'PY'
import hashlib,json,os,datetime
rows=[]
for base,dirs,files in os.walk('/work/evidence'):
    dirs[:]=[d for d in dirs if d.lower() not in ('.local','wallet-profiles','secrets')]
    for name in sorted(files):
        p=os.path.join(base,name); rel=os.path.relpath(p,'/work/evidence').replace(os.sep,'/')
        if any(x in rel.lower() for x in ('password','private-key','wallet-profile','seed-phrase','accounts.json')): continue
        rows.append({'path':rel,'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest(),'bytes':os.path.getsize(p),'classification':'private raw proof; public packet carries digest only'})
d={'schema_version':'1','scope':'TR-T-REPRO clean Linux disposable episode','created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'claims':'artifact inventory only; no acceptance result inferred','artifacts':rows}
with open('/proof/public/artifact-manifest.json','x',encoding='utf8') as f:json.dump(d,f,indent=2);f.write('\n')
PY
printf 'REPRO_DRIVER_END status=completed run=%s; review private proof and current 32-ID matrix before status changes\n' "$ALDER_REPRO_RUN_ID"
