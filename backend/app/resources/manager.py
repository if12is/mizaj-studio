"""Free public resource catalog + background downloads (7.8.3)."""

from __future__ import annotations

import hashlib
import json
import shutil
import threading
from pathlib import Path
from typing import Any

from app.core.errors import MizajError, not_found, validation_error
from app.io.jobs import Job, JobRegistry
from app.resources import net

CATALOG_PATH = Path(__file__).resolve().parent / "catalog.json"
JOBS = JobRegistry()
_catalog_override: list[dict[str, Any]] | None = None


def set_catalog(entries: list[dict[str, Any]] | None) -> None:
    """Test hook: replace the catalog."""
    global _catalog_override
    _catalog_override = entries


def catalog() -> list[dict[str, Any]]:
    if _catalog_override is not None:
        return _catalog_override
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))["resources"]


def find(rid: str) -> dict[str, Any]:
    for r in catalog():
        if r["id"] == rid:
            return r
    raise not_found("Resource", rid)


def res_dir(data_dir: Path, rid: str) -> Path:
    return Path(data_dir) / "resources" / rid


def installed(data_dir: Path, r: dict[str, Any]) -> dict[str, Any] | None:
    meta = res_dir(data_dir, r["id"]) / "installed.json"
    try:
        return json.loads(meta.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def listing(data_dir: Path, db_path: Path) -> dict[str, Any]:
    enabled = net.get_switch(db_path, "online_resources")
    items = []
    for r in catalog():
        job = next(
            (j for j in reversed(JOBS.all()) if j.fields.get("resource_id") == r["id"]), None
        )
        items.append(
            {
                **r,
                "requires_user_file": r.get("sha256") is None,
                "installed": installed(data_dir, r),
                "job": job.snapshot() if job else None,
            }
        )
    return {"online_resources": enabled, "resources": items}


def _write_meta(data_dir: Path, r: dict[str, Any], digest: str, how: str) -> dict[str, Any]:
    meta = {
        "id": r["id"],
        "filename": r["filename"],
        "sha256": digest,
        "license": r["license"],
        "license_url": r["license_url"],
        "attribution": r["attribution"],
        "source": how,
        "path": str(res_dir(data_dir, r["id"]) / r["filename"]),
    }
    (res_dir(data_dir, r["id"]) / "installed.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return meta


def start_download(data_dir: Path, db_path: Path, rid: str, accept_license: bool) -> Job:
    r = find(rid)
    if not accept_license:
        raise MizajError(
            "ERR_LICENSE_NOT_ACCEPTED",
            409,
            "يجب قبول ترخيص المورد قبل التنزيل.",
            f"Accept the license ({r['license']}) first.",
            {"license": r["license"], "license_url": r["license_url"]},
        )
    net.require_switch(db_path, "online_resources")
    if r.get("sha256") is None:
        raise MizajError(
            "ERR_RESOURCE_NEEDS_FILE",
            409,
            "لا يوجد تحقق مضمون لهذا المورد؛ نزّله بنفسك ثم استورده.",
            "No pinned checksum: download the file yourself and use /import.",
            {"id": rid, "url": r["url"]},
        )
    job = JOBS.add(Job("download", resource_id=rid, bytes_done=0, bytes_total=r.get("size")))

    def prog(done: int, total: int | None) -> None:
        job.update(bytes_done=done, bytes_total=total)

    def run() -> None:
        job.status = "running"
        try:
            dest = res_dir(data_dir, rid) / r["filename"]
            digest = net.download(
                r["url"],
                dest,
                db_path=db_path,
                expected_sha256=r["sha256"],
                expected_size=r.get("size"),
                progress=prog,
                cancelled=lambda: job.cancelled,
            )
            job.update(result=_write_meta(data_dir, r, digest, "download"))
            job.finish("done")
        except MizajError as exc:
            job.update(error=exc.envelope())
            job.finish("cancelled" if exc.error_code == "ERR_TASK_CANCELLED" else "failed")
        except Exception as exc:  # noqa: BLE001
            job.update(error={"error_code": "ERR_INTERNAL", "message_en": str(exc)})
            job.finish("failed")

    threading.Thread(target=run, daemon=True, name=f"mizaj-dl-{rid}").start()
    return job


def import_file(data_dir: Path, rid: str, src: Path, accept_license: bool) -> dict[str, Any]:
    r = find(rid)
    if not accept_license:
        raise MizajError(
            "ERR_LICENSE_NOT_ACCEPTED", 409, "يجب قبول الترخيص.", "Accept the license first.",
            {"license": r["license"], "license_url": r["license_url"]},
        )  # fmt: skip
    src = Path(src)
    if not src.is_absolute() or not src.is_file():
        raise validation_error("path must be an absolute path of an existing file")
    h = hashlib.sha256()
    with open(src, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    digest = h.hexdigest()
    if r.get("sha256") and digest != r["sha256"]:
        raise net._checksum_error("sha256 mismatch", r["sha256"], digest)
    d = res_dir(data_dir, rid)
    d.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, d / r["filename"])
    return _write_meta(data_dir, r, digest, "user-file")
