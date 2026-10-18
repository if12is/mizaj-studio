"""Run the tashkeel engines over a gold corpus and report DER / WER.

python scripts/eval_tashkeel.py                      # gold set, all available engines
python scripts/eval_tashkeel.py --engines mock       # CI-friendly (no models)
python scripts/eval_tashkeel.py --corpus /data/tashkeela --max-lines 500
python scripts/eval_tashkeel.py --check backend/eval/baseline.json --threshold 0.3
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from eval.calibration import calibration
from eval.corpus import GOLD_DIR, load_corpus, load_gold
from eval.metrics import compute

EVAL_DIR = Path(__file__).resolve().parent
# name -> pipeline options. "accurate" is CATT alone (the morph filter is a separate variant).
SPECS: dict[str, dict[str, Any]] = {
    "mock": {"mode": "fast", "mock": True},
    "fast": {"mode": "fast"},
    "accurate": {"mode": "accurate", "morph": False},
    "accurate+mf1": {"mode": "accurate", "morph": True, "morph_version": "1"},
    "accurate+mf2": {"mode": "accurate", "morph": True, "morph_version": "2"},
    "accurate+mf2+fixes": {"mode": "accurate", "morph": True, "morph_version": "2", "fixes": True},
    "accurate+irab": {"mode": "accurate", "morph": False, "irab": True},
    "accurate+mf2+irab": {"mode": "accurate", "morph": True, "morph_version": "2", "irab": True},
    "accurate-int8": {"mode": "accurate", "morph": False, "precision": "int8"},
    "accurate-int8+mf2": {
        "mode": "accurate",
        "morph": True,
        "morph_version": "2",
        "precision": "int8",
    },
    "accurate-int8-attn": {"mode": "accurate", "morph": False, "precision": "int8-attn"},
}
ALL_ENGINES = ("mock", "fast", "accurate", "accurate+mf1", "accurate+mf2", "accurate-int8+mf2")
PRIMARY = ("with_case_ending", "all")  # the number used for regression checks


async def _run_engine(name: str, sentences: list[str], data_dir: Path):
    from app.core.database import connect
    from app.engine import config
    from app.engine.executor import run_blocking
    from app.engine.factory import build_pipeline
    from app.engine.manager import manager
    from app.engine.normalize import strip_marks

    if name == "shakkala":
        from eval.candidates import run_shakkala

        t0 = time.perf_counter()
        outs = await run_blocking(run_shakkala, [strip_marks(s) for s in sentences])
        return outs, time.perf_counter() - t0, [[] for _ in sentences]
    spec = SPECS.get(name)
    if spec is None:
        raise RuntimeError(f"unknown engine spec '{name}'")
    if spec.get("mock"):
        os.environ["MIZAJ_ENGINE_MODE"] = "mock"
    else:
        os.environ.pop("MIZAJ_ENGINE_MODE", None)
    os.environ["MIZAJ_MORPH_VERSION"] = spec.get("morph_version", "2")
    os.environ["MIZAJ_CATT_PRECISION"] = spec.get("precision", "float")
    manager.reset()
    mode = spec["mode"]
    if mode == "accurate" and not config.model_present():
        raise RuntimeError("CATT model not available")
    if spec.get("precision", "float") != "float" and not config.int8_available():
        raise RuntimeError("INT8 encoder not available (run scripts/quantize_catt.py)")
    pipeline = await build_pipeline(
        mode,
        "full",
        keep_existing=False,
        morph_filter=spec.get("morph", False),
        use_cache=False,
        irab_rules=spec.get("irab", False),
        use_names=False,  # measure the engine, not the dictionary
        protect_quran=False,
        grammar_fixes=spec.get("fixes", False),  # legal_fix.py: lexicon + grammar rules
    )
    db = data_dir / "mizaj.db"

    def work():
        conn = connect(db)
        try:
            res = [pipeline.run_text_ex(conn, strip_marks(s)) for s in sentences]
            return [r[0] for r in res], [r[1] for r in res]
        finally:
            conn.close()

    t0 = time.perf_counter()
    preds, wconfs = await run_blocking(work)
    return preds, time.perf_counter() - t0, wconfs


def evaluate(
    engines: list[str], items: list[tuple[str, str]], progress: bool = True
) -> dict[str, Any]:
    from app.core.logging_setup import shutdown_logging
    from app.main import create_app

    logging.getLogger().setLevel(logging.WARNING)
    sentences = [s for _, s in items]
    n_words = sum(len(s.split()) for s in sentences)
    results: dict[str, Any] = {
        "corpus": {"sentences": len(sentences), "words": n_words},
        "engines": {},
    }
    # ExitStack unwinds before TemporaryDirectory cleans up.
    with tempfile.TemporaryDirectory() as td, contextlib.ExitStack() as stack:
        data_dir = Path(td)
        create_app(data_dir)  # runs migrations
        # The app's log file lives in td; release it before cleanup (required on Windows).
        stack.callback(shutdown_logging)
        logging.getLogger().setLevel(logging.WARNING)
        for name in engines:
            try:
                preds, secs, wconfs = asyncio.run(_run_engine(name, sentences, data_dir))
            except RuntimeError as exc:
                results["engines"][name] = {"skipped": str(exc)}
                if progress:
                    print(f"[SKIP] {name}: {exc}", file=sys.stderr)
                continue
            m = compute(sentences, preds)
            m["calibration"] = calibration(sentences, preds, wconfs)
            m["seconds"] = round(secs, 2)
            m["words_per_second"] = round(n_words / secs, 1) if secs else None
            by_cat: dict[str, Any] = {}
            for cat in sorted({c for c, _ in items}):
                idx = [i for i, (c, _) in enumerate(items) if c == cat]
                mc = compute([sentences[i] for i in idx], [preds[i] for i in idx])
                by_cat[cat] = {
                    "der": mc["with_case_ending"]["all"]["der"],
                    "wer": mc["with_case_ending"]["all"]["wer"],
                    "sentences": len(idx),
                }
            m["by_category"] = by_cat
            results["engines"][name] = m
            if progress:
                d = m["with_case_ending"]["all"]
                print(
                    f"[OK] {name}: DER {d['der']}  WER {d['wer']}  ({secs:.1f}s)", file=sys.stderr
                )
    return results


def _f(x: float | None) -> str:
    return "-" if x is None else f"{x:.2f}"


def to_markdown(res: dict[str, Any], title: str = "Tashkeel accuracy") -> str:
    c = res["corpus"]
    lines = [
        f"# {title}",
        "",
        f"Corpus: {c['sentences']} sentences, {c['words']} words. DER/WER in %, lower is better. "
        "Conventions: see `eval/metrics.py` (Arabic letters only; `all` = every letter, "
        "`gold-only` = letters that carry a diacritic in the gold text).",
        "",
        "| Engine | Scope | DER w/ case | WER w/ case | DER w/o case | WER w/o case | "
        "internal DER | final (i'rab) DER | shadda err | words/s |",
        "| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, m in res["engines"].items():
        if "skipped" in m:
            lines.append(f"| {name} | skipped: {m['skipped']} |  |  |  |  |  |  |  |  |")
            continue
        for scope, label in (("all", "all letters"), ("gold_only", "gold-only")):
            w, wo = m["with_case_ending"][scope], m["without_case_ending"][scope]
            lines.append(
                f"| {name} | {label} | {_f(w['der'])} | {_f(w['wer'])} | {_f(wo['der'])} | "
                f"{_f(wo['wer'])} | {_f(w['internal_der'])} | {_f(w['final_der'])} | "
                f"{_f(w['shadda_error'])} | {m['words_per_second']} |"
            )
    lines += ["", "## By category (DER / WER, with case ending, all letters)", ""]
    cats = sorted({k for m in res["engines"].values() for k in m.get("by_category", {})})
    lines.append("| Engine | " + " | ".join(cats) + " |")
    lines.append("| :--- | " + " | ".join("---:" for _ in cats) + " |")
    for name, m in res["engines"].items():
        if "by_category" in m:
            cells = [
                f"{_f(m['by_category'][c]['der'])} / {_f(m['by_category'][c]['wer'])}"
                if c in m["by_category"]
                else "-"
                for c in cats
            ]
            lines.append(f"| {name} | " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def check_baseline(res: dict[str, Any], baseline: dict[str, Any], threshold: float) -> list[str]:
    """Failure messages for engines whose primary DER got worse by more than `threshold` points."""
    problems = []
    for name, base in baseline.get("engines", {}).items():
        cur = res["engines"].get(name)
        if not cur or "skipped" in cur or "skipped" in base:
            continue
        k, s = PRIMARY
        b, c = base[k][s]["der"], cur[k][s]["der"]
        if c - b > threshold:
            problems.append(f"{name}: DER {b:.2f} -> {c:.2f} (> +{threshold})")
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--engines", default=",".join(ALL_ENGINES))
    ap.add_argument("--gold", type=Path, default=GOLD_DIR, help="gold dir or file")
    ap.add_argument(
        "--corpus", type=Path, help="external Tashkeela/Fadel-format corpus (not committed)"
    )
    ap.add_argument("--max-lines", type=int, default=500)
    ap.add_argument("--min-diacritized", type=float, default=0.8)
    ap.add_argument("--json", type=Path, help="write JSON results here")
    ap.add_argument("--md", type=Path, help="write the markdown table here")
    ap.add_argument("--check", type=Path, help="baseline.json to compare against")
    ap.add_argument("--threshold", type=float, default=0.3, help="max DER regression (points)")
    args = ap.parse_args(argv)

    if args.corpus:
        items = load_corpus(args.corpus, args.max_lines, args.min_diacritized)
    else:
        items = load_gold(args.gold)
        if args.gold == GOLD_DIR:  # owner's legal memo gold (apart: other tests glob GOLD_DIR)
            items += load_gold(EVAL_DIR / "gold_owner")
    if not items:
        print("no evaluation sentences found", file=sys.stderr)
        return 2
    res = evaluate([e.strip() for e in args.engines.split(",") if e.strip()], items)
    if args.json:
        args.json.write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    md = to_markdown(res)
    if args.md:
        args.md.write_text(md, encoding="utf-8")
    print(md)
    if args.check:
        problems = check_baseline(
            res, json.loads(args.check.read_text(encoding="utf-8")), args.threshold
        )
        for p in problems:
            print(f"[REGRESSION] {p}", file=sys.stderr)
        return 1 if problems else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
