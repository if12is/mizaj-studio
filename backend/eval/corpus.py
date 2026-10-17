"""Gold / external corpus loaders."""

from __future__ import annotations

from pathlib import Path

from app.engine.normalize import MARKS, WORD_RE, has_arabic_letters

GOLD_DIR = Path(__file__).resolve().parent / "gold"
TATWEEL = "ـ"


def _lines(path: Path) -> list[str]:
    out = []
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


def load_gold(path: Path | None = None) -> list[tuple[str, str]]:
    """(category, sentence) for the committed gold set (one sentence per line, file = category)."""
    root = Path(path) if path else GOLD_DIR
    files = [root] if root.is_file() else sorted(root.glob("*.txt"))
    return [(f.stem, line) for f in files for line in _lines(f)]


def diacritized_ratio(line: str) -> float:
    """Share of Arabic words carrying at least one diacritic."""
    ws = [m.group(0) for m in WORD_RE.finditer(line) if has_arabic_letters(m.group(0))]
    return sum(any(c in MARKS for c in w) for w in ws) / len(ws) if ws else 0.0


def load_corpus(
    path: Path, max_lines: int | None = None, min_ratio: float = 0.8
) -> list[tuple[str, str]]:
    """External corpus in Tashkeela / Fadel format (UTF-8 text, one fully diacritized line or
    paragraph per line; directories are read recursively). Lines that are mostly undiacritized
    are skipped; tatweel is removed. The corpus itself is never committed."""
    p = Path(path)
    files = [p] if p.is_file() else sorted(p.rglob("*.txt"))
    out: list[tuple[str, str]] = []
    for f in files:
        for raw in f.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            line = raw.replace(TATWEEL, "").strip()
            if len(line) < 10 or not has_arabic_letters(line):
                continue
            if diacritized_ratio(line) < min_ratio:
                continue
            out.append((f.stem, line))
            if max_lines and len(out) >= max_lines:
                return out
    return out
