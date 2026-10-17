"""Optional adapter for the `libtashkeel` Rust bindings.

`libtashkeel` is not available on PyPI as of Phase 2; this adapter is only used if
`import libtashkeel` succeeds, otherwise fast mode falls back to mishkal.
"""

from __future__ import annotations

from app.engine.base import Engine, Lookup


class LibtashkeelEngine(Engine):
    name = "libtashkeel"
    cache_tag = "libtashkeel"

    def __init__(self) -> None:
        import libtashkeel  # noqa: F401  (ImportError => caller falls back)

        fn = getattr(libtashkeel, "do_tashkeel", None) or getattr(libtashkeel, "tashkeel", None)
        if fn is None:
            raise ImportError("libtashkeel has no known entry point")
        self._fn = fn

    def diacritize(self, words: list[str], lookup: Lookup | None = None) -> list[str]:
        out = str(self._fn(" ".join(words))).split()
        if len(out) != len(words):
            out = [(str(self._fn(w)).split() or [w])[0] for w in words]
        return out

    def suggestions(self, word: str) -> list[dict[str, str]]:
        return [{"diacritized": self.diacritize([word])[0], "pos": "غير محدد"}]

    def is_ambiguous(self, word: str) -> bool:
        raise NotImplementedError("use the mishkal oracle")
