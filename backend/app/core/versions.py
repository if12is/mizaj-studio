"""Document edit history: compressed snapshots, coalescing, dedupe, word diff, retention."""

from __future__ import annotations

import hashlib
import re
import sqlite3
import zlib
from collections import Counter
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
from typing import Any

# Kinds: autosave (coalescable typing), event (named operation), checkpoint (user-named,
# never pruned), restore (a restore, itself undoable), initial (state before history began).
KINDS = ("autosave", "event", "checkpoint", "restore", "initial")
LABEL_MANUAL = "تعديل يدوي"
LABEL_INITIAL = "النسخة الأصلية"
LABEL_CHECKPOINT = "نقطة استرجاع"
LABEL_RESTORE = "استعادة نسخة"
LABEL_CREATED = "إنشاء المستند"
LABEL_IMPORT = "استيراد"

COALESCE_SECONDS = 30
DEFAULT_RETENTION_DAYS = 30
DEFAULT_RETENTION_KEEP = 500
SETTING_DAYS = "history_retention_days"
SETTING_KEEP = "history_retention_keep"
# Beyond this many word tokens per side the exact diff is replaced by a cheap multiset estimate.
EXACT_DIFF_MAX_WORDS = 20_000
# A localized edit is diffed exactly; a huge changed middle is reported coarsely instead.
DIFF_MAX_CELLS = 25_000_000

_TOKEN = re.compile(r"\s+|\S+")
_ARABIC_DIGITS = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")
_TS_FMT = "%Y-%m-%dT%H:%M:%S.%f"


def ar_num(n: int) -> str:
    return str(n).translate(_ARABIC_DIGITS)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def pack(text: str) -> bytes:
    return zlib.compress(text.encode("utf-8"), 6)


def unpack(blob: bytes) -> str:
    return zlib.decompress(blob).decode("utf-8")


def _fmt(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime(_TS_FMT)[:-3] + "Z"


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, _TS_FMT + "Z").replace(tzinfo=UTC)


def tokenize(text: str) -> list[str]:
    """Words and whitespace runs as separate tokens; ''.join(tokens) == text."""
    return _TOKEN.findall(text)


def _is_word(tok: str) -> bool:
    return not tok.isspace()


def _estimate(a_words: list[str], b_words: list[str]) -> list[dict[str, str]]:
    """Fallback for huge texts: multiset difference as one delete and one insert block."""
    ca, cb = Counter(a_words), Counter(b_words)
    gone, new = ca - cb, cb - ca
    ops: list[dict[str, str]] = []
    if gone:
        ops.append({"op": "delete", "text": " ".join(gone.elements())})
    if new:
        ops.append({"op": "insert", "text": " ".join(new.elements())})
    return ops


def diff_ops(old: str, new: str) -> list[dict[str, str]]:
    """Word-level diff as [{op: equal|insert|delete, text}], merged; old -> new.

    `delete` text is only in `old`, `insert` text only in `new`; concatenating the equal and
    delete ops (resp. equal and insert ops) reproduces `old` (resp. `new`) exactly, except for
    texts so large that the coarse estimate kicks in.
    """
    if old == new:
        return [{"op": "equal", "text": old}] if old else []
    a, b = tokenize(old), tokenize(new)
    pre = 0
    limit = min(len(a), len(b))
    while pre < limit and a[pre] == b[pre]:
        pre += 1
    suf = 0
    while suf < limit - pre and a[len(a) - 1 - suf] == b[len(b) - 1 - suf]:
        suf += 1
    am, bm = a[pre : len(a) - suf], b[pre : len(b) - suf]
    ops: list[dict[str, str]] = []

    def push(op: str, toks: list[str]) -> None:
        if not toks:
            return
        text = "".join(toks)
        if ops and ops[-1]["op"] == op:
            ops[-1]["text"] += text
        else:
            ops.append({"op": op, "text": text})

    push("equal", a[:pre])
    if len(am) * len(bm) > DIFF_MAX_CELLS or max(len(am), len(bm)) > 2 * EXACT_DIFF_MAX_WORDS:
        for o in _estimate([t for t in am if _is_word(t)], [t for t in bm if _is_word(t)]):
            push(o["op"], [o["text"]])
    else:
        sm = SequenceMatcher(None, am, bm, autojunk=False)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                push("equal", am[i1:i2])
            else:
                push("delete", am[i1:i2])
                push("insert", bm[j1:j2])
    push("equal", a[len(a) - suf :] if suf else [])
    return ops


def delta_stats(old: str, new: str) -> tuple[int, int]:
    """(words_added, words_removed) between two texts."""
    ops = diff_ops(old, new)
    added = sum(len(o["text"].split()) for o in ops if o["op"] == "insert")
    removed = sum(len(o["text"].split()) for o in ops if o["op"] == "delete")
    return added, removed


# --- settings / retention ------------------------------------------------------------------


def retention_settings(db: sqlite3.Connection) -> tuple[int, int]:
    """(days, keep_last) from the settings table, defaulting to 30 days + last 500."""
    vals = {
        r["key"]: r["value"]
        for r in db.execute(
            "SELECT key, value FROM settings WHERE key IN (?, ?)", (SETTING_DAYS, SETTING_KEEP)
        )
    }

    def num(key: str, default: int) -> int:
        v = vals.get(key, "")
        return int(v) if v.isascii() and v.isdigit() else default

    return num(SETTING_DAYS, DEFAULT_RETENTION_DAYS), num(SETTING_KEEP, DEFAULT_RETENTION_KEEP)


