import json
import pathlib
import sys
import time
import urllib.error
import urllib.request
import psutil

ROOT = pathlib.Path(r'C:\Users\user\portfolio-build\alder').resolve()
NODE = str((ROOT / '.local/runtime/node-v26.7.0/node.exe').resolve())
EXPECTED_CMD = [NODE, '--max-old-space-size=2048', '--import', 'tsx', 'tests/round5-ops/isolated-api.ts']

def api_health():
    with urllib.request.urlopen('http://127.0.0.1:9103/health', timeout=3) as response:
        data = json.loads(response.read().decode('utf-8'))
        if response.status != 200 or not data.get('ready') or data.get('chainId') != 31337:
            raise RuntimeError('P6_API_HEALTH_NOT_READY')
        return data

def validate(pid, expected_birth=None):
    p = psutil.Process(pid)
    exe = str(pathlib.Path(p.exe()).resolve())
    cwd = str(pathlib.Path(p.cwd()).resolve())
    cmd = p.cmdline()
    birth = p.create_time()
    if expected_birth is not None and birth != float(expected_birth): raise RuntimeError('P6_API_BIRTH_MISMATCH')
    if exe.lower() != NODE.lower() or cwd.lower() != str(ROOT).lower() or cmd != EXPECTED_CMD:
        raise RuntimeError('P6_API_PROCESS_IDENTITY_MISMATCH')
    return p, {'pid': pid, 'birth': birth, 'exe': exe, 'cmd': cmd, 'cwd': cwd}

action = sys.argv[1]
pid = int(sys.argv[2])
if action == 'inspect':
    deadline = time.time() + 120
    while True:
        p, identity = validate(pid)
        try:
            health = api_health()
            print(json.dumps({'event': 'verified-api', **identity, 'ready': True, 'chainId': health.get('chainId')}, separators=(',', ':')))
            break
        except Exception:
            if time.time() >= deadline: raise
            time.sleep(2)
elif action == 'stop':
    if len(sys.argv) != 4: raise SystemExit('P6_API_BIRTH_ARGUMENT_REQUIRED')
    p, identity = validate(pid, sys.argv[3])
    health = api_health()
    print(json.dumps({'event': 'verified-api-before-stop', **identity, 'ready': True, 'chainId': health.get('chainId')}, separators=(',', ':')))
    p.terminate()
    p.wait(timeout=15)
    try:
        api_health()
        raise RuntimeError('P6_API_PORT_STILL_SERVING_AFTER_STOP')
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        pass
    print(json.dumps({'event': 'stopped-exact-api', 'pid': pid, 'birth': identity['birth']}, separators=(',', ':')))
else:
    raise SystemExit('P6_API_ACTION_INVALID')
