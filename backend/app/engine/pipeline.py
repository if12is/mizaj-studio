"""Tashkeel pipeline: lock -> split -> per-chunk cache/engine -> filter -> reapply lock."""

from __future__ import annotations

import logging
import sqlite3
from collections import Counter
from dataclasses import dataclass

from app.engine.base import Engine
from app.engine.cache import TashkeelCache
from app.engine.chunk_map import ChunkMap
from app.engine.morph_filter import MorphFilter
from app.engine.normalize import (
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

log = logging.getLogger("mizaj.pipeline")


@dataclass
class ChunkResult:
    text: str
    cached: bool
    words: int


class TashkeelPipeline:
    def __init__(
        self,
        engine: Engine,
        level: str = "full",
        keep_existing: bool = True,
        morph: MorphFilter | None = None,
        splitter: ArabicSentenceSplitter | None = None,
    ) -> None:
        self.engine = engine
        self.level = level
        self.keep_existing = keep_existing
        self.morph = morph
        self.splitter = splitter or ArabicSentenceSplitter()
        self.cache_tag = engine.cache_tag + ("+mf" if morph is not None else "")

    # ---- single chunk (runs in the engine executor; never on the event loop) ----
    def process_chunk(self, conn: sqlite3.Connection, chunk_text: str) -> ChunkResult:
        if self.keep_existing:
            stripped, lock = PartialDiacritizationLock.capture(chunk_text)
        else:
            stripped, lock = strip_marks(chunk_text), PartialDiacritizationLock()
        spans = [m for m in WORD_RE.finditer(stripped) if has_arabic_letters(m.group(0))]
        if not spans:
            return ChunkResult(chunk_text, True, 0)

        cache = TashkeelCache(conn)
        raw = cache.get_chunk(self.cache_tag, stripped)
        cached = raw is not None
        if raw is None:
            raw = self._run_engine(cache, stripped, spans)
            cache.put_chunk(self.cache_tag, stripped, raw)

        out = reduce_level(raw, self.level)
        out = self._apply_dictionary(cache, out, stripped, spans)
        out = lock.apply(out)
        if strip_marks(out) != strip_marks(chunk_text):  # safety net: never alter base text
            log.error("pipeline produced altered base text; returning chunk unchanged")
            return ChunkResult(chunk_text, cached, len(spans))
        return ChunkResult(out, cached, len(spans))

    def _run_engine(self, cache: TashkeelCache, stripped: str, spans) -> str:
        words = [m.group(0) for m in spans]
        eng_words = [engine_letters(w)[0] for w in words]
        usable = [i for i, e in enumerate(eng_words) if e]
        outs = self.engine.diacritize([eng_words[i] for i in usable], cache.any_words)
        if self.morph is not None:
            outs = self.morph.refine([eng_words[i] for i in usable], outs)
        by_index = dict(zip(usable, outs, strict=True))
        parts, pos = [], 0
        for i, m in enumerate(spans):
            parts.append(stripped[pos : m.start()])
            w = m.group(0)
            fixed = apply_engine_marks(w, by_index[i]) if i in by_index else None
            parts.append(fixed if fixed is not None else w)
            pos = m.end()
        parts.append(stripped[pos:])
        return "".join(parts)

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
            # keep indices stable: replacement has the same number of base letters
        cache.bump_words(used)
        return join_pairs(pairs)

    # ---- whole text (non-streaming) ----
    def run_text(self, conn: sqlite3.Connection, text: str) -> str:
        cmap = ChunkMap.build(text, self.splitter)
        outputs = {c.index: self.process_chunk(conn, c.text).text for c in cmap.chunks}
        result = cmap.assemble(outputs)
        if not cmap.is_lossless(result):
            raise RuntimeError("lossless reassembly check failed")
        return result


__all__ = ["Chunk", "ChunkResult", "TashkeelPipeline"]
