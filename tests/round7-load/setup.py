"""Create a new isolated P6 database/chain copy; never reset a prior episode."""
import gzip
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import time
from datetime import datetime, timezone

ROOT=Path('C:/Users/user/portfolio-build/alder')
stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
run='p6-'+stamp+'-resume'
out=ROOT/'.local/scratch-r6/runs'/run
out.mkdir(parents=True,exist_ok=False)
(out/'P6-RUN.json').write_text(json.dumps({'runId':run,'createdAt':stamp},indent=2))
for port in (15543,18547,18548,9103,9113):
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1',port))==0:
            raise RuntimeError('P6_PORT_ALREADY_IN_USE_'+str(port))
container='alder-'+run.lower()+'-pg'
volume=container+'-data'
counter=0
def cmd(args,raw=None,check=True):
    global counter
    counter+=1
    p=subprocess.run(args,input=raw,cwd=ROOT,capture_output=True)
    (out/('setup-%02d.raw.log'%counter)).write_bytes(p.stdout+p.stderr)
    if check and p.returncode:
        raise RuntimeError('SETUP_COMMAND_FAILED_'+str(counter))
    return p
image=cmd(['docker','inspect','alder-postgres','--format','{{.Config.Image}}']).stdout.decode().strip()
cmd(['docker','volume','create','--label','alder.round7.owner='+run,volume])
cmd(['docker','run','-d','--name',container,'--label','alder.round7.owner='+run,
     '-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1:15543:5432',
     '--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data',image])
for _ in range(60):
    if cmd(['docker','exec',container,'pg_isready','-U','postgres'],check=False).returncode==0:
        break
    time.sleep(1)
else:raise RuntimeError('PG_NOT_READY')
roles=ROOT/'.local/backups/alder-roles-pre-round6-perf-20261031T030457Z.sql'
cmd(['docker','exec','-i',container,'psql','-U','postgres'],roles.read_bytes(),check=False)
cmd(['docker','exec',container,'createdb','-U','postgres','-O','postgres','alder'])
dump=ROOT/'.local/backups/alder-pre-round6-perf-20261031T030457Z.dump'
cmd(['docker','exec','-i',container,'pg_restore','-U','postgres','-d','alder','--exit-on-error'],dump.read_bytes())
import psycopg
with psycopg.connect('host=127.0.0.1 port=15543 dbname=alder user=postgres') as c:
    applied={r[0] for r in c.execute('SELECT id FROM schema_migrations')}
    for migration in sorted((ROOT/'db').glob('*.sql')):
        if migration.stem in applied:continue
        if int(migration.name[:3])<14:raise RuntimeError('BASELINE_MIGRATION_MISSING')
        c.execute(migration.read_text(encoding='utf-8'))
        c.execute('INSERT INTO schema_migrations(id,sha256,note) VALUES(%s,%s,%s)',
                  (migration.stem,hashlib.sha256(migration.read_bytes()).hexdigest(),'round7 isolated restore'))
    journal=[r[0] for r in c.execute('SELECT id FROM schema_migrations ORDER BY id')]
    tables=c.execute("select count(*) from pg_tables where schemaname='public'").fetchone()[0]
original=ROOT/'.local/o5/anvil-18548-isolated-state.hex'
raw=gzip.decompress(bytes.fromhex(original.read_text().strip()[2:]))
state=json.loads(raw)
dep=json.loads((ROOT/'evidence/round5-ops/isolated-deployment.json').read_text())
genesis=[b for b in state['blocks'] if int(b['header']['number'],16)==0]
times=sorted(set(b['header']['timestamp'] for b in genesis))
if len(times)!=1:raise RuntimeError('AMBIGUOUS_GENESIS')
statepath=out/'anvil-state.json'
statepath.write_bytes(raw)
receipt={'run':run,'root':str(out),'container':container,'volume':volume,
         'journal':journal,'tables':tables,'chain_state':str(statepath),
         'chain_head':state['best_block_number'],'genesis_timestamp':times[0],
         'expected_genesis':dep['genesis'],'original_state_sha256':hashlib.sha256(original.read_bytes()).hexdigest(),
         'source_dump_sha256':hashlib.sha256(dump.read_bytes()).hexdigest()}
(out/'setup-receipt.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt),flush=True)
