#!/usr/bin/env python3
"""Smoke-test the frozen engine (or `python -m app.main` without --exe) end to end (8.3.3).

    python scripts/smoke_frozen.py [--exe backend/dist/mizaj-engine/mizaj-engine] [--models DIR]

Checks: handshake, /health, fast + accurate /api/tashkeel, SSE stream, spelling, legal tafqeet,
DOCX export, PDF export + PDF import round trip, OCR (fake tesseract shell script, POSIX only),
batch folder job. Exits non-zero on the first failure.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
TOKEN = "smoke-token"
TXT = "ذهب الولد إلى المدرسة صباحا وقرأ كتابا جديدا"


class Client:
    def __init__(self, port: int):
        self.base = f"http://127.0.0.1:{port}"

    def call(self, method: str, path: str, body=None, timeout=240):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json", "X-Mizaj-Token": TOKEN})
        deadline = time.time() + timeout
        while True:
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return r.status, r.read()
            except urllib.error.HTTPError as exc:
                if exc.code == 503 and time.time() < deadline:  # engine still warming up
                    time.sleep(0.2)
                    continue
                return exc.code, exc.read()

    def json(self, method, path, body=None, expect=200):
        st, raw = self.call(method, path, body)
        assert st == expect, f"{method} {path} -> {st}: {raw[:300]!r}"
        return json.loads(raw) if raw else None


def check(name: str, cond: bool, info: str = "") -> None:
    print(f"  [{'ok' if cond else 'FAIL'}] {name} {info}")
    if not cond:
        raise SystemExit(f"smoke failed: {name}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--exe")
    ap.add_argument("--models", default=str(BACKEND / "models" / "catt_eo"))
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="mizaj-smoke-"))
    data = tmp / "data"
    env = {**os.environ, "MIZAJ_API_TOKEN": TOKEN, "MIZAJ_MODELS_DIR": a.models,
           "PYTHONUNBUFFERED": "1"}
    env.pop("MIZAJ_ENGINE_MODE", None)
    # fake tesseract (shell script so it also works when sys.executable is the frozen exe)
    tess = tmp / "tesseract"
    tess.write_text(
        '#!/bin/sh\nif [ "$1" = "--list-langs" ]; then printf "List:\\nara\\neng\\n"; exit 0; fi\n'
        'printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\t'
        'height\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t1\\t1\\t90\\tمرحبا\\n"\n')
    tess.chmod(tess.stat().st_mode | stat.S_IEXEC)
    env["MIZAJ_TESSERACT"] = str(tess)
    cmd = ([a.exe] if a.exe else [sys.executable, "-m", "app.main"]) + [
        "--port", "0", "--data-dir", str(data)]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env,
                         cwd=None if a.exe else str(BACKEND))
    try:
        port = None
        t0 = time.time()
        for line in p.stdout:  # type: ignore[union-attr]
            if line.startswith("MIZAJ_PORT="):
                port = int(line.split("=")[1])
            if line.strip() == "MIZAJ_STATUS=READY":
                break
        check("handshake", port is not None, f"port={port} in {time.time() - t0:.1f}s")
        c = Client(port)  # type: ignore[arg-type]
        h = c.json("GET", "/health")
        check("health", h["status"] == "ok", f"engine_mode={h.get('engine_mode')}")
        for mode in ("fast", "accurate"):
            r = c.json("POST", "/api/tashkeel", {"text": TXT, "mode": mode})
            check(f"tashkeel {mode}", any("ً" <= ch <= "ْ" for ch in r["text"]),
                  f"engine={r['engine']}")
        st, raw = c.call("POST", "/api/tashkeel/stream", {"text": TXT * 3, "mode": "fast"})
        check("tashkeel stream", st == 200 and b"event: done" in raw)
        r = c.json("GET", "/api/word-suggestions?word=%D8%B9%D9%84%D9%85")
        check("word-suggestions (qalsadi)", len(r) >= 1, f"{len(r)} items")
        r = c.json("POST", "/api/spelling/check", {"text": "ذهبت الى المدرسه"})
        check("spelling", isinstance(r, dict), f"keys={sorted(r)[:4]}")
        r = c.json("POST", "/api/legal/tafqeet", {"amount": 1250.5, "currency": "SAR",
                                                  "style": "legal"})
        check("legal tafqeet", bool(r.get("words")), r["words"][:30])
        out = tmp / "out"
        out.mkdir()
        fx = BACKEND / "tests" / "fixtures"
        for name, mode in (("sample_mixed.docx", "accurate"), ("sample_ar.docx", "fast")):
            dst = out / f"{mode}_{name}"
            r = c.json("POST", "/api/docx/export", {
                "source_path": str(fx / name), "target_path": str(dst), "mode": mode})
            check(f"docx export {mode}", dst.stat().st_size > 1000)
        pdf = out / "o.pdf"
        font = next((f for f in (
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf") if Path(f).is_file()),
            None)
        r = c.json("POST", "/api/io/export", {"target_path": str(pdf), "text": TXT,
                                              "font_path": font})
        check("pdf export", pdf.read_bytes().startswith(b"%PDF"))
        r = c.json("POST", "/api/io/import", {"path": str(pdf)})
        check("pdf import", bool(r["text"].strip()))
        from_png = out / "scan.png"
        # minimal valid 1x1 PNG
        from_png.write_bytes(bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
            "0000000d49444154789c6360f8cfc0f01f0005000201a5f645400000000049454e44ae426082"))
        r = c.json("POST", "/api/ocr", {"path": str(from_png)})
        check("ocr (fake tesseract)", "مرحبا" in r["text"])
        indir = tmp / "in"
        indir.mkdir()
        (indir / "a.txt").write_text(TXT, encoding="utf-8")
        (indir / "b.txt").write_text(TXT + " جديد", encoding="utf-8")
        job = c.json("POST", "/api/batch", {"input_dir": str(indir), "output_dir": str(tmp / "bo"),
                                            "mode": "fast", "formats": ["txt"]}, expect=202)
        for _ in range(100):
            s = c.json("GET", f"/api/batch/{job['job_id']}")
            if s["status"] in ("done", "failed", "cancelled"):
                break
            time.sleep(0.2)
        check("batch", s["status"] == "done" and s["succeeded"] == 2, f"{s['status']}")
        print("frozen engine smoke test PASSED")
        return 0
    finally:
        p.terminate()
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()


if __name__ == "__main__":
    sys.exit(main())
