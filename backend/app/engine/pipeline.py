"""Tashkeel pipeline.

Per chunk: lock -> cache / engine (+ confidence) -> optional morph filter -> optional i'rab
rules -> proper-noun dictionary -> level -> user dictionary -> user-typed marks -> restore
protected spans. The base letters are never changed (checked at the end of every chunk).
"""

from __future__ import annotations

import logging
import re
import sqlite3
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field

from app.engine import irab_rules, legal_fix
from app.engine.base import Engine
from app.engine.cache import TashkeelCache
from app.engine.chunk_map import ChunkMap
from app.engine.morph_filter import MorphFilter
from app.engine.normalize import (
    MARKS,
    WORD_RE,
    apply_engine_marks,
    engine_letters,
    has_arabic_letters,
    join_pairs,
    reduce_level,
    split_pairs,
    strip_marks,
)
from app.engine.partial_lock import PartialDiacritizationLock
from app.engine.splitter import ArabicSentenceSplitter, Chunk
from app.legal.glossary import GlossaryIndex, override_word

log = logging.getLogger("mizaj.pipeline")
Conf = tuple[float, float] | None  # (word confidence, case-ending confidence)
Span = tuple[int, int]
CONF_SEP = "\x1e"


_DOUBLE_FATHATAN = re.compile("\u064b([\u0651\u064e\u0652]*)(\u0627[\u0651]*\u064b)")


@dataclass
class ChunkResult:
    text: str
    cached: bool
    words: int
    # per Arabic word, positions in `text` (code points): (start, end, confidence, irab_confidence)
    word_conf: list[tuple[int, int, float | None, float | None]] = field(default_factory=list)
    irab_changes: int = 0


def pack_raw(raw: str, confs: list[Conf]) -> str:
    """Cache payload: engine text, then (optionally) per-word confidences."""
    if not any(confs):
        return raw
    parts = ["" if c is None else f"{c[0]:.3f},{c[1]:.3f}" for c in confs]
    return raw + CONF_SEP + ";".join(parts)


def unpack_raw(payload: str, n_words: int) -> tuple[str, list[Conf]]:
    raw, sep, rest = payload.partition(CONF_SEP)
    if not sep:
        return raw, [None] * n_words
    confs: list[Conf] = []
    for part in rest.split(";"):
        if part:
            a, b = part.split(",")
            confs.append((float(a), float(b)))
        else:
            confs.append(None)
    if len(confs) != n_words:
        return raw, [None] * n_words
    return raw, confs


def local_spans(spans: list[Span], start: int, end: int) -> list[Span]:
    """Protected spans clipped to [start, end) and shifted to chunk coordinates."""
    return [(max(s, start) - start, min(e, end) - start) for s, e in spans if s < end and e > start]


def neighbour_context(cmap: ChunkMap, i: int, words: int = 4) -> tuple[str, str]:
    """Stripped last words of chunk i-1 and first words of chunk i+1 (with their separators)."""
    left = right = ""
    if i > 0:
        t = strip_marks(cmap.chunks[i - 1].text)
        left = "".join(re.split(r"(?<=\s)", t)[-words:]) if t.strip() else ""
    if i + 1 < len(cmap.chunks):
        t = strip_marks(cmap.chunks[i + 1].text)
        right = "".join(re.split(r"(?<=\s)", t)[:words])
    return left, right


