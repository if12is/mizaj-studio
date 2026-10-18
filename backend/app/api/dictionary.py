from __future__ import annotations

import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator

from app.api.deps import get_db
from app.core.database import now_iso, write
from app.core.errors import duplicate_word, not_found, validation_error
from app.engine.normalize import strip_marks

router = APIRouter(prefix="/api/dictionary", tags=["dictionary"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]


def _nonempty(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("must not be empty")
    return v


class DictEntry(BaseModel):
    id: int
    word_or_phrase: str
    diacritized_form: str
    source: str
    is_user_locked: int
    usage_count: int
    created_at: str
    updated_at: str


class EntryIn(BaseModel):
    word_or_phrase: str = Field(max_length=500)
    diacritized_form: str = Field(max_length=1000)

    _v = field_validator("word_or_phrase", "diacritized_form")(_nonempty)


class FormIn(BaseModel):
    diacritized_form: str = Field(max_length=1000)

    _v = field_validator("diacritized_form")(_nonempty)


class ImportIn(BaseModel):
    entries: list[EntryIn] = Field(max_length=100_000)


def _same_letters(word: str, form: str) -> bool:
    ws = lambda t: " ".join(t.split())  # noqa: E731
    return strip_marks(ws(word)) == strip_marks(ws(form))


def _require_same_letters(word: str, form: str) -> None:
    """Never change base letters: the form may only add/change marks (AGENTS.md section 5)."""
    if not _same_letters(word, form):
        raise validation_error(
            "diacritized_form must have exactly the same letters as the word",
            {"word": word},
            "الصيغة المشكولة يجب أن تحمل نفس حروف الكلمة تماماً؛ المسموح تغيير الحركات فقط.",
        )


def _locked(db: sqlite3.Connection, eid: int) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM tashkeel_cache WHERE id=? AND is_user_locked=1", (eid,)
    ).fetchone()
    if row is None:
        raise not_found("Dictionary entry", eid)
    return row


def _upsert(db: sqlite3.Connection, word: str, form: str) -> tuple[int, str]:
    """Returns (id, 'created'|'upgraded'|'updated'). Must be called inside write()."""
    ts = now_iso()
    row = db.execute(
        "SELECT id, is_user_locked FROM tashkeel_cache WHERE word_or_phrase=?", (word,)
    ).fetchone()
    if row is None:
        cur = db.execute(
            "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form, source, is_user_locked,"
            " created_at, updated_at) VALUES (?,?,'user',1,?,?)",
            (word, form, ts, ts),
        )
        return cur.lastrowid, "created"
    db.execute(
        "UPDATE tashkeel_cache SET diacritized_form=?, source='user', is_user_locked=1, "
        "updated_at=? WHERE id=?",
        (form, ts, row["id"]),
    )
    return row["id"], "updated" if row["is_user_locked"] else "upgraded"


def _entry(db: sqlite3.Connection, eid: int) -> DictEntry:
    return DictEntry(
        **dict(db.execute("SELECT * FROM tashkeel_cache WHERE id=?", (eid,)).fetchone())
    )


@router.get("", response_model=list[DictEntry])
def list_entries(db: Db, q: str | None = None) -> list[DictEntry]:
    sql = "SELECT * FROM tashkeel_cache WHERE is_user_locked=1"
    args: list[str] = []
    if q and q.strip():
        like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sql += " AND (word_or_phrase LIKE ? ESCAPE '\\' OR diacritized_form LIKE ? ESCAPE '\\')"
        args = [like, like]
    sql += " ORDER BY updated_at DESC, id DESC"
    return [DictEntry(**dict(r)) for r in db.execute(sql, args).fetchall()]


@router.post("", response_model=DictEntry, status_code=201)
def add_entry(body: EntryIn, db: Db) -> DictEntry:
    _require_same_letters(body.word_or_phrase, body.diacritized_form)
    with write(db):
        row = db.execute(
            "SELECT is_user_locked FROM tashkeel_cache WHERE word_or_phrase=?",
            (body.word_or_phrase,),
        ).fetchone()
        if row is not None and row["is_user_locked"]:
            raise duplicate_word(body.word_or_phrase)
        eid, _ = _upsert(db, body.word_or_phrase, body.diacritized_form)
    return _entry(db, eid)


@router.post("/import")
def import_entries(body: ImportIn, db: Db) -> dict[str, int]:
    imported = updated = rejected = 0
    with write(db):
        for e in body.entries:
            if not _same_letters(e.word_or_phrase, e.diacritized_form):
                rejected += 1  # base letters differ: never imported
                continue
            _, kind = _upsert(db, e.word_or_phrase, e.diacritized_form)
            if kind == "created":
                imported += 1
            else:
                updated += 1
    return {"imported": imported, "updated": updated, "rejected": rejected}


@router.get("/export")
def export_entries(db: Db) -> dict:
    rows = db.execute(
        "SELECT word_or_phrase, diacritized_form FROM tashkeel_cache "
        "WHERE is_user_locked=1 ORDER BY id"
    ).fetchall()
    return {"version": 1, "entries": [dict(r) for r in rows]}


@router.put("/{eid}", response_model=DictEntry)
def update_entry(eid: int, body: FormIn, db: Db) -> DictEntry:
    row = _locked(db, eid)
    _require_same_letters(row["word_or_phrase"], body.diacritized_form)
    with write(db):
        db.execute(
            "UPDATE tashkeel_cache SET diacritized_form=?, updated_at=? WHERE id=?",
            (body.diacritized_form, now_iso(), eid),
        )
    return _entry(db, eid)


@router.delete("/{eid}", status_code=204)
def delete_entry(eid: int, db: Db) -> Response:
    _locked(db, eid)
    with write(db):
        db.execute("DELETE FROM tashkeel_cache WHERE id=?", (eid,))
    return Response(status_code=204)