def apply_retention(db: sqlite3.Connection, document_id: int, now: datetime | None = None) -> int:
    """Delete versions that are older than `days` AND outside the newest `keep`.

    Named checkpoints (kind checkpoint, or any version carrying a name) are never deleted.
    Returns the number of deleted rows. Caller owns the transaction.
    """
    days, keep = retention_settings(db)
    cutoff = _fmt((now or datetime.now(UTC)) - timedelta(days=days))
    cur = db.execute(
        "DELETE FROM document_versions WHERE document_id=? AND kind != 'checkpoint' AND name='' "
        "AND created_at < ? AND id NOT IN ("
        "  SELECT id FROM document_versions WHERE document_id=? ORDER BY id DESC LIMIT ?)",
        (document_id, cutoff, document_id, keep),
    )
    return cur.rowcount


# --- recording -----------------------------------------------------------------------------


def _latest(db: sqlite3.Connection, document_id: int) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM document_versions WHERE document_id=? ORDER BY id DESC LIMIT 1",
        (document_id,),
    ).fetchone()


def _previous(db: sqlite3.Connection, document_id: int, before_id: int) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM document_versions WHERE document_id=? AND id<? ORDER BY id DESC LIMIT 1",
        (document_id, before_id),
    ).fetchone()


_DEFAULT_LABELS = {
    "autosave": LABEL_MANUAL,
    "checkpoint": LABEL_CHECKPOINT,
    "initial": LABEL_INITIAL,
}


def record_version(
    db: sqlite3.Connection,
    document_id: int,
    text: str,
    *,
    kind: str = "autosave",
    label: str | None = None,
    name: str = "",
    now: datetime | None = None,
) -> int | None:
    """Record a snapshot; returns its id, or None when it was a pure duplicate.

    - identical to the latest snapshot: nothing is added (a named event or checkpoint relabels
      an autosave entry, so «before tashkeel» is never lost behind a typing entry);
    - an autosave right after an autosave entry that started < 30s ago is merged into it;
    - old versions are pruned by the retention policy afterwards.
    Caller owns the transaction (use `write(db)`).
    """
    if kind not in KINDS:
        raise ValueError(f"bad kind {kind!r}")
    label = (label or "").strip() or _DEFAULT_LABELS.get(kind, LABEL_MANUAL)
    ts_dt = now or datetime.now(UTC)
    ts = _fmt(ts_dt)
    digest = _hash(text)
    last = _latest(db, document_id)

    if last is not None and last["content_hash"] == digest:
        if kind in ("event", "checkpoint") and last["kind"] == "autosave":
            db.execute(
                "UPDATE document_versions SET kind=?, label=?, name=?, updated_at=? WHERE id=?",
                (kind, label, name, ts, last["id"]),
            )
            return int(last["id"])
        if kind == "checkpoint" and last["kind"] != "checkpoint":
            keep = last["kind"] in ("event", "restore")  # their label says more than "checkpoint"
            db.execute(
                "UPDATE document_versions SET kind='checkpoint', name=?, label=?, updated_at=? "
                "WHERE id=?",
                (name, last["label"] if keep else label, ts, last["id"]),
            )
            return int(last["id"])
        return None

    chars, words = len(text), len(text.split())
    blob = pack(text)

    if (
        kind == "autosave"
        and last is not None
        and last["kind"] == "autosave"
        and (ts_dt - _parse(last["created_at"])).total_seconds() < COALESCE_SECONDS
    ):
        prev = _previous(db, document_id, last["id"])
        base = unpack(prev["content_z"]) if prev is not None else ""
        added, removed = delta_stats(base, text)
        db.execute(
            "UPDATE document_versions SET updated_at=?, content_hash=?, content_z=?, "
            "char_count=?, word_count=?, words_added=?, words_removed=?, chars_delta=? "
            "WHERE id=?",
            (ts, digest, blob, chars, words, added, removed, chars - len(base), last["id"]),
        )
        return int(last["id"])

    base = unpack(last["content_z"]) if last is not None else ""
    added, removed = delta_stats(base, text)
    cur = db.execute(
        "INSERT INTO document_versions(document_id, created_at, updated_at, kind, label, name, "
        "content_hash, content_z, char_count, word_count, words_added, words_removed, "
        "chars_delta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            document_id,
            ts,
            ts,
            kind,
            label,
            name,
            digest,
            blob,
            chars,
            words,
            added,
            removed,
            chars - len(base),
        ),
    )
    apply_retention(db, document_id, ts_dt)
    return int(cur.lastrowid)  # type: ignore[arg-type]


def ensure_baseline(db: sqlite3.Connection, document_id: int, text: str) -> None:
    """Before the first recorded change, keep the state the document had (if it had any)."""
    if text and _latest(db, document_id) is None:
        record_version(db, document_id, text, kind="initial")


def meta(row: sqlite3.Row) -> dict[str, Any]:
    return {k: row[k] for k in row.keys() if k not in ("content_z", "content_hash")}  # noqa: SIM118
