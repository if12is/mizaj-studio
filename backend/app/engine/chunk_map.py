"""ChunkMap: lossless reassembly of processed chunks into their original positions."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from app.engine.normalize import strip_marks
from app.engine.splitter import ArabicSentenceSplitter, Chunk


class ChunkMap:
    def __init__(self, source: str, chunks: Sequence[Chunk]) -> None:
        self.source = source
        self.chunks = list(chunks)
        pos = 0
        for c in self.chunks:
            if c.start != pos or source[c.start : c.end] != c.text:
                raise ValueError("chunks are not a contiguous cover of the source text")
            pos = c.end
        if pos != len(source):
            raise ValueError("chunks do not cover the whole source text")

    @classmethod
    def build(cls, source: str, splitter: ArabicSentenceSplitter | None = None) -> ChunkMap:
        return cls(source, (splitter or ArabicSentenceSplitter()).split(source))

    def assemble(self, outputs: Mapping[int, str] | Sequence[str]) -> str:
        """Join per-chunk outputs; a missing chunk falls back to its original text."""
        get = outputs.get if isinstance(outputs, Mapping) else None
        parts = []
        for c in self.chunks:
            if get is not None:
                out = get(c.index)
            else:
                out = outputs[c.index] if c.index < len(outputs) else None
            parts.append(c.text if out is None else out)
        return "".join(parts)

    def is_lossless(self, result: str) -> bool:
        """True if `result` equals the source once diacritics are stripped from both."""
        return strip_marks(result) == strip_marks(self.source)
