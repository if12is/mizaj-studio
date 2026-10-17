from __future__ import annotations

import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator

from app.api.deps import get_db
from app.core.database import now_iso, write
from app.core.errors import not_found, validation_error

router = APIRouter(prefix="/api/projects", tags=["projects"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]


class Project(BaseModel):
    id: int
    name: str
    description: str
    created_at: str
    updated_at: str


def _name(v: str | None) -> str | None:
    if v is None:
        return v
    v = v.strip()
    if not v:
        raise ValueError("name must not be empty")
    return v


class ProjectCreate(BaseModel):
    name: str = Field(max_length=200)
    description: str = Field(default="", max_length=5000)

    _n = field_validator("name")(_name)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=5000)

    _n = field_validator("name")(_name)


def _get(db: sqlite3.Connection, pid: int) -> Project:
    row = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if row is None:
        raise not_found("Project", pid)
    return Project(**dict(row))


@router.get("", response_model=list[Project])
def list_projects(db: Db) -> list[Project]:
    rows = db.execute("SELECT * FROM projects ORDER BY updated_at DESC, id DESC").fetchall()
    return [Project(**dict(r)) for r in rows]


@router.post("", response_model=Project, status_code=201)
def create_project(body: ProjectCreate, db: Db) -> Project:
    ts = now_iso()
    with write(db):
        cur = db.execute(
            "INSERT INTO projects(name, description, created_at, updated_at) VALUES (?,?,?,?)",
            (body.name, body.description, ts, ts),
        )
    return _get(db, cur.lastrowid)


@router.get("/{pid}", response_model=Project)
def get_project(pid: int, db: Db) -> Project:
    return _get(db, pid)


@router.put("/{pid}", response_model=Project)
def update_project(pid: int, body: ProjectUpdate, db: Db) -> Project:
    cur = _get(db, pid)
    if "name" in body.model_fields_set and body.name is None:
        raise validation_error("name must not be null")
    name = body.name if body.name is not None else cur.name
    desc = body.description if body.description is not None else cur.description
    with write(db):
        db.execute(
            "UPDATE projects SET name=?, description=?, updated_at=? WHERE id=?",
            (name, desc, now_iso(), pid),
        )
    return _get(db, pid)


@router.delete("/{pid}", status_code=204)
def delete_project(pid: int, db: Db) -> Response:
    _get(db, pid)
    with write(db):
        db.execute("DELETE FROM projects WHERE id=?", (pid,))
    return Response(status_code=204)
