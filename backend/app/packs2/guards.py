"""Import guards: Quran text must never enter the user dictionary (AGENTS.md; slice 7.4.1)."""

from __future__ import annotations

from collections.abc import Callable

_override: Callable[[str], bool] | None = None
_CANDIDATES = ("is_quran_text", "matches_quran", "contains_ayah", "is_quranic")


def set_quran_checker(fn: Callable[[str], bool] | None) -> None:
    """Test/integration hook."""
    global _override
    _override = fn


def quran_checker() -> Callable[[str], bool] | None:
    """Callable(text)->bool or None when `app.quran` is not importable / exposes no matcher.

    Contract expected from app.quran: a module-level function named one of
    is_quran_text / matches_quran / contains_ayah / is_quranic taking a str."""
    if _override is not None:
        return _override
    try:
        import app.quran as q
    except Exception:  # noqa: BLE001
        return None
    for name in _CANDIDATES:
        fn = getattr(q, name, None)
        if callable(fn):
            return fn
    return None
