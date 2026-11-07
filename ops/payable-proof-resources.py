"""Read-only Windows process-tree RSS monitor; no psutil/install/private files."""
import ctypes as C
from ctypes import wintypes as W
import json,sys,threading,time
root=int(sys.argv[1]);stop=threading.Event()
threading.Thread(target=lambda:(sys.stdin.read(),stop.set()),daemon=True).start()
K=C.WinDLL('kernel32',use_last_error=True);P=C.WinDLL('psapi',use_last_error=True)
class Entry(C.Structure):
    _fields_=[('size',W.DWORD),('usage',W.DWORD),('pid',W.DWORD),('heap',C.c_size_t),('module',W.DWORD),('threads',W.DWORD),('parent',W.DWORD),('priority',W.LONG),('flags',W.DWORD),('exe',W.WCHAR*260)]
class Memory(C.Structure):
    _fields_=[('size',W.DWORD),('faults',W.DWORD)]+[(n,C.c_size_t) for n in ['peak','rss','qpp','qp','qnp','qn','page','peakpage']]
class Status(C.Structure):
    _fields_=[('size',W.DWORD),('load',W.DWORD)]+[(n,C.c_ulonglong) for n in ['total','available','tp','ap','tv','av','ae']]
K.CreateToolhelp32Snapshot.restype=W.HANDLE;K.OpenProcess.restype=W.HANDLE
K.CloseHandle.argtypes=[W.HANDLE];K.Process32FirstW.argtypes=[W.HANDLE,C.POINTER(Entry)];K.Process32NextW.argtypes=[W.HANDLE,C.POINTER(Entry)]
P.GetProcessMemoryInfo.argtypes=[W.HANDLE,C.POINTER(Memory),W.DWORD]
try:
    while not stop.is_set():
        handle=K.CreateToolhelp32Snapshot(2,0)
        if handle==W.HANDLE(-1).value:raise OSError(C.get_last_error())
        parents={};e=Entry();e.size=C.sizeof(e)
        try:
            ok=K.Process32FirstW(handle,C.byref(e))
            while ok:
                parents[e.pid]=e.parent;ok=K.Process32NextW(handle,C.byref(e))
        finally:K.CloseHandle(handle)
        if root not in parents:break
        owned={root}
        while True:
            expanded=owned|{p for p,parent in parents.items() if parent in owned}
            if expanded==owned:break
            owned=expanded
        rows=[]
        for pid in sorted(owned):
            h=K.OpenProcess(0x410,False,pid)
            if not h:continue # exited between Toolhelp snapshot and OpenProcess
            try:
                m=Memory();m.size=C.sizeof(m)
                if not P.GetProcessMemoryInfo(h,C.byref(m),m.size):raise OSError(C.get_last_error())
                rows.append({'pid':pid,'rss':m.rss})
            finally:K.CloseHandle(h)
        s=Status();s.size=C.sizeof(s)
        if not K.GlobalMemoryStatusEx(C.byref(s)):raise OSError(C.get_last_error())
        print(json.dumps({'available':s.available,'tree_rss':sum(r['rss'] for r in rows),'processes':rows}),flush=True)
        stop.wait(.1)
except Exception as ex:
    print(json.dumps({'error':type(ex).__name__+':'+str(ex)}),flush=True);sys.exit(1)
