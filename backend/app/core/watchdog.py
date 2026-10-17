"""Parent-process watchdog: exit when the Electron parent dies (no orphaned sidecar)."""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from collections.abc import Callable

log = logging.getLogger("mizaj.watchdog")
HARD_EXIT_AFTER = 5.0


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        SYNCHRONIZE, WAIT_OBJECT_0 = 0x00100000, 0
        k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        h = k32.OpenProcess(SYNCHRONIZE, False, pid)
        if not h:
            # ERROR_ACCESS_DENIED (5) means it exists; anything else: gone
            return k32.GetLastError() == 5
        try:
            return k32.WaitForSingleObject(h, 0) != WAIT_OBJECT_0
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def parent_gone(pid: int, original_ppid: int | None) -> bool:
    if not pid_alive(pid):
        return True
    return sys.platform != "win32" and original_ppid is not None and os.getppid() != original_ppid


def start_parent_watchdog(
    pid: int,
    request_shutdown: Callable[[], None],
    interval: float = 1.0,
    hard_exit_after: float = HARD_EXIT_AFTER,
) -> threading.Thread:
    original_ppid = os.getppid() if sys.platform != "win32" else None

    def run() -> None:
        while not parent_gone(pid, original_ppid):
            time.sleep(interval)
        log.warning("parent process %d is gone; shutting down", pid)
        request_shutdown()
        time.sleep(hard_exit_after)
        log.warning("graceful shutdown timed out; forcing exit")
        os._exit(0)

    t = threading.Thread(target=run, name="mizaj-parent-watchdog", daemon=True)
    t.start()
    return t
