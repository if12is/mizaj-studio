"""7.9 spelling API: dictionary, common-error patterns and Arabic punctuation (suggestions only).

Nothing here ever modifies the user's text: every response is a list of issues with
suggested replacements the UI applies only after the user accepts them.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.core.database import connect, now_iso, write
from app.core.errors import MizajError, validation_error
from app.engine.executor import run_blocking
from app.spelling.engine import get_engine
from app.spelling.service import ALL_CHECKS, check_text
from app.spelling.text import strip_for_lookup

router = APIRouter(prefix="/api/spelling", tags=["spelling"])

IGNORE_KEY = "spelling_ignore"
MAX_WORD_LEN = 64


class CheckIn(BaseModel):
    text: str = Field(max_length=5_000_000)
    checks: list[Literal["dictionary", "patterns", "punctuation"]] | None = None
    max_issues: int = Field(default=1000, ge=1, le=10_000)


class SuggestIn(BaseModel):
    word: str
    limit: int = Field(default=5, ge=1, le=8)


class IgnoreIn(BaseModel):
    word: str


def _engine():
    try:
        return get_engine()
    except (FileNotFoundError, OSError) as exc:
        raise MizajError(
            "ERR_SPELL_DICT_MISSING",
            503,
            "قاموس التدقيق الإملائي غير متوفر.",
            "Spelling dictionary files are missing.",
            {"reason": str(exc)},
        ) from exc


def read_ignore(conn: sqlite3.Connection) -> list[str]:
    row = conn.execute("SELECT value FROM settings WHERE key=?", (IGNORE_KEY,)).fetchone()
    if row is None:
        return []
    try:
        data = json.loads(row["value"])
    except ValueError:
        return []
    return [w for w in data if isinstance(w, str)] if isinstance(data, list) else []


def _write_ignore(conn: sqlite3.Connection, words: list[str]) -> None:
    with write(conn):
        conn.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (IGNORE_KEY, json.dumps(sorted(set(words)), ensure_ascii=False), now_iso()),
        )


def personal_words(conn: sqlite3.Connection) -> set[str]:
    """Words the user locked in the personal dictionary (tashkeel_cache.is_user_locked)."""
    out: set[str] = set()
    for r in conn.execute("SELECT word_or_phrase FROM tashkeel_cache WHERE is_user_locked=1"):
        for part in (r["word_or_phrase"] or "").split():
            k = strip_for_lookup(part)
            if k:
                out.add(k)
    return out


def _normalize_word(word: str) -> str:
    k = strip_for_lookup(word.strip())
    if not k or len(k) > MAX_WORD_LEN or any(c.isspace() for c in k):
        raise validation_error("word must be a single non-empty word", {"word": word})
    return k


def _check(db_path: Path, body: CheckIn) -> dict:
    eng = _engine()
    conn = connect(db_path)
    try:
        ignored = {strip_for_lookup(w) for w in read_ignore(conn)}
        known = personal_words(conn)
    finally:
        conn.close()
    checks = tuple(body.checks) if body.checks is not None else ALL_CHECKS
    return check_text(body.text, eng, checks, body.max_issues, known, ignored)


def _ignore_op(db_path: Path, op: str, word: str | None) -> dict:
    conn = connect(db_path)
    try:
        words = read_ignore(conn)
        changed = False
        if op == "add" and word is not None and word not in words:
            words.append(word)
            _write_ignore(conn, words)
            changed = True
        elif op == "remove" and word is not None and word in words:
            words.remove(word)
            _write_ignore(conn, words)
            changed = True
        return {"words": sorted(set(words)), "changed": changed}
    finally:
        conn.close()


def _status() -> dict:
    try:
        info = get_engine().info
        return {
            "dictionary": {**info, "source": "ayaspell via LibreOffice dictionaries"},
            "ready": True,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "dictionary": {
                "name": "ayaspell Arabic (hunspell-ar)",
                "version": "3.5",
                "license": "GPL/LGPL/MPL tri-license",
            },
            "ready": False,
            "error": str(exc),
        }


@router.post("/check")
async def check(body: CheckIn, request: Request) -> dict:
    return await run_blocking(_check, request.app.state.db_path, body)


def _suggest(db_path: Path, body: SuggestIn) -> dict:
    eng = _engine()
    key = strip_for_lookup(body.word.strip())
    if not key or len(key) > MAX_WORD_LEN:
        raise validation_error("word must be a single non-empty word", {"word": body.word})
    conn = connect(db_path)
    try:
        known = personal_words(conn)
    finally:
        conn.close()
    return {"word": body.word, "suggestions": eng.suggest(key, body.limit, extra_valid=known)}


@router.post("/suggest")
async def suggest(body: SuggestIn, request: Request) -> dict:
    """Suggestions for one word (the UI calls this for issues returned without suggestions)."""
    return await run_blocking(_suggest, request.app.state.db_path, body)


@router.get("/ignore")
async def list_ignore(request: Request) -> dict:
    return await run_blocking(_ignore_op, request.app.state.db_path, "list", None)


@router.post("/ignore")
async def add_ignore(body: IgnoreIn, request: Request) -> dict:
    return await run_blocking(
        _ignore_op, request.app.state.db_path, "add", _normalize_word(body.word)
    )


@router.delete("/ignore/{word}")
async def remove_ignore(word: str, request: Request) -> dict:
    return await run_blocking(
        _ignore_op, request.app.state.db_path, "remove", _normalize_word(word)
    )


@router.get("/status")
async def status() -> dict:
    return await run_blocking(_status)
