"""Learning from user corrections (Task 7.1.7).

The editor reports every edit the user makes to an engine-produced word. Repeated identical
corrections become a *suggestion* ("add to my dictionary?"). Nothing is ever locked
automatically: the dictionary entry is created only by an explicit accept call.
"""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from app.api.deps import get_db
from app.api.dictionary import _upsert
from app.core.database import now_iso, write
from app.core.errors import duplicate_word, not_found, validation_error
from app.engine.normalize import strip_marks

router = APIRouter(prefix="/api/corrections", tags=["corrections"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]
DEFAULT_SUGGEST_AFTER = 2


class CorrectionIn(BaseModel):
    word: str | None = Field(default=None, max_length=200)  # bare word; derived when omitted
    engine_form: str = Field(min_length=1, max_length=200)
    user_form: str = Field(min_length=1, max_length=200)


def suggest_after(db: sqlite3.Connection, override: int | None = None) -> int:
    if override is not None:
        return max(1, override)
    row = db.execute("SELECT value FROM settings WHERE key='corrections_suggest_after'").fetchone()
    try:
        return max(1, int(row["value"])) if row else DEFAULT_SUGGEST_AFTER
    except (TypeError, ValueError):
        return DEFAULT_SUGGEST_AFTER


def _row(r: sqlite3.Row, after: int, locked: dict[str, str]) -> dict[str, Any]:
    in_dict = locked.get(r["word"]) == r["user_form"]
    return {
        "id": r["id"], "word": r["word"], "engine_form": r["engine_form"],
        "user_form": r["user_form"], "count": r["count"], "dismissed": bool(r["dismissed"]),
        "in_dictionary": in_dict, "last_at": r["last_at"],
        "suggest": r["count"] >= after and not r["dismissed"] and not in_dict,
    }  # fmt: skip


def _locked(db: sqlite3.Connection) -> dict[str, str]:
    rows = db.execute(
        "SELECT word_or_phrase, diacritized_form FROM tashkeel_cache WHERE is_user_locked=1"
    ).fetchall()
    return {r["word_or_phrase"]: r["diacritized_form"] for r in rows}


@router.post("", status_code=201)
def record(body: CorrectionIn, db: Db) -> dict[str, Any]:
    bare = strip_marks(body.user_form).strip()
    if strip_marks(body.engine_form).strip() != bare or (
        body.word and strip_marks(body.word).strip() != bare
    ):
        raise validation_error("a correction may only change marks, never the letters")
    if body.engine_form == body.user_form:
        raise validation_error("engine_form and user_form are identical")
    ts = now_iso()
    with write(db):
        db.execute(
            "INSERT INTO corrections(word, engine_form, user_form, count, last_at, created_at) "
            "VALUES (?,?,?,1,?,?) ON CONFLICT(word, user_form) DO UPDATE SET "
            "count=count+1, engine_form=excluded.engine_form, last_at=excluded.last_at",
            (bare, body.engine_form, body.user_form, ts, ts),
        )
    r = db.execute(
        "SELECT * FROM corrections WHERE word=? AND user_form=?", (bare, body.user_form)
    ).fetchone()
    return _row(r, suggest_after(db), _locked(db))


@router.get("")
def list_all(db: Db) -> list[dict[str, Any]]:
    after, locked = suggest_after(db), _locked(db)
    rows = db.execute("SELECT * FROM corrections ORDER BY count DESC, last_at DESC").fetchall()
    return [_row(r, after, locked) for r in rows]


@router.get("/suggestions")
def suggestions(db: Db, min_count: int | None = None) -> dict[str, Any]:
    after, locked = suggest_after(db, min_count), _locked(db)
    rows = db.execute(
        "SELECT * FROM corrections WHERE count>=? AND dismissed=0 "
        "ORDER BY count DESC, last_at DESC",
        (after,),
    ).fetchall()
    items = [_row(r, after, locked) for r in rows]
    return {"suggest_after": after, "suggestions": [i for i in items if i["suggest"]]}


def _get(db: sqlite3.Connection, cid: int) -> sqlite3.Row:
    r = db.execute("SELECT * FROM corrections WHERE id=?", (cid,)).fetchone()
    if r is None:
        raise not_found("Correction", cid)
    return r


@router.post("/{cid}/dismiss")
def dismiss(cid: int, db: Db) -> dict[str, Any]:
    _get(db, cid)
    with write(db):
        db.execute("UPDATE corrections SET dismissed=1 WHERE id=?", (cid,))
    return _row(_get(db, cid), suggest_after(db), _locked(db))


@router.post("/{cid}/accept", status_code=201)
def accept(cid: int, db: Db) -> dict[str, Any]:
    """The user's explicit "add to my dictionary" click: creates the locked entry."""
    r = _get(db, cid)
    with write(db):
        row = db.execute(
            "SELECT is_user_locked, diacritized_form FROM tashkeel_cache WHERE word_or_phrase=?",
            (r["word"],),
        ).fetchone()
        if row is not None and row["is_user_locked"]:
            if row["diacritized_form"] == r["user_form"]:
                raise duplicate_word(r["word"])
        eid, kind = _upsert(db, r["word"], r["user_form"])
        db.execute("UPDATE corrections SET dismissed=1 WHERE id=?", (cid,))
    return {
        "dictionary_id": eid,
        "result": kind,
        "word": r["word"],
        "diacritized_form": r["user_form"],
    }


@router.delete("/{cid}", status_code=204)
def delete(cid: int, db: Db) -> Response:
    _get(db, cid)
    with write(db):
        db.execute("DELETE FROM corrections WHERE id=?", (cid,))
    return Response(status_code=204)
