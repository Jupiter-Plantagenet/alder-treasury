"""Measure two scratch WAL archive cycles and recover both committed markers."""
from __future__ import annotations
import hashlib, importlib.util, json, os, shutil, subprocess, sys, tarfile, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN = os.environ.get('ALDER_ROUND7_RUN', '20261103-r7c')
OWNER = 'r7wal' + hashlib.sha256(RUN.encode()).hexdigest()[:12]
ARCHROOT = ROOT / '.local' / 'backups' / 'wal-archive' / ('round7-' + RUN) / 'continuous'
ARCHROOT.mkdir(parents=True, exist_ok=False)
spec = importlib.util.spec_from_file_location('wal_archive', ROOT / 'ops' / 'wal-archive.py')
wal = importlib.util.module_from_spec(spec); sys.modules[spec.name] = wal; spec.loader.exec_module(wal)
wal.ROOT_ARCHIVE = ARCHROOT
IMAGE = wal.IMAGE
pg, rx, rec = 'alder-wal-pg-' + OWNER, 'alder-wal-rx-' + OWNER, 'alder-wal-rec-' + OWNER
net, vol = 'alder-wal-net-' + OWNER, 'alder-wal-vol-' + OWNER
owner_label = 'alder.wal.owner'
created: dict[str, str] = {'containers': [], 'volumes': [], 'networks': []}
service_process: subprocess.Popen | None = None
service_log = None
report = {'schema':'alder.round7-continuous-wal/v1','runId':RUN,'owner':OWNER,
          'startedAtUtc':datetime.now(timezone.utc).isoformat(),'cycles':[],
          'retainedSourceTouched':False,'broadcastAttempted':False}

