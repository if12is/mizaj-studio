"""Compact pure-Python Hunspell affix engine for the ayaspell Arabic dictionary.

Why not `spylls`? It works (MPL-2.0, pure Python) but needs ~600 MB RSS and ~6 s to load the
465k-stem Arabic dictionary. This module implements only what ar.aff uses (PFX/SFX with
cross-product, one level of suffix continuation classes, AF flag aliases, ICONV/IGNORE) and
needs ~100 MB. It is validated against spylls in tests/dev scripts (see data/README.md).
"""

from __future__ import annotations

import gzip
import re
from dataclasses import dataclass
from pathlib import Path

IGNORE_CHARS = "ًٌٍَُِّْـٰ"  # ar.aff IGNORE: marks, tatweel, dagger alef
_IGNORE_RE = re.compile(f"[{IGNORE_CHARS}]")
MAX_CHAIN = 2
_COND_ITEM = re.compile(r"\[[^\]]*\]|.")


@dataclass(slots=True)
class Rule:
    flag: str
    cross: bool
    strip: str
    add: str
    cond: re.Pattern[str]
    cont: frozenset[str]
    klen: int  # number of characters the condition looks at
    trivial: bool  # condition is "." (always true)


def _sfx_ok(r: Rule, base: str) -> bool:
    if r.trivial:
        return True
    return len(base) >= r.klen and r.cond.fullmatch(base[len(base) - r.klen :]) is not None


def _pfx_ok(r: Rule, base: str) -> bool:
    if r.trivial:
        return True
    return len(base) >= r.klen and r.cond.fullmatch(base[: r.klen]) is not None


