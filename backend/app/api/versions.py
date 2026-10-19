"""Document edit history API: list / get / diff / restore / checkpoint."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.api.deps import get_db
from app.core import versions as vs
from app.core.database import now_iso, write
from app.core.errors import not_found, validation_error

router = APIRouter(prefix="/api/documents/{did}/versions", tags=["versions"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]


class VersionCreate(BaseModel):
    kind: Literal["event", "checkpoint"] = "event"
    label: str = Field(default="", max_length=200)
    name: str = Field(default="", max_length=200)
    # the editor text when it is ahead of the last autosave; default: the saved document
    content: str | None = Field(default=None, max_length=20_000_000)


class VersionName(BaseModel):
    name: str = Field(max_length=200)


class RestoreBody(BaseModel):
    label: str = Field(default="", max_length=200)


def _doc(db: sqlite3.Connection, did: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM documents WHERE id=? AND is_deleted=0", (did,)).fetchone()
    if row is None:
        raise not_found("Document", did)
    return row


def _version(db: sqlite3.Connection, did: int, vid: int) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM document_versions WHERE id=? AND document_id=?", (vid, did)
    ).fetchone()
    if row is None:
        raise not_found("Version", vid)
    return row


@router.get("")
def list_versions(
    did: int,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=2000)] = 300,
    before_id: int | None = None,
) -> dict[str, Any]:
    _doc(db, did)
    cols = (
        "id, document_id, created_at, updated_at, kind, label, name, char_count, word_count, "
        "words_added, words_removed, chars_delta"
    )
    sql = f"SELECT {cols} FROM document_versions WHERE document_id=?"  # noqa: S608 - static
    args: list[Any] = [did]
    if before_id is not None:
        sql += " AND id<?"
        args.append(before_id)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    items = [dict(r) for r in db.execute(sql, args).fetchall()]
    total = db.execute(
        "SELECT COUNT(*) FROM document_versions WHERE document_id=?", (did,)
    ).fetchone()[0]
    return {"items": items, "total": total}


@router.post("", status_code=201)
def create_version(did: int, body: VersionCreate, db: Db) -> dict[str, Any]:
    """Snapshot on a named event (before/after tashkeel, ...) or a manual checkpoint."""
    doc = _doc(db, did)
    text = doc["raw_content"] if body.content is None else body.content
    name = body.name.strip()
    kind = "checkpoint" if body.kind == "checkpoint" or name else "event"
    if kind == "event" and not body.label.strip():
        raise validation_error("label is required for an event snapshot", {"field": "label"})
    with write(db):
        vs.ensure_baseline(db, did, doc["raw_content"])
        vid = vs.record_version(db, did, text, kind=kind, label=body.label, name=name)
        duplicate = vid is None
        if vid is None:
            latest = db.execute(
                "SELECT id FROM document_versions WHERE document_id=? ORDER BY id DESC LIMIT 1",
                (did,),
            ).fetchone()
            vid = latest["id"] if latest else None
    meta = vs.meta(_version(db, did, vid)) if vid is not None else None
    return {"version": meta, "duplicate": duplicate}


@router.get("/diff")
def diff_versions(
    did: int,
    db: Db,
    from_: Annotated[int, Query(alias="from")],
    to: str = "current",
) -> dict[str, Any]:
    """Word-level diff from version `from` to version `to` (an id, or `current` text)."""
    doc = _doc(db, did)
    old = vs.unpack(_version(db, did, from_)["content_z"])
    if to == "current":
        new, to_id = doc["raw_content"], None
    elif to.isdigit():
        new, to_id = vs.unpack(_version(db, did, int(to))["content_z"]), int(to)
    else:
        raise validation_error("to must be a version id or 'current'", {"field": "to"})
    ops = vs.diff_ops(old, new)
    return {
        "from_id": from_,
        "to_id": to_id,
        "ops": ops,
        "added": sum(len(o["text"].split()) for o in ops if o["op"] == "insert"),
        "removed": sum(len(o["text"].split()) for o in ops if o["op"] == "delete"),
    }


@router.get("/{vid}")
def get_version(did: int, vid: int, db: Db) -> dict[str, Any]:
    _doc(db, did)
    row = _version(db, did, vid)
    return {**vs.meta(row), "content": vs.unpack(row["content_z"])}


@router.put("/{vid}")
def label_checkpoint(did: int, vid: int, body: VersionName, db: Db) -> dict[str, Any]:
    """Name a version: it becomes a checkpoint that retention never deletes."""
    _doc(db, did)
    row = _version(db, did, vid)
    name = body.name.strip()
    label = row["label"] if row["kind"] == "checkpoint" else vs.LABEL_CHECKPOINT
    with write(db):
        db.execute(
            "UPDATE document_versions SET kind='checkpoint', name=?, label=?, updated_at=? "
            "WHERE id=?",
            (name, label, now_iso(), vid),
        )
    return vs.meta(_version(db, did, vid))


@router.post("/{vid}/restore")
def restore_version(did: int, vid: int, body: RestoreBody, db: Db) -> dict[str, Any]:
    """Make the document equal to version `vid`; recorded as a new version (undoable)."""
    doc = _doc(db, did)
    src = _version(db, did, vid)
    text = vs.unpack(src["content_z"])
    label = body.label.strip()
    if not label:
        when = datetime.strptime(src["created_at"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)
        label = f"{vs.LABEL_RESTORE} {when:%Y-%m-%d %H:%M}"
    with write(db):
        vs.ensure_baseline(db, did, doc["raw_content"])
        # whatever the document holds now is kept as a version first, so nothing is lost
        vs.record_version(db, did, doc["raw_content"], kind="autosave")
        new_id = vs.record_version(db, did, text, kind="restore", label=label)
        diac = text if doc["diacritized_content"] else doc["diacritized_content"]
        db.execute(
            "UPDATE documents SET raw_content=?, diacritized_content=?, word_count=?, "
            "updated_at=? WHERE id=?",
            (text, diac, len(text.split()), now_iso(), did),
        )
        if new_id is None:  # already identical to the newest version
            new_id = db.execute(
                "SELECT id FROM document_versions WHERE document_id=? ORDER BY id DESC LIMIT 1",
                (did,),
            ).fetchone()["id"]
    return {"version": vs.meta(_version(db, did, new_id)), "content": text}
