"""Launch only this Alder workload inside its already verified Windows job.

The explicit parent is an exact-identity P6 worker already in the job. Windows
inherits that parent's job hierarchy (Microsoft UpdateProcThreadAttribute docs).
The new process stays suspended until membership and limits are checked.
No code is run in, and no handles are inherited from, the existing worker.
"""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
from pathlib import Path
import subprocess
import sys
import time

import resource_profile as profile

ROOT=profile.ROOT
PYTHON=Path('C:/Users/user/portfolio-build/fieldwork/.venv/Scripts/python.exe')

class STARTUPINFO(c.Structure):
    _fields_=[('cb',w.DWORD),('lpReserved',w.LPWSTR),('lpDesktop',w.LPWSTR),
      ('lpTitle',w.LPWSTR),('dwX',w.DWORD),('dwY',w.DWORD),('dwXSize',w.DWORD),
      ('dwYSize',w.DWORD),('dwXCountChars',w.DWORD),('dwYCountChars',w.DWORD),
      ('dwFillAttribute',w.DWORD),('dwFlags',w.DWORD),('wShowWindow',w.WORD),
      ('cbReserved2',w.WORD),('lpReserved2',c.POINTER(c.c_byte)),
      ('hStdInput',w.HANDLE),('hStdOutput',w.HANDLE),('hStdError',w.HANDLE)]
class STARTUPINFOEX(c.Structure):
    _fields_=[('StartupInfo',STARTUPINFO),('lpAttributeList',w.LPVOID)]
