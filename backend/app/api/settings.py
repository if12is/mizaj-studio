from __future__ import annotations

import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import get_db
from app.core.database import now_iso, write
from app.core.errors import validation_error

router = APIRouter(prefix="/api/settings", tags=["settings"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]

DEFAULTS: dict[str, str] = {
    "engine_mode": "fast",
    "tashkeel_level": "full",
    "editor_font": "Amiri",
    "editor_font_size": "20",
    "colored_diacritics": "true",
    "theme": "dark",
    "ya_style": "standard",
    "proofread_before_tashkeel": "ask",
}
ENUMS: dict[str, set[str]] = {
    "engine_mode": {"fast", "accurate"},
    "tashkeel_level": {"full", "irab_only", "essential", "minimal", "legal"},
    "theme": {"dark", "light"},
    "colored_diacritics": {"true", "false"},
    "ya_style": {"standard", "egyptian"},
    "proofread_before_tashkeel": {"ask", "auto_punct", "off"},
}


def _validate(key: str, value: str) -> None:
    if key in ENUMS and value not in ENUMS[key]:
        raise validation_error(
            f"Invalid value for {key}", {"key": key, "allowed": sorted(ENUMS[key])}
        )
    if key == "editor_font_size":
        if not (value.isascii() and value.isdigit() and 12 <= int(value) <= 48):
            raise validation_error(
                "editor_font_size must be an integer between 12 and 48", {"key": key}
            )
    if key == "editor_font" and not value.strip():
        raise validation_error("editor_font must not be empty", {"key": key})


def _all(db: sqlite3.Connection) -> dict[str, str]:
    out = dict(DEFAULTS)
    out.update({r["key"]: r["value"] for r in db.execute("SELECT key, value FROM settings")})
    return out


@router.get("")
def get_settings(db: Db) -> dict[str, str]:
    return _all(db)


@router.put("")
def put_settings(body: dict[str, str], db: Db) -> dict[str, str]:
    for k, v in body.items():
        _validate(k, v)
    ts = now_iso()
    with write(db):
        for k, v in body.items():
            db.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                "updated_at=excluded.updated_at",
                (k, v, ts),
            )
    return _all(db)
