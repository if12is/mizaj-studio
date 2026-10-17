"""Spell-check evaluation (Task 7.9.8): synthetic error injection -> precision / recall per rule.

Clean sentences come from licence-clean project text (backend/eval/gold/*.txt, marks stripped,
plus the corrected side of backend/tests/fixtures/spelling_errors.txt). Errors of known classes
are injected with a fixed seed, then the checker is run and each issue is scored:

  * recall      - injected errors overlapped by an issue of the expected family
  * fix-recall  - ... whose first suggestion restores the original word
  * precision   - issues that overlap an injected error / all issues reported on the
                  injected texts (issues on untouched sentences count as false positives)

python scripts/eval_spelling.py                 # prints the table and rewrites EVAL.md
python scripts/eval_spelling.py --seed 7 --no-write
"""

from __future__ import annotations

import argparse
import random
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.spelling.engine import get_engine  # noqa: E402
from app.spelling.service import check_text  # noqa: E402

MARKS = re.compile("[ً-ْـٰ]")
WORD = re.compile("[ء-ي]+")
FUNC = ["في", "من", "على", "إلى", "عن", "أن", "إن"]

# class -> (family of codes accepted as a detection, category)
FAMILY = {
    "hamza_qat": {"HAMZA_QAT", "HAMZA_WASL", "SPELL_UNKNOWN"},
    "taa_marbuta": {"TAA_MARBUTA", "SPELL_UNKNOWN"},
    "alef_maqsura": {"ALEF_MAQSURA", "SPELL_UNKNOWN"},
    "alef_farqa": {"ALEF_FARQA", "SPELL_UNKNOWN"},
    "latin_comma": {"PUNCT_LATIN_COMMA"},
    "latin_question": {"PUNCT_LATIN_QUESTION"},
    "repeated_word": {"REPEATED_WORD"},
    "double_space": {"PUNCT_DOUBLE_SPACE"},
    "space_before_comma": {"PUNCT_SPACE_BEFORE"},
}

NOTES = '\n## Notes\n\n* `alef_maqsura` recall is low by design: ayaspell accepts the `ي` spelling of many words\n  (`إلي`, `علي`, `انتهي`, `يرجي`, ...), and a generic rule produced false positives on legitimate\n  words (`تحوي`, `سحابي`, the name `علي`). Only a closed list (`الي`, `حتي`, `متي`, `مستشفي`, `فى`)\n  and dictionary-invalid forms are flagged, in line with "low false positives beat recall".\n* `taa_marbuta` misses are words where the `ه` spelling is a valid pronoun-suffixed word\n  (`مدرسه` = "his teacher"); only `ال`-prefixed and dictionary-invalid forms are flagged.\n* Readability (`/api/spelling/readability`) uses OSMAN, El-Haj & Rayson, LREC 2016 (https://aclanthology.org/L16-1038/). `app/spelling/osman.py` is an independent port verified against the official Java reference (https://github.com/drelhaj/OsmanReadability) on 110 texts: all component counts equal and scores within 1e-6 (`tests/fixtures/osman_reference.json`). The reference documents no interpretation bands, so only the raw score is reported.\n* The injected-error mix is synthetic; add a human-written sample before relying on these numbers.\n'  # noqa: E501


def load_clean() -> list[str]:
    sents: list[str] = []
    for f in sorted((BACKEND / "eval" / "gold").glob("*.txt")):
        for ln in f.read_text(encoding="utf-8").splitlines():
            if ln.strip() and not ln.startswith("#"):
                sents.append(MARKS.sub("", ln.strip()))
    fx = BACKEND / "tests" / "fixtures" / "spelling_errors.txt"
    for ln in fx.read_text(encoding="utf-8").splitlines():
        if "\t" in ln:
            sents.append(ln.split("\t")[1].strip())
    out, seen = [], set()
    for s in sents:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def inject(kind: str, s: str, rng: random.Random):
    """Return (bad_text, start, end, original) or None when the class does not apply."""
    ws = list(WORD.finditer(s))
    if kind == "hamza_qat":
        c = [m for m in ws if m.group()[0] in "أإ" and len(m.group()) > 3]
        if not c:
            return None
        m = rng.choice(c)
        w = "ا" + m.group()[1:]
    elif kind == "taa_marbuta":
        c = [m for m in ws if m.group().endswith("ة") and len(m.group()) > 3]
        if not c:
            return None
        m = rng.choice(c)
        w = m.group()[:-1] + "ه"
    elif kind == "alef_maqsura":
        c = [m for m in ws if m.group().endswith("ى") and len(m.group()) > 2]
        if not c:
            return None
        m = rng.choice(c)
        w = m.group()[:-1] + "ي"
    elif kind == "alef_farqa":
        c = [m for m in ws if m.group().endswith("وا") and len(m.group()) > 3]
        if not c:
            return None
        m = rng.choice(c)
        w = m.group()[:-1]
    elif kind in ("latin_comma", "latin_question"):
        ch = "،" if kind == "latin_comma" else "؟"
        idx = [i for i, c in enumerate(s) if c == ch]
        if not idx:
            return None
        i = rng.choice(idx)
        return s[:i] + ("," if kind == "latin_comma" else "?") + s[i + 1 :], i, i + 1, ch
    elif kind == "repeated_word":
        c = [m for m in ws if m.group() in FUNC]
        if not c:
            return None
        m = rng.choice(c)
        bad = s[: m.end()] + " " + m.group() + s[m.end() :]
        return bad, m.end(), m.end() + 1 + len(m.group()), ""
    elif kind == "double_space":
        idx = [i for i, c in enumerate(s) if c == " "]
        if not idx:
            return None
        i = rng.choice(idx)
        return s[:i] + "  " + s[i + 1 :], i, i + 2, " "
    elif kind == "space_before_comma":
        idx = [i for i, c in enumerate(s) if c == "،"]
        if not idx:
            return None
        i = rng.choice(idx)
        return s[:i] + " " + s[i:], i, i + 1, ""
    else:
        return None
    return s[: m.start()] + w + s[m.end() :], m.start(), m.end() - (0), m.group()


