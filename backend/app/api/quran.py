"""7.4.1 Quran protection API (detection only; the text is installed from Tanzil, never bundled)."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.core import security
from app.engine.executor import run_blocking
from app.quran import store
from app.quran.detect import get_index

router = APIRouter(prefix="/api/quran", tags=["quran"])


class DetectIn(BaseModel):
    text: str = Field(max_length=5_000_000)
    include_partial: bool = True


QURAN_EXTS = ("", ".txt", ".xml", ".sql", ".csv", ".json")


class InstallIn(BaseModel):
    kind: str = Field(max_length=40)  # one of store.KINDS (e.g. "uthmani", "simple-clean")
    source_path: str
    sha256: str | None = Field(default=None, max_length=64)


def _status(data_dir: Path) -> dict:
    st = store.status(data_dir)
    idx = get_index(data_dir) if st["installed"] else None
    st["verses"] = idx.verse_count if idx else 0
    st["ready"] = idx is not None
    return st


def _detect(data_dir: Path, body: DetectIn) -> dict:
    idx = get_index(data_dir)
    if idx is None:
        return {"installed": False, "spans": [], "attribution": store.ATTRIBUTION}
    from app.spelling.text import OffsetMap

    om = OffsetMap(body.text)
    spans = idx.detect(body.text, body.include_partial)
    for s in spans:
        s["word"] = body.text[s["start"] : s["end"]]
        s["start16"], s["end16"] = om.to16(s["start"]), om.to16(s["end"])
    return {"installed": True, "spans": spans, "attribution": store.ATTRIBUTION}


class DownloadIn(BaseModel):
    kinds: list[str] | None = None


def _download(data_dir: Path, db_path: Path, body: DownloadIn) -> dict:
    kinds = tuple(body.kinds) if body.kinds else store.DEFAULT_KINDS
    store.download_quran_text(data_dir, db_path, kinds)
    get_index(None)
    return _status(data_dir)


def _install(data_dir: Path, body: InstallIn) -> dict:
    src = security.safe_path(
        body.source_path, "source_path", exts=QURAN_EXTS, max_bytes=64 * security.MB
    )
    store.install_quran_text(data_dir, src, body.kind, body.sha256)
    return _status(data_dir)


@router.get("/status")
async def status(request: Request) -> dict:
    return await run_blocking(_status, request.app.state.data_dir)


@router.post("/detect")
async def detect(body: DetectIn, request: Request) -> dict:
    """Spans (code points + UTF-16) of Quranic text with sura/aya refs. Never edits text."""
    return await run_blocking(_detect, request.app.state.data_dir, body)


@router.post("/install")
async def install(body: InstallIn, request: Request) -> dict:
    """Import a Tanzil file the user already has (verbatim copy, checksum recorded)."""
    return await run_blocking(_install, request.app.state.data_dir, body)


@router.post("/download")
async def download(body: DownloadIn, request: Request) -> dict:
    """Opt-in: fetch the Tanzil text (needs the `online_resources` switch; only tanzil.net)."""
    return await run_blocking(
        _download, request.app.state.data_dir, request.app.state.db_path, body
    )
