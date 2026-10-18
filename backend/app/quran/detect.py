"""Verse detection: normalized word n-gram index + maximal extension (one-word gap tolerated)."""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from pathlib import Path

from .store import installed_files

# Quranic text: letters, harakat, small high marks (06D6-06ED), dagger alef, wasla, tatweel
WORD_RE = re.compile("[ؐ-ؚء-ٰٟۖ-ۭـٱ]+")
_DROP = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭـ࣓-ࣿ]")
_MAP = str.maketrans(
    {"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ؤ": "و", "ئ": "ي", "ى": "ي", "ة": "ه"}
)
N_FULL = 4  # minimum consecutive words outside ﴿ ﴾
N_BRACKET = 2
OPEN, CLOSE = "﴿", "﴾"  # ﴿ and ﴾ (as they appear in either order in RTL text)
BRACKET_RE = re.compile("[﴾﴿](.{1,2000}?)[﴾﴿]", re.DOTALL)


def qkey(word: str) -> str:
    """Matching key: no marks/tatweel/small signs; hamza-seat, ya, ta-marbuta unified and alefs
    dropped (so Uthmani dagger-alef and Imlaei spellings such as العٰلمين / العالمين agree)."""
    return _DROP.sub("", word).translate(_MAP).replace("ا", "")


@dataclass(slots=True)
class Hit:
    start: int
    end: int
    sura: int
    aya: int
    first_word: int  # 0-based positions inside the verse
    last_word: int
    verse_words: int
    kind: str  # "verse" | "partial"
    bracketed: bool
    aya_end: int = 0

    def as_dict(self) -> dict:
        cov = (self.last_word - self.first_word + 1) / max(self.verse_words, 1)
        return {
            "start": self.start,
            "end": self.end,
            "sura": self.sura,
            "aya": self.aya,
            "aya_end": self.aya_end,
            "ref": f"{self.sura}:{self.aya}"
            + (f"-{self.aya_end}" if self.aya_end > self.aya else ""),
            "kind": self.kind,
            "bracketed": self.bracketed,
            "coverage": round(min(cov, 1.0), 2),
            "confidence": 0.99 if self.bracketed or self.kind == "verse" else 0.8,
            "needs_confirmation": self.kind == "partial" and not self.bracketed,
        }