def docker(args, timeout=120, check=True):
    p=subprocess.run(['docker',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if check and p.returncode: raise RuntimeError('DOCKER_'+args[0].upper()+'_FAILED_'+str(p.returncode))
    return p
def sql(container, statement, db='postgres'):
    p=subprocess.run(['docker','exec','-i',container,'psql','-U','postgres','-d',db,'-X','-qAt','-v','ON_ERROR_STOP=1'],input=statement.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
    if p.returncode: raise RuntimeError('SCRATCH_SQL_FAILED')
    return p.stdout.decode().strip()
def ts(): return datetime.now(timezone.utc).isoformat()
def owned_cleanup():
    for name in reversed(created['containers']):
        q=docker(['inspect','--format','{{index .Config.Labels "'+owner_label+'"}}',name],check=False)
        if q.returncode==0 and q.stdout.decode().strip()==OWNER: docker(['rm','-f',name],check=False)
    for name in created['volumes']:
        q=docker(['volume','inspect','--format','{{index .Labels "'+owner_label+'"}}',name],check=False)
        if q.returncode==0 and q.stdout.decode().strip()==OWNER: docker(['volume','rm',name],check=False)
    for name in created['networks']:
        q=docker(['network','inspect','--format','{{index .Labels "'+owner_label+'"}}',name],check=False)
        if q.returncode==0 and q.stdout.decode().strip()==OWNER: docker(['network','rm',name],check=False)

try:
    docker(['network','create','--label',owner_label+'='+OWNER,net]); created['networks'].append(net)
    docker(['run','-d','--name',pg,'--label',owner_label+'='+OWNER,'--network',net,'-e','POSTGRES_HOST_AUTH_METHOD=trust',IMAGE,'postgres','-c','wal_level=replica','-c','max_wal_senders=10','-c','max_replication_slots=4']); created['containers'].append(pg)
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        if docker(['exec',pg,'pg_isready','-U','postgres'],check=False).returncode==0: break
        time.sleep(.5)
    else: raise RuntimeError('SCRATCH_POSTGRES_NOT_READY')
    docker(['exec','-u','postgres',pg,'sh','-c',"printf '\\nhost replication all 127.0.0.1/32 trust\\n' >> \"$PGDATA/pg_hba.conf\" && pg_ctl -D \"$PGDATA\" reload -s"])
    sql(pg,'CREATE DATABASE alder;')
    sql(pg,'CREATE TABLE public.wal_marker (id text primary key, committed_at timestamptz not null);','alder')
    obj=json.loads(docker(['inspect',pg]).stdout)[0]
    config={'container':pg,'containerId':obj['Id'],'image':obj['Image'],'networkMode':obj['HostConfig']['NetworkMode'],
        'systemIdentifier':sql(pg,'SELECT system_identifier FROM pg_control_system();'),
        'database':'alder','databaseOid':sql(pg,"SELECT oid FROM pg_database WHERE datname='alder';"),
        'port':5432,'receiver':rx,'owner':OWNER,'slot':'alder_wal_'+OWNER.replace('-','_'),
        'spoolVolume':'alder-wal-rxvol-'+OWNER,'privateRoot':str(ARCHROOT/'service')}
    service=Path(config['privateRoot']); (service/'archive').mkdir(parents=True); (service/'manifest').mkdir(); (service/'copy-stage').mkdir()
    wal.write_immutable_json(service/'service-config.private.json',config)
    first=wal.service_loop(config,wal.sha(Path(wal.__file__).read_bytes()),wal.sha(wal.CRYPTO.read_bytes()),once=True)
    created['containers'].append(rx); created['volumes'].append(config['spoolVolume'])
    archive=service/'archive'; manifest=service/'manifest'; stage=service/'copy-stage'
    # Start the actual installed loop: WAL switch every 30s, complete-segment collection every 5s.
    service_log=(ARCHROOT/'service-loop.private.log').open('wb')
    cfg_path=service/'service-config.private.json'
    service_process=subprocess.Popen([sys.executable,str(ROOT/'ops'/'wal-archive.py'),'service',
        '--source-sha256',wal.sha(Path(wal.__file__).read_bytes()),'--crypto-sha256',wal.sha(wal.CRYPTO.read_bytes()),
        '--config',str(cfg_path)],cwd=ROOT,stdout=service_log,stderr=subprocess.STDOUT)
    base_receipts=service/'basebackup-receipts'
    deadline=time.monotonic()+240; receipt_paths=[]
    while time.monotonic()<deadline:
        if service_process.poll() is not None: raise RuntimeError('WAL_SERVICE_LOOP_EXITED')
        receipt_paths=sorted(base_receipts.glob('*.json')) if base_receipts.exists() else []
        if receipt_paths: break
        time.sleep(1)
    if not receipt_paths: raise RuntimeError('WAL_SERVICE_BASEBACKUP_NOT_COMPLETE')
    base=json.loads(receipt_paths[-1].read_text()); base_path=archive/base['file']
    report['serviceLoop']={'actualServiceProcessStarted':True,'baseBackupReceiptPath':str(receipt_paths[-1]),
        'baseBackupReceiptSha256':wal.sha_file(receipt_paths[-1]),'baseBackupCreatedUtc':base.get('createdUtc'),
        'switchIntervalSeconds':30,'collectionIntervalSeconds':5}
    cycles=[]
    for n in (1,2):
        marker=f'{OWNER}-marker-{n}'
        switch_file=service/'last-switch.json'
        prior=json.loads(switch_file.read_text()) if switch_file.exists() else {}
        prior_switch=prior.get('switchedUtc','')
        commit=ts()
        sql(pg,f"INSERT INTO wal_marker(id,committed_at) VALUES ('{marker}','{commit}'); SELECT pg_create_restore_point('{marker}');",'alder')
        deadline=time.monotonic()+60; switched=None; item=None; receipt_path=None
        while time.monotonic()<deadline:
            if service_process.poll() is not None: raise RuntimeError('WAL_SERVICE_LOOP_EXITED_DURING_CYCLE')
            current=json.loads(switch_file.read_text()) if switch_file.exists() else {}
            if current.get('switchedUtc','')>commit and current.get('switchedUtc')!=prior_switch:
                switched=current
                receipts=[]
                for p in manifest.glob('*.json'):
                    v=json.loads(p.read_text())
                    if v.get('recordedUtc','')>=switched['switchedUtc'] and v.get('sourceBinding')==wal.source_binding(config): receipts.append((v['recordedUtc'],p,v))
                if receipts:
                    _,receipt_path,item=max(receipts,key=lambda x:x[0]); break
            time.sleep(1)
        if not item: raise RuntimeError('SERVICE_LOOP_WAL_NOT_DURABLE_WITHIN_60_SECONDS')
        receipt=item['recordedUtc']; delay=(datetime.fromisoformat(receipt)-datetime.fromisoformat(commit)).total_seconds()
        latest_collect=json.loads((service/'last-collect.json').read_text()) if (service/'last-collect.json').exists() else {}
        cycle={'marker':marker,'commitTimeUtc':commit,'walSwitchTimeUtc':switched['switchedUtc'],
               'durableReceiptTimeUtc':receipt,'commitToAuthenticatedArchiveSeconds':round(delay,3),
               'segment':item['file'],'authenticated':item.get('authenticated') is True,
               'sourceBindingMatches':item.get('sourceBinding')==wal.source_binding(config),
               'serviceLoopLastCollectTotalSegments':latest_collect.get('totalSegments'),
               'receiptFileSha256':wal.sha_file(receipt_path)}
        if delay>60 or not cycle['authenticated'] or not cycle['sourceBindingMatches']:
            raise RuntimeError('WAL_RPO_OR_AUTHENTICATION_ASSERTION_FAILED')
        cycles.append(cycle); report['cycles']=cycles
    if len({c['segment'] for c in cycles})!=2: raise RuntimeError('MARKERS_NOT_ARCHIVED_IN_DISTINCT_WAL_CYCLES')

    # Restore from the authenticated base plus receipt-verified WAL only.
    raw=ARCHROOT/'restore'; raw.mkdir(); wal.crypto('open',base_path,raw/'base.tar',base['aad'])
    for receipt_path in sorted(manifest.glob('*.json')):
        item=json.loads(receipt_path.read_text()); name=item['file'].removesuffix('.aesgcm')
        out=raw/name; wal.crypto('open',archive/item['file'],out,wal.wal_aad(config,name))
        if wal.sha_file(out)!=item['plaintextSha256'] or item.get('sourceBinding')!=wal.source_binding(config): raise RuntimeError('ARCHIVED_WAL_DIGEST_OR_BINDING_INVALID')
    docker(['volume','create','--label',owner_label+'='+OWNER,vol]); created['volumes'].append(vol)
    docker(['create','--name',rec,'--label',owner_label+'='+OWNER,'--network',net,'--mount','type=volume,source='+vol+',target=/var/lib/postgresql/data','--entrypoint','sleep',IMAGE,'infinity']); created['containers'].append(rec)
    docker(['start',rec]); docker(['exec',rec,'mkdir','-p','/wal']); docker(['cp',str(raw)+'/.',rec+':/wal'])
    basedir=raw/'base-dir'; basedir.mkdir()
    with tarfile.open(raw/'base.tar','r:') as t:
        for m in t.getmembers():
            if m.name.startswith('/') or '..' in Path(m.name).parts or m.issym() or m.islnk(): raise RuntimeError('BASE_TAR_PATH_REFUSED')
        t.extractall(basedir,filter='data')
    conf=basedir/'postgresql.auto.conf'
    with conf.open('a') as f: f.write("\nrestore_command = 'cp /wal/%f %p'\nrecovery_target_name = '"+cycles[-1]['marker']+"'\nrecovery_target_action = 'promote'\n")
    (basedir/'recovery.signal').write_text('')
    docker(['cp',str(basedir)+'/.',rec+':/var/lib/postgresql/data'])
    docker(['exec','-u','root',rec,'chown','-R','postgres:postgres','/var/lib/postgresql/data']); docker(['exec','-u','root',rec,'chmod','700','/var/lib/postgresql/data'])
    docker(['exec','-d','-u','postgres',rec,'sh','-c','postgres -D /var/lib/postgresql/data >/tmp/recovery.log 2>&1'])
    deadline=time.monotonic()+90; restored=[]
    while time.monotonic()<deadline:
        q=docker(['exec',rec,'psql','-U','postgres','-d','alder','-X','-qAt','-c','SELECT id FROM wal_marker ORDER BY id'],check=False)
        if q.returncode==0:
            restored=q.stdout.decode().splitlines()
            if cycles[-1]['marker'] in restored: break
        time.sleep(.5)
    report['recoveredMarkers']=restored
    report['bothCommittedMarkersRecovered']=all(c['marker'] in restored for c in cycles)
    report['allCyclesAtMost60Seconds']=all(c['commitToAuthenticatedArchiveSeconds']<=60 for c in cycles)
    report['rpoPass']=report['bothCommittedMarkersRecovered'] and report['allCyclesAtMost60Seconds']
except Exception as e:
    report['errorCategory']=str(e) if str(e).isupper() else type(e).__name__
    report['rpoPass']=False
finally:
    if service_process is not None and service_process.poll() is None:
        service_process.terminate()
        try: service_process.wait(timeout=10)
        except subprocess.TimeoutExpired: service_process.kill(); service_process.wait(timeout=10)
    if service_log is not None: service_log.close()
    owned_cleanup()
    report['cleanup']='removed only owner-verified scratch resources'
    report['finishedAtUtc']=ts()
    out=ARCHROOT/'continuous-proof.json'; out.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'proof':str(out),'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),
        'rpoPass':report.get('rpoPass'),'cycleDelays':[c.get('commitToAuthenticatedArchiveSeconds') for c in report.get('cycles',[])],
        'bothMarkersRecovered':report.get('bothCommittedMarkersRecovered'),'errorCategory':report.get('errorCategory')}))
if not report.get('rpoPass'): sys.exit(2)
