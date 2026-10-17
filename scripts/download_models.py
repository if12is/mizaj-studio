#!/usr/bin/env python3
"""
Model Downloader & SHA256 Verifier for Mizaj Studio.
Supports --dry-run and --verify-or-mock for offline/CI environments.
"""
import argparse
import hashlib
import os
import sys
import urllib.request

MODELS_MANIFEST = {
    "catt_encoder_int8.onnx": {
        "url": "https://github.com/abjadai/catt/releases/download/v1.0.0/catt_encoder_int8.onnx",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",  # Replace with actual release hash
        "size_mb": 42,
        "description": "Quantized INT8 ONNX Encoder-Only CATT Diacritization Model"
    }
}

def compute_sha256(filepath: str) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def main() -> int:
    parser = argparse.ArgumentParser(description="Download and verify Mizaj Studio offline NLP models.")
    parser.add_argument("--dry-run", action="store_true", help="Print manifest and exit without downloading.")
    parser.add_argument("--verify-or-mock", action="store_true", help="Verify existing models or enable mock fallback without failing.")
    parser.add_argument("--models-dir", default=os.path.join(os.path.dirname(__file__), "..", "backend", "models"), help="Target directory.")
    args = parser.parse_args()

    models_dir = os.path.abspath(args.models_dir)
    os.makedirs(models_dir, exist_ok=True)

    if args.dry_run:
        print(f"[DRY-RUN] Target directory: {models_dir}")
        for name, meta in MODELS_MANIFEST.items():
            print(f"  - {name} (~{meta['size_mb']} MB): {meta['description']} | SHA256: {meta['sha256'][:16]}...")
        return 0

    for name, meta in MODELS_MANIFEST.items():
        target_path = os.path.join(models_dir, name)
        if os.path.exists(target_path):
            actual_hash = compute_sha256(target_path)
            if actual_hash == meta["sha256"]:
                print(f"[OK] {name} verified (SHA256 matches).")
                continue
            else:
                print(f"[WARN] {name} SHA256 mismatch! Expected {meta['sha256']}, got {actual_hash}.")
                if args.verify_or_mock:
                    print("[INFO] Running in fallback/mock-ready mode.")
                    continue

        if args.verify_or_mock:
            print(f"[INFO] Model '{name}' not found locally. System will use MIZAJ_ENGINE_MODE=mock or libtashkeel until downloaded.")
            continue

        print(f"[DOWNLOADING] {name} from {meta['url']} ...")
        try:
            urllib.request.urlretrieve(meta["url"], target_path)
            print(f"[SUCCESS] Downloaded {name} to {target_path}")
        except Exception as exc:
            print(f"[ERROR] Failed to download {name}: {exc}", file=sys.stderr)
            print("Tip: Check your internet connection or set MIZAJ_ENGINE_MODE=mock for development.", file=sys.stderr)
            return 1

    return 0

if __name__ == "__main__":
    sys.exit(main())