class TashkeelPipeline:
    def __init__(
        self,
        engine: Engine,
        level: str = "full",
        keep_existing: bool = True,
        morph: MorphFilter | None = None,
        ambiguity: Callable[[str], bool] | None = None,
        use_cache: bool = True,
        splitter: ArabicSentenceSplitter | None = None,
        passive: Callable[[str, str], bool] | None = None,
        glossary_loader: Callable[[sqlite3.Connection], GlossaryIndex] | None = None,
        names_loader: Callable[[sqlite3.Connection], GlossaryIndex] | None = None,
        irab_noun: Callable[[str], bool] | None = None,
        irab_rules_on: bool = False,
        conf_threshold: float = 0.9,
        irab_threshold: float = 0.75,
        minimal_words: frozenset[str] = frozenset(),
        protector: Callable[[str], list[Span]] | None = None,
        fixes_on: bool = False,
        fix_oracle=None,
    ) -> None:
        self.engine = engine
        self.level = level
        self.keep_existing = keep_existing
        self.morph = morph
        self.ambiguity = ambiguity
        self.use_cache = use_cache
        self.passive = passive
        self.glossary_loader = glossary_loader
        self.names_loader = names_loader
        self.irab_noun = irab_noun
        self.irab_rules_on = irab_rules_on
        self.conf_threshold = conf_threshold
        self.irab_threshold = irab_threshold
        self.minimal_words = minimal_words
        self.protector = protector
        self.fixes_on = fixes_on
        self.fix_oracle = fix_oracle
        self._glossary: GlossaryIndex | None = None
        self._names: GlossaryIndex | None = None
        self.splitter = splitter or ArabicSentenceSplitter()
        tag = engine.cache_tag
        if morph is not None:
            tag += "+mf2" if getattr(morph, "version", 1) == 2 else "+mf"
        self.cache_tag = tag

    # ---- single chunk (runs in the engine executor; never on the event loop) ----
    def process_chunk(
        self,
        conn: sqlite3.Connection,
        chunk_text: str,
        protected: list[Span] | None = None,
        left: str = "",
        right: str = "",
    ) -> ChunkResult:
        """`left` / `right`: stripped words of the neighbouring chunks (context for the grammar
        rules only; the chunk cache and the returned text never include them)."""
        if self.keep_existing:
            stripped, lock = PartialDiacritizationLock.capture(chunk_text)
        else:
            stripped, lock = strip_marks(chunk_text), PartialDiacritizationLock()
        spans = [m for m in WORD_RE.finditer(stripped) if has_arabic_letters(m.group(0))]
        if not spans:
            return ChunkResult(chunk_text, True, 0)

        cache = TashkeelCache(conn)
        payload = cache.get_chunk(self.cache_tag, stripped) if self.use_cache else None
        cached = payload is not None
        if payload is not None:
            raw, confs = unpack_raw(payload, len(spans))
        else:
            raw, confs = self._run_engine(cache, stripped, spans)
            if self.use_cache:
                cache.put_chunk(self.cache_tag, stripped, pack_raw(raw, confs))

        irab_changes = 0
        if self.irab_rules_on:
            raw, irab_changes = self._irab(raw, spans, confs)
        raw = self._apply_names(raw, spans, conn)
        if self.fixes_on:  # grammar + legal-lexicon corrections (legal_fix.py)
            raw, _ = legal_fix.apply_fixes(stripped, spans, raw, self.fix_oracle, left, right)
        out = self._apply_level(raw, spans, conn, confs)
        out = self._apply_dictionary(cache, out, stripped, spans)
        out = lock.apply(out)
        # the user's own «اً» plus the engine's «قًا» would read «وَفْقًاً»: keep the user's
        out = _DOUBLE_FATHATAN.sub(r"\1\2", out)
        if protected:
            out = self._restore_protected(out, chunk_text, protected)
        if strip_marks(out) != strip_marks(chunk_text):  # safety net: never alter base text
            log.error("pipeline produced altered base text; returning chunk unchanged")
            return ChunkResult(chunk_text, cached, len(spans))
        return ChunkResult(
            out, cached, len(spans), self._word_conf(out, spans, confs), irab_changes
        )

    # ---- confidence ----
    @staticmethod
    def _word_conf(
        out: str, spans, confs: list[Conf]
    ) -> list[tuple[int, int, float | None, float | None]]:
        out_spans = [m for m in WORD_RE.finditer(out) if has_arabic_letters(m.group(0))]
        if len(out_spans) != len(spans):
            return []
        res = []
        for m, c in zip(out_spans, confs, strict=True):
            res.append(
                (m.start(), m.end(), None if c is None else c[0], None if c is None else c[1])
            )
        return res

    # ---- protected spans (Quran etc.): byte-identical, no marks added or removed ----
    @staticmethod
    def _restore_protected(out: str, original: str, protected: list[Span]) -> str:
        orig_pairs = split_pairs(original, canon=False)
        out_pairs = split_pairs(out, canon=False)
        if len(orig_pairs) != len(out_pairs):
            return out
        # original char index -> pair index
        pair_of, k = [], -1
        for ch in original:
            if ch not in MARKS or k < 0:
                k += 1
            pair_of.append(max(k, 0))
        for s, e in protected:
            s, e = max(0, s), min(len(original), e)
            if s >= e:
                continue
            i, j = pair_of[s], pair_of[e - 1]
            out_pairs[i : j + 1] = orig_pairs[i : j + 1]
        return join_pairs(out_pairs)

    # ---- optional i'rab post-rules (7.1.6) ----
    def _irab(self, raw: str, spans, confs: list[Conf]) -> tuple[str, int]:
        words = [m.group(0) for m in spans]
        irab_conf = [None if c is None else c[1] for c in confs]
        targets = irab_rules.plan(words, irab_conf, self.irab_noun, self.irab_threshold)
        if not targets:
            return raw, 0
        pairs = split_pairs(raw, canon=False)
        changed = 0
        for j, case in targets.items():
            m = spans[j]
            fixed = irab_rules.set_case(pairs[m.start() : m.end()], case)
            if fixed is not None:
                pairs[m.start() : m.end()] = fixed
                changed += 1
        return join_pairs(pairs), changed

    # ---- proper nouns (7.4.3) ----
    def _apply_names(self, raw: str, spans, conn: sqlite3.Connection) -> str:
        if self.names_loader is None:
            return raw
        if self._names is None:
            self._names = self.names_loader(conn)
        words = [m.group(0) for m in spans]
        matches = self._names.match(words)
        if not matches:
            return raw
        pairs = split_pairs(raw, canon=False)
        for i, (gpairs, shift, skip) in matches.items():
            m = spans[i]
            pairs[m.start() : m.end()] = override_word(
                pairs[m.start() : m.end()], gpairs, shift, skip, keep_final=True
            )
        return join_pairs(pairs)

    def _legal(self, raw: str, spans, conn: sqlite3.Connection) -> str:
        """`legal` level: marks only where they disambiguate.

        Kept: (1) glossary terms (internal vowels + shadda from the glossary), (2) words the
        ambiguity oracle flags (the whole word keeps the engine's marks, incl. case ending),
        (3) passive-voice verbs, (4) shadda and tanween everywhere. Everything else is bare."""
        if self.ambiguity is None:
            raise RuntimeError("level 'legal' needs an ambiguity oracle")
        if self._glossary is None and self.glossary_loader is not None:
            self._glossary = self.glossary_loader(conn)
        words = [m.group(0) for m in spans]
        matches = self._glossary.match(words) if self._glossary is not None else {}
        pairs = split_pairs(raw, canon=False)
        for i, m in enumerate(spans):
            seg = pairs[m.start() : m.end()]
            if i in matches:
                gpairs, shift, skip = matches[i]
                seg = override_word(seg, gpairs, shift, skip)
            else:
                eng = engine_letters(words[i])[0]
                keep = self.ambiguity(eng) or (
                    self.passive is not None and self.passive(eng, join_pairs(seg))
                )
                if not keep:
                    seg = [(b, "".join(c for c in mk if c == "\u0651" or c in "\u064b\u064c\u064d"))
                           for b, mk in seg]  # fmt: skip
            pairs[m.start() : m.end()] = seg
        return join_pairs(pairs)

    def keep_in_minimal(self, bare: str, diacritized: str, conf: Conf) -> bool:
        """Context-aware `minimal` (7.1.5): a word keeps its marks when it is lexically
        ambiguous, the engine is unsure of it, it is a passive-voice verb, or it is on the small
        always-diacritize list."""
        if self.ambiguity is not None and self.ambiguity(bare):
            return True
        if conf is not None and conf[0] < self.conf_threshold:
            return True
        if self.passive is not None and self.passive(bare, diacritized):
            return True
        return strip_marks(bare) in self.minimal_words

    def _apply_level(self, raw: str, spans, conn: sqlite3.Connection, confs: list[Conf]) -> str:
        if self.level == "legal":
            return self._legal(raw, spans, conn)
        if self.level != "minimal":
            return reduce_level(raw, self.level)
        if self.ambiguity is None:
            raise RuntimeError("level 'minimal' needs an ambiguity oracle")
        pairs = split_pairs(raw, canon=False)
        for i, m in enumerate(spans):
            bare = engine_letters(m.group(0))[0]
            seg = pairs[m.start() : m.end()]
            if not self.keep_in_minimal(
                bare, join_pairs(seg), confs[i] if i < len(confs) else None
            ):
                pairs[m.start() : m.end()] = [(b, "") for b, _ in seg]
        return join_pairs(pairs)

    def _run_engine(self, cache: TashkeelCache, stripped: str, spans) -> tuple[str, list[Conf]]:
        words = [m.group(0) for m in spans]
        eng_words = [engine_letters(w)[0] for w in words]
        usable = [i for i, e in enumerate(eng_words) if e]
        outs, uconfs = self.engine.diacritize_scored(
            [eng_words[i] for i in usable], cache.any_words
        )
        if self.morph is not None:
            outs = self.morph.refine([eng_words[i] for i in usable], outs, uconfs)
        by_index = dict(zip(usable, outs, strict=True))
        confs: list[Conf] = [None] * len(spans)
        for i, c in zip(usable, uconfs, strict=True):
            confs[i] = c
        parts, pos = [], 0
        for i, m in enumerate(spans):
            parts.append(stripped[pos : m.start()])
            w = m.group(0)
            fixed = apply_engine_marks(w, by_index[i]) if i in by_index else None
            parts.append(fixed if fixed is not None else w)
            pos = m.end()
        parts.append(stripped[pos:])
        return "".join(parts), confs

    def _apply_dictionary(self, cache: TashkeelCache, text: str, stripped: str, spans) -> str:
        """User-locked dictionary words always win over engine output (any level)."""
        locked = cache.locked_words(m.group(0) for m in spans)
        if not locked:
            return text
        pairs = split_pairs(text, canon=False)
        if len(pairs) != len(stripped):
            return text
        used: Counter[str] = Counter()
        for m in spans:
            w = m.group(0)
            form = locked.get(w)
            if form is None or strip_marks(form) != w:
                continue
            pairs[m.start() : m.end()] = split_pairs(form, canon=False)
            used[w] += 1
        cache.bump_words(used)
        return join_pairs(pairs)

    # ---- whole text (non-streaming) ----
    def protected_spans(self, text: str) -> list[Span]:
        if self.protector is None:
            return []
        try:
            return [(int(s), int(e)) for s, e in self.protector(text)]
        except Exception:  # a broken protector must never break diacritization
            log.exception("protector failed; continuing without protected spans")
            return []

    def run_text(self, conn: sqlite3.Connection, text: str) -> str:
        return self.run_text_ex(conn, text)[0]

    def run_text_ex(
        self, conn: sqlite3.Connection, text: str
    ) -> tuple[str, list[tuple[int, int, float | None, float | None]]]:
        """(output text, per-word confidences with offsets in the OUTPUT text)."""
        cmap = ChunkMap.build(text, self.splitter)
        prot = self.protected_spans(text)
        outputs: dict[int, str] = {}
        words: list[tuple[int, int, float | None, float | None]] = []
        offset = 0
        for c in cmap.chunks:
            res = self.process_chunk(
                conn, c.text, local_spans(prot, c.start, c.end), *neighbour_context(cmap, c.index)
            )
            outputs[c.index] = res.text
            words.extend((s + offset, e + offset, wc, ic) for s, e, wc, ic in res.word_conf)
            offset += len(res.text)
        result = cmap.assemble(outputs)
        if not cmap.is_lossless(result):
            raise RuntimeError("lossless reassembly check failed")
        return result, words


__all__ = ["Chunk", "ChunkResult", "TashkeelPipeline", "local_spans"]
