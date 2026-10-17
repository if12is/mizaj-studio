"""Legal glossary (Task 7.10.7): preferred diacritized forms + discouraged variants.

Built-in sample entries live in data/glossary.json; users extend/override them through the
`legal_glossary` table. Entries feed the `legal` tashkeel level: internal vowels and shadda of a
glossary term come from the glossary (not the neural engine); the final-letter case ending is
never taken from the glossary. Priority: user dictionary (tashkeel_cache, locked) > glossary >
engine.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.database import now_iso
from app.engine.normalize import WORD_RE, split_pairs, strip_marks

DATA = Path(__file__).resolve().parent / "data" / "glossary.json"
SHADDA = "ّ"
TANWEEN = "ًٌٍ"
# attached one/two-letter particles that may precede a glossary word
_PREFIXES = ["", "و", "ف", "ب", "ك", "ل", "وب", "ول", "فب", "فل", "وك", "فك", "بال", "وبال"]


class GlossaryError(ValueError):
    pass


@dataclass(frozen=True)
class Entry:
    term: str
    diacritized: str
    preferred: str = ""
    avoid: tuple[str, ...] = ()
    definition: str = ""
    jurisdiction: str = ""
    source: str = ""
    note: str = ""
    id: int | None = None
    builtin: bool = False


def _norm_space(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def validate_entry(term: str, diacritized: str) -> tuple[str, str]:
    term, diacritized = _norm_space(term), _norm_space(diacritized)
    if not term or not diacritized:
        raise GlossaryError("term and diacritized are required")
    if strip_marks(diacritized) != term:
        raise GlossaryError("diacritized form must have exactly the same letters as the term")
    return term, diacritized


def builtin_entries() -> list[Entry]:
    raw = json.loads(DATA.read_text(encoding="utf-8"))["entries"]
    return [
        Entry(
            e["term"],
            e["diacritized"],
            e.get("preferred", ""),
            tuple(e.get("avoid", [])),
            e.get("definition", ""),
            e.get("jurisdiction", ""),
            e.get("source", ""),
            e.get("note", ""),
            None,
            True,
        )  # fmt: skip
        for e in raw
    ]


def row_to_entry(r: sqlite3.Row) -> Entry:
    return Entry(r["term"], r["diacritized"], r["preferred"], tuple(json.loads(r["avoid_json"])),
                 r["definition"], r["jurisdiction"], r["source"], r["note"], r["id"])  # fmt: skip


def load_entries(conn: sqlite3.Connection | None) -> list[Entry]:
    """Built-in entries, overridden/disabled/extended by the user's table."""
    merged = {e.term: e for e in builtin_entries()}
    if conn is not None:
        for r in conn.execute("SELECT * FROM legal_glossary ORDER BY id"):
            if r["enabled"]:
                merged[r["term"]] = row_to_entry(r)
            else:
                merged.pop(r["term"], None)
    return list(merged.values())


class GlossaryIndex:
    """Matches glossary terms in a sequence of (stripped) words and overrides marks."""

    def __init__(self, entries: list[Entry]) -> None:
        self.by_first: dict[str, list[tuple[list[str], list[list[tuple[str, str]]]]]] = {}
        for e in entries:
            try:
                term, dia = validate_entry(e.term, e.diacritized)
            except GlossaryError:
                continue
            words = term.split(" ")
            forms = [split_pairs(w) for w in dia.split(" ")]  # canonical mark order
            if len(forms) != len(words):
                continue
            self.by_first.setdefault(words[0], []).append((words, forms))
        for lst in self.by_first.values():
            lst.sort(key=lambda x: -len(x[0]))

    def match(self, words: list[str]) -> dict[int, tuple[list[tuple[str, str]], int, int]]:
        """word index -> (glossary letter pairs, shift, skip) for `override_word`."""
        out: dict[int, tuple[list[tuple[str, str]], int, int]] = {}
        i = 0
        while i < len(words):
            hit = self._match_at(words, i)
            if hit is None:
                i += 1
                continue
            n, assigns = hit
            for k, (pairs, shift, skip) in enumerate(assigns):
                out[i + k] = (pairs, shift, skip)
            i += n
        return out

    def _match_at(self, words: list[str], i: int):
        w = words[i]
        for prefix in _PREFIXES:
            if not w.startswith(prefix):
                continue
            rem = w[len(prefix) :]
            # plain: prefix + term word;  lam-lam: prefix + "لل" + body  (= ل + ال + body)
            variants = [(rem, 0)]
            if rem.startswith("لل"):
                variants.append(("ا" + rem[1:], 2))
            for cand, skip in variants:
                for tw, forms in self.by_first.get(cand, ()):
                    if len(words) < i + len(tw) or words[i + 1 : i + len(tw)] != tw[1:]:
                        continue
                    assigns = [(forms[0], len(prefix), skip)]
                    assigns += [(f, 0, 0) for f in forms[1:]]
                    return len(tw), assigns
        return None


