from __future__ import annotations

import sqlite3
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import get_db
from app.engine import config

router = APIRouter()
VERSION = "0.1.0"


def engine_mode() -> Literal["mock", "real"]:
    return "mock" if config.is_mock() else "real"


class Health(BaseModel):
    status: str
    version: str
    engine_mode: Literal["mock", "real"]
    db_user_version: int
    models_dir: str


@router.get("/health", response_model=Health)
def health(db: Annotated[sqlite3.Connection, Depends(get_db)]) -> Health:
    uv = db.execute("PRAGMA user_version").fetchone()[0]
    return Health(
        status="ok",
        version=VERSION,
        engine_mode=engine_mode(),
        db_user_version=uv,
        models_dir=str(config.catt_dir()),
    )
