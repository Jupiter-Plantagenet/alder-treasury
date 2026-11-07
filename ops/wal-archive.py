#!/usr/bin/env python3
"""Alder private completed-WAL archive and isolated PITR rehearsal."""
from __future__ import annotations
import argparse, hashlib, json, os, re, secrets, shutil, subprocess, sys, tarfile, time, stat
import posixpath
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
KEY=ROOT/'.local'/'backup-key.bin'
ROOT_ARCHIVE=ROOT/'.local'/'backups'/'wal-archive'
NODE=ROOT/'.local'/'runtime'/'node-v26.7.0'/'node.exe'
NODE_SHA256='e921fe5307e29bf6fd00000dd594356affd3a7b044e52720c7f10decbdc305b9'
CRYPTO=ROOT/'ops'/'wal-crypto.mjs'
IMAGE='sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
SEGMENT=re.compile(r'^[0-9A-F]{24}$')
LIVE_SOURCE='alder-postgres'
LIVE_OWNER='alder-wal-live-v1'
LIVE_PIN={'container':'alder-postgres','containerId':'16a15549a67ef304132c39457a49b3be470fef354b6ae67e8206c381975b4b0a',
          'image':IMAGE,'networkMode':'bridge','systemIdentifier':'7700867458029396005','database':'alder',
          'databaseOid':'16384','port':5432,'receiver':'alder-wal-receiver','owner':LIVE_OWNER,
          'slot':'alder_wal_archive_v1','spoolVolume':'alder-wal-spool-v1',
          'privateRoot':str(ROOT_ARCHIVE/'live')}

def sha(b:bytes)->str: return hashlib.sha256(b).hexdigest()
def sha_file(path:Path)->str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()
def tar_inventory(path:Path)->dict[str,str]:
    result={}
    with tarfile.open(path,'r:') as archive:
        for item in archive.getmembers():
            if item.name.startswith('/') or '..' in Path(item.name).parts: raise RuntimeError('BASE_TAR_PATH_INVALID')
            if item.issym() or item.islnk(): raise RuntimeError('BASE_TAR_LINK_REFUSED')
            if item.isfile():
                stream=archive.extractfile(item)
                if stream is None: raise RuntimeError('BASE_TAR_MEMBER_READ_FAILED')
                h=hashlib.sha256()
                with stream:
                    for chunk in iter(lambda:stream.read(1024*1024),b''): h.update(chunk)
                result['/'.join(x for x in posixpath.normpath(item.name).split('/') if x not in ('.',''))]=h.hexdigest()
    return result
def tree_inventory(root:Path)->dict[str,str]:
    out={}
    for p in root.rglob('*'):
        if p.is_symlink(): raise RuntimeError('EXTRACTED_BASE_LINK_REFUSED')
        if p.is_file(): out[p.relative_to(root).as_posix()]=sha_file(p)
    return out
def require_key()->None:
    checked_path(KEY,ROOT)
    if not KEY.is_file() or KEY.stat().st_size!=32: raise RuntimeError('EXISTING_PRIVATE_32_BYTE_KEY_REQUIRED')
def checked_path(path:Path,root:Path)->Path:
    # Keep lexical components until every existing component has been lstat-checked.
    absolute=Path(os.path.abspath(os.fspath(path)))
    root_abs=Path(os.path.abspath(os.fspath(root)))
    if absolute.drive.upper()!='C:' or not absolute.is_relative_to(root_abs): raise RuntimeError('PRIVATE_PATH_MUST_REMAIN_UNDER_C_ROOT')
    chain=[*reversed(absolute.parents),absolute]
    for component in chain:
        try: info=os.lstat(component)
        except FileNotFoundError: continue
        attrs=getattr(info,'st_file_attributes',0)
        if stat.S_ISLNK(info.st_mode) or attrs & 0x400 or getattr(os.path,'isjunction',lambda _:False)(component):
            raise RuntimeError('SYMLINK_OR_REPARSE_COMPONENT_REFUSED')
    return absolute
