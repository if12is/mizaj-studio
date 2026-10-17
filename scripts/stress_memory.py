#!/usr/bin/env python3
"""Memory stress test (Task 5.2.4): stream sample_long.txt through the sidecar with the chunk
cache disabled and report peak RSS (read from /proc, Linux only; no psutil needed).

    python scripts/stress_memory.py                       # dev sidecar (backend/.venv python)
    python scripts/stress_memory.py --exe dist/mizaj-engine/mizaj-engine
    python scripts/stress_memory.py --modes accurate --limit-mb 500
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(HERE, "..", "backend")
SAMPLE = os.path.join(BACKEND, "tests", "fixtures", "sample_long.txt")


def rss_mb(pid: int) -> float:
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    return 0.0


class Sampler(threading.Thread):
    def __init__(self, pid: int, interval: float = 0.5) -> None:
        super().__init__(daemon=True)
        self.pid, self.interval = pid, interval
        self.peak = 0.0
        self.samples: list[float] = []
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            v = rss_mb(self.pid)
            self.samples.append(v)
            self.peak = max(self.peak, v)
            self._stop.wait(self.interval)

    def stop(self) -> None:
        self._stop.set()
        self.join()


def start_sidecar(exe: str | None, data_dir: str, models_dir: str | None) -> tuple[subprocess.Popen, int]:
    if exe:
        cmd, cwd = [exe], None
    else:
        py = os.path.join(BACKEND, ".venv", "bin", "python")
        cmd, cwd = [py if os.path.exists(py) else sys.executable, "-m", "app.main"], BACKEND
    cmd += ["--port", "0", "--data-dir", data_dir]
    env = {k: v for k, v in os.environ.items() if k != "MIZAJ_ENGINE_MODE"}
    if models_dir:
        env["MIZAJ_MODELS_DIR"] = models_dir
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, text=True,
                            stderr=subprocess.DEVNULL)
    port = None
    for _ in range(2):
        line = proc.stdout.readline().strip()
        if line.startswith("MIZAJ_PORT="):
            port = int(line.split("=")[1])
    if port is None:
        proc.kill()
        raise SystemExit("sidecar did not print the handshake")
    return proc, port


def run_mode(mode: str, exe: str | None, text: str, models_dir: str | None) -> dict:
    with tempfile.TemporaryDirectory() as data_dir:
        proc, port = start_sidecar(exe, data_dir, models_dir)
        try:
            sampler = Sampler(proc.pid)
            sampler.start()
            time.sleep(1.0)
            baseline = rss_mb(proc.pid)
            body = json.dumps({"text": text, "mode": mode, "use_cache": False}).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/tashkeel/stream", body,
                {"Content-Type": "application/json"},
            )
            t0 = time.time()
            chunks = words = 0
            with urllib.request.urlopen(req, timeout=3600) as resp:
                event = "message"
                for raw in resp:
                    line = raw.decode("utf-8").rstrip("\n")
                    if line.startswith("event: "):
                        event = line[7:]
                    elif line.startswith("data: "):
                        data = json.loads(line[6:])
                        if event == "message":
                            chunks += 1
                        elif event == "done":
                            words = data["words"]
                        elif event == "error":
                            raise SystemExit(f"stream error: {data}")
                        event = "message"
            elapsed = time.time() - t0
            time.sleep(1.0)
            after = rss_mb(proc.pid)
            sampler.stop()
            return {"mode": mode, "baseline_mb": round(baseline), "peak_mb": round(sampler.peak),
                    "after_mb": round(after), "chunks": chunks, "words": words,
                    "seconds": round(elapsed, 1), "samples": len(sampler.samples)}
        finally:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--exe", help="frozen mizaj-engine executable (default: dev sidecar)")
    ap.add_argument("--modes", default="fast,accurate")
    ap.add_argument("--text", default=SAMPLE)
    ap.add_argument("--models-dir", default=os.path.join(BACKEND, "models"),
                    help="MIZAJ_MODELS_DIR for the sidecar (contains catt_eo/)")
    ap.add_argument("--limit-mb", type=int, default=500)
    args = ap.parse_args()
    with open(args.text, encoding="utf-8") as f:
        text = f.read()
    ok = True
    for mode in args.modes.split(","):
        r = run_mode(mode.strip(), args.exe, text, args.models_dir)
        status = "PASS" if r["peak_mb"] < args.limit_mb else "FAIL"
        ok &= status == "PASS"
        print(f"[{status}] {json.dumps(r)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
