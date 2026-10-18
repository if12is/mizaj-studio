"""Proofreading before tashkeel: hamza -> spelling -> final ya -> punctuation (suggestions only).

`POST /api/proofread` returns proposals; it never changes or stores the text.  The client shows
them grouped by category and sends back only the ones the user accepted to
`POST /api/proofread/apply` (or applies them itself with the UTF-16 offsets).  Base-letter
changes are therefore always an explicit user action (AGENTS.md section 5).
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.api.spelling import _engine, personal_words, read_ignore
from app.core.database import connect
from app.engine.executor import run_blocking
from app.quran.detect import find_protected_spans
from app.spelling.proofread import (
    CATEGORIES,
    CATEGORY_LABEL_AR,
    ProofreadOptions,
    apply_items,
    proofread,
)
from app.spelling.text import strip_for_lookup

router = APIRouter(prefix="/api/proofread", tags=["proofread"])

SETTING_YA = "ya_style"
Category = Literal["hamza", "spelling", "ya", "punctuation"]


class ProofreadIn(BaseModel):
    text: str = Field(max_length=5_000_000)
    # None -> the saved setting «الياء آخر الكلمة» (standard unless the user chose Egyptian)
    ya_style: Literal["standard", "egyptian"] | None = None
    categories: list[Category] | None = None
    quotes: Literal["keep", "guillemets"] = "keep"
    max_items: int = Field(default=5000, ge=1, le=20_000)


class ItemIn(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    original: str = Field(max_length=2000)
    replacement: str = Field(max_length=2000)


class ApplyIn(BaseModel):
    text: str = Field(max_length=5_000_000)
    items: list[ItemIn] = Field(max_length=50_000)


def _saved_ya_style(db_path: Path) -> str:
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (SETTING_YA,)).fetchone()
    finally:
        conn.close()
    return row["value"] if row and row["value"] in ("standard", "egyptian") else "standard"


def _run(db_path: Path, data_dir: Path | None, body: ProofreadIn) -> dict:
    eng = _engine()
    conn = connect(db_path)
    try:
        ignored = {strip_for_lookup(w) for w in read_ignore(conn)}
        known = personal_words(conn)
    finally:
        conn.close()
    protected: list[tuple[int, int]] = []
    if data_dir is not None:  # Quranic verses are never "corrected"
        try:
            protected = find_protected_spans(body.text, data_dir)
        except Exception:  # noqa: BLE001 - protection is best-effort for the checker
            protected = []
    style = body.ya_style or _saved_ya_style(db_path)
    opt = ProofreadOptions(
        ya_style=style,  # type: ignore[arg-type]
        categories=tuple(body.categories) if body.categories else CATEGORIES,
        quotes=body.quotes,
    )
    res = proofread(body.text, eng, opt, known, ignored, protected, body.max_items)
    res["labels_ar"] = CATEGORY_LABEL_AR
    return res


@router.post("")
async def run_proofread(body: ProofreadIn, request: Request) -> dict:
    return await run_blocking(
        _run, request.app.state.db_path, getattr(request.app.state, "data_dir", None), body
    )


@router.post("/apply")
async def apply(body: ApplyIn) -> dict:
    """Apply accepted proposals (verified against the text; stale ones are reported, not forced)."""
    return await run_blocking(apply_items, body.text, [i.model_dump() for i in body.items])
