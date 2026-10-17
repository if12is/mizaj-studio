"""ArabicSentenceSplitter: contiguous, lossless chunks of at most `max_chars` characters."""

from __future__ import annotations

from dataclasses import dataclass

MAX_CHARS = 256  # CATT context is 512 tokens incl. added marks and BOS/EOS
STRONG = ".؟!؟?;؛\n"  # sentence-ending punctuation and newline
WEAK = "،,"
_MARKS = "ًٌٍَُِّْٰ"


@dataclass(frozen=True)
class Chunk:
    index: int
    start: int
    end: int
    text: str


class ArabicSentenceSplitter:
    """Splits on sentence punctuation / newline first, then whitespace; never cuts a word
    (unless a single whitespace-free token is longer than `max_chars`). The concatenation of
    all chunks is exactly the input (separators are preserved, attached to the chunk end)."""

    def __init__(self, max_chars: int = MAX_CHARS, line_mode: bool = False) -> None:
        if max_chars < 8:
            raise ValueError("max_chars too small")
        self.max_chars = max_chars
        self.line_mode = line_mode  # poetry: never merge lines into one chunk
        self.min_fill = max_chars // 4

    def _break(self, text: str, pos: int) -> int:
        """Return exclusive end index of the chunk starting at `pos` (> pos)."""
        n = len(text)
        limit = min(pos + self.max_chars, n)
        if limit == n:
            return n

        def extend_ws(k: int) -> int:
            while k < limit and text[k].isspace():
                k += 1
            return k

        def last_after(chars: str, lo: int) -> int:
            for k in range(limit, lo, -1):  # k = candidate end; char k-1 is the boundary
                if text[k - 1] in chars:
                    return extend_ws(k)
            return -1

        lo = pos + self.min_fill
        for chars in (STRONG, WEAK):
            k = last_after(chars, lo)
            if k > 0:
                return k
        # whitespace: end after a whitespace char, or right before one
        for k in range(limit, pos, -1):
            if text[k - 1].isspace() or (k < n and text[k].isspace()):
                return extend_ws(k) if text[k - 1].isspace() else k
        # lone token longer than max_chars: hard cut, but never between a letter and its marks
        k = limit
        while k > pos + 1 and text[k] in _MARKS:
            k -= 1
        return k

    def split(self, text: str) -> list[Chunk]:
        if self.line_mode:
            return self._split_lines(text)
        return self._split_free(text, 0, len(text))

    def _split_lines(self, text: str) -> list[Chunk]:
        chunks: list[Chunk] = []
        pos = 0
        while pos < len(text):
            nl = text.find("\n", pos)
            end = len(text) if nl < 0 else nl + 1
            for c in self._split_free(text, pos, end):
                chunks.append(Chunk(len(chunks), c.start, c.end, c.text))
            pos = end
        return chunks

    def _split_free(self, text: str, lo: int, hi: int) -> list[Chunk]:
        chunks: list[Chunk] = []
        pos = lo
        while pos < hi:
            end = min(self._break(text, pos), hi) if hi < len(text) else self._break(text, pos)
            end = min(end, hi)
            chunks.append(Chunk(len(chunks), pos, end, text[pos:end]))
            pos = end
        return chunks