def overlap(a0, a1, b0, b1):
    return a0 < b1 and b0 < a1


def run(seed: int) -> dict:
    rng = random.Random(seed)
    eng = get_engine()
    clean = load_clean()
    stats = defaultdict(lambda: {"n": 0, "detected": 0, "fixed": 0, "issues": 0, "tp": 0})
    fp_clean = 0
    for s in clean:
        fp_clean += len(check_text(s, eng)["issues"])
    for kind in FAMILY:
        for s in clean:
            inj = inject(kind, s, rng)
            if inj is None:
                continue
            bad, a, b, orig = inj
            if kind in ("hamza_qat", "taa_marbuta", "alef_maqsura", "alef_farqa"):
                b = a + len(WORD.match(bad, a).group())
            st = stats[kind]
            st["n"] += 1
            issues = check_text(bad, eng)["issues"]
            hit = [i for i in issues if overlap(i["start"], i["end"], a, b)]
            fam = [i for i in hit if i["code"] in FAMILY[kind]]
            st["issues"] += len(issues)
            st["tp"] += len(hit)
            if fam:
                st["detected"] += 1
                i0 = fam[0]
                top = (i0["suggestions"] or [bad[i0["start"] : i0["end"]]])[0]
                fixed = bad[: i0["start"]] + top + bad[i0["end"] :]
                if fixed == s:
                    st["fixed"] += 1
    return {"stats": dict(stats), "clean_sentences": len(clean), "clean_fp": fp_clean}


def table(res: dict) -> str:
    rows = ["| class | injected | detected (recall) | exact fix (top-1) | precision |",
            "| :--- | ---: | ---: | ---: | ---: |"]
    tot = {"n": 0, "detected": 0, "fixed": 0, "issues": 0, "tp": 0}
    for k, v in res["stats"].items():
        prec = v["tp"] / v["issues"] if v["issues"] else 0
        rows.append(
            f"| {k} | {v['n']} | {v['detected'] / v['n']:.1%} | {v['fixed'] / v['n']:.1%} "
            f"| {prec:.1%} |"
        )
        for f in tot:
            tot[f] += v[f]
    rows.append(f"| **all** | {tot['n']} | {tot['detected'] / tot['n']:.1%} | "
                f"{tot['fixed'] / tot['n']:.1%} | {tot['tp'] / max(tot['issues'], 1):.1%} |")
    return "\n".join(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--no-write", action="store_true")
    a = ap.parse_args()
    res = run(a.seed)
    t = table(res)
    print(t)
    print(f"false positives on {res['clean_sentences']} clean sentences: {res['clean_fp']}")
    if not a.no_write:
        md = (
            "# Spell-check evaluation (Task 7.9.8)\n\n"
            "Generated by `python scripts/eval_spelling.py` (seed %d). Synthetic errors are "
            "injected into licence-clean project sentences (`backend/eval/gold`, corrected side of "
            "`backend/tests/fixtures/spelling_errors.txt`); real-world error distributions differ, "
            "so treat these as regression numbers, not accuracy claims. QALB (not redistributable) "
            "can be run locally by pointing the loader at it.\n\n%s\n\n"
            "False positives on the %d untouched clean sentences: **%d**.\n\n"
            "*precision* = issues overlapping the injected error / all issues on the injected "
            "sentences (so it also counts issues on untouched parts).\n"
            % (a.seed, t, res["clean_sentences"], res["clean_fp"])
        ) + NOTES
        (BACKEND / "app" / "spelling" / "EVAL.md").write_text(md, encoding="utf-8")


if __name__ == "__main__":
    main()