class QuranIndex:
    def __init__(self) -> None:
        self.verses: list[tuple[int, int, list[str], int]] = []  # sura, aya, keys, aya_end
        self._count = 0
        self._seen: set[tuple[int, int, tuple[str, ...]]] = set()
        self.gram4: dict[tuple[str, ...], list[tuple[int, int]]] = {}
        self.gram2: dict[tuple[str, ...], list[tuple[int, int]]] = {}

    def add_file(self, path: Path) -> int:
        n = 0
        rows: list[tuple[int, int, list[str]]] = []
        for line in path.read_text(encoding="utf-8").lstrip("\ufeff").splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            parts = line.split("|", 2)
            if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
                continue
            keys = [k for k in (qkey(w) for w in WORD_RE.findall(parts[2])) if k]
            if not keys:
                continue
            ident = (int(parts[0]), int(parts[1]), tuple(keys))
            if ident in self._seen:  # uthmani and simple may normalize identically
                continue
            self._seen.add(ident)
            self._add(int(parts[0]), int(parts[1]), keys, int(parts[1]))
            rows.append((int(parts[0]), int(parts[1]), keys))
            n += 1
        # n-grams crossing a verse boundary (quoting two or more consecutive verses)
        for (s1, a1, k1), (s2, a2, k2) in zip(rows, rows[1:], strict=False):
            if s1 == s2 and a2 == a1 + 1:
                self._add(s1, a1, k1 + k2, a2, cross=len(k1))
        self._count += n
        return n

    def _add(self, sura, aya, keys, aya_end, cross=None):
        vid = len(self.verses)
        self.verses.append((sura, aya, keys, aya_end))
        for g, table in ((N_FULL, self.gram4), (N_BRACKET, self.gram2)):
            lo = 0 if cross is None else max(0, cross - g + 1)
            hi = len(keys) - g + 1 if cross is None else min(cross - 1, len(keys) - g) + 1
            for p in range(lo, hi):
                table.setdefault(tuple(keys[p : p + g]), []).append((vid, p))

    @property
    def verse_count(self) -> int:
        return self._count

    # ------------------------------------------------------------------ detection
    def detect(self, text: str, include_partial: bool = True) -> list[dict]:
        toks = []  # (start, end, key)
        for m in WORD_RE.finditer(text):
            k = qkey(m.group())
            if k:
                toks.append((m.start(), m.end(), k))
        if not toks:
            return []
        keys = [t[2] for t in toks]
        brackets = [(m.start(1), m.end(1)) for m in BRACKET_RE.finditer(text)]

        def in_bracket(i: int) -> bool:
            s, e = toks[i][0], toks[i][1]
            return any(bs <= s and e <= be for bs, be in brackets)

        hits: dict[tuple[int, int, int], tuple[int, int, int, int, bool]] = {}
        for i in range(len(keys)):
            for n, table in ((N_FULL, self.gram4), (N_BRACKET, self.gram2)):
                if i + n > len(keys):
                    continue
                br = in_bracket(i) and in_bracket(i + n - 1)
                if n == N_BRACKET and not br:
                    continue
                for vid, p in table.get(tuple(keys[i : i + n]), ()):
                    diag = (vid, i - p, 0)
                    if diag in hits and hits[diag][0] <= i <= hits[diag][1]:
                        continue
                    run = self._extend(keys, i, vid, p, n)
                    prev = hits.get(diag)
                    if prev is None or run[1] - run[0] > prev[1] - prev[0]:
                        hits[diag] = (*run, br or (prev[4] if prev else False))
                    elif br:
                        hits[diag] = (*prev[:4], True)
        out: list[Hit] = []
        for (vid, _off, _), (i0, i1, p0, p1, br) in hits.items():
            sura, aya, vkeys, aya_end = self.verses[vid]
            nwords = i1 - i0 + 1
            full = p0 == 0 and p1 == len(vkeys) - 1 or nwords >= 0.8 * len(vkeys)
            if not full and not include_partial and not br:
                continue
            if nwords < (N_BRACKET if br else N_FULL):
                continue
            out.append(
                Hit(
                    toks[i0][0],
                    toks[i1][1],
                    sura,
                    aya,
                    p0,
                    p1,
                    len(vkeys),
                    "verse" if full else "partial",
                    br,
                    aya_end,
                )
            )
        out.sort(key=lambda h: (h.start, -(h.end - h.start)))
        # keep the widest hit per span; list every ref that matches the same span
        merged: list[dict] = []
        for h in out:
            d = h.as_dict()
            for m in merged:
                if m["start"] == d["start"] and m["end"] == d["end"]:
                    m["alternatives"].append(d["ref"])
                    break
                if d["start"] >= m["start"] and d["end"] <= m["end"]:
                    break  # contained in a wider hit
            else:
                d["alternatives"] = []
                merged.append(d)
        return merged

    def _extend(self, keys, i, vid, p, n):
        """Grow a seed left/right; one mismatching word inside the run is tolerated."""
        vk = self.verses[vid][2]  # noqa
        i0, p0 = i, p
        i1, p1 = i + n - 1, p + n - 1
        while i0 > 0 and p0 > 0:
            if keys[i0 - 1] == vk[p0 - 1]:
                i0, p0 = i0 - 1, p0 - 1
            elif i0 > 1 and p0 > 1 and keys[i0 - 2] == vk[p0 - 2]:  # single substituted word
                i0, p0 = i0 - 2, p0 - 2
            else:
                break
        while i1 + 1 < len(keys) and p1 + 1 < len(vk):
            if keys[i1 + 1] == vk[p1 + 1]:
                i1, p1 = i1 + 1, p1 + 1
            elif i1 + 2 < len(keys) and p1 + 2 < len(vk) and keys[i1 + 2] == vk[p1 + 2]:
                i1, p1 = i1 + 2, p1 + 2
            else:
                break
        return i0, i1, p0, p1


_index: QuranIndex | None = None
_index_key: str | None = None
_last_dir: Path | None = None  # remembered so callers without a data dir can still ask
_lock = threading.Lock()


def get_index(data_dir: Path | None = None) -> QuranIndex | None:
    """Index built from the installed files; None when the text is not installed."""
    global _index, _index_key, _last_dir
    if data_dir is None:
        if _index is None and _last_dir is not None:
            return get_index(_last_dir)
        return _index
    _last_dir = data_dir
    files = installed_files(data_dir)
    if not files:
        return None
    key = "|".join(f"{p}:{p.stat().st_mtime_ns}" for p in files.values())
    with _lock:
        if _index is None or _index_key != key:
            idx = QuranIndex()
            for p in files.values():
                idx.add_file(p)
            _index, _index_key = idx, key
    return _index


def reset_index() -> None:
    global _index, _index_key, _last_dir
    _index = _index_key = _last_dir = None


def find_protected_spans(
    text: str, data_dir: Path | None = None, include_partial: bool = True
) -> list[tuple[int, int]]:
    """Code-point spans (start, end) of Quranic text in `text`. Empty when no text installed.

    `data_dir=None` reuses the index loaded by the last API/`get_index(data_dir)` call.
    """
    idx = get_index(data_dir) if data_dir is not None else _index
    if idx is None or not text:
        return []
    spans = sorted((d["start"], d["end"]) for d in idx.detect(text, include_partial))
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(e, merged[-1][1]))
        else:
            merged.append((s, e))
    return merged


def is_quran_text(text: str, data_dir: Path | None = None) -> bool:
    """True if `text` matches a verse or a substantial (>= 4 word) fragment of one.

    False when no Quran text is installed. Uses the data dir of the last API/index call when
    `data_dir` is omitted.
    """
    idx = get_index(data_dir)
    return bool(idx and text and idx.detect(text, include_partial=True))
