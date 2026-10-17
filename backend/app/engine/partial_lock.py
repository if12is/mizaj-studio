"""PartialDiacritizationLock: keep diacritics the user typed themselves."""

from __future__ import annotations

from app.engine.normalize import split_pairs, strip_marks


class PartialDiacritizationLock:
    """Records user-placed marks per base-letter index and re-applies them after the engine.

    Index = position of the base character in the *stripped* text (marks removed).
    """

    def __init__(self, locks: dict[int, str] | None = None) -> None:
        self.locks: dict[int, str] = locks or {}

    @classmethod
    def capture(cls, text: str) -> tuple[str, PartialDiacritizationLock]:
        locks: dict[int, str] = {}
        for i, (_, marks) in enumerate(split_pairs(text, canon=False)):
            if marks:
                locks[i] = marks
        return strip_marks(text), cls(locks)

    def __len__(self) -> int:
        return len(self.locks)

    def apply(self, text: str, base_offset: int = 0) -> str:
        """Replace engine marks at locked positions with the user's marks."""
        if not self.locks:
            return text
        out: list[str] = []
        for i, (base, marks) in enumerate(split_pairs(text, canon=False)):
            locked = self.locks.get(base_offset + i)
            out.append(base + (locked if locked is not None else marks))
        return "".join(out)
