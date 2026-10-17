from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import get_db

router = APIRouter()
VERSION = "0.1.0"
MODEL_PATH = Path(__file__).resolve().parent.parent.parent / "models" / "catt_encoder_int8.onnx"


def engine_mode() -> Literal["mock", "real"]:
    if os.environ.get("MIZAJ_ENGINE_MODE", "").lower() == "mock" or not MODEL_PATH.exists():
        return "mock"
    return "real"


class Health(BaseModel):
    status: str
    version: str
    engine_mode: Literal["mock", "real"]
    db_user_version: int


@router.get("/health", response_model=Health)
def health(db: Annotated[sqlite3.Connection, Depends(get_db)]) -> Health:
    uv = db.execute("PRAGMA user_version").fetchone()[0]
    return Health(status="ok", version=VERSION, engine_mode=engine_mode(), db_user_version=uv)
