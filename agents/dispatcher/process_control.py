"""A shared interruptible wait; the caller owns process-tree cleanup."""
import subprocess
import time


class RunCancelled(Exception):
    pass


def wait(proc, timeout, cancel_event=None):
    if cancel_event is None:
        return proc.wait(timeout=timeout)
    deadline = time.monotonic() + timeout
    while True:
        if cancel_event.is_set():
            raise RunCancelled("Stop requested by operator")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(proc.args, timeout)
        try:
            return proc.wait(timeout=min(.25, remaining))
        except subprocess.TimeoutExpired:
            pass