class HunspellLite:
    def __init__(self) -> None:
        self.af: list[frozenset[str]] = [frozenset()]  # AF alias table, 1-indexed
        self.iconv: dict[str, str] = {}
        self.pfx: dict[str, list[Rule]] = {}  # keyed by `add`
        self.sfx: dict[str, list[Rule]] = {}
        self.sfx_by_cont: dict[str, dict[str, list[Rule]]] = {}
        self.max_pfx = 0
        self.max_sfx = 0
        self.stems: dict[str, int | tuple[int, ...]] = {}
        self._cache: dict[str, bool] = {}

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, aff_path: Path, dic_path: Path) -> HunspellLite:
        h = cls()
        h._parse_aff(aff_path.read_text(encoding="utf-8"))
        opener = gzip.open if dic_path.suffix == ".gz" else open
        with opener(dic_path, "rt", encoding="utf-8") as fh:
            h._parse_dic(fh)
        return h

    def _flags(self, token: str) -> frozenset[str]:
        """Continuation/flag field: an AF alias number (this dictionary always uses aliases)."""
        if token.isdigit():
            return self.af[int(token)]
        return frozenset(token[i : i + 2] for i in range(0, len(token), 2))

    def _parse_aff(self, text: str) -> None:
        rules: list[tuple[str, list[str]]] = []
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            parts = line.split()
            kw = parts[0]
            if kw == "AF" and len(parts) == 2 and not parts[1].isdigit():
                f = parts[1]
                self.af.append(frozenset(f[i : i + 2] for i in range(0, len(f), 2)))
            elif kw == "ICONV" and len(parts) == 3:
                self.iconv[parts[1]] = parts[2]
            elif kw in ("PFX", "SFX"):
                rules.append((kw, parts))
        cross_by_flag: dict[tuple[str, str], bool] = {}
        for kw, parts in rules:
            if len(parts) == 4 and parts[3].isdigit():
                cross_by_flag[(kw, parts[1])] = parts[2] == "Y"
        for kw, parts in rules:
            if len(parts) == 4 and parts[3].isdigit():
                continue
            if len(parts) < 5:
                continue
            flag, strip, add, cond = parts[1], parts[2], parts[3], parts[4]
            cont: frozenset[str] = frozenset()
            if "/" in add:
                add, c = add.split("/", 1)
                cont = self._flags(c)
            strip = "" if strip == "0" else strip
            add = "" if add == "0" else add
            klen = len(_COND_ITEM.findall(cond))
            rule = Rule(
                flag,
                cross_by_flag.get((kw, flag), True),
                strip,
                add,
                re.compile(cond),
                cont,
                klen,
                cond == ".",
            )
            if kw == "SFX":
                self.sfx.setdefault(add, []).append(rule)
                for cf in cont:
                    self.sfx_by_cont.setdefault(cf, {}).setdefault(add, []).append(rule)
                self.max_sfx = max(self.max_sfx, len(add))
            else:
                self.pfx.setdefault(add, []).append(rule)
                self.max_pfx = max(self.max_pfx, len(add))

    def _parse_dic(self, fh) -> None:  # noqa: ANN001
        first = True
        stems = self.stems
        for line in fh:
            line = line.rstrip("\n")
            if first:
                first = False
                if line.strip().isdigit():
                    continue
            if not line or line.startswith("#"):
                continue
            if "/" in line:
                stem, fl = line.split("/", 1)
                idx = int(fl.split()[0]) if fl.split()[0].isdigit() else 0
            else:
                stem, idx = line.split()[0], 0
            stem = self.normalize(stem)
            cur = stems.get(stem)
            if cur is None:
                stems[stem] = idx
            elif isinstance(cur, int):
                if cur != idx:
                    stems[stem] = (cur, idx)
            elif idx not in cur:
                stems[stem] = (*cur, idx)

    # ------------------------------------------------------------------ lookup
    def normalize(self, word: str) -> str:
        word = _IGNORE_RE.sub("", word)
        if self.iconv:
            for a, b in self.iconv.items():
                if a in word:
                    word = word.replace(a, b)
        return word

    def _stem_flags(self, stem: str) -> list[frozenset[str]] | None:
        v = self.stems.get(stem)
        if v is None:
            return None
        if isinstance(v, int):
            return [self.af[v]]
        return [self.af[i] for i in v]

    def _prefix_options(self, word: str):
        yield word, None
        for n in range(1, min(self.max_pfx, len(word) - 1) + 1):
            for r in self.pfx.get(word[:n], ()):
                base = r.strip + word[n:]
                if base and _pfx_ok(r, base):
                    yield base, r

    def check(self, word: str) -> bool:
        """True when `word` is a valid form (marks/tatweel are ignored, as in ar.aff)."""
        hit = self._cache.get(word)
        if hit is not None:
            return hit
        w = self.normalize(word)
        ok = self._check(w)
        if len(self._cache) > 200_000:
            self._cache.clear()
        self._cache[word] = ok
        return ok

    def _flags_ok(self, stem: str, p: Rule | None, chain: tuple[Rule, ...]) -> bool:
        sets = self._stem_flags(stem)
        if not sets:
            return False
        if p is not None and chain and not (p.cross and chain[-1].cross):
            return False
        for fl in sets:
            if p is not None and p.flag not in fl and not any(p.flag in r.cont for r in chain):
                continue
            if chain and chain[-1].flag not in fl:
                continue
            return True
        return False

    def _check(self, w: str) -> bool:
        if not w:
            return False
        stems = self.stems
        if w in stems:
            return True
        sfx, by_cont, max_sfx = self.sfx, self.sfx_by_cont, self.max_sfx
        for w1, p in self._prefix_options(w):
            ln = len(w1)
            for n in range(0, min(max_sfx, ln - 1) + 1):
                add = w1[ln - n :] if n else ""
                for r in sfx.get(add, ()):
                    base = w1[: ln - n] + r.strip
                    if not base or not _sfx_ok(r, base):
                        continue
                    if base in stems and self._flags_ok(base, p, (r,)):
                        return True
                    inner = by_cont.get(r.flag)
                    if not inner:
                        continue
                    lb = len(base)
                    for n2 in range(0, min(max_sfx, lb - 1) + 1):
                        add2 = base[lb - n2 :] if n2 else ""
                        for r2 in inner.get(add2, ()):
                            b2 = base[: lb - n2] + r2.strip
                            if b2 in stems and _sfx_ok(r2, b2) and self._flags_ok(b2, p, (r, r2)):
                                return True
            if p is not None and w1 in stems and self._flags_ok(w1, p, ()):
                return True
        return False

    @property
    def stem_count(self) -> int:
        return len(self.stems)