class PROCESS_INFORMATION(c.Structure):
    _fields_=[('hProcess',w.HANDLE),('hThread',w.HANDLE),('dwProcessId',w.DWORD),('dwThreadId',w.DWORD)]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--parent',type=int,required=True)
    ap.add_argument('--created',required=True)
    ap.add_argument('--owner',required=True)
    ap.add_argument('--run',required=True)
    ap.add_argument('--mode',choices=['rate','full'],required=True)
    args=ap.parse_args()
    if Path(sys.executable).resolve()!=PYTHON.resolve():raise RuntimeError('PINNED_PYTHON_REQUIRED')
    out=ROOT/'.local/scratch-r6/runs'/args.run
    if out.parent!=ROOT/'.local/scratch-r6/runs' or not (out/'P6-RUN.json').is_file():raise RuntimeError('RUN_PATH_INVALID')
    setup=json.loads((out/'setup-receipt.json').read_text())
    if setup.get('retainedStackRun')!=args.owner:raise RuntimeError('STACK_OWNER_MISMATCH')
    records=profile.process_records([args.parent]);row=records.get(args.parent)
    if not row or str(row.get('CreationDate'))!=args.created:raise RuntimeError('PARENT_IDENTITY_CHANGED')
    if Path(str(row.get('ExecutablePath'))).resolve()!=(ROOT/'.local/runtime/node-v26.7.0/node.exe').resolve():raise RuntimeError('PARENT_RUNTIME_MISMATCH')
    if 'services\\indexer-worker.ts' not in str(row.get('CommandLine')).replace('/','\\').casefold():raise RuntimeError('PARENT_NOT_OWN_WORKER')
    if profile.listener_records().get(9113)!=args.parent:raise RuntimeError('PARENT_WORKER_PORT_MISMATCH')
    profile.verify_docker(setup['container'],args.owner)
    k=c.WinDLL('kernel32',use_last_error=True)
    k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
    k.OpenJobObjectW.argtypes=[w.DWORD,w.BOOL,w.LPCWSTR];k.OpenJobObjectW.restype=w.HANDLE
    k.IsProcessInJob.argtypes=[w.HANDLE,w.HANDLE,c.POINTER(w.BOOL)];k.IsProcessInJob.restype=w.BOOL
    k.InitializeProcThreadAttributeList.argtypes=[w.LPVOID,w.DWORD,w.DWORD,c.POINTER(c.c_size_t)]
    k.UpdateProcThreadAttribute.argtypes=[w.LPVOID,w.DWORD,c.c_size_t,w.LPVOID,c.c_size_t,w.LPVOID,w.LPVOID]
    k.DeleteProcThreadAttributeList.argtypes=[w.LPVOID]
    k.CreateProcessW.argtypes=[w.LPCWSTR,w.LPWSTR,w.LPVOID,w.LPVOID,w.BOOL,w.DWORD,w.LPVOID,w.LPCWSTR,c.POINTER(STARTUPINFOEX),c.POINTER(PROCESS_INFORMATION)]
    k.CreateProcessW.restype=w.BOOL
    k.ResumeThread.argtypes=[w.HANDLE];k.ResumeThread.restype=w.DWORD
    k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD];k.WaitForSingleObject.restype=w.DWORD
    k.GetExitCodeProcess.argtypes=[w.HANDLE,c.POINTER(w.DWORD)]
    k.TerminateProcess.argtypes=[w.HANDLE,w.UINT]
    k.CloseHandle.argtypes=[w.HANDLE]
    parent=k.OpenProcess(0x0080|0x1000,False,args.parent)
    job=k.OpenJobObjectW(0x0004,False,'Local\\AlderP6Round7_'+args.owner)
    if not parent or not job:raise c.WinError(c.get_last_error())
    si=STARTUPINFOEX();pi=PROCESS_INFORMATION();initialized=False;resumed=False
    try:
        profile.verify_job_limits(job)
        member=w.BOOL()
        if not k.IsProcessInJob(parent,job,c.byref(member)) or not member.value:raise RuntimeError('PARENT_NOT_IN_TARGET_JOB')
        size=c.c_size_t()
        k.InitializeProcThreadAttributeList(None,1,0,c.byref(size))
        buf=c.create_string_buffer(size.value);si.lpAttributeList=c.cast(buf,w.LPVOID)
        if not k.InitializeProcThreadAttributeList(si.lpAttributeList,1,0,c.byref(size)):raise c.WinError(c.get_last_error())
        initialized=True;parent_value=w.HANDLE(parent)
        if not k.UpdateProcThreadAttribute(si.lpAttributeList,0,0x00020000,c.byref(parent_value),c.sizeof(parent_value),None,None):raise c.WinError(c.get_last_error())
        bootstrap=out/(args.mode+'-bootstrap.py')
        log=out/(args.mode+'-coordinator.raw.log')
        code='import sys,runpy,os\nsys.stdin=open(os.devnull,"r")\nsys.stdout=open('+repr(str(log))+',"x",encoding="utf-8",buffering=1)\nsys.stderr=sys.stdout\nsys.argv=['+repr(str(ROOT/'tests/round7-load/run.py'))+','+repr(args.run)+','+repr(args.mode)+']\nrunpy.run_path(sys.argv[0],run_name="__main__")\n'
        with bootstrap.open('x',encoding='utf-8') as f:f.write(code)
        command=c.create_unicode_buffer(subprocess.list2cmdline([str(PYTHON),'-u',str(bootstrap)]))
        si.StartupInfo.cb=c.sizeof(si)
        # EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW.
        if not k.CreateProcessW(str(PYTHON),command,None,None,False,0x00080000|0x4|0x08000000,None,str(ROOT),c.byref(si),c.byref(pi)):raise c.WinError(c.get_last_error())
        member=w.BOOL()
        if not k.IsProcessInJob(pi.hProcess,job,c.byref(member)) or not member.value:raise RuntimeError('SUSPENDED_CHILD_NOT_IN_TARGET_JOB')
        proof={'parentPid':args.parent,'parentCreationDate':args.created,'childPid':pi.dwProcessId,'sameJobVerifiedBeforeResume':True,'owner':args.owner,'run':args.run,'mode':args.mode,'handleInheritance':False,'limitsVerified':True}
        (out/(args.mode+'-job-launch.json')).write_text(json.dumps(proof,indent=2))
        if k.ResumeThread(pi.hThread)==0xffffffff:raise c.WinError(c.get_last_error())
        resumed=True
        print(json.dumps(proof),flush=True)
        while k.WaitForSingleObject(pi.hProcess,1000)==258:pass
        result=w.DWORD()
        if not k.GetExitCodeProcess(pi.hProcess,c.byref(result)):raise c.WinError(c.get_last_error())
        proof['exitCode']=result.value
        (out/(args.mode+'-job-launch.json')).write_text(json.dumps(proof,indent=2))
        print(json.dumps({'run':args.run,'mode':args.mode,'exitCode':result.value}),flush=True)
        return result.value
    finally:
        if pi.hProcess and not resumed:k.TerminateProcess(pi.hProcess,126)
        if pi.hThread:k.CloseHandle(pi.hThread)
        if pi.hProcess:k.CloseHandle(pi.hProcess)
        if initialized:k.DeleteProcThreadAttributeList(si.lpAttributeList)
        k.CloseHandle(parent);k.CloseHandle(job)

if __name__=='__main__':raise SystemExit(main())
