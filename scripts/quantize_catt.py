#!/usr/bin/env python3
"""Dynamic INT8 quantization of the CATT encoder with an accuracy guard (Task 7.1.2).

    python scripts/quantize_catt.py                       # writes encoder_int8.onnx next to encoder.onnx
    python scripts/quantize_catt.py --exclude-last 8      # keep the last 8 MatMuls in float
    python scripts/quantize_catt.py --guard 0.3           # also run the gold-set DER guard

The guard compares DER (with case ending, all letters) of the float and INT8 encoders on the gold
set and exits 1 if INT8 is worse by more than the given number of points. Ship the INT8 file only
when the guard passes. Needs `onnx` (build-time only; not part of the runtime requirements).
"""

import argparse
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(HERE, "..", "backend"))


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def quantize(src: str, dst: str, exclude_last: int, per_channel: bool) -> None:
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic

    exclude: list[str] = []
    if exclude_last:
        nodes = [n.name for n in onnx.load(src).graph.node if n.op_type == "MatMul"]
        exclude = nodes[-exclude_last:]
        print(f"[INFO] keeping {len(exclude)} MatMul nodes in float: {exclude[:3]}...")
    quantize_dynamic(
        src, dst, weight_type=QuantType.QInt8, per_channel=per_channel, nodes_to_exclude=exclude
    )


def guard(models_dir: str, variant: str, threshold: float) -> int:
    sys.path.insert(0, BACKEND)
    os.chdir(BACKEND)
    from eval.corpus import load_gold
    from eval.run_eval import evaluate

    os.environ["MIZAJ_MODELS_DIR"] = os.path.dirname(os.path.abspath(models_dir))
    items = load_gold()
    res = evaluate(["accurate", variant], items, progress=False)
    k, s = "with_case_ending", "all"
    fl, q = res["engines"]["accurate"], res["engines"][variant]
    if "skipped" in q or "skipped" in fl:
        print(f"[ERROR] could not evaluate: {q.get('skipped') or fl.get('skipped')}")
        return 2
    d_fl, d_q = fl[k][s]["der"], q[k][s]["der"]
    print(
        f"[GUARD] DER float {d_fl:.2f}  int8 {d_q:.2f}  delta {d_q - d_fl:+.2f} (limit +{threshold})"
    )
    print(f"[GUARD] speed float {fl['words_per_second']} w/s  int8 {q['words_per_second']} w/s")
    return 0 if d_q - d_fl <= threshold else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--models-dir", default=os.path.join(BACKEND, "models", "catt_eo"))
    ap.add_argument("--exclude-last", type=int, default=0, help="keep the last N MatMuls in float")
    ap.add_argument("--per-channel", action="store_true")
    ap.add_argument("--guard", type=float, help="max allowed DER regression (points)")
    args = ap.parse_args()
    src = os.path.join(args.models_dir, "encoder.onnx")
    name = "encoder_int8_attn.onnx" if args.exclude_last else "encoder_int8.onnx"
    dst = os.path.join(args.models_dir, name)
    if not os.path.exists(src):
        print(f"[ERROR] {src} not found (run scripts/download_models.py)", file=sys.stderr)
        return 1
    quantize(src, dst, args.exclude_last, args.per_channel)
    print(
        f"[OK] {dst}  {os.path.getsize(dst) / 1e6:.1f} MB (float {os.path.getsize(src) / 1e6:.1f} MB)"
    )
    print(f"[SHA256] {sha256(dst)}")
    if args.guard is not None:
        return guard(
            args.models_dir,
            "accurate-int8-attn" if args.exclude_last else "accurate-int8",
            args.guard,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
