"""Windows process-tree containment. A gated child cannot launch before job assignment."""
import ctypes
from ctypes import wintypes as w
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from process_control import wait

if sys.platform == "win32":
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    class BasicLimits(ctypes.Structure):
        _fields_ = [("ProcessTime", ctypes.c_int64), ("JobTime", ctypes.c_int64), ("Flags", w.DWORD),
                    ("MinWorkingSet", ctypes.c_size_t), ("MaxWorkingSet", ctypes.c_size_t),
                    ("ActiveLimit", w.DWORD), ("Affinity", ctypes.c_size_t), ("Priority", w.DWORD), ("Scheduling", w.DWORD)]
    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]
    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("Basic", BasicLimits), ("Io", IoCounters), ("ProcessMemory", ctypes.c_size_t),
                    ("JobMemory", ctypes.c_size_t), ("PeakProcess", ctypes.c_size_t), ("PeakJob", ctypes.c_size_t)]
    class Accounting(ctypes.Structure):
        _fields_ = [("User", ctypes.c_int64), ("Kernel", ctypes.c_int64), ("PeriodUser", ctypes.c_int64),
                    ("PeriodKernel", ctypes.c_int64), ("Faults", w.DWORD), ("Total", w.DWORD), ("Active", w.DWORD), ("Terminated", w.DWORD)]
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
    kernel.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [w.HANDLE]

def checked(ok):
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())

def run(cmd, cwd, timeout, *, env, cancel_event=None):
    job = kernel.CreateJobObjectW(None, None)
    checked(job)
    proc = None
    try:
        limits = ExtendedLimits()
        limits.Basic.Flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        checked(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--child"],
                cwd=str(cwd), stdin=subprocess.PIPE, stdout=out, stderr=err,
                creationflags=subprocess.CREATE_NO_WINDOW, env=env)
            checked(kernel.AssignProcessToJobObject(job, w.HANDLE(int(proc._handle))))
            # This is the gate: no user CLI exists until assignment has succeeded.
            proc.stdin.write(json.dumps(cmd).encode("utf-8"))
            proc.stdin.close()
            try:
                code = wait(proc, timeout, cancel_event)
            finally:
                checked(kernel.TerminateJobObject(job, 1))
                deadline = time.monotonic() + 5
                while True:
                    info = Accounting()
                    checked(kernel.QueryInformationJobObject(job, 1, ctypes.byref(info), ctypes.sizeof(info), None))
                    if info.Active == 0: break
                    if time.monotonic() >= deadline: raise RuntimeError("Windows job still has active processes")
                    time.sleep(.05)
            out.seek(0); err.seek(0)
            return code, out.read().decode("utf-8", "replace"), err.read().decode("utf-8", "replace")
    finally:
        kernel.CloseHandle(job)
        if proc is not None and proc.poll() is None:
            proc.kill(); proc.wait(timeout=5)

if __name__ == "__main__" and "--child" in sys.argv:
    command = json.loads(sys.stdin.buffer.read())
    raise SystemExit(subprocess.call(command, stdin=subprocess.DEVNULL))
