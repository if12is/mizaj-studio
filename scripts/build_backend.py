#!/usr/bin/env python3
"""Freeze the Python sidecar into dist/mizaj-engine/ (one-folder PyInstaller build).

    python scripts/build_backend.py [--dist DIR] [--no-clean] [--rebuild-bootloader]

--rebuild-bootloader compiles PyInstaller's bootloader from source (Windows, needs MSVC) so the
stub exe is not the widely-shared prebuilt one that AV vendors fingerprint. Equivalent to:
    PYINSTALLER_COMPILE_BOOTLOADER=1 pip install --force-reinstall --no-binary pyinstaller \
        --no-cache-dir pyinstaller==<pinned in requirements-build.txt>
Set MIZAJ_VERSION (e.g. 0.1.1) to stamp the exe VERSIONINFO; default = desktop/package.json.

Requires: pip install -r backend/requirements.txt -r backend/requirements-build.txt
Output: <dist>/mizaj-engine/mizaj-engine[.exe]  (default dist = backend/dist)
"""

import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(HERE, "..", "backend"))


def dir_size(path: str) -> int:
    return sum(
        os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs
        if not os.path.islink(os.path.join(r, f))
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dist", default=os.path.join(BACKEND, "dist"))
    ap.add_argument("--work", default=os.path.join(BACKEND, "build"))
    ap.add_argument("--no-clean", action="store_true")
    ap.add_argument("--rebuild-bootloader", action="store_true",
                    help="reinstall PyInstaller from source, compiling its bootloader (MSVC)")
    ap.add_argument("--python", default=sys.executable, help="interpreter with PyInstaller")
    args = ap.parse_args()

    if args.rebuild_bootloader:
        req = os.path.join(BACKEND, "requirements-build.txt")
        pin = "pyinstaller"
        with open(req, encoding="utf-8") as f:
            for line in f:
                if line.strip().lower().startswith("pyinstaller"):
                    pin = line.split("#")[0].strip()
        pip = [args.python, "-m", "pip", "install", "--force-reinstall", "--no-cache-dir",
               "--no-binary", "pyinstaller", pin]
        print("[BOOTLOADER]", " ".join(pip))
        rc = subprocess.call(pip, env={**os.environ, "PYINSTALLER_COMPILE_BOOTLOADER": "1"})
        if rc != 0:
            print("[ERROR] bootloader rebuild failed", file=sys.stderr)
            return rc

    cmd = [args.python, "-m", "PyInstaller", "--noconfirm", "--distpath", args.dist,
           "--workpath", args.work]
    if not args.no_clean:
        cmd.append("--clean")
    cmd.append(os.path.join(BACKEND, "mizaj_engine.spec"))
    print("[BUILD]", " ".join(cmd))
    rc = subprocess.call(cmd, cwd=BACKEND)
    if rc != 0:
        print("[ERROR] PyInstaller failed", file=sys.stderr)
        return rc
    out = os.path.join(args.dist, "mizaj-engine")
    exe = os.path.join(out, "mizaj-engine" + (".exe" if os.name == "nt" else ""))
    if not os.path.isfile(exe):
        print(f"[ERROR] expected {exe}", file=sys.stderr)
        return 1
    print(f"[OK] {exe}  ({dir_size(out) / 1024 / 1024:.0f} MB uncompressed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
