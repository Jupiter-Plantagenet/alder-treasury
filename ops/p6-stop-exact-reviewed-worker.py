import json
import pathlib
import sys
import urllib.request
import psutil

ROOT = pathlib.Path(r'C:\Users\user\portfolio-build\alder').resolve()
EXPECTED_PID = 45408
EXPECTED_BIRTH = 1793624549.9328976
NODE = str((ROOT / '.local/runtime/node-v26.7.0/node.exe').resolve())

p = psutil.Process(EXPECTED_PID)
exe = str(pathlib.Path(p.exe()).resolve())
cmd = p.cmdline()
cwd = str(pathlib.Path(p.cwd()).resolve())
if p.create_time() != EXPECTED_BIRTH:
    raise SystemExit('P6_WORKER_BIRTH_MISMATCH')
if exe.lower() != NODE.lower() or cwd.lower() != str(ROOT).lower():
    raise SystemExit('P6_WORKER_PATH_IDENTITY_MISMATCH')
if cmd != [NODE, '--import', 'tsx', 'services/indexer-worker.ts']:
    raise SystemExit('P6_WORKER_COMMAND_IDENTITY_MISMATCH')
with urllib.request.urlopen('http://127.0.0.1:9103/health', timeout=4) as response:
    api = json.loads(response.read().decode('utf-8'))
if response.status != 200 or not api.get('ready') or api.get('chainId') != 31337:
    raise SystemExit('P6_API_NOT_HEALTHY')
with urllib.request.urlopen('http://127.0.0.1:9113/status', timeout=4) as response:
    worker = json.loads(response.read().decode('utf-8'))
if response.status != 200 or worker.get('pid') != EXPECTED_PID or worker.get('phase') != 'rebuilding':
    raise SystemExit('P6_WORKER_STATUS_IDENTITY_MISMATCH')
print(json.dumps({'event': 'verified-old-worker', 'pid': EXPECTED_PID, 'birth': p.create_time(),
                  'exe': exe, 'cmd': cmd, 'cwd': cwd, 'phase': worker.get('phase'),
                  'fence': worker.get('fence'), 'passes': worker.get('passes'), 'apiReady': True}, separators=(',', ':')))
p.terminate()
p.wait(timeout=15)
print(json.dumps({'event': 'stopped-exact-worker', 'pid': EXPECTED_PID, 'birth': EXPECTED_BIRTH}, separators=(',', ':')))
