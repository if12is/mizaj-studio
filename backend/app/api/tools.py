from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.engine.executor import run_blocking
from app.resources import net
from app.tools import clients, discovery

router = APIRouter(tags=["tools"])


class OllamaIn(BaseModel):
    text: str = Field(max_length=clients.MAX_CHARS)
    model: str


class LtIn(BaseModel):
    text: str = Field(max_length=200_000)
    language: str = "ar"


@router.get("/api/online/status")
async def online_status(request: Request) -> dict[str, Any]:
    return await run_blocking(net.status, request.app.state.db_path)


@router.get("/api/tools")
async def tools() -> dict[str, Any]:
    return await run_blocking(discovery.detect_all)


@router.post("/api/tools/ollama/suggest")
async def ollama_suggest(body: OllamaIn, request: Request) -> dict[str, Any]:
    return await run_blocking(
        clients.ollama_suggest, request.app.state.db_path, body.text, body.model
    )


@router.post("/api/tools/languagetool/check")
async def lt_check(body: LtIn, request: Request) -> dict[str, Any]:
    return await run_blocking(
        clients.languagetool_check, request.app.state.db_path, body.text, body.language
    )
