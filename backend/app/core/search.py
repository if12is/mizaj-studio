"""Arabic-aware full-text search over all documents (SQLite FTS5 + normalized shadow text).

The index stores a normalized copy of each document: harakat, tatweel and Quranic marks are
dropped, alef/hamza forms, ya/alef-maqsura and ta-marbuta are folded, digits become ASCII.
Queries get the same treatment, so «مُدَرِّسَة» finds «مدرسه» and «أحمد» finds «احمد».
Normalization is a pure `str.translate` (one character in, at most one character out) so a
position in the normalized text maps back to the original with `positions()`; that is how
snippets are cut from the ORIGINAL text with the match highlighted.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from app.core.database import connect, write

log = logging.getLogger("mizaj.search")

_DROP = (
    [*range(0x064B, 0x0660), 0x0670, 0x0640]  # harakat, dagger alef, tatweel
    + list(range(0x06D6, 0x06EE))  # Quranic annotation marks
    + [0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x061C, 0xFEFF]
)
_FOLD = {
    "أ": "ا",  # alef with hamza above -> alef
    "إ": "ا",  # alef with hamza below -> alef
    "آ": "ا",  # alef with madda -> alef
    "ٱ": "ا",  # alef wasla -> alef
    "ى": "ي",  # alef maqsura -> ya
    "ئ": "ي",  # hamza on ya -> ya
    "ی": "ي",  # Persian ya -> ya
    "ؤ": "و",  # hamza on waw -> waw
    "ة": "ه",  # ta marbuta -> ha
    "ک": "ك",  # Persian kaf -> kaf
}
_TABLE: dict[int, str | None] = {c: None for c in _DROP}
_TABLE.update({ord(k): v for k, v in _FOLD.items()})
_TABLE.update({0x0660 + i: str(i) for i in range(10)})  # Arabic-Indic digits
_TABLE.update({0x06F0 + i: str(i) for i in range(10)})  # Persian digits
_TABLE.update({c: chr(c + 32) for c in range(ord("A"), ord("Z") + 1)})

_DROP_SET = frozenset(chr(c) for c in _DROP)
_WORD = re.compile(r"\w+")
MAX_TOKENS = 8
CONTEXT = 48  # normalized characters of context on each side of a match


def normalize(text: str) -> str:
    return text.translate(_TABLE)


def positions(text: str) -> list[int]:
    """positions(text)[i] = index in `text` of normalized character i."""
    get = _TABLE.get
    return [i for i, c in enumerate(text) if get(ord(c), c) is not None]


# Arabic attaches articles, prepositions and conjunctions to the word (والمدرسة, بالكتاب, للمعلم),
# and FTS5 only matches word starts. So the index also holds every word WITHOUT such a prefix,
# and queries drop a leading «ال»: «مدرسة» then finds «المدرسة», «والمدرسة» and «للمدرسة».
_CLITICS = (
    "وبال", "فبال", "وكال", "ولل", "فلل", "وال", "فال", "بال", "كال", "لل", "ال",
    "و", "ف", "ب", "ل", "ك",
)  # fmt: skip
_CLITIC_RE = "(?:" + "|".join(_CLITICS) + ")"
_MIN_STEM = 3


def _stem(word: str) -> str | None:
    for c in _CLITICS:  # longest first
        if word.startswith(c) and len(word) - len(c) >= _MIN_STEM:
            return word[len(c) :]
    return None


def index_body(norm: str) -> str:
    """Normalized text + the prefix-less form of each word, for the FTS body column."""
    extra = {st for w in set(_WORD.findall(norm)) if (st := _stem(w))}
    return norm + "\n" + " ".join(sorted(extra)) if extra else norm


def tokens(query: str) -> list[str]:
    out = []
    for w in _WORD.findall(normalize(query))[:MAX_TOKENS]:
        if w.startswith("ال") and len(w) - 2 >= 2:
            w = w[2:]
        out.append(w)
    return out


def fts_query(toks: list[str]) -> str:
    """`"tok"*` for each token (prefix match: Arabic clitics و/ب/ال… attach to words)."""
    return " ".join(f'"{t}"*' for t in toks)


# ---------------------------------------------------------------- index maintenance
def index_document(db: sqlite3.Connection, did: int) -> None:
    """(Re)index one document. Call inside the same write transaction that changed it."""
    row = db.execute(
        "SELECT title, raw_content, is_deleted, updated_at FROM documents WHERE id=?", (did,)
    ).fetchone()
    db.execute("DELETE FROM document_search WHERE rowid=?", (did,))
    if row is None or row["is_deleted"]:
        db.execute("DELETE FROM document_search_meta WHERE document_id=?", (did,))
        return
    db.execute(
        "INSERT INTO document_search(rowid, title_norm, body_norm) VALUES (?,?,?)",
        (did, index_body(normalize(row["title"])), index_body(normalize(row["raw_content"]))),
    )
    db.execute(
        "INSERT INTO document_search_meta(document_id, src_updated_at) VALUES (?,?) "
        "ON CONFLICT(document_id) DO UPDATE SET src_updated_at=excluded.src_updated_at",
        (did, row["updated_at"]),
    )


def ensure_index(db_path: Path) -> int:
    """Startup: index documents that are missing/stale (e.g. created before migration 008) and
    drop rows of documents that are gone. Returns how many documents were (re)indexed."""
    conn = connect(db_path)
    done = 0
    try:
        stale = [
            r["id"]
            for r in conn.execute(
                "SELECT d.id FROM documents d LEFT JOIN document_search_meta m "
                "ON m.document_id=d.id WHERE d.is_deleted=0 "
                "AND (m.document_id IS NULL OR m.src_updated_at<>d.updated_at)"
            ).fetchall()
        ]
        orphans = [
            r["document_id"]
            for r in conn.execute(
                "SELECT m.document_id FROM document_search_meta m LEFT JOIN documents d "
                "ON d.id=m.document_id WHERE d.id IS NULL OR d.is_deleted=1"
            ).fetchall()
        ]
        for did in [*stale, *orphans]:
            with write(conn):
                index_document(conn, did)
            done += 1
    except sqlite3.Error:
        log.exception("could not refresh the search index")
    finally:
        conn.close()
    return done


# ---------------------------------------------------------------- snippets
@dataclass
class Snippet:
    offset: int  # of the first highlighted range, in editor units (UTF-16, CRLF = 1)
    text: str
    ranges: list[tuple[int, int]]  # highlighted [start, end) inside `text`

    def as_dict(self) -> dict:
        return {"offset": self.offset, "text": self.text, "ranges": [list(r) for r in self.ranges]}


def editor_offset(text: str, idx: int) -> int:
    """Offset of `text[idx]` as the editor counts it: UTF-16 units, "\\r\\n" is one break."""
    head = text[:idx]
    astral = sum(1 for c in head if ord(c) > 0xFFFF)
    return idx + astral - head.count("\r\n")


def orig_end(text: str, pos: list[int], b: int) -> int:
    """End (exclusive) in `text` of the match ending at normalized index `b`; the marks that
    follow its last letter belong to the highlighted word."""
    end = pos[b - 1] + 1
    while end < len(text) and text[end] in _DROP_SET:
        end += 1
    return end


def find_hits(norm: str, toks: list[str], cap: int = 200) -> list[tuple[int, int, int]]:
    """(start, end, token index) of word-start matches of every token, in text order."""
    out: list[tuple[int, int, int]] = []
    for ti, t in enumerate(toks):
        n = 0
        for m in re.finditer(r"(?<!\w)" + _CLITIC_RE + "?" + re.escape(t), norm):
            out.append((m.start(), m.end(), ti))
            n += 1
            if n >= cap:
                break
    out.sort()
    return out


def _collapse(piece: str, ranges: list[tuple[int, int]]) -> tuple[str, list[tuple[int, int]]]:
    """Whitespace runs (newlines, tabs) collapse to one space so an excerpt reads on one line."""
    out: list[str] = []
    remap: list[int] = []
    prev_space = False
    for c in piece:
        remap.append(len(out))
        if c.isspace():
            if not prev_space:
                out.append(" ")
            prev_space = True
        else:
            out.append(c)
            prev_space = False
    remap.append(len(out))
    return "".join(out), [(remap[a], remap[min(b, len(piece))]) for a, b in ranges]


def make_snippets(text: str, toks: list[str], max_snippets: int = 3) -> tuple[list[Snippet], int]:
    """Up to `max_snippets` highlighted excerpts of `text` and the number of matches found.
    Excerpts are cut from the ORIGINAL text (diacritics intact)."""
    if not toks or not text:
        return [], 0
    norm = normalize(text)
    pos = positions(text)
    hits = find_hits(norm, toks)
    out: list[Snippet] = []
    covered_to = -1
    for start, _end, _ti in hits:
        if start < covered_to:
            continue  # already inside the previous excerpt
        n_from, n_to = max(0, start - CONTEXT), min(len(norm), start + CONTEXT)
        s = pos[n_from]
        e = pos[n_to - 1] + 1
        while s > 0 and not text[s - 1].isspace() and s > pos[n_from] - 12:
            s -= 1
        while e < len(text) and not text[e].isspace() and e < pos[n_to - 1] + 13:
            e += 1
        ranges = [
            (pos[a] - s, orig_end(text, pos, b) - s)
            for a, b, _ in hits
            if a >= n_from and b <= n_to
        ]
        piece, ranges = _collapse(text[s:e], ranges)
        out.append(Snippet(editor_offset(text, pos[start]), piece, ranges))
        covered_to = n_to
        if len(out) >= max_snippets:
            break
    return out, len(hits)
