#!/usr/bin/env python3
"""
Model Downloader & SHA256 Verifier for Mizaj Studio.

Downloads the CATT encoder-only ONNX release (abjadai/catt v2, eo_model_onnx.zip), verifies its
SHA256, and extracts encoder.onnx + decoder.onnx to backend/models/catt_eo/.
Supports --dry-run and --verify-or-mock for offline/CI environments.
"""

import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request
import zipfile

ARCHIVE = {
    "url": "https://github.com/abjadai/catt/releases/download/v2/eo_model_onnx.zip",
    "sha256": "5343bfdfda70c981b587811b79348b8dde91f65c0a551ca98f232ea5cb62ceac",
    "size_bytes": 72109998,
    "description": "CATT encoder-only ONNX (float) + decoder, Apache-2.0 (abjadai/catt v2)",
}
# Files extracted from the archive into <models-dir>/catt_eo/
FILES = {
    "encoder.onnx": "437a99c032ec7de4249280efbc4dce2d0532f95c9fe8356debf24ce05a34ba6a",
    "decoder.onnx": "e6575bdba8623bf51a6d459fc4955e8a98aa3c6c2ffc5abffac26e883792bc80",
}
SUBDIR = "catt_eo"


def compute_sha256(filepath: str) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def installed_ok(target_dir: str) -> tuple[bool, list[str]]:
    problems = []
    for name, expected in FILES.items():
        path = os.path.join(target_dir, name)
        if not os.path.exists(path):
            problems.append(f"{name}: missing")
        elif compute_sha256(path) != expected:
            problems.append(f"{name}: SHA256 mismatch")
    return not problems, problems


def download(target_dir: str) -> None:
    os.makedirs(target_dir, exist_ok=True)
    fd, tmp_zip = tempfile.mkstemp(suffix=".zip", dir=target_dir)
    os.close(fd)
    try:
        print(f"[DOWNLOADING] {ARCHIVE['url']} ...")
        urllib.request.urlretrieve(ARCHIVE["url"], tmp_zip)
        actual = compute_sha256(tmp_zip)
        if actual != ARCHIVE["sha256"]:
            raise RuntimeError(f"archive SHA256 mismatch: expected {ARCHIVE['sha256']}, got {actual}")
        with zipfile.ZipFile(tmp_zip) as zf:
            for name in FILES:
                data = zf.read(name)  # KeyError if the archive layout changed
                with open(os.path.join(target_dir, name), "wb") as out:
                    out.write(data)
    finally:
        if os.path.exists(tmp_zip):
            os.remove(tmp_zip)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download and verify Mizaj Studio offline NLP models.")
    parser.add_argument("--dry-run", action="store_true", help="Print manifest and exit without downloading.")
    parser.add_argument("--verify-or-mock", action="store_true", help="Verify existing models or fall back to mock mode without failing.")
    parser.add_argument("--models-dir", default=os.path.join(os.path.dirname(__file__), "..", "backend", "models"), help="Target directory.")
    args = parser.parse_args()

    models_dir = os.path.abspath(args.models_dir)
    target_dir = os.path.join(models_dir, SUBDIR)

    if args.dry_run:
        print(f"[DRY-RUN] Target directory: {target_dir}")
        print(f"  - {ARCHIVE['url']} (~{ARCHIVE['size_bytes'] // 1_000_000} MB): {ARCHIVE['description']}")
        print(f"    archive SHA256: {ARCHIVE['sha256']}")
        for name, digest in FILES.items():
            print(f"    -> {SUBDIR}/{name}  SHA256: {digest[:16]}...")
        return 0

    ok, problems = installed_ok(target_dir)
    if ok:
        print(f"[OK] CATT models in {target_dir} verified (SHA256 matches).")
        return 0
    for p in problems:
        print(f"[WARN] {p}")

    if args.verify_or_mock:
        print("[INFO] CATT model not available. Accurate mode will report ERR_MODEL_MISSING; "
              "set MIZAJ_ENGINE_MODE=mock for deterministic development.")
        return 0

    try:
        download(target_dir)
    except Exception as exc:
        print(f"[ERROR] Failed to download models: {exc}", file=sys.stderr)
        print("Tip: Check your internet connection or set MIZAJ_ENGINE_MODE=mock for development.", file=sys.stderr)
        return 1
    ok, problems = installed_ok(target_dir)
    if not ok:
        print(f"[ERROR] Post-extract verification failed: {problems}", file=sys.stderr)
        return 1
    print(f"[SUCCESS] Models installed to {target_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