def override_word(
    engine_pairs: list[tuple[str, str]],
    glossary_pairs: list[tuple[str, str]],
    shift: int,
    skip: int,
) -> list[tuple[str, str]]:
    """Replace the marks of aligned letters by the glossary's marks (text letter `shift + j` <->
    glossary letter `j`). The final letter keeps only the glossary's shadda (plus the engine's
    tanween) - the case ending is not the glossary's call. The first `skip` glossary letters
    (the merged lam of "لل") keep the engine's marks."""
    out = list(engine_pairs)
    last = len(out) - 1
    for j, (_, gm) in enumerate(glossary_pairs):
        pos = shift + j
        if j < skip or not 0 <= pos <= last:
            continue
        base, em = out[pos]
        if pos == last:
            out[pos] = (
                base,
                (SHADDA if SHADDA in gm else "") + "".join(c for c in em if c in TANWEEN),
            )
        else:
            out[pos] = (base, gm)
    return out


def check_text(text: str, entries: list[Entry]) -> list[dict[str, Any]]:
    """Report discouraged variants (`avoid`) with the preferred term as a suggestion."""
    issues = []
    plain = strip_marks(text)
    for e in entries:
        for bad in e.avoid:
            b = strip_marks(bad)
            for m in re.finditer(rf"(?<![ء-ي]){re.escape(b)}(?![ء-ي])", plain):
                issues.append({"type": "avoid_term", "term": bad, "preferred": e.preferred or e.term,
                               "start": m.start(), "end": m.end(),
                               "message_ar": f"المصطلح «{bad}» غير مفضّل؛ المفضّل: «{e.preferred or e.term}».",
                               "message_en": f"'{bad}' is discouraged; preferred: '{e.preferred or e.term}'."})  # fmt: skip
    return sorted(issues, key=lambda i: i["start"])


def words_of(stripped: str) -> list[tuple[str, int, int]]:
    from app.engine.normalize import has_arabic_letters

    return [
        (m.group(0), m.start(), m.end())
        for m in WORD_RE.finditer(stripped)
        if has_arabic_letters(m.group(0))
    ]


def save_entry(conn: sqlite3.Connection, e: dict[str, Any], entry_id: int | None = None) -> int:
    term, dia = validate_entry(e["term"], e["diacritized"])
    ts = now_iso()
    vals = (term, dia, e.get("preferred") or term, json.dumps(e.get("avoid", []), ensure_ascii=False),
            e.get("definition", ""), e.get("jurisdiction", ""), e.get("source", ""),
            e.get("note", ""), 1 if e.get("enabled", True) else 0)  # fmt: skip
    if entry_id is None:
        cur = conn.execute(
            "INSERT INTO legal_glossary(term, diacritized, preferred, avoid_json, definition, "
            "jurisdiction, source, note, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (*vals, ts, ts),
        )
        return cur.lastrowid
    conn.execute(
        "UPDATE legal_glossary SET term=?, diacritized=?, preferred=?, avoid_json=?, definition=?, "
        "jurisdiction=?, source=?, note=?, enabled=?, updated_at=? WHERE id=?",
        (*vals, ts, entry_id),
    )
    return entry_id
