"""Proper-noun dictionary (Task 7.4.3): built-in names/places + user entries."""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from app.api.deps import get_db
from app.core.database import now_iso, write
from app.core.errors import not_found, validation_error
from app.engine.names import load_names
from app.engine.normalize import strip_marks
from app.legal.glossary import GlossaryError, validate_entry

router = APIRouter(prefix="/api/names", tags=["names"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]


class NameIn(BaseModel):
    term: str = Field(min_length=1, max_length=120)
    diacritized: str = Field(min_length=1, max_length=240)
    kind: str = Field(default="", max_length=40)
    enabled: bool = True


def _save(db: sqlite3.Connection, n: NameIn, nid: int | None = None) -> int:
    try:
        term, dia = validate_entry(n.term, n.diacritized)
    except GlossaryError as exc:
        raise validation_error(str(exc)) from exc
    ts = now_iso()
    try:
        with write(db):
            if nid is None:
                cur = db.execute(
                    "INSERT INTO proper_nouns(term, diacritized, kind, enabled, created_at, "
                    "updated_at) VALUES (?,?,?,?,?,?)",
                    (term, dia, n.kind, int(n.enabled), ts, ts),
                )
                return cur.lastrowid
            db.execute(
                "UPDATE proper_nouns SET term=?, diacritized=?, kind=?, enabled=?, updated_at=? "
                "WHERE id=?",
                (term, dia, n.kind, int(n.enabled), ts, nid),
            )
            return nid
    except sqlite3.IntegrityError as exc:
        raise validation_error("term already exists in the user list") from exc


def _json(e) -> dict[str, Any]:
    return {
        "id": e.id,
        "term": e.term,
        "diacritized": e.diacritized,
        "kind": e.note,
        "builtin": e.builtin,
    }


@router.get("")
def list_names(db: Db, q: str | None = None) -> list[dict[str, Any]]:
    out = [_json(e) for e in load_names(db)]
    if q and q.strip():
        needle = strip_marks(q.strip())
        out = [e for e in out if needle in e["term"]]
    return out


@router.post("", status_code=201)
def add_name(body: NameIn, db: Db) -> dict[str, Any]:
    nid = _save(db, body)
    return next(_json(e) for e in load_names(db) if e.id == nid) if body.enabled else {"id": nid}


@router.put("/{nid}")
def update_name(nid: int, body: NameIn, db: Db) -> dict[str, Any]:
    if db.execute("SELECT 1 FROM proper_nouns WHERE id=?", (nid,)).fetchone() is None:
        raise not_found("Name", nid)
    _save(db, body, nid)
    return {"id": nid}


@router.delete("/{nid}", status_code=204)
def delete_name(nid: int, db: Db) -> Response:
    if db.execute("SELECT 1 FROM proper_nouns WHERE id=?", (nid,)).fetchone() is None:
        raise not_found("Name", nid)
    with write(db):
        db.execute("DELETE FROM proper_nouns WHERE id=?", (nid,))
    return Response(status_code=204)


class NameImport(BaseModel):
    entries: list[NameIn] = Field(max_length=100_000)


@router.post("/import")
def import_names(body: NameImport, db: Db) -> dict[str, int]:
    imported = updated = 0
    for n in body.entries:
        row = db.execute("SELECT id FROM proper_nouns WHERE term=?", (n.term.strip(),)).fetchone()
        _save(db, n, row["id"] if row else None)
        updated += bool(row)
        imported += not row
    return {"imported": imported, "updated": updated}


@router.get("/export")
def export_names(db: Db) -> dict[str, Any]:
    rows = db.execute("SELECT term, diacritized, kind FROM proper_nouns ORDER BY id").fetchall()
    return {"version": 1, "kind": "names", "entries": [dict(r) for r in rows]}
