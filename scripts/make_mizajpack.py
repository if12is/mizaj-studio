#!/usr/bin/env python3
"""Build a `.mizajpack` model update pack (zip + manifest.json) for air-gapped installs.

    python scripts/make_mizajpack.py --version 2025.07-v2 -o catt-models.mizajpack
"""

import argparse
import hashlib
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, "..", "backend", "models", "catt_eo")


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", default=DEFAULT_SRC, help="directory with encoder.onnx/decoder.onnx")
    ap.add_argument("--subdir", default="catt_eo", help="directory name inside the pack")
    ap.add_argument("--version", required=True)
    ap.add_argument("-o", "--output", required=True)
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    if not os.path.isfile(os.path.join(src, "encoder.onnx")):
        print(f"[ERROR] {src}/encoder.onnx not found (run scripts/download_models.py)", file=sys.stderr)
        return 1
    files = []
    for name in sorted(os.listdir(src)):
        p = os.path.join(src, name)
        if os.path.isfile(p) and name.endswith((".onnx", ".json", ".txt")):
            files.append(
                {"path": f"{args.subdir}/{name}", "sha256": sha256_of(p), "size": os.path.getsize(p)}
            )
    manifest = {"format": 1, "kind": "models", "version": args.version, "files": files}
    tmp = args.output + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        for f in files:
            z.write(os.path.join(src, os.path.basename(f["path"])), f["path"])
    os.replace(tmp, args.output)
    print(f"[OK] {args.output}: {len(files)} files, version {args.version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
