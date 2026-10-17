"""Does the engine's per-word confidence predict its mistakes? (Task 7.1.3)"""

from __future__ import annotations

from typing import Any

from eval.metrics import words

BINS = [(0.0, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 0.97), (0.97, 1.01)]


def calibration(
    golds: list[str], preds: list[str], wconfs: list[list[Any]]
) -> dict[str, Any] | None:
    """Word error rate per confidence bin (a good score has error rates falling with confidence)."""
    stats = {b: [0, 0] for b in BINS}  # bin -> [words, wrong]
    seen = 0
    for g, p, wc in zip(golds, preds, wconfs, strict=True):
        gw, pw = words(g), words(p)
        if len(gw) != len(pw) or len(wc) != len(gw):
            continue
        for a, b, (_s, _e, conf, _ic) in zip(gw, pw, wc, strict=True):
            if conf is None:
                continue
            seen += 1
            for lo, hi in BINS:
                if lo <= conf < hi:
                    stats[(lo, hi)][0] += 1
                    stats[(lo, hi)][1] += a != b
                    break
    if not seen:
        return None
    rows = [
        {
            "bin": f"{lo:.2f}-{min(hi, 1.0):.2f}",
            "words": n,
            "word_error_rate": round(100 * w / n, 1) if n else None,
        }
        for (lo, hi), (n, w) in stats.items()
    ]
    return {"words": seen, "bins": rows}
