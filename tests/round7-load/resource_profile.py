#!/usr/bin/env python3
"""Prepare or enforce the frozen P6 Windows resource profile.

Default invocation is read-only/preparation-only. --apply is deliberately
explicit and requires a per-process PID + creation-time allowlist. On success,
this process remains alive holding the Windows Job Object handle. Keep it alive
for the entire workload; Ctrl+C closes the holder handle, while active members may
remain constrained until they exit.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import hashlib
import os
import re
from pathlib import Path
import subprocess
import sys
import time
from ctypes import wintypes

ROOT = Path(__file__).resolve().parents[2]
CPU_COUNT = 16
CPU_RATE = 1875  # 3/16 of total host CPU, in hundredths of one percent.
JOB_MEMORY_BYTES = 12 * 1024**3
REQUIRED_PORTS = (18548, 18547, 9103, 9113)
NODE_EXE = ROOT / ".local/runtime/node-v26.7.0/node.exe"
SERVICE_PATHS = {
    18547: "tests/round5-ops/rpc-proxy.mjs",
    9103: "tests/round5-ops/isolated-api.ts",
    9113: "services/indexer-worker.ts",
}

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True) if os.name == "nt" else None

# Job Object API constants and structures (Windows SDK definitions).
JobObjectBasicLimitInformation = 2
JobObjectExtendedLimitInformation = 9
JobObjectCpuRateControlInformation = 15
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1
JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001


class LARGE_INTEGER(ctypes.Structure):
    _fields_ = [("QuadPart", ctypes.c_longlong)]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", LARGE_INTEGER),
        ("PerJobUserTimeLimit", LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class JOBOBJECT_CPU_RATE_CONTROL_INFORMATION(ctypes.Structure):
    _fields_ = [("ControlFlags", wintypes.DWORD), ("CpuRate", wintypes.DWORD)]


def win_error(action: str) -> RuntimeError:
    return RuntimeError(f"{action}: {ctypes.WinError(ctypes.get_last_error())}")


def process_records(pids: list[int]) -> dict[int, dict[str, object]]:
    """Read only the explicitly named PIDs from Windows CIM; never enumerate the host."""
    if not pids:
        return {}
    filters = " OR ".join(f"ProcessId={pid}" for pid in pids)
    ps = (
        "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter '"
        + filters + "' | Select-Object ProcessId,CreationDate,CommandLine,ExecutablePath | "
        "ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        check=True, capture_output=True, text=True,
    )
    data = json.loads(result.stdout or "[]")
    if isinstance(data, dict):
        data = [data]
    return {int(row["ProcessId"]): row for row in data}


def listener_records() -> dict[int, int]:
    """Query only the four required listening ports and their owning PIDs."""
    ports = ",".join(str(port) for port in REQUIRED_PORTS)
    ps = (
        "$ErrorActionPreference='Stop'; $ports=@(" + ports + "); "
        "Get-NetTCPConnection -State Listen | Where-Object { $ports -contains $_.LocalPort } | "
        "Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        check=True, capture_output=True, text=True,
    )
    data = json.loads(result.stdout or "[]")
    if isinstance(data, dict):
        data = [data]
    owners: dict[int, int] = {}
    for row in data:
        port, pid = int(row["LocalPort"]), int(row["OwningProcess"])
        if port in owners and owners[port] != pid:
            raise RuntimeError(f"Multiple listener PIDs reported for port {port}")
        owners[port] = pid
    return owners


def docker_inspect(container: str) -> dict[str, object]:
    result = subprocess.run(
        ["docker", "inspect", container], check=True, capture_output=True, text=True,
    )
    decoded = json.loads(result.stdout)
    if not decoded:
        raise RuntimeError(f"Docker inspect returned no container for {container!r}")
    return decoded[0]


def verify_docker(container: str, owner: str) -> None:
    info = docker_inspect(container)
    config = info.get("Config") or {}
    labels = config.get("Labels") or {}
    if labels.get("alder.round7.owner") != owner:
        raise RuntimeError(
            "Docker owner label mismatch: expected exact "
            f"alder.round7.owner={owner!r}, got {labels.get('alder.round7.owner')!r}"
        )
    host = info.get("HostConfig") or {}
    nano_cpus = int(host.get("NanoCpus") or 0)
    memory = int(host.get("Memory") or 0)
    if nano_cpus != 1_000_000_000 or memory != 4 * 1024**3:
        raise RuntimeError(
            "Docker limits mismatch: expected --cpus=1 --memory=4g; "
            f"inspect reports NanoCpus={nano_cpus}, Memory={memory} bytes"
        )
    print(f"Docker verified: {info.get('Name', container)} label=alder.round7.owner={owner}, "
          "NanoCpus=1000000000, Memory=4294967296")


def approved_anvil_identity() -> tuple[Path, str]:
    policy_path = ROOT / "ops/alder-watchdog-policy.json"
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    runtime = policy.get("runtime") or {}
    image = Path(str(runtime.get("anvilPath") or ""))
    expected_sha = str(runtime.get("anvilSha256") or "").casefold()
    if not image.is_absolute() or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        raise RuntimeError("Alder watchdog policy has no valid pinned Anvil path/hash")
    if not image.is_file():
        raise RuntimeError(f"Pinned Anvil image is missing: {image}")
    actual_sha = hashlib.sha256(image.read_bytes()).hexdigest()
    if actual_sha != expected_sha:
        raise RuntimeError("Pinned Anvil executable SHA-256 differs from watchdog policy")
    return image.resolve(), expected_sha


def is_under_root(path: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(ROOT.resolve())
        return True
    except (OSError, ValueError):
        return False


def validate_allowlist(
    items: list[str], records: dict[int, dict[str, object]],
    listeners: dict[int, int], owner: str
) -> list[int]:
    if not items:
        raise RuntimeError("--apply requires at least one --allow PID:CREATE_TIME entry")
    selected: list[int] = []
    seen: set[int] = set()
    for item in items:
        try:
            pid_text, expected_created = item.split(":", 1)
            pid = int(pid_text)
        except ValueError as exc:
            raise RuntimeError(f"Invalid allowlist item {item!r}; expected PID:CREATE_TIME") from exc
        if pid in seen:
            raise RuntimeError(f"Duplicate allowlist PID {pid}")
        seen.add(pid)
        row = records.get(pid)
        if row is None:
            raise RuntimeError(f"Allowlisted PID {pid} is not running")
        actual_created = str(row.get("CreationDate") or "")
        if actual_created != expected_created:
            raise RuntimeError(f"PID {pid} creation-time mismatch; refusing PID reuse")
        if not row.get("CommandLine") or not row.get("ExecutablePath"):
            raise RuntimeError(f"PID {pid} command line or executable path is unavailable")
        selected.append(pid)
        print(f"Allowlisted PID verified: {pid} created={actual_created}; "
              f"image={Path(str(row['ExecutablePath'])).name}; command line redacted")

    missing = [port for port in REQUIRED_PORTS if port not in listeners]
    if missing:
        raise RuntimeError(f"Required listening ports are absent: {missing}")
    for port in REQUIRED_PORTS:
        pid = listeners[port]
        if pid not in records or pid not in selected:
            raise RuntimeError(f"Listener {port} PID {pid} is not in the explicit allowlist")

    for port, expected_script in SERVICE_PATHS.items():
        row = records[listeners[port]]
        exe = Path(str(row.get("ExecutablePath") or ""))
        command = str(row.get("CommandLine") or "").replace("/", "\\").casefold()
        if exe.resolve(strict=False) != NODE_EXE.resolve(strict=False):
            raise RuntimeError(f"Port {port} must be owned by Alder-pinned Node under {ROOT}")
        expected_path = expected_script.replace("/", "\\").casefold()
        if expected_path not in command:
            raise RuntimeError(f"Port {port} command does not identify {expected_script}")

    anvil_pid = listeners[18548]
    anvil = records[anvil_pid]
    anvil_exe = Path(str(anvil.get("ExecutablePath") or ""))
    anvil_cmd = str(anvil.get("CommandLine") or "").replace("/", "\\").casefold()
    approved_anvil, approved_sha = approved_anvil_identity()
    if anvil_exe.resolve(strict=False) != approved_anvil:
        raise RuntimeError(
            "Port 18548 Anvil image differs from the exact watchdog-policy path "
            f"{approved_anvil}"
        )
    state_match = re.search(r"--state\s+(?:\"([^\"]+)\"|(\S+))", anvil_cmd)
    if not state_match:
        raise RuntimeError("Port 18548 Anvil command is missing its --state path")
    state_path = Path(state_match.group(1) or state_match.group(2))
    if not state_path.is_absolute():
        state_path = ROOT / state_path
    if not is_under_root(state_path):
        raise RuntimeError("Port 18548 Anvil state path must remain under the Alder root")
    if "--port 18548" not in anvil_cmd:
        raise RuntimeError("Pinned Anvil command must listen on port 18548")
    print(f"Pinned Anvil path/hash verified against Alder watchdog policy; state path is Alder-root: {state_path}")

    listener_pids = set(listeners.values())
    for pid in selected:
        if pid in listener_pids:
            continue
        row = records[pid]
        command = str(row.get("CommandLine") or "").replace("/", "\\").casefold()
        if str(ROOT).casefold() not in command or owner.casefold() not in command:
            raise RuntimeError(
                f"Non-listener allowlist PID {pid} must identify an Alder-root workload command "
                "and the exact P6 run ID in its command line"
            )
    print("Listener owners verified exactly: " + json.dumps(listeners, sort_keys=True))
    print("Proxy/API/worker command paths are under Alder; Anvil image and state path are under Alder.")
    return selected


def verify_job_limits(job: int) -> None:
    assert kernel32 is not None
    verified_ext = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    returned = wintypes.DWORD()
    if not kernel32.QueryInformationJobObject(
        job, JobObjectExtendedLimitInformation, ctypes.byref(verified_ext),
        ctypes.sizeof(verified_ext), ctypes.byref(returned),
    ):
        raise win_error("QueryInformationJobObject memory verification failed")
    verified_cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION()
    if not kernel32.QueryInformationJobObject(
        job, JobObjectCpuRateControlInformation, ctypes.byref(verified_cpu),
        ctypes.sizeof(verified_cpu), ctypes.byref(returned),
    ):
        raise win_error("QueryInformationJobObject CPU verification failed")
    flags = verified_cpu.ControlFlags
    if verified_ext.JobMemoryLimit != JOB_MEMORY_BYTES or not (
        flags & JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
        and flags & JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
        and verified_cpu.CpuRate == CPU_RATE
    ):
        raise RuntimeError("Queried Job Object limits do not match requested profile")


def join_and_launch(owner: str, command: list[str]) -> int:
    if os.name != "nt" or kernel32 is None:
        raise RuntimeError("Named Job Object join is supported only on Windows")
    if not command:
        raise RuntimeError("--join-and-launch requires --launch followed by a command")
    expected_python = Path(r"C:\Users\user\portfolio-build\fieldwork\.venv\Scripts\python.exe")
    if Path(sys.executable).resolve(strict=False) != expected_python.resolve(strict=False):
        raise RuntimeError(f"Join launcher must use pinned Fieldwork Python: {expected_python}")
    in_root_argument = False
    for token in command[1:]:
        candidate = Path(token)
        if not candidate.is_absolute():
            candidate = ROOT / candidate
        if candidate.exists() and candidate.is_file() and is_under_root(candidate):
            in_root_argument = True
            break
    if not in_root_argument:
        raise RuntimeError("Launched command must name an existing command/script path under Alder")

    current = process_records([os.getpid()]).get(os.getpid())
    if not current or not str(current.get("CommandLine") or "").casefold().count(
        str(Path(__file__).resolve()).casefold()
    ):
        raise RuntimeError("Join coordinator command line does not identify this Alder script")

    job_name = "Local\\AlderP6Round7_" + owner
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.OpenJobObjectW.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel32.IsProcessInJob.restype = wintypes.BOOL
    job = kernel32.OpenJobObjectW(0x0004 | 0x0001, False, job_name)  # QUERY | ASSIGN_PROCESS
    if not job:
        raise win_error(f"OpenJobObjectW failed for {job_name}")
    process = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE,
        False, os.getpid()
    )
    if not process:
        kernel32.CloseHandle(job)
        raise win_error("Could not open join coordinator process")
    try:
        verify_job_limits(job)
        if not kernel32.AssignProcessToJobObject(job, process):
            raise win_error("Joining named Job Object failed; nested-job policy may prohibit it")
    finally:
        kernel32.CloseHandle(process)
    try:
        child = subprocess.Popen(command, cwd=ROOT)
        child_handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, child.pid)
        if not child_handle:
            child.terminate()
            raise win_error("Could not verify launched child job membership")
        try:
            member = wintypes.BOOL()
            if not kernel32.IsProcessInJob(child_handle, job, ctypes.byref(member)) or not member.value:
                child.terminate()
                raise RuntimeError("Launched child did not inherit named Job Object membership")
        finally:
            kernel32.CloseHandle(child_handle)
        print(f"Joined {job_name}; launched child PID {child.pid} verified in same Job Object")
        return child.wait()
    finally:
        kernel32.CloseHandle(job)

def hold_after_assignment_failure(job: int, assigned: list[int], reason: str) -> None:
    """Keep a partially populated job alive instead of abandoning constrained members."""
    print(f"PARTIAL ASSIGNMENT: {reason}", file=sys.stderr)
    print(f"Already assigned PIDs remain constrained: {assigned}", file=sys.stderr)
    print("Keep this holder open while those members exit. Press Ctrl+C only after they exit.",
          file=sys.stderr)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("Closing holder; any surviving job members may remain constrained.", file=sys.stderr)
    finally:
        assert kernel32 is not None
        kernel32.CloseHandle(job)


def set_and_verify_job(
    pids: list[int], hold_seconds: float | None = None, job_name: str | None = None,
    inheritance_probe: bool = False, expected_identities: dict[int, tuple[str, str]] | None = None
) -> None:
    if os.name != "nt":
        raise RuntimeError("Windows Job Objects are available only on Windows")
    assert kernel32 is not None
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD)
    ]
    kernel32.QueryInformationJobObject.restype = wintypes.BOOL
    ctypes.set_last_error(0)
    job = kernel32.CreateJobObjectW(None, job_name)
    if not job:
        raise win_error("CreateJobObjectW failed")
    if job_name and ctypes.get_last_error() == 183:
        kernel32.CloseHandle(job)
        raise RuntimeError(f"Named Job Object already exists; refusing to reuse {job_name!r}")

    ext = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY
    ext.JobMemoryLimit = JOB_MEMORY_BYTES
    if not kernel32.SetInformationJobObject(
        job, JobObjectExtendedLimitInformation, ctypes.byref(ext), ctypes.sizeof(ext)
    ):
        kernel32.CloseHandle(job)
        raise win_error("Setting 12 GiB Job Object memory limit failed")

    cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION()
    cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
    cpu.CpuRate = CPU_RATE
    if not kernel32.SetInformationJobObject(
        job, JobObjectCpuRateControlInformation, ctypes.byref(cpu), ctypes.sizeof(cpu)
    ):
        kernel32.CloseHandle(job)
        raise win_error("Setting 18.75% Job Object hard CPU cap failed")

    # Configure first, then assign only individually verified PIDs. Assignment can
    # fail for existing/nested jobs; retain the holder if any member was assigned.
    assigned: list[int] = []
    for pid in pids:
        process = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE,
            False, pid,
        )
        if not process:
            error = win_error(f"OpenProcess failed for allowlisted PID {pid}")
            if assigned:
                hold_after_assignment_failure(job, assigned, str(error))
            else:
                kernel32.CloseHandle(job)
            raise error
        try:
            if expected_identities is not None:
                fresh = process_records([pid]).get(pid)
                expected_created, expected_image = expected_identities[pid]
                if (fresh is None or str(fresh.get("CreationDate") or "") != expected_created
                        or str(fresh.get("ExecutablePath") or "").casefold() != expected_image.casefold()):
                    error = RuntimeError(
                        f"PID {pid} changed identity between snapshot and assignment; refusing it"
                    )
                    if assigned:
                        hold_after_assignment_failure(job, assigned, str(error))
                    else:
                        kernel32.CloseHandle(job)
                    raise error
            if not kernel32.AssignProcessToJobObject(job, process):
                error = win_error(
                    f"AssignProcessToJobObject failed for PID {pid}; existing/nested job "
                    "restrictions may prevent assignment"
                )
                if assigned:
                    hold_after_assignment_failure(job, assigned, str(error))
                else:
                    kernel32.CloseHandle(job)
                raise error
            assigned.append(pid)
        finally:
            kernel32.CloseHandle(process)

    try:
        verify_job_limits(job)
    except (OSError, RuntimeError) as exc:
        hold_after_assignment_failure(job, assigned, str(exc))
        raise
    print("Verified Job Object: CPU hard cap 18.75% (3/16 logical CPU equivalents); "
          "job memory limit 12 GiB")
    print("Job handle is held by this foreground process. Keep it alive to coordinate "
          "the run. Closing it does not necessarily release already-assigned processes: "
          "Windows retains a Job Object while member processes remain.")
    print("Future child processes created by a member normally inherit job membership "
          "unless breakaway is explicitly enabled; verify their membership before relying on it.")
    if inheritance_probe:
        kernel32.IsProcessInJob.argtypes = [
            wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)
        ]
        kernel32.IsProcessInJob.restype = wintypes.BOOL
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        child_handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, child.pid)
        try:
            if not child_handle:
                child.terminate()
                raise win_error("Could not open self-test child for membership verification")
            member = wintypes.BOOL()
            if not kernel32.IsProcessInJob(child_handle, job, ctypes.byref(member)) or not member.value:
                child.terminate()
                raise RuntimeError("Self-test child did not inherit the named Job Object")
            print(f"Named-job inheritance verified for disposable child PID {child.pid}")
        finally:
            if child_handle:
                kernel32.CloseHandle(child_handle)
            child.terminate()
            child.wait(timeout=10)
    try:
        if hold_seconds is None:
            while True:
                time.sleep(3600)
        else:
            time.sleep(hold_seconds)
    except KeyboardInterrupt:
        print("Closing the holder handle. Existing members may remain limited until they exit.")
    finally:
        kernel32.CloseHandle(job)


def self_test() -> None:
    """Test named-job limits and inheritance using only this helper and its child."""
    name = f"Local\\AlderP6Smoke_{os.getpid()}"
    print(f"Job Object API smoke test targets only this process and its child; job={name}")
    set_and_verify_job(
        [os.getpid()], hold_seconds=0.1, job_name=name, inheritance_probe=True
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="apply limits to exact verified allowlist")
    parser.add_argument("--self-test", action="store_true", help="smoke-test named Job Object limits and inheritance on this process plus one disposable child")
    parser.add_argument("--allow", action="append", default=[], metavar="PID:CREATE_TIME",
                        help="exact PID and CIM CreationDate; repeat per process (also scopes prep inspection)")
    parser.add_argument("--inspect-pid", action="append", default=[], type=int, metavar="PID",
                        help="inspect only this exact PID in preparation mode; repeat as needed")
    parser.add_argument("--docker-container", help="exact container name/ID to inspect")
    parser.add_argument("--owner", help="exact P6 run ID expected in alder.round7.owner")
    parser.add_argument("--join-and-launch", action="store_true", help="join the named run Job Object, then launch one verified Alder command")
    parser.add_argument("--launch", nargs=argparse.REMAINDER, default=[], help="command and args to launch as a child of the joined job")
    args = parser.parse_args()
    print(f"Alder repository root: {ROOT}")
    if os.name != "nt":
        print("Preparation/enforcement targets Windows; this host is not Windows.", file=sys.stderr)
        return 2
    if args.self_test:
        try:
            self_test()
            return 0
        except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
            print(f"JOB OBJECT SELF-TEST FAILED: {exc}", file=sys.stderr)
            return 1
    if args.join_and_launch:
        if not args.owner:
            print("Refusing --join-and-launch without exact --owner run ID.", file=sys.stderr)
            return 2
        try:
            return join_and_launch(args.owner, args.launch)
        except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
            print(f"NAMED JOB LAUNCH FAILED: {exc}", file=sys.stderr)
            return 1
    if args.apply and (not args.docker_container or not args.owner):
        print("Refusing --apply without both --docker-container and exact --owner run ID.", file=sys.stderr)
        return 2
    if args.owner and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", args.owner):
        print("Refusing invalid --owner run ID.", file=sys.stderr)
        return 2
    if args.apply and not args.allow:
        print("Refusing --apply without explicit --allow PID:CREATE_TIME entries.", file=sys.stderr)
        return 2
    try:
        try:
            inspect_pids = [int(item.split(":", 1)[0]) for item in args.allow]
        except ValueError as exc:
            raise RuntimeError("Invalid --allow value; expected PID:CREATE_TIME") from exc
        inspect_pids.extend(args.inspect_pid)
        if len(inspect_pids) != len(set(inspect_pids)):
            raise RuntimeError("Duplicate explicit PID in --allow/--inspect-pid")
        records = process_records(inspect_pids)
        print(f"Explicit PIDs inspected: {len(inspect_pids)}; no other host PIDs were queried")
        for pid in inspect_pids:
            row = records.get(pid)
            if row is None:
                raise RuntimeError(f"Explicit PID {pid} is not running or CIM returned no record")
            print(f"PID={pid} CREATE_TIME={row.get('CreationDate')} IMAGE={row.get('ExecutablePath')} COMMAND_LINE=redacted")
        if inspect_pids:
            print("Required TCP listener mapping: " + json.dumps(listener_records(), sort_keys=True))
        if args.docker_container:
            if not args.owner:
                raise RuntimeError("--docker-container requires the exact --owner run ID")
            verify_docker(args.docker_container, args.owner)
        if not args.apply:
            if not inspect_pids:
                print("No process query was made. To inspect, pass only explicit --inspect-pid values.")
            print("Preparation-only complete. No process or container limits were changed.")
            print("Frozen reference remains 4 cores / 16 GiB. Target Windows P6 stack: "
                  "3/16 CPU hard cap and 12 GiB Job Object memory; own Docker run: "
                  "1 CPU / 4 GiB. Use --apply only for an explicitly approved future run.")
            return 0
        listeners = listener_records()
        print("Required TCP listener mapping: " + json.dumps(listeners, sort_keys=True))
        selected = validate_allowlist(args.allow, records, listeners, args.owner)
        job_name = "Local\\AlderP6Round7_" + args.owner
        print(f"Creating named Job Object {job_name!r} for future join-before-launch children")
        identities = {
            pid: (str(records[pid].get("CreationDate") or ""),
                  str(records[pid].get("ExecutablePath") or ""))
            for pid in selected
        }
        set_and_verify_job(selected, job_name=job_name, expected_identities=identities)
        return 0
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"FAIL CLOSED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
