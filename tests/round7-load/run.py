"""Run P6 workload under the shared lock, with preserved raw output and source pins."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT=Path('C:/Users/user/portfolio-build/alder')
sys.path.insert(0,str(ROOT.parent/'tools'))
import product_lock

run,mode=sys.argv[1:3]
out=ROOT/'.local/scratch-r6/runs'/run
env=dict(os.environ,P6_RUN_ID=run,ALDER_DEPLOYMENT_FILE='evidence/round5-ops/isolated-deployment.json',
         ALDER_RPC_URL='http://127.0.0.1:18547')
if mode in ('smoke','rate'):
    env.update(O5_DURATION='90' if mode=='smoke' else '30',
               O5_BATCH_AT='5,50' if mode=='smoke' else '480,1080',
               O5_OUT=str(out/('load/smoke-90s' if mode=='smoke' else 'load/rate-30s')))
    argv=[str(ROOT/'.local/runtime/node-v26.7.0/node.exe'),'--import','tsx','tests/round6-perf/load-run-p6.ts']
elif mode=='full':
    setup=json.loads((out/'setup-receipt.json').read_text())
    env.update(P6_DURATION='1800',P6_SAMPLER_CONTAINER=setup['container'],
               P6_VITALS_RUNNER='tests/round7-load/vitals-release.ts',
               P6_VITALS_DIST=str(ROOT/'.local/release-candidate-20261103'))
    argv=['C:/Program Files/Git/bin/bash.exe','tests/round6-perf/run-load-full-p6.sh']
else:raise RuntimeError('MODE_INVALID')
sources={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()
         for folder in ('apps','packages','services','tests/round6-perf','tests/round7-load')
         for p in (ROOT/folder).rglob('*') if p.is_file() and p.suffix in ('.ts','.tsx','.ps1','.sh')}
deadline=time.monotonic()+600
announced=False
while not product_lock.acquire('alder','round7-'+mode+'-load'):
    if not announced:
        print('Waiting for the current shared heavy-work owner to finish; no lock is stolen.',flush=True)
        announced=True
    if time.monotonic()>deadline:raise RuntimeError('SHARED_HEAVY_LOCK_HELD_TIMEOUT')
    time.sleep(1)
try:
    record=out/(mode+'-source-pins.json')
    with record.open('x',encoding='utf-8') as f:json.dump(sources,f,indent=2)
    print(json.dumps(dict(run=run,mode=mode,started=datetime.now(timezone.utc).isoformat())),flush=True)
    with (out/(mode+'-wrapper.raw.log')).open('xb') as log:
        p=subprocess.run(argv,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
    changed=[name for name,sha in sources.items() if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=sha]
    result=dict(exit_code=p.returncode,source_changed=changed,run=run,mode=mode)
    (out/(mode+'-wrapper-result.json')).write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
finally:product_lock.release()
sys.exit(p.returncode if p.returncode else (1 if changed else 0))