def safe_dir(p:Path,create:bool=False)->Path:
    p=checked_path(p,ROOT_ARCHIVE)
    if create:
        p.mkdir(parents=True,exist_ok=True)
        checked_path(p,ROOT_ARCHIVE)
        account=subprocess.check_output(['whoami'],text=True,timeout=10).strip()
        subprocess.run(['icacls',str(p),'/inheritance:r','/grant:r',account+':(OI)(CI)F'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
        checked_path(p,ROOT_ARCHIVE)
    return p
def write_immutable_json(path:Path,value:dict)->None:
    directory=safe_dir(path.parent,True); target=checked_path(directory/path.name,ROOT_ARCHIVE)
    raw=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
    temp=directory/(path.name+'.'+secrets.token_hex(5)+'.partial')
    with temp.open('xb') as f: f.write(raw); f.flush(); os.fsync(f.fileno())
    try: os.link(temp,target)
    except FileExistsError:
        if json.loads(target.read_text(encoding='utf-8'))!=value: raise RuntimeError('IMMUTABLE_JSON_DESTINATION_CONFLICT')
    finally: temp.unlink(missing_ok=True)
def crypto(mode:str,src:Path,dst:Path,aad:str)->dict:
    require_key()
    src=checked_path(src,ROOT_ARCHIVE); dst=checked_path(dst,ROOT_ARCHIVE)
    checked_path(NODE,ROOT); checked_path(CRYPTO,ROOT)
    if not NODE.is_file() or not CRYPTO.is_file(): raise RuntimeError('PINNED_NODE_CRYPTO_HELPER_MISSING')
    p=subprocess.run([str(NODE),str(CRYPTO),mode,str(src),str(dst),str(KEY),aad],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=900)
    if p.returncode: raise RuntimeError('AES256GCM_'+mode.upper()+'_FAILED')
    return json.loads(p.stdout)
def docker(args:list[str],timeout:int=180,ok:bool=True,input_bytes:bytes|None=None)->bytes:
    p=subprocess.run(['docker',*args],input=input_bytes,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if ok and p.returncode: raise RuntimeError('DOCKER_STEP_FAILED_'+args[0].upper())
    return p.stdout
def sql(container:str,text:str,database:str='postgres')->str:
    p=subprocess.run(['docker','exec','-i',container,'psql','-U','postgres','-d',database,'-X','-qAt','-v','ON_ERROR_STOP=1'],input=text.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=40)
    if p.returncode: raise RuntimeError('PRIVATE_PSQL_STEP_FAILED')
    return p.stdout.decode().strip()

def live_ready(config:dict)->None:
    p=subprocess.run(['docker','inspect',config['container']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
    if p.returncode: raise RuntimeError('PINNED_POSTGRES_CONTAINER_MISSING')
    obj=json.loads(p.stdout)[0]
    observed={'container':obj.get('Name','').lstrip('/'),'containerId':obj.get('Id'),'image':obj.get('Image'),
              'networkMode':obj.get('HostConfig',{}).get('NetworkMode')}
    if any(observed[k]!=config[k] for k in ('container','containerId','image','networkMode')):
        raise RuntimeError('PINNED_POSTGRES_CONTAINER_ID_IMAGE_OR_NETWORK_MISMATCH')
    version=sql(config['container'],'SHOW server_version_num;')
    if not version.startswith('16'): raise RuntimeError('POSTGRES_MAJOR_VERSION_NOT_16')
    system=sql(config['container'],'SELECT system_identifier FROM pg_control_system();')
    oid=sql(config['container'],f"SELECT oid FROM pg_database WHERE datname='{config['database']}';")
    if system!=config['systemIdentifier'] or oid!=config['databaseOid']:
        raise RuntimeError('POSTGRES_SYSTEM_IDENTIFIER_OR_DATABASE_OID_MISMATCH')

def source_binding(config:dict)->dict:
    return {k:config[k] for k in ('container','containerId','image','networkMode','systemIdentifier','database','databaseOid','receiver','owner','slot','spoolVolume','port')}

def wal_aad(config:dict,name:str)->str:
    return json.dumps({'sourceBinding':source_binding(config),'segment':name},sort_keys=True,separators=(',',':'))

def base_aad(config:dict,name:str)->str:
    return json.dumps({'sourceBinding':source_binding(config),'baseBackup':name},sort_keys=True,separators=(',',':'))

def write_owner_receipt(config:dict,kind:str)->None:
    directory=safe_dir(Path(config['privateRoot'])/'ownership',True)
    target=checked_path(directory/(kind+'.json'),ROOT_ARCHIVE); value={'schema':'alder-wal-owner-v1','kind':kind,'binding':source_binding(config)}
    raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
    temp=directory/(kind+'.'+secrets.token_hex(5)+'.partial')
    with temp.open('xb') as f: f.write(raw); f.flush(); os.fsync(f.fileno())
    try: os.link(temp,target)
    except FileExistsError:
        if json.loads(target.read_text())!=value: raise RuntimeError('EXISTING_OWNER_RECEIPT_BINDING_MISMATCH')
    finally: temp.unlink(missing_ok=True)

def require_owner_receipt(config:dict,kind:str)->None:
    target=checked_path(Path(config['privateRoot'])/'ownership'/(kind+'.json'),ROOT_ARCHIVE)
    expected={'schema':'alder-wal-owner-v1','kind':kind,'binding':source_binding(config)}
    if not target.is_file() or json.loads(target.read_text())!=expected:
        raise RuntimeError('OWNED_'+kind.upper()+'_RECEIPT_MISSING_OR_MISMATCHED')

def receiver_command(config:dict)->list[str]:
    return ['-h','127.0.0.1','-p',str(config['port']),'-U','postgres','-D','/spool','-S',config['slot']]

def inspect_receiver(config:dict)->dict|None:
    p=subprocess.run(['docker','inspect',config['receiver']],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15)
    if p.returncode: return None
    obj=json.loads(p.stdout)[0]
    if obj.get('Config',{}).get('Labels',{}).get('alder.wal.owner')!=config['owner']:
        raise RuntimeError('RECEIVER_CONTAINER_LABEL_OWNER_MISMATCH')
    cfg=obj.get('Config',{}); host=obj.get('HostConfig',{})
    mounts=obj.get('Mounts',[])
    expected_networks={'container:'+config['container'],'container:'+config['containerId']}
    mismatches=[]
    if obj.get('Image')!=config['image'] or cfg.get('Image')!=config['image']: mismatches.append('image')
    if obj.get('Name','').lstrip('/')!=config['receiver']: mismatches.append('name')
    if host.get('NetworkMode') not in expected_networks: mismatches.append('network-namespace')
    if cfg.get('Entrypoint')!=['pg_receivewal']: mismatches.append('entrypoint')
    if cfg.get('Cmd')!=receiver_command(config): mismatches.append('argv')
    if host.get('RestartPolicy',{}).get('Name')!='unless-stopped': mismatches.append('restart-policy')
    spool_mount=[m for m in mounts if m.get('Destination')=='/spool']
    tmpfs=host.get('Tmpfs',{}).get('/var/lib/postgresql/data','')
    if (len(mounts)!=1 or len(spool_mount)!=1 or spool_mount[0].get('Type')!='volume' or
        spool_mount[0].get('Name')!=config['spoolVolume'] or not spool_mount[0].get('RW') or
        tmpfs!='rw,noexec,nosuid,size=16m'):
        mismatches.append('mounts')
    if mismatches:
        mount_summary=[{'type':m.get('Type'),'destination':m.get('Destination'),'name':m.get('Name'),'rw':m.get('RW')} for m in mounts]
        raise RuntimeError('EXISTING_RECEIVER_CONFIGURATION_MISMATCH:'+','.join(mismatches)+'; mounts='+json.dumps(mount_summary,separators=(',',':'))+'; tmpfs='+repr(tmpfs))
    return obj

def live_receiver_start(config:dict)->dict:
    live_ready(config)
    name=config['receiver']; volume=config['spoolVolume']; owner=config['owner']
    vol=subprocess.run(['docker','volume','inspect',volume],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15)
    if vol.returncode:
        docker(['volume','create','--label','alder.wal.owner='+owner,volume]); write_owner_receipt(config,'volume')
    else:
        v=json.loads(vol.stdout)[0]
        if v.get('Labels',{}).get('alder.wal.owner')!=owner: raise RuntimeError('RECEIVER_VOLUME_OWNER_MISMATCH')
        require_owner_receipt(config,'volume')
    # Refuse any pre-existing slot without this source-pinned creation receipt.
    slotrow=sql(config['container'],"SELECT slot_type||'|'||coalesce(database,'') FROM pg_replication_slots WHERE slot_name='"+config['slot']+"';")
    slot_receipt=Path(config['privateRoot'])/'ownership'/'slot.json'
    if slotrow:
        require_owner_receipt(config,'slot')
        if slotrow!='physical|': raise RuntimeError('EXISTING_REPLICATION_SLOT_TYPE_OR_DATABASE_MISMATCH')
    else:
        if slot_receipt.exists(): raise RuntimeError('OWNED_SLOT_RECEIPT_WITHOUT_DATABASE_SLOT')
        create=['docker','run','--rm','--label','alder.wal.owner='+owner,'--network','container:'+config['container'],
                '--mount','type=volume,source='+volume+',target=/spool','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=16m',
                '--entrypoint','pg_receivewal',config['image'],
                *receiver_command(config),'--create-slot']
        p=subprocess.run(create,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
        if p.returncode: raise RuntimeError('REPLICATION_SLOT_CREATE_FAILED; existing unowned slot is never adopted')
        write_owner_receipt(config,'slot')
    existing=inspect_receiver(config)
    receiver_receipt=Path(config['privateRoot'])/'ownership'/'receiver.json'
    if existing:
        require_owner_receipt(config,'receiver')
        if not existing.get('State',{}).get('Running'): docker(['start',name])
        return {'receiver':name,'alreadyOwned':True}
    if receiver_receipt.exists(): raise RuntimeError('RECEIVER_RECEIPT_WITHOUT_CONTAINER')
    args=['docker','run','-d','--restart','unless-stopped','--name',name,'--label','alder.wal.owner='+owner,
          '--network','container:'+config['container'],'--mount','type=volume,source='+volume+',target=/spool',
          '--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=16m',
          '--entrypoint','pg_receivewal',config['image'],*receiver_command(config)]
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if p.returncode: raise RuntimeError('PG_RECEIVEWAL_START_FAILED')
    if inspect_receiver(config) is None: raise RuntimeError('STARTED_RECEIVER_NOT_INSPECTABLE')
    write_owner_receipt(config,'receiver')
    return {'receiver':name,'containerId':p.stdout.decode().strip(),'slot':config['slot'],'sourceSystemIdentifier':config['systemIdentifier']}

def switch_live(config:dict)->dict:
    live_ready(config); before=sql(config['container'],'SELECT pg_current_wal_lsn();')
    after=sql(config['container'],'SELECT pg_switch_wal();')
    return {'container':config['container'],'containerId':config['containerId'],'systemIdentifier':config['systemIdentifier'],
            'lsnBefore':before,'switchResult':after,'switchedUtc':datetime.now(timezone.utc).isoformat()}

def live_basebackup(config:dict,destination:Path)->dict:
    live_ready(config); destination=safe_dir(destination)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4)
    clear=destination/('base-'+stamp+'.tar'); encrypted=destination/('base-'+stamp+'.tar.aesgcm')
    verify=destination/('base-'+stamp+'.verify')
    stage='/tmp/alder-wal-base-'+stamp
    try:
        docker(['exec','-u','postgres',config['container'],'mkdir','-p',stage])
        docker(['exec','-u','postgres',config['container'],'pg_basebackup','-U','postgres','-D',stage,'-Fp','-X','stream','-P'],timeout=1800)
        with clear.open('xb') as stream:
            p=subprocess.run(['docker','exec',config['container'],'tar','-cf','-','-C',stage,'.'],stdout=stream,stderr=subprocess.PIPE,timeout=1800)
            stream.flush(); os.fsync(stream.fileno())
        if p.returncode: raise RuntimeError('CANONICAL_BASEBACKUP_TAR_FAILED')
        aad=base_aad(config,clear.name)
        digest=sha_file(clear); byte_count=clear.stat().st_size; sealed=crypto('seal',clear,encrypted,aad)
        crypto('open',encrypted,verify,aad)
        if sha_file(verify)!=digest: raise RuntimeError('CANONICAL_BASEBACKUP_AUTHENTICATION_FAILED')
        proof={'createdUtc':datetime.now(timezone.utc).isoformat(),'file':encrypted.name,'bytes':byte_count,
               'plaintextSha256':digest,'ciphertextSha256':sealed['outputSha256'],'aad':aad,'authenticatedRoundTrip':True,
               'envelopeVersion':sealed['envelopeVersion'],'compression':sealed['compression'],
               'sourceContainer':config['container'],'sourceContainerId':config['containerId'],
               'sourceSystemIdentifier':config['systemIdentifier'],'sourceDatabaseOid':config['databaseOid'],
               'sourceBinding':source_binding(config)}
        receipt=destination/(encrypted.name+'.json'); write_immutable_json(receipt,proof)
        return proof
    finally:
        cleanup_error=None
        for plaintext in (clear,verify):
            try:
                checked_path(plaintext,ROOT_ARCHIVE)
                plaintext.unlink(missing_ok=True)
            except Exception as error:
                cleanup_error=error
        try:
            live_ready(config)
            subprocess.run(['docker','exec',config['container'],'rm','-rf',stage],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        except Exception:
            pass
        if cleanup_error is not None: raise RuntimeError('PRIVATE_BASE_PLAINTEXT_CLEANUP_FAILED') from cleanup_error

def service_loop(config:dict,expected_source:str,expected_crypto:str,once:bool=False)->dict|None:
    checked_path(Path(__file__),ROOT); checked_path(CRYPTO,ROOT); checked_path(NODE,ROOT)
    if sha(Path(__file__).read_bytes())!=expected_source.lower() or sha(CRYPTO.read_bytes())!=expected_crypto.lower():
        raise RuntimeError('INSTALLED_SOURCE_PIN_MISMATCH')
    if sha_file(NODE)!=NODE_SHA256 or subprocess.check_output([str(NODE),'--version'],text=True,timeout=10).strip()!='v26.7.0':
        raise RuntimeError('PINNED_NODE_VERSION_MISMATCH')
    root=safe_dir(Path(config['privateRoot']),True); archive=safe_dir(root/'archive',True)
    copy_stage=safe_dir(root/'copy-stage',True); live_receiver_start(config)
    if once:
        switched=switch_live(config)
        collected=archive_receiver(config,archive,root/'manifest',copy_stage)
        backup=live_basebackup(config,archive)
        return {'receiver':config['receiver'],'switch':switched,'collect':collected,'basebackup':backup}
    last_switch=0.0; last_collect=0.0
    backup_state={'next':0.0}; backup_thread=None; error_state={'last':0.0}; error_lock=threading.Lock()
    def log_error(component:str,error:Exception)->None:
        with error_lock:
            now=time.monotonic()
            if now-error_state['last']<60: return
            error_path=checked_path(root/'service.private.log',ROOT_ARCHIVE)
            with error_path.open('a',encoding='utf-8') as f:
                f.write(json.dumps({'at':datetime.now(timezone.utc).isoformat(),'component':component,
                                    'error':type(error).__name__+': '+str(error)})+'\n')
            error_state['last']=now
    def backup_worker()->None:
        delay=86400
        try:
            backup=live_basebackup(config,archive)
            write_immutable_json(root/'basebackup-receipts'/(Path(backup['file']).name+'.json'),backup)
        except Exception as e:
            delay=300; log_error('basebackup',e)
        finally: backup_state['next']=time.monotonic()+delay
    while True:
        now=time.monotonic()
        if now-last_switch>=30:
            last_switch=now
            try:
                proof=switch_live(config); path=checked_path(root/'last-switch.json',ROOT_ARCHIVE)
                path.write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
            except Exception as e: log_error('wal-switch',e)
        if now-last_collect>=5:
            last_collect=now
            try:
                collect=archive_receiver(config,archive,root/'manifest',copy_stage)
                path=checked_path(root/'last-collect.json',ROOT_ARCHIVE)
                path.write_text(json.dumps(collect,indent=2)+'\n',encoding='utf-8')
            except Exception as e: log_error('wal-collect',e)
        if now>=backup_state['next'] and (backup_thread is None or not backup_thread.is_alive()):
            backup_thread=threading.Thread(target=backup_worker,name='alder-wal-basebackup',daemon=True)
            backup_thread.start()
        time.sleep(1)
def archive_complete(spool:Path,archive:Path,manifest_path:Path,config:dict)->dict:
    require_key(); spool=safe_dir(spool); archive=safe_dir(archive,True); manifest_dir=safe_dir(manifest_path,True)
    binding=source_binding(config)
    entries={}
    for receipt in sorted(manifest_dir.glob('*.json')):
        checked_path(receipt,ROOT_ARCHIVE)
        item=json.loads(receipt.read_text(encoding='utf-8')); name=item.get('file')
        if not isinstance(name,str) or not item.get('authenticated') or receipt.name!=name+'.json' or item.get('sourceBinding')!=binding:
            raise RuntimeError('WAL_MANIFEST_ENTRY_INVALID_OR_SOURCE_BINDING_MISMATCH')
        prior=entries.get(name)
        if prior and (prior.get('plaintextSha256')!=item.get('plaintextSha256') or prior.get('ciphertextSha256')!=item.get('ciphertextSha256')):
            raise RuntimeError('WAL_MANIFEST_CONFLICT')
        entries[name]=item
    count=0
    for src in sorted(spool.iterdir()):
        if not src.is_file() or not SEGMENT.fullmatch(src.name) or src.stat().st_size!=16*1024*1024: continue
        dst=archive/(src.name+'.aesgcm')
        checked_path(dst,ROOT_ARCHIVE)
        prior=entries.get(dst.name)
        if prior and not dst.is_file(): raise RuntimeError('ARCHIVED_SEGMENT_MISSING_FOR_IMMUTABLE_RECEIPT')
        if dst.exists():
            aad=wal_aad(config,src.name)
            check=checked_path(dst.with_name(dst.name+'.verify-'+secrets.token_hex(4)),ROOT_ARCHIVE)
            try:
                opened=crypto('open',dst,check,aad)
                if sha_file(check)!=sha_file(src): raise RuntimeError('WAL_SEGMENT_ARCHIVE_CONFLICT')
            finally: check.unlink(missing_ok=True)
            cipher_hash=sha(dst.read_bytes())
            envelope=opened
        else:
            aad=wal_aad(config,src.name)
            seal=crypto('seal',src,dst,aad)
            check=checked_path(dst.with_name(dst.name+'.verify-'+secrets.token_hex(4)),ROOT_ARCHIVE)
            try:
                crypto('open',dst,check,aad)
                if sha_file(check)!=sha_file(src): raise RuntimeError('WAL_AESGCM_ROUNDTRIP_FAILED')
            finally: check.unlink(missing_ok=True)
            cipher_hash=seal['outputSha256']
            envelope=seal
        digest=sha(src.read_bytes()); size=src.stat().st_size
        entry={'file':dst.name,'bytes':size,'plaintextSha256':digest,'ciphertextSha256':cipher_hash,
               'sourceBinding':binding,'aadSha256':sha(wal_aad(config,src.name).encode()),
               'envelopeVersion':envelope['envelopeVersion'],'compression':envelope['compression'],'authenticated':True,
               'recordedUtc':datetime.now(timezone.utc).isoformat()}
        if prior and (prior.get('plaintextSha256')!=digest or prior.get('ciphertextSha256')!=cipher_hash):
            raise RuntimeError('WAL_MANIFEST_ARCHIVE_BINDING_CONFLICT')
        if not prior:
            receipt=checked_path(manifest_dir/(dst.name+'.json'),ROOT_ARCHIVE); temp=checked_path(manifest_dir/(dst.name+'.'+secrets.token_hex(5)+'.partial'),ROOT_ARCHIVE)
            with temp.open('xb') as f:
                f.write((json.dumps(entry,separators=(',',':'))+'\n').encode()); f.flush(); os.fsync(f.fileno())
            try: os.link(temp,receipt)
            except FileExistsError:
                existing=json.loads(receipt.read_text(encoding='utf-8'))
                if (existing.get('file')!=dst.name or existing.get('bytes')!=size or
                    existing.get('plaintextSha256')!=digest or existing.get('ciphertextSha256')!=cipher_hash or
                    existing.get('sourceBinding')!=binding or
                    existing.get('aadSha256')!=sha(wal_aad(config,src.name).encode()) or
                    existing.get('envelopeVersion',1)!=envelope['envelopeVersion'] or
                    existing.get('compression','none')!=envelope['compression'] or
                    existing.get('authenticated') is not True):
                    raise RuntimeError('WAL_MANIFEST_FILE_COLLISION')
            finally: temp.unlink(missing_ok=True)
            entries[dst.name]=entry
        # This is the only source deletion: ciphertext and durable append-only receipt are authenticated.
        src.unlink()
        count+=1
    digest=hashlib.sha256()
    for receipt in sorted(manifest_dir.glob('*.json')):
        checked_path(receipt,ROOT_ARCHIVE); digest.update(receipt.name.encode()+b'\0'+receipt.read_bytes())
    return {'archivedNow':count,'totalSegments':len(entries),'manifestSha256':digest.hexdigest()}

def archive_receiver(config:dict,archive:Path,manifest_path:Path,stage:Path)->dict:
    """Copy complete segments from receiver-only volume; remove remote source only after verification."""
    live_ready(config); stage=safe_dir(stage,True); archive=safe_dir(archive,True); container=config['receiver']
    require_owner_receipt(config,'receiver'); require_owner_receipt(config,'slot'); require_owner_receipt(config,'volume')
    if inspect_receiver(config) is None: raise RuntimeError('OWNED_RECEIVER_MISSING')
    listed=docker(['exec',container,'sh','-c','ls -1 /spool 2>/dev/null || true'],timeout=20).decode().splitlines()
    names=[n.strip() for n in listed if SEGMENT.fullmatch(n.strip())]
    for name in names:
        dst=checked_path(stage/name,ROOT_ARCHIVE)
        if not dst.exists():
            p=subprocess.run(['docker','cp',container+':/spool/'+name,str(dst)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
            if p.returncode: raise RuntimeError('RECEIVER_WAL_COPY_FAILED')
        if dst.stat().st_size!=16*1024*1024: dst.unlink(missing_ok=True)
    result=archive_complete(stage,archive,manifest_path,config)
    live_ready(config)
    require_owner_receipt(config,'receiver'); require_owner_receipt(config,'slot'); require_owner_receipt(config,'volume')
    entries={}
    for p in manifest_path.glob('*.json'):
        checked_path(p,ROOT_ARCHIVE)
        item=json.loads(p.read_text()); entries[item['file'].removesuffix('.aesgcm')]=item
    for name in names:
        if name in entries and entries[name].get('authenticated') and not (stage/name).exists():
            docker(['exec',container,'rm','-f','--','/spool/'+name],timeout=30)
    return result

def rehearsal(run_id:str,service_only:bool=False)->dict:
    if not re.fullmatch(r'[a-z0-9-]{8,24}',run_id): raise RuntimeError('RUN_ID_INVALID')
    require_key(); base=safe_dir(ROOT_ARCHIVE/('scratch-'+run_id),True)
    if any(base.iterdir()): raise RuntimeError('SCRATCH_PATH_MUST_BE_UNIQUE_EMPTY')
    service_root,stage=(base/'service',base/'stage')
    for p in (service_root,stage): safe_dir(p,True)
    log=base/'rehearsal.private.log'; pg='alder-wal-pg-'+run_id; rx='alder-wal-rx-'+run_id; rec='alder-wal-rec-'+run_id
    net='alder-wal-net-'+run_id; vol='alder-wal-vol-'+run_id; rxvol='alder-wal-rxvol-'+run_id; slot='alder_wal_'+run_id.replace('-','_'); mark='alder_'+run_id.replace('-','_')
    def run(a:list[str],timeout:int=180,ok:bool=True)->bytes:
        p=subprocess.run(['docker',*a],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
        with log.open('ab') as f:
            f.write(('$ docker '+' '.join(a[:8])+'\n').encode())
            if len(p.stdout)>65536: f.write(f'[stdout bytes={len(p.stdout)} sha256={sha(p.stdout)} omitted: binary backup/archive stream]\n'.encode())
            else: f.write(p.stdout)
            f.write(p.stderr+b'\n')
        if ok and p.returncode: raise RuntimeError('SCRATCH_DOCKER_STEP_FAILED; inspect private rehearsal log')
        return p.stdout
    def run_to_file(a:list[str],target:Path,timeout:int=180)->dict:
        with target.open('xb') as out:
            p=subprocess.run(['docker',*a],stdout=out,stderr=subprocess.PIPE,timeout=timeout)
            out.flush(); os.fsync(out.fileno())
        with log.open('ab') as f: f.write(('$ docker '+' '.join(a[:8])+' [stdout streamed to private file]\n').encode()+p.stderr+b'\n')
        if p.returncode: raise RuntimeError('SCRATCH_BACKUP_STREAM_FAILED; inspect private rehearsal log')
        return {'bytes':target.stat().st_size,'sha256':sha_file(target)}
    try:
        run(['network','create','--label','alder.wal.owner='+run_id,net])
        run(['run','-d','--name',pg,'--label','alder.wal.owner='+run_id,'--network',net,'-e','POSTGRES_HOST_AUTH_METHOD=trust',IMAGE,'postgres','-c','wal_level=replica','-c','max_wal_senders=10','-c','max_replication_slots=4'])
        end=time.monotonic()+45
        while time.monotonic()<end:
            ready=subprocess.run(['docker','exec',pg,'pg_isready','-U','postgres'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=6)
            with log.open('ab') as f: f.write(b'$ docker exec '+pg.encode()+b' pg_isready\n'+ready.stdout+ready.stderr+b'\n')
            if ready.returncode==0: break
            time.sleep(.5)
        else: raise RuntimeError('SCRATCH_POSTGRES_NOT_READY')
        run(['exec','-u','postgres',pg,'sh','-c',"printf '\\nhost replication all 127.0.0.1/32 trust\\n' >> \"$PGDATA/pg_hba.conf\" && pg_ctl -D \"$PGDATA\" reload -s"])
        sql(pg,'CREATE DATABASE alder;')
        sql(pg,'CREATE TABLE public.wal_marker (id text primary key, created_at timestamptz default clock_timestamp());','alder')
        source_obj=json.loads(run(['inspect',pg]))[0]
        config={'container':pg,'containerId':source_obj['Id'],'image':source_obj['Image'],
                'networkMode':source_obj['HostConfig']['NetworkMode'],
                'systemIdentifier':sql(pg,'SELECT system_identifier FROM pg_control_system();'),
                'database':'alder','databaseOid':sql(pg,"SELECT oid FROM pg_database WHERE datname='alder';"),
                'port':5432,'receiver':rx,'owner':run_id,'slot':slot,'spoolVolume':rxvol,'privateRoot':str(service_root)}
        config_path=service_root/'service-config.private.json'
        write_immutable_json(config_path,config)
        config=load_service_config(config_path)
        service_result=service_loop(config,sha(Path(__file__).read_bytes()),sha(CRYPTO.read_bytes()),once=True)
        arch=service_root/'archive'; backup=service_result['basebackup']
        if service_only:
            proof={'schema':'alder-wal-service-scratch-proof-v1','runId':run_id,'sourceBinding':source_binding(config),
                   'serviceCycle':service_result,'receiverOwnerReceipts':[p.name for p in sorted((service_root/'ownership').glob('*.json'))],
                   'privateLog':str(log),'pitrRun':'not requested in service-only diagnostic'}
            write_immutable_json(base/'service-proof.json',proof)
            return proof
        enc_path=arch/backup['file']; verify=stage/'base.verify.tar'
        crypto('open',enc_path,verify,backup['aad'])
        if sha_file(verify)!=backup['plaintextSha256']: raise RuntimeError('SERVICE_BASEBACKUP_DECRYPT_HASH_MISMATCH')
        source_inventory=tar_inventory(verify)
        service_manifest=service_root/'manifest'
        sql(pg,f"INSERT INTO wal_marker(id) VALUES ('{run_id}'); SELECT pg_create_restore_point('{mark}');",'alder')
        switched=switch_live(config)
        time.sleep(7)
        marker_collect=archive_receiver(config,arch,service_manifest,service_root/'copy-stage')
        manifest=[json.loads(p.read_text()) for p in sorted(service_manifest.glob('*.json'))]
        if not manifest: raise RuntimeError('SCRATCH_NO_FINALIZED_SEGMENTS')
        if tar_inventory(verify)!=source_inventory: raise RuntimeError('BASE_ARCHIVE_INVENTORY_MISMATCH')
        # A clean recovery container gets only the decrypted, authenticated scratch archive.
        raw_segments=stage/'wal'; raw_segments.mkdir()
        for seg in manifest:
            name=seg['file'].removesuffix('.aesgcm'); dst=raw_segments/name
            if seg.get('sourceBinding')!=source_binding(config): raise RuntimeError('WAL_RECEIPT_SOURCE_BINDING_MISMATCH')
            crypto('open',arch/seg['file'],dst,wal_aad(config,name))
            if sha(dst.read_bytes())!=seg['plaintextSha256']: raise RuntimeError('ARCHIVED_WAL_HASH_MISMATCH')
        # Base backup stream is copied into a scratch-only named volume.
        run(['volume','create','--label','alder.wal.owner='+run_id,vol])
        run(['create','--name',rec,'--label','alder.wal.owner='+run_id,'--network',net,'--mount','type=volume,source='+vol+',target=/var/lib/postgresql/data','--entrypoint','sleep',IMAGE,'infinity'])
        run(['start',rec])
        run(['exec',rec,'mkdir','-p','/wal'])
        run(['cp',str(raw_segments)+'/.',rec+':/wal'])
        # Recover only from the authenticated encrypted base archive.
        backup_dir=stage/'base-dir'; backup_dir.mkdir()
        with tarfile.open(verify,'r:') as t:
            for member in t.getmembers():
                if member.name.startswith('/') or '..' in Path(member.name).parts or member.issym() or member.islnk():
                    raise RuntimeError('AUTHENTICATED_BASE_EXTRACT_PATH_REFUSED')
            t.extractall(backup_dir,filter='data')
        if tar_inventory(verify)!=source_inventory or tree_inventory(backup_dir)!=source_inventory:
            raise RuntimeError('DECRYPTED_BASE_INVENTORY_CHANGED')
        run(['cp',str(backup_dir)+'/.',rec+':/var/lib/postgresql/data'])
        with (backup_dir/'postgresql.auto.conf').open('a',encoding='utf-8') as f:
            f.write("\nrestore_command = 'cp /wal/%f %p'\nrecovery_target_name = '"+mark+"'\nrecovery_target_action = 'promote'\n")
        (backup_dir/'recovery.signal').write_text('',encoding='ascii')
        run(['cp',str(backup_dir/'postgresql.auto.conf'),rec+':/var/lib/postgresql/data/postgresql.auto.conf'])
        run(['cp',str(backup_dir/'recovery.signal'),rec+':/var/lib/postgresql/data/recovery.signal'])
        run(['exec','-u','root',rec,'chown','-R','postgres:postgres','/var/lib/postgresql/data'])
        run(['exec','-u','root',rec,'chmod','700','/var/lib/postgresql/data'])
        run(['exec','-d','-u','postgres',rec,'sh','-c','postgres -D /var/lib/postgresql/data > /tmp/recovery.private.log 2>&1'],timeout=30)
        deadline=time.monotonic()+60; recovered=False
        while time.monotonic()<deadline:
            q=subprocess.run(['docker','exec',rec,'psql','-U','postgres','-d','alder','-X','-qAt','-c',f"SELECT count(*) FROM wal_marker WHERE id='{run_id}'"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=6)
            if q.returncode==0 and q.stdout.strip()==b'1': recovered=True; break
            time.sleep(.5)
        if not recovered: raise RuntimeError('SCRATCH_PITR_MARKER_MISSING')
        proof={'schema':'alder-wal-scratch-proof-v1','runId':run_id,'image':IMAGE,
               'ownedObjects':{'primary':pg,'receiver':rx,'recovery':rec,'network':net,'volume':vol},
               'baseBackup':{'plainBytes':backup['bytes'],'plainSha256':backup['plaintextSha256'],'cipherSha256':backup['ciphertextSha256'],
                             'authenticatedRoundTrip':True,'inventoryFileCount':len(source_inventory),
                             'inventorySha256':sha(json.dumps(source_inventory,sort_keys=True,separators=(',',':')).encode()),
                             'recoverySeed':'authenticated decrypted base archive; no source PGDATA copy'},
               'serviceCycle':service_result,'markerSwitch':switched,'postMarkerCollection':marker_collect,
               'segments':manifest,'restorePoint':mark,'markerRecovered':True,
               'privateLog':str(log),'archiveManifestSha256':marker_collect['manifestSha256'],
               'cleanup':'owned Docker objects are removed after proof; private ciphertext and failed-attempt log retained'}
        write_immutable_json(base/'proof.json',proof)
        shutil.rmtree(stage)
        return proof
    finally:
        # Names and labels are unique to this invocation; preserve all C: evidence.
        capture=subprocess.run(['docker','exec',rec,'cat','/tmp/recovery.private.log'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
        if capture.stdout:
            with log.open('ab') as f: f.write(b'\n[isolated recovery server private diagnostic]\n'+capture.stdout)
        for name in (rec,rx,pg):
            info=subprocess.run(['docker','inspect','--format','{{index .Config.Labels "alder.wal.owner"}}',name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=10)
            if info.returncode==0 and info.stdout.strip()==run_id:
                subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        ni=subprocess.run(['docker','network','inspect','--format','{{index .Labels "alder.wal.owner"}}',net],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=10)
        if ni.returncode==0 and ni.stdout.strip()==run_id: subprocess.run(['docker','network','rm',net],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
        for vname in (vol,rxvol):
            vi=subprocess.run(['docker','volume','inspect','--format','{{index .Labels "alder.wal.owner"}}',vname],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=10)
            if vi.returncode==0 and vi.stdout.strip()==run_id: subprocess.run(['docker','volume','rm',vname],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)

def load_service_config(path:Path|None)->dict:
    if path is None: return dict(LIVE_PIN)
    path=checked_path(path,ROOT_ARCHIVE)
    if not path.is_file(): raise RuntimeError('SERVICE_CONFIG_MISSING')
    config=json.loads(path.read_text(encoding='utf-8'))
    required=('container','containerId','image','networkMode','systemIdentifier','database','databaseOid','port',
              'receiver','owner','slot','spoolVolume','privateRoot')
    if any(k not in config for k in required): raise RuntimeError('SERVICE_CONFIG_FIELD_MISSING')
    if config['image']!=IMAGE or config['port']!=5432: raise RuntimeError('SERVICE_CONFIG_IMAGE_OR_PORT_MISMATCH')
    if (not config['container'].startswith('alder-') or config['database']!='alder' or
        not re.fullmatch(r'[0-9a-f]{64}',config['containerId']) or not str(config['systemIdentifier']).isdigit() or
        not str(config['databaseOid']).isdigit() or not re.fullmatch(r'[a-z0-9-]{8,32}',config['owner']) or
        not config['receiver'].startswith('alder-wal-') or not config['slot'].startswith('alder_wal_') or
        not config['spoolVolume'].startswith('alder-wal-')):
        raise RuntimeError('SERVICE_CONFIG_ALDER_IDENTITY_INVALID')
    safe_dir(Path(config['privateRoot']))
    return config

def main()->int:
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest='cmd',required=True)
    c=sub.add_parser('collect-once'); c.add_argument('--config',required=True)
    r=sub.add_parser('scratch-rehearsal'); r.add_argument('--run-id',required=True); r.add_argument('--service-only',action='store_true')
    svc=sub.add_parser('service'); svc.add_argument('--source-sha256',required=True); svc.add_argument('--crypto-sha256',required=True)
    svc.add_argument('--config'); svc.add_argument('--once',action='store_true')
    sub.add_parser('receiver-start')
    sub.add_parser('switch')
    b=sub.add_parser('basebackup'); b.add_argument('--destination',required=True)
    a=ap.parse_args()
    if a.cmd=='collect-once':
        config=load_service_config(Path(a.config)); live_ready(config)
        require_owner_receipt(config,'receiver'); require_owner_receipt(config,'slot'); require_owner_receipt(config,'volume')
        private_root=safe_dir(Path(config['privateRoot'])); result=archive_receiver(config,private_root/'archive',private_root/'manifest',private_root/'copy-stage')
    elif a.cmd=='scratch-rehearsal': result=rehearsal(a.run_id,a.service_only)
    elif a.cmd=='receiver-start': result=live_receiver_start(dict(LIVE_PIN))
    elif a.cmd=='switch': result=switch_live(dict(LIVE_PIN))
    elif a.cmd=='basebackup': result=live_basebackup(dict(LIVE_PIN),safe_dir(Path(a.destination)))
    elif a.cmd=='service':
        result=service_loop(load_service_config(Path(a.config) if a.config else None),a.source_sha256,a.crypto_sha256,a.once)
        if not a.once: return 0
    print(json.dumps(result,indent=2)); return 0
if __name__=='__main__':
    try: raise SystemExit(main())
    except Exception as e: print(type(e).__name__+': '+str(e),file=sys.stderr); raise SystemExit(2)
