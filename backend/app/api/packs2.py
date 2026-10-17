# ruff: noqa: E501
from __future__ import annotations

import gc
import json
import sqlite3
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.api.deps import get_db
from app.core import security
from app.core.database import connect, write
from app.core.errors import validation_error
from app.engine.executor import run_blocking
from app.engine.manager import manager
from app.packs2 import backup, merge
from app.packs2.export import export_pack
from app.packs2.models import apply_models
from app.packs2.schema import DATA_KINDS, read_pack

router = APIRouter(tags=["packs2"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]


PACK_MAX_BYTES = 5 * 1024**3
BACKUP_MAX_BYTES = 17 * 1024**3


def _path(raw: str, suffix: str) -> Path:
    """Input file: absolute, right extension, regular file, size-capped (no UNC/devices)."""
    cap = BACKUP_MAX_BYTES if suffix == ".mizajbackup" else PACK_MAX_BYTES
    return security.safe_path(raw, "path", exts=(suffix,), max_bytes=cap)


def _out(raw: str, suffix: str, data_dir: Path) -> Path:
    """Output file: absolute, right extension, outside the app data folder, no symlink."""
    return security.safe_path(
        raw, "target_path", exts=(suffix,), kind="output", data_dir=data_dir
    )


class ExportIn(BaseModel):
    target_path: str
    kinds: list[str] = Field(default_factory=lambda: list(DATA_KINDS))
    name: str = Field(min_length=1, max_length=200)
    version: str = "1.0.0"
    license: str = Field(min_length=1, max_length=200)
    author: str = ""
    attribution: str = ""
    description: str = ""
    include_sample_templates: bool = False
    include_private_settings: bool = False


class PreviewIn(BaseModel):
    path: str
    kinds: list[str] | None = None


class ApplyIn(PreviewIn):
    # {"dictionary": {"<key>": "override"}, "templates": {"<name>|<category>": "duplicate"}}
    decisions: dict[str, dict[str, str]] = Field(default_factory=dict)
    expected_content_sha256: str | None = None


class BackupExportIn(BaseModel):
    target_path: str
    include_models: bool = False


class BackupPathIn(BaseModel):
    path: str


def _describe(pack, plans) -> dict[str, Any]:
    m = pack.manifest
    return {
        "name": m.get("name", ""), "version": m.get("version"), "format": m.get("format"),
        "kind": m.get("kind"), "kinds": pack.kinds, "license": m.get("license"),
        "attribution": m.get("attribution", ""), "author": m.get("author", ""),
        "description": m.get("description", ""), "created_at": m.get("created_at"),
        "app_version": m.get("app_version"), "entries": m.get("entries", {}),
        "content_sha256": m.get("content_sha256"),
        "models": {"files": len(pack.model_files)} if pack.model_files else None,
        "summary": merge.summarize(plans),
    }  # fmt: skip


@router.post("/api/packs/v2/export")
async def export(body: ExportIn, request: Request) -> dict[str, Any]:
    target = _out(body.target_path, ".mizajpack", request.app.state.data_dir)
    if set(body.kinds) - set(DATA_KINDS):
        raise validation_error("unsupported kinds", {"allowed": list(DATA_KINDS)})

    def run() -> dict[str, Any]:
        conn = connect(request.app.state.db_path)
        try:
            return export_pack(
                conn, target, body.kinds, name=body.name, version=body.version, license=body.license,
                author=body.author, attribution=body.attribution, description=body.description,
                include_samples=body.include_sample_templates,
                include_private_settings=body.include_private_settings,
            )  # fmt: skip
        finally:
            conn.close()

    return await run_blocking(run)


def _load(db_path: Path, body: PreviewIn):
    p = _path(body.path, ".mizajpack")
    pack = read_pack(p)
    conn = connect(db_path)
    try:
        return pack, merge.make_plan(conn, pack, body.kinds), conn
    except BaseException:
        conn.close()
        raise


@router.post("/api/packs/v2/preview")
async def preview(body: PreviewIn, request: Request) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        pack, plans, conn = _load(request.app.state.db_path, body)
        conn.close()
        return {**_describe(pack, plans), "items": merge.public_plan(plans)}

    return await run_blocking(run)


@router.post("/api/packs/v2/apply")
async def apply(body: ApplyIn, request: Request) -> dict[str, Any]:
    data_dir = request.app.state.data_dir

    def run_data() -> dict[str, Any]:
        pack, plans, conn = _load(request.app.state.db_path, body)
        try:
            sha = pack.manifest.get("content_sha256")
            if body.expected_content_sha256 and sha != body.expected_content_sha256:
                raise validation_error("pack changed since the preview")
            with write(conn):
                journal, applied = merge.apply_plan(conn, plans, body.decisions)
                kind = "bundle" if len(plans) > 1 else next(iter(plans), "models")
                iid = merge.record_import(conn, pack, kind, applied, journal)
        finally:
            conn.close()
        return {
            "import_id": iid,
            "applied": applied,
            "undoable": True,
            "models": None,
            "pack": pack,
        }

    pack_probe = await run_blocking(read_pack, _path(body.path, ".mizajpack"))
    want_models = pack_probe.model_files and (body.kinds is None or "models" in body.kinds)
    out: dict[str, Any] = {"import_id": None, "applied": {}, "undoable": False, "models": None}
    if any(k in pack_probe.payloads for k in DATA_KINDS):
        res = await run_blocking(run_data)
        res.pop("pack")
        out.update(res)
    if want_models:
        manager.reset()  # release mapped model files first (Windows)
        gc.collect()
        info = await run_blocking(apply_models, pack_probe, data_dir)
        manager.reset()
        out["models"] = {"version": info["version"], "undoable": False}
        if out["import_id"] is None:

            def rec() -> str:
                conn = connect(request.app.state.db_path)
                try:
                    with write(conn):
                        return merge.record_import(conn, pack_probe, "models", {}, [])
                finally:
                    conn.close()

            out["import_id"] = await run_blocking(rec)
    return out


@router.get("/api/packs/v2/imports")
def list_imports(db: Db) -> list[dict[str, Any]]:
    rows = db.execute(
        "SELECT id, kind, name, version, status, summary_json, created_at, undone_at "
        "FROM pack_imports ORDER BY created_at DESC, rowid DESC LIMIT 200"
    ).fetchall()
    return [{**dict(r), "summary": json.loads(r["summary_json"])} for r in rows]


@router.post("/api/packs/v2/undo/{import_id}")
def undo(import_id: str, db: Db) -> dict[str, Any]:
    return merge.undo_import(db, import_id)


# ------------------------------------------------------------------ backup
@router.post("/api/backup/export")
async def backup_export(body: BackupExportIn, request: Request) -> dict[str, Any]:
    target = _out(body.target_path, ".mizajbackup", request.app.state.data_dir)
    return await run_blocking(
        backup.export_backup,
        request.app.state.db_path,
        request.app.state.data_dir,
        target,
        body.include_models,
    )


@router.post("/api/backup/inspect")
async def backup_inspect(body: BackupPathIn) -> dict[str, Any]:
    p = _path(body.path, ".mizajbackup")
    return await run_blocking(backup.inspect_backup, p)


@router.post("/api/backup/restore")
async def backup_restore(body: BackupPathIn, request: Request) -> dict[str, Any]:
    p = _path(body.path, ".mizajbackup")
    manager.reset()
    gc.collect()
    res = await run_blocking(
        backup.restore, p, request.app.state.data_dir, request.app.state.db_path
    )
    manager.reset()
    return res
