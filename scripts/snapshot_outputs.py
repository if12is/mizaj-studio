#!/usr/bin/env python3
"""Deterministic output snapshot of every core feature (8.3.3 trimming guard).

    python scripts/snapshot_outputs.py [--exe PATH] [--out FILE]

Starts the engine (frozen with --exe, else from source), runs a fixed sample through fast and
accurate tashkeel, word suggestions, i'rab, arud, spelling, tafqeet, Hijri dates, Quran detect,
DOCX / EPUB-less text / PDF export+import, OCR (fake tesseract) and writes canonical JSON. Diff the
files of two builds: the diff must be empty for a size trim to be acceptable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke_frozen import BACKEND, Client, TOKEN  # noqa: E402

TXT = "ذهب الولد إلى المدرسة صباحا وقرأ كتابا جديدا. قال الله تعالى: الحمد لله رب العالمين"
VOLATILE = {"elapsed_ms", "wps", "seconds", "took_ms"}


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items() if k not in VOLATILE}
    if isinstance(o, list):
        return [clean(v) for v in o]
    return o


def docx_digest(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        h = hashlib.sha256()
        for n in sorted(z.namelist()):
            if n.startswith("word/") and n.endswith(".xml") and "settings" not in n:
                h.update(re.sub(rb"w:rsid\w*=\"[^\"]*\"", b"", z.read(n)))
        return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe")
    ap.add_argument("--out", required=True)
    ap.add_argument("--models", default=str(BACKEND / "models" / "catt_eo"))
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="mizaj-snap-"))
    env = {**os.environ, "MIZAJ_API_TOKEN": TOKEN, "MIZAJ_MODELS_DIR": a.models,
           "PYTHONUNBUFFERED": "1"}
    env.pop("MIZAJ_ENGINE_MODE", None)
    tess = tmp / "tesseract"
    tess.write_text(
        '#!/bin/sh\nif [ "$1" = "--list-langs" ]; then printf "List:\\nara\\neng\\n"; exit 0; fi\n'
        'printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\t'
        'height\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t1\\t1\\t90\\tمرحبا\\n"\n')
    tess.chmod(tess.stat().st_mode | stat.S_IEXEC)
    env["MIZAJ_TESSERACT"] = str(tess)
    cmd = ([a.exe] if a.exe else [sys.executable, "-m", "app.main"]) + [
        "--port", "0", "--data-dir", str(tmp / "data")]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                         env=env, cwd=None if a.exe else str(BACKEND))
    snap: dict = {}
    try:
        port = None
        for line in p.stdout:
            if line.startswith("MIZAJ_PORT="):
                port = int(line.split("=")[1])
            if line.strip() == "MIZAJ_STATUS=READY":
                break
        c = Client(port)

        def rec(name, method, path, body=None, expect=200):
            st, raw = c.call(method, path, body)
            try:
                snap[name] = {"status": st, "body": clean(json.loads(raw))}
            except ValueError:
                snap[name] = {"status": st, "sha": hashlib.sha256(raw).hexdigest()}

        for mode in ("fast", "accurate"):
            for level in ("full", "minimal", "legal"):
                rec(f"tashkeel-{mode}-{level}", "POST", "/api/tashkeel",
                    {"text": TXT, "mode": mode, "level": level, "confidence": True})
        for w in ("علم", "كتب", "المدرسة", "يكتبون"):
            rec(f"suggest-{w}", "GET", "/api/word-suggestions?word=" + urllib.parse.quote(w))
            rec(f"irab-{w}", "GET", "/api/irab?word=" + urllib.parse.quote(w) + "&mode=fast")
        rec("arud", "POST", "/api/arud/analyze", {"text": "قفا نبك من ذكرى حبيب ومنزل",
                                                    "mode": "fast"})
        rec("spelling", "POST", "/api/spelling/check",
            {"text": "ذهبت الى المدرسه وقرات الكتاب هاذا الصباح"})
        rec("spelling-suggest", "POST", "/api/spelling/suggest", {"word": "المدرسه"})
        for amt, cur in ((1250.5, "SAR"), (1000000, "EGP"), (7, None)):
            rec(f"tafqeet-{amt}-{cur}", "POST", "/api/legal/tafqeet",
                {"amount": amt, "currency": cur, "style": "legal"})
        for d, cal in (("2024-03-15", "gregorian"), ("1445-09-01", "hijri")):
            rec(f"date-{cal}", "POST", "/api/legal/date-words", {"date": d, "calendar": cal})
        # synthetic but structurally valid Tanzil file: real Al-Fatiha, filler elsewhere
        sys.path.insert(0, str(BACKEND))
        from app.quran.store import VERSE_COUNTS

        fatiha = ["بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ", "ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ",
                  "ٱلرَّحْمَٰنِ ٱلرَّحِيمِ", "مَٰلِكِ يَوْمِ ٱلدِّينِ",
                  "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ", "ٱهْدِنَا ٱلصِّرَٰطَ ٱلْمُسْتَقِيمَ",
                  "صِرَٰطَ ٱلَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ ٱلْمَغْضُوبِ عَلَيْهِمْ وَلَا ٱلضَّآلِّينَ"]
        letters = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي"
        lines = []
        for si, n in enumerate(VERSE_COUNTS, 1):
            for ai in range(1, n + 1):
                t = fatiha[ai - 1] if si == 1 else (
                    letters[si % 28] + letters[ai % 28] + letters[(si * ai) % 28] + "ا قلب كلام")
                lines.append(f"{si}|{ai}|{t}")
        lines += ["#", "# Tanzil Quran Text, Creative Commons Attribution 3.0"]
        qf = tmp / "q.txt"
        qf.write_text("\n".join(lines) + "\n", encoding="utf-8")
        rec("quran-install", "POST", "/api/quran/install",
            {"kind": "uthmani", "source_path": str(qf)})
        rec("quran-detect", "POST", "/api/quran/detect", {"text": TXT})
        rec("legal-lint", "POST", "/api/legal/lint", {"text": "يلتزم الطرف الأول بدفع مبلغ 500 ريال"})
        fx = BACKEND / "tests" / "fixtures"
        out = tmp / "out"
        out.mkdir()
        for name, mode in (("sample_mixed.docx", "accurate"), ("sample_ar.docx", "fast")):
            dst = out / f"{mode}_{name}"
            st, _ = c.call("POST", "/api/docx/export", {
                "source_path": str(fx / name), "target_path": str(dst), "mode": mode})
            snap[f"docx-{mode}"] = {"status": st, "digest": docx_digest(dst)}
        for ext in ("txt", "md", "srt"):
            src = tmp / f"s.{ext}"
            src.write_text(TXT + "\n", encoding="utf-8")
            dst = out / f"o.{ext}"
            st, _ = c.call("POST", "/api/io/convert", {
                "input_path": str(src), "output_path": str(dst), "mode": "fast"})
            snap[f"convert-{ext}"] = {"status": st, "text": dst.read_text(encoding="utf-8")}
        pdf = out / "o.pdf"
        font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
        c.call("POST", "/api/io/export", {"target_path": str(pdf), "text": TXT, "font_path": font})
        st, raw = c.call("POST", "/api/io/import", {"path": str(pdf)})
        snap["pdf-import"] = {"status": st, "body": clean(json.loads(raw))}
        png = out / "scan.png"
        png.write_bytes(bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
            "0000000d49444154789c6360f8cfc0f01f0005000201a5f645400000000049454e44ae426082"))
        rec("ocr", "POST", "/api/ocr", {"path": str(png)})
    finally:
        p.terminate()
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
    Path(a.out).write_text(json.dumps(snap, ensure_ascii=False, indent=1, sort_keys=True),
                           encoding="utf-8")
    bad = [k for k, v in snap.items() if v.get("status", 200) >= 500]
    print(f"{len(snap)} entries written to {a.out}; server errors: {bad}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
