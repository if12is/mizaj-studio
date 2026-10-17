"""Poetry / 'arud basics (Task 7.4.2): meter detection of classical verse."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.arud import METERS, analyze
from app.core.database import connect
from app.engine.executor import run_blocking
from app.engine.factory import build_pipeline
from app.engine.normalize import MARKS
from app.engine.splitter import ArabicSentenceSplitter

router = APIRouter(prefix="/api/arud", tags=["arud"])


class AnalyzeIn(BaseModel):
    text: str = Field(max_length=200_000)
    diacritize: bool | None = None  # None: only when the text is mostly undiacritized
    mode: Literal["fast", "accurate"] = "accurate"


def _diacritize(db_path, pipeline, text: str) -> str:
    conn = connect(db_path)
    try:
        return pipeline.run_text(conn, text)
    finally:
        conn.close()


@router.get("/meters")
def meters() -> list[str]:
    return list(METERS)


@router.post("/analyze")
async def analyze_verse(body: AnalyzeIn, request: Request) -> dict[str, Any]:
    text = body.text
    letters = sum(1 for c in text if "ء" <= c <= "ي")
    marks = sum(1 for c in text if c in MARKS)
    need = body.diacritize if body.diacritize is not None else marks < 0.6 * letters
    diacritized = False
    if need:
        pipeline = await build_pipeline(body.mode, "full", keep_existing=True)
        pipeline.splitter = ArabicSentenceSplitter(line_mode=True)  # keep the verse structure
        text = await run_blocking(_diacritize, request.app.state.db_path, pipeline, text)
        diacritized = True
    res = await run_blocking(analyze, text)
    return {**res, "text": text, "diacritized": diacritized}
