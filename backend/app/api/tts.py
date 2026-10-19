from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.engine.executor import run_blocking
from app.tts import piper

router = APIRouter(tags=["tts"])


class PiperIn(BaseModel):
    text: str = Field(max_length=piper.MAX_CHARS * 2)
    length_scale: float = Field(default=1.0, ge=0.1, le=5.0)


@router.get("/api/tts/piper/status")
async def piper_status(request: Request) -> dict[str, Any]:
    return piper.status(request.app.state.data_dir)


@router.post("/api/tts/piper/synthesize")
async def piper_synthesize(body: PiperIn, request: Request) -> Response:
    wav = await run_blocking(
        piper.synthesize, request.app.state.data_dir, body.text, body.length_scale
    )
    return Response(content=wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})
