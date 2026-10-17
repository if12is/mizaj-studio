from __future__ import annotations

import sqlite3
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator

from app.api.deps import get_db
from app.core.database import now_iso, write
from app.core.errors import not_found, validation_error

router = APIRouter(prefix="/api/documents", tags=["documents"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]


class DocumentSummary(BaseModel):
    id: int
    project_id: int
    title: str
    source_docx_path: str | None
    language: str
    direction: str
    word_count: int
    is_deleted: int
    created_at: str
    updated_at: str


class Document(DocumentSummary):
    raw_content: str
    diacritized_content: str


class DocumentCreate(BaseModel):
    project_id: int
    title: str = Field(max_length=500)
    raw_content: str = Field(default="", max_length=20_000_000)
    language: str = Field(default="ar", min_length=1, max_length=16)
    direction: Literal["rtl", "ltr"] = "rtl"

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be empty")
        return v


class DocumentUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=500)
    raw_content: str | None = Field(default=None, max_length=20_000_000)
    diacritized_content: str | None = Field(default=None, max_length=20_000_000)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("title must not be empty")
        return v


def count_words(text: str) -> int:
    return len(text.split())


def _row(db: sqlite3.Connection, did: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM documents WHERE id=? AND is_deleted=0", (did,)).fetchone()
    if row is None:
        raise not_found("Document", did)
    return row


@router.get("", response_model=list[DocumentSummary])
def list_documents(db: Db, project_id: int | None = None) -> list[DocumentSummary]:
    cols = (
        "id, project_id, title, source_docx_path, language, direction, "
        "word_count, is_deleted, created_at, updated_at"
    )
    sql = f"SELECT {cols} FROM documents WHERE is_deleted=0"  # noqa: S608 - static columns
    args: tuple = ()
    if project_id is not None:
        sql += " AND project_id=?"
        args = (project_id,)
    sql += " ORDER BY updated_at DESC, id DESC"
    return [DocumentSummary(**dict(r)) for r in db.execute(sql, args).fetchall()]


@router.post("", response_model=Document, status_code=201)
def create_document(body: DocumentCreate, db: Db) -> Document:
    if db.execute("SELECT 1 FROM projects WHERE id=?", (body.project_id,)).fetchone() is None:
        raise not_found("Project", body.project_id)
    ts = now_iso()
    try:
        with write(db):
            cur = db.execute(
                "INSERT INTO documents(project_id, title, raw_content, language, direction, "
                "word_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (
                    body.project_id,
                    body.title,
                    body.raw_content,
                    body.language,
                    body.direction,
                    count_words(body.raw_content),
                    ts,
                    ts,
                ),
            )
    except sqlite3.IntegrityError as exc:  # project deleted concurrently
        raise not_found("Project", body.project_id) from exc
    return Document(**dict(_row(db, cur.lastrowid)))


@router.get("/{did}", response_model=Document)
def get_document(did: int, db: Db) -> Document:
    return Document(**dict(_row(db, did)))


@router.put("/{did}", response_model=Document)
def update_document(did: int, body: DocumentUpdate, db: Db) -> Document:
    cur = _row(db, did)
    sent = body.model_fields_set
    for f in sent:
        if getattr(body, f) is None:
            raise validation_error(f"{f} must not be null", {"field": f})
    title = body.title if "title" in sent else cur["title"]
    raw = body.raw_content if "raw_content" in sent else cur["raw_content"]
    diac = body.diacritized_content if "diacritized_content" in sent else cur["diacritized_content"]
    wc = count_words(raw) if "raw_content" in sent else cur["word_count"]
    with write(db):
        db.execute(
            "UPDATE documents SET title=?, raw_content=?, diacritized_content=?, word_count=?, "
            "updated_at=? WHERE id=?",
            (title, raw, diac, wc, now_iso(), did),
        )
    return Document(**dict(_row(db, did)))


@router.delete("/{did}", status_code=204)
def delete_document(did: int, db: Db) -> Response:
    _row(db, did)
    with write(db):
        db.execute("UPDATE documents SET is_deleted=1, updated_at=? WHERE id=?", (now_iso(), did))
    return Response(status_code=204)
