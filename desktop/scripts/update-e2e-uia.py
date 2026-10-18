"""Real auto-update test for a *release* build (fuses on, so Playwright cannot attach).

Drives the installed app through Windows UI Automation instead: waits for the update
banner, clicks «تنزيل», then «إعادة التشغيل والتثبيت». The workflow then verifies the
installed exe version changed.

    python scripts/update-e2e-uia.py <installed exe> <expected new version> <userData dir>
"""

import os
import subprocess
import sys
import time

from pywinauto import Desktop

DOWNLOAD = "تنزيل"
INSTALL = "إعادة التشغيل والتثبيت"


def log(*a: object) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def find_button(pid: int, title: str, timeout: float):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for w in Desktop(backend="uia").windows(process=pid):
            try:
                for b in w.descendants(control_type="Button"):
                    if (b.window_text() or "").strip() == title:
                        return b
            except Exception:  # window closed or not ready yet
                continue
        time.sleep(2)
    return None


def fail(msg: str) -> None:
    log("FAILED:", msg)
    print(f"::error title=Update E2E::{msg}")
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 4:
        print("usage: update-e2e-uia.py <exe> <expected-version> <userData>")
        sys.exit(2)
    exe, expected, user_data = sys.argv[1:]
    env = {**os.environ, "MIZAJ_USER_DATA_DIR": user_data}
    proc = subprocess.Popen([exe, "--force-renderer-accessibility"], env=env)
    log("launched", exe, "pid", proc.pid)

    # The automatic check fires ~10 s after start.
    btn = find_button(proc.pid, DOWNLOAD, 240)
    if btn is None:
        fail(f"update banner with «{DOWNLOAD}» did not appear (expected {expected})")
    log("banner found; clicking download")
    btn.invoke()

    btn = find_button(proc.pid, INSTALL, 900)
    if btn is None:
        fail("download did not finish within 15 minutes")
    log("downloaded; clicking restart & install")
    btn.invoke()

    try:
        proc.wait(timeout=120)
    except subprocess.TimeoutExpired:
        fail("app did not quit for installation within 120 s")
    log("UPDATE FLOW OK")


if __name__ == "__main__":
    main()
