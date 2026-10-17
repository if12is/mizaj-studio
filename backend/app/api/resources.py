from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.core import security
from app.core.errors import not_found
from app.engine.executor import run_blocking
from app.resources import manager

router = APIRouter(tags=["resources"])


class DownloadIn(BaseModel):
    accept_license: bool = False


class ImportIn(BaseModel):
    path: str
    accept_license: bool = False


@router.get("/api/resources")
async def list_resources(request: Request) -> dict[str, Any]:
    return await run_blocking(
        manager.listing, request.app.state.data_dir, request.app.state.db_path
    )


@router.post("/api/resources/{rid}/download", status_code=202)
async def download(rid: str, body: DownloadIn, request: Request) -> dict[str, Any]:
    job = manager.start_download(
        request.app.state.data_dir, request.app.state.db_path, rid, body.accept_license
    )
    return {"job_id": job.id}


@router.get("/api/resources/jobs/{job_id}")
async def job_status(job_id: str) -> dict[str, Any]:
    job = manager.JOBS.get(job_id)
    if job is None:
        raise not_found("Job", job_id)
    return job.snapshot()


@router.post("/api/resources/jobs/{job_id}/cancel")
async def job_cancel(job_id: str, request: Request) -> dict[str, Any]:
    job = manager.JOBS.get(job_id)
    if job is None:
        raise not_found("Job", job_id)
    manager.cancel(request.app.state.data_dir, job)  # also drops a paused job's partial file
    return job.snapshot()


@router.post("/api/resources/jobs/{job_id}/resume", status_code=202)
async def job_resume(job_id: str, request: Request) -> dict[str, Any]:
    """Continue a paused download (interrupted by the network or an app restart)."""
    job = manager.JOBS.get(job_id)
    if job is None:
        raise not_found("Job", job_id)
    manager.resume(request.app.state.data_dir, request.app.state.db_path, job)
    return job.snapshot()


@router.post("/api/resources/{rid}/import")
async def import_file(rid: str, body: ImportIn, request: Request) -> dict[str, Any]:
    src = security.safe_path(
        body.path, "path", exts=manager.IMPORT_EXTS, max_bytes=manager.IMPORT_MAX_BYTES
    )
    return await run_blocking(
        manager.import_file, request.app.state.data_dir, rid, src, body.accept_license
    )
