"""Tracked isolated P6 services; preserves files and terminates only its children."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT=Path('C:/Users/user/portfolio-build/alder')
run=sys.argv[1]
out=ROOT/'.local/scratch-r6/runs'/run
setup=json.loads((out/'setup-receipt.json').read_text())
node=ROOT/'.local/runtime/node-v26.7.0/node.exe'
env=dict(os.environ)
env.update(P6_RUN_ID=run,ALDER_RPC_URL='http://127.0.0.1:18547',
           ALDER_DEPLOYMENT_FILE='evidence/round5-ops/isolated-deployment.json',
           ALDER_RELOAD_POINTS_FILE=str(out/'reload-points-18548.jsonl'),
           O5_SRC=str(ROOT),O5_POOL_MAX='8',
           ALDER_PUBLIC_ORIGINS='http://127.0.0.1:5103,https://127.0.0.1:5103',
           O5_TAMPER_LOG=str(out/'proxy-tamper.jsonl'),
           ALDER_ISOLATED_WORKER_DB='postgresql://alder_indexer@127.0.0.1:15543/alder',
           ALDER_WORKER_PORT='9113',ALDER_WORKER_ROLE='round7-load',
           ALDER_WORKER_LOG=str(out/'runtime/worker.jsonl'),
           ALDER_OUTBOX_SINK=str(out/'notifications'))
(out/'runtime').mkdir(exist_ok=True)
children=[]
def launch(name,args):
    logpath=out/('runtime/'+name+'.raw.log')
    if logpath.exists():logpath=out/('runtime/'+name+'.'+str(time.time_ns())+'.raw.log')
    log=logpath.open('xb')
    p=subprocess.Popen([str(x) for x in args],cwd=ROOT,env=env,
                       stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
    children.append((name,p,log))
    return p
def rpc(method,params):
    req=urllib.request.Request('http://127.0.0.1:18548',
        json.dumps(dict(jsonrpc='2.0',id=1,method=method,params=params)).encode(),
        {'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(req,timeout=10))['result']
try:
    subprocess.run([str(node),'ops/sanitize-anvil-state.mjs',setup['chain_state'],
                    setup['genesis_timestamp']],cwd=ROOT,check=True)
    launch('anvil',[Path('C:/Users/user/.foundry/bin/anvil.exe'),'--host','127.0.0.1',
           '--port','18548','--chain-id','31337','--hardfork','shanghai','--silent',
           '--state',setup['chain_state'],'--state-interval','5'])
    for _ in range(60):
        try:
            genesis=rpc('eth_getBlockByNumber',['0x0',False])
            break
        except Exception:time.sleep(.5)
    else:raise RuntimeError('ANVIL_START_TIMEOUT')
    if genesis['hash'].lower()!=setup['expected_genesis'].lower():
        raise RuntimeError('ISOLATED_GENESIS_MISMATCH')
    launch('proxy',[node,'tests/round5-ops/rpc-proxy.mjs'])
    launch('api',[node,'--max-old-space-size=2048','--import','tsx','tests/round5-ops/isolated-api.ts'])
    launch('worker',[node,'--import','tsx','services/indexer-worker.ts'])
    print(json.dumps(dict(run=run,pids={n:p.pid for n,p,_ in children},
                         genesis=genesis['hash'],head=rpc('eth_blockNumber',[]))),flush=True)
    while True:
        for name,p,_ in children:
            if p.poll() is not None:raise RuntimeError(name.upper()+'_EXITED_'+str(p.returncode))
        time.sleep(2)
finally:
    for _,p,_ in reversed(children):
        if p.poll() is None:p.terminate()
    for _,p,log in children:
        try:p.wait(timeout=15)
        except subprocess.TimeoutExpired:p.kill()
        log.close()
