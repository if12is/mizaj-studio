from __future__ import annotations

import asyncio
import gc
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.core.errors import not_found, validation_error
from app.core.packs import apply_pack, installed_info
from app.engine import config
from app.engine.executor import run_blocking
from app.engine.manager import manager

router = APIRouter(prefix="/api/packs", tags=["packs"])
_apply_lock = asyncio.Lock()


class ApplyRequest(BaseModel):
    path: str


def _status(data_dir: Path) -> dict[str, Any]:
    source, d = config.resolve_model_dir()
    info = installed_info(data_dir)
    return {
        "installed": info is not None,
        "version": info["version"] if info else None,
        "installed_at": info["installed_at"] if info else None,
        "models_dir": str(d),
        "models_source": source,
        "model_present": config.model_present(),
    }


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    return await run_blocking(_status, request.app.state.data_dir)


@router.post("/apply")
async def apply(body: ApplyRequest, request: Request) -> dict[str, Any]:
    p = Path(body.path)
    if not p.is_absolute() or p.suffix.lower() != ".mizajpack":
        raise validation_error("path must be an absolute path ending with .mizajpack")
    if not p.is_file():
        raise not_found("File", str(p))
    data_dir = request.app.state.data_dir
    async with _apply_lock:
        # release loaded sessions first (Windows keeps model files locked while mapped)
        manager.reset()
        gc.collect()
        info = await run_blocking(apply_pack, p, data_dir)
        manager.reset()  # engines reload lazily from the new models
    return {"applied": True, "version": info["version"], **await run_blocking(_status, data_dir)}
