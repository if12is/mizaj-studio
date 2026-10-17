#!/usr/bin/env python3
"""Measure sidecar startup (Task 8.3.1): spawn -> MIZAJ_STATUS=READY and time to first tashkeel.

    python scripts/measure_startup.py [--exe PATH] [--runs 5] [--no-preload] [--json]

Without --exe the sidecar runs from source (`python -m app.main`, cwd=backend/). With --exe the
frozen binary is used. Each run uses a fresh empty data dir (so migrations run, as on first
launch) and a fresh process. Reported (median / min / max over --runs, milliseconds):

  ready_ms      process spawn -> `MIZAJ_STATUS=READY` line on stdout (the handshake)
  fast_ms       READY -> first `POST /api/tashkeel` (mode=fast) answered (engine load included)
  accurate_ms   READY -> first `POST /api/tashkeel` (mode=accurate) answered (skipped w/o model)

The page cache cannot be dropped without root, so numbers are "warm disk, cold process".
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(HERE, "..", "backend"))
TEXT = "ذهب الولد إلى المدرسة صباحا وقرأ كتابا جديدا"


def _post(port: int, token: str, body: dict, timeout: float = 180.0) -> float:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/tashkeel",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Mizaj-Token": token},
    )
    t0 = time.perf_counter()
    while True:  # 503 ERR_ENGINE_NOT_READY while the warm-up loads the engine: retry like the UI
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                r.read()
            return (time.perf_counter() - t0) * 1000
        except urllib.error.HTTPError as exc:
            if exc.code != 503 or time.perf_counter() - t0 > timeout:
                raise
            time.sleep(0.05)


def one_run(exe: str | None, preload: bool, accurate: bool) -> dict[str, float]:
    token = "measure-token"
    env = {**os.environ, "MIZAJ_API_TOKEN": token, "PYTHONUNBUFFERED": "1"}
    env.pop("MIZAJ_ENGINE_MODE", None)
    env.setdefault("MIZAJ_MODELS_DIR", os.path.join(BACKEND, "models", "catt_eo"))
    if not preload:
        env["MIZAJ_PRELOAD"] = "0"
    with tempfile.TemporaryDirectory() as data:
        cmd = ([exe] if exe else [sys.executable, "-m", "app.main"]) + [
            "--port", "0", "--data-dir", data]
        t0 = time.perf_counter()
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                             env=env, cwd=None if exe else BACKEND)
        port = None
        try:
            assert p.stdout is not None
            for line in p.stdout:
                if line.startswith("MIZAJ_PORT="):
                    port = int(line.split("=")[1])
                if line.strip() == "MIZAJ_STATUS=READY":
                    break
            else:
                raise RuntimeError("sidecar exited before READY")
            res = {"ready_ms": (time.perf_counter() - t0) * 1000}
            res["fast_ms"] = _post(port, token, {"text": TEXT, "mode": "fast"})
            if accurate:
                res["accurate_ms"] = _post(port, token, {"text": TEXT, "mode": "accurate"})
            return res
        finally:
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--exe")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--no-preload", action="store_true", help="MIZAJ_PRELOAD=0 (pure cold paths)")
    ap.add_argument("--no-accurate", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    runs = [one_run(a.exe, not a.no_preload, not a.no_accurate) for _ in range(a.runs)]
    summary = {}
    for k in runs[0]:
        vals = [r[k] for r in runs]
        summary[k] = {"median": round(statistics.median(vals)), "min": round(min(vals)),
                      "max": round(max(vals))}
    if a.json:
        print(json.dumps({"runs": runs, "summary": summary}, indent=2))
    else:
        label = a.exe or "dev (python -m app.main)"
        print(f"{label}  runs={a.runs} preload={not a.no_preload}")
        for k, v in summary.items():
            print(f"  {k:12s} median {v['median']:6d}  min {v['min']:6d}  max {v['max']:6d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
