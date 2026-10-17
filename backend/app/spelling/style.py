"""7.9.7 Style and readability hints.

Readability is the OSMAN metric (El-Haj & Rayson, LREC 2016, https://aclanthology.org/L16-1038/),
computed by `osman.py`, an independent Python implementation verified against the official Java
reference (https://github.com/drelhaj/OsmanReadability) on tests/fixtures/osman_reference.json.
The other hints (long sentences/paragraphs, passive-voice markers, repeated words) are simple
heuristics, shown as indicators rather than verdicts.
"""

from __future__ import annotations

import re
from bisect import bisect_left

from .osman import osman as osman_score
from .text import AR_WORD_RE, Masker, OffsetMap, strip_for_lookup

REFERENCE = (
    "El-Haj & Rayson (2016), OSMAN - A Novel Arabic Readability Metric, LREC 2016, "
    "https://aclanthology.org/L16-1038/ ; reference: https://github.com/drelhaj/OsmanReadability"
)
SENT_SPLIT = re.compile(r"[^.!؟?؛\n]+[.!؟?؛]?", re.DOTALL)
_BLANK_LINE = re.compile(r"\n\s*\n")


def paragraph_spans(text: str):
    """(start, end) of each non-blank paragraph (blank-line separated, trimmed). Linear time: the
    former lazy regex `\\S(?:.*?\\S)?(?=\\n\\s*\\n|\\Z)` was O(n^2) on text without blank lines."""
    pos = 0
    seps = [*_BLANK_LINE.finditer(text), None]
    for m in seps:
        end = m.start() if m else len(text)
        seg = text[pos:end]
        lead = len(seg) - len(seg.lstrip())
        trail = len(seg.rstrip())
        if trail > lead:
            yield pos + lead, pos + trail
        pos = m.end() if m else len(text)
FASEEH = set("ءئؤذظ")
HARAKAT_SYLL = set("ًٌٍَُِ")
PASSIVE_AUX = {"تم", "تمت", "يتم", "تتم", "سيتم", "ستتم", "جرى", "جرت", "يجري", "تجري"}
STOP = set(
    "في من على إلى الى عن مع أن إن ان ما لا لم لن قد كان كانت هذا هذه ذلك تلك الذي التي الذين"
    " هو هي هم هن نحن أنا أنت أو ثم بين كل بعد قبل عند حتى إذا اذا لكن و ف ب ل ك أي اي هناك"
    " حيث كما".split()
)
MIN_REPEAT_LEN = 4


def _syllables(raw: str, key: str) -> int:
    marks = sum(1 for c in raw if c in HARAKAT_SYLL)
    if marks >= max(1, len(key) // 3):  # diacritized: count short vowels + long vowels
        return max(1, marks + sum(1 for c in key[1:] if c in "اويى"))
    return max(1, (len(key) + 1) // 2)  # undiacritized estimate


def _is_passive_diacritized(raw: str) -> bool:
    """فُعِلَ / يُفْعَلُ shapes: damma on the first letter and kasra before the last (past)."""
    letters = [(c, i) for i, c in enumerate(raw) if "ء" <= c <= "ي"]
    if len(letters) < 3 or "ُ" not in raw[: letters[1][1]]:
        return False
    tail = raw[letters[-2][1] : letters[-1][1]]
    head_ok = raw[letters[0][1] + 1 : letters[1][1]].startswith("ُ")
    return head_ok and "ِ" in tail


def analyze(
    text: str,
    max_sentence_words: int = 30,
    max_paragraph_words: int = 150,
    repeat_window: int = 40,
    protected: list[tuple[int, int]] | None = None,
) -> dict:
    masker = Masker(text, protected)
    om = OffsetMap(text)
    words = [m for m in AR_WORD_RE.finditer(text) if not masker.overlaps(m.start(), m.end())]
    n_words = len(words)
    sentences = [
        m for m in SENT_SPLIT.finditer(text) if AR_WORD_RE.search(m.group()) and m.group().strip()
    ]
    n_sent = max(len(sentences), 1 if n_words else 0)

    keys = [strip_for_lookup(m.group()) for m in words]
    letters_total = sum(len(k) for k in keys)
    metrics: dict = {
        "words": n_words,
        "sentences": n_sent,
        "avg_sentence_words": round(n_words / n_sent, 2) if n_sent else 0.0,
        "avg_word_length": round(letters_total / n_words, 2) if n_words else 0.0,
    }
    om_ = osman_score(text) if n_words else None
    metrics["osman"] = om_["score"] if om_ else None
    metrics["level"] = None  # the reference documents no interpretation bands: raw score only

    def span(s: int, e: int) -> dict:
        return {"start": s, "end": e, "start16": om.to16(s), "end16": om.to16(e)}

    long_sent = []
    for m in sentences:
        wc = sum(1 for _ in AR_WORD_RE.finditer(m.group()))
        if wc > max_sentence_words:
            s = m.start() + (len(m.group()) - len(m.group().lstrip()))
            long_sent.append({**span(s, m.end()), "words": wc})

    passive = []
    for m, k in zip(words, keys, strict=True):
        if k in PASSIVE_AUX or _is_passive_diacritized(m.group()):
            passive.append(span(m.start(), m.end()))

    counts: dict[str, list[int]] = {}
    repeated: dict[str, int] = {}
    for idx, k in enumerate(keys):
        if len(k) < MIN_REPEAT_LEN or k in STOP:
            continue
        pos = counts.setdefault(k, [])
        pos.append(idx)
        recent = len(pos) - bisect_left(pos, idx - repeat_window)  # O(log n), not a rescan
        if recent >= 3:
            repeated[k] = max(repeated.get(k, 0), recent)
    rep_list = sorted(
        ({"word": k, "count": c} for k, c in repeated.items()), key=lambda d: -d["count"]
    )[:20]

    long_par = []
    paragraphs = 0
    for ps, pe in paragraph_spans(text):
        wc = sum(1 for _ in AR_WORD_RE.finditer(text, ps, pe))
        paragraphs += wc > 0
        if wc > max_paragraph_words:
            long_par.append({**span(ps, pe), "words": wc})

    return {
        "metrics": {**metrics, "paragraphs": paragraphs},
        "long_sentences": long_sent,
        "passive": {
            "count": len(passive),
            "per_100_words": round(100 * len(passive) / n_words, 2) if n_words else 0.0,
            "spans": passive[:200],
        },
        "repeated_words": rep_list,
        "long_paragraphs": long_par,
        "thresholds": {
            "max_sentence_words": max_sentence_words,
            "max_paragraph_words": max_paragraph_words,
            "repeat_window": repeat_window,
        },
        "osman": ({**om_, "exact": True} if om_ else None),
        "reference": REFERENCE,
    }
