"""Free public resource catalog + background downloads (7.8.3)."""

from __future__ import annotations

import hashlib
import json
import shutil
import threading
import zipfile
from pathlib import Path
from typing import Any

from app.core.errors import MizajError, not_found, validation_error
from app.io.jobs import Job, JobRegistry
from app.resources import downloads, net

CATALOG_PATH = Path(__file__).resolve().parent / "catalog.json"
JOBS = JobRegistry()
IMPORT_EXTS = (".txt", ".dic", ".aff", ".json", ".csv", ".tsv", ".zip", ".xml", ".mizajpack")
IMPORT_MAX_BYTES = 2 * 1024**3
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


def _verified(path: Path, sha256: str) -> bool:
    try:
        return path.is_file() and downloads._sha256_file(path) == sha256.lower()
    except OSError:
        return False


def _post_install(data_dir: Path, r: dict[str, Any]) -> None:
    """Resources with `extract_to` are zip archives unpacked (safely) next to the download."""
    sub = r.get("extract_to")
    if not sub:
        return
    base = res_dir(data_dir, r["id"])
    zip_extract(base / r["filename"], base / sub, int(r.get("extract_max_bytes") or 500_000_000))


def zip_extract(archive: Path, dest: Path, max_bytes: int) -> None:
    """Extract `archive` into a fresh `dest`: no absolute/`..` paths, no symlinks, size-capped."""
    tmp = dest.with_name(dest.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    root = tmp.resolve()
    total = 0
    try:
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                total += info.file_size
                target = (tmp / info.filename).resolve()
                mode = info.external_attr >> 16
                if (
                    total > max_bytes
                    or not target.is_relative_to(root)
                    or (mode & 0o170000) == 0o120000
                ):
                    raise zipfile.BadZipFile("unsafe archive")
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
        # the archive has one top-level folder (piper/): flatten it
        kids = list(tmp.iterdir())
        src_dir = kids[0] if len(kids) == 1 and kids[0].is_dir() else tmp
        shutil.rmtree(dest, ignore_errors=True)
        shutil.move(str(src_dir), str(dest))
    except (zipfile.BadZipFile, OSError) as exc:
        raise MizajError(
            "ERR_DOWNLOAD_FAILED", 422, "تعذر فك ضغط الملف المنزَّل.",
            "Archive could not be extracted safely.", {"reason": type(exc).__name__},
        ) from exc  # fmt: skip
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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
    if r.get("extract_to"):
        meta["extracted_to"] = str(res_dir(data_dir, r["id"]) / r["extract_to"])
    if r.get("extra_files"):
        meta["files"] = [x["filename"] for x in r["extra_files"]]
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
    job = _find_job(data_dir, rid)
    if job is not None and job.status in ("queued", "running"):
        return job  # already in progress: never run two writers on the same partial file
    if job is None or job.finished:
        job = JOBS.add(
            Job("download", resource_id=rid, bytes_done=0, bytes_total=r.get("size"))
        )
    job.data_dir = Path(data_dir)  # type: ignore[attr-defined]
    _launch(job, data_dir, db_path, r)
    return job


def dl_key(rid: str) -> str:
    return f"res-{rid}"


def _find_job(data_dir: Path, rid: str) -> Job | None:
    for j in reversed(JOBS.all()):
        if j.fields.get("resource_id") == rid and getattr(j, "data_dir", None) == Path(data_dir):
            return j
    return None


def _launch(job: Job, data_dir: Path, db_path: Path, r: dict[str, Any]) -> None:
    """Run the (resumable) download of resource `r` in a thread; progress goes to `job`."""
    rid = r["id"]
    job.cancel_event.clear()
    job.status = "running"
    job.finished_at = None
    job.update(error=None, retrying=None, resumable=True)

    def prog(done: int, total: int | None) -> None:
        job.update(bytes_done=done, bytes_total=total, retrying=None)

    def waiting(attempt: int, delay: float, reason: str) -> None:
        job.update(retrying={"attempt": attempt, "in_seconds": round(delay, 1), "reason": reason})

    def run() -> None:
        try:
            # small companion files first, the main (large) file last: an interrupted run then
            # always leaves the resumable state under the main key
            extras = r.get("extra_files") or []
            for i, x in enumerate(extras):
                xdest = res_dir(data_dir, rid) / x["filename"]
                if _verified(xdest, x["sha256"]):
                    continue
                downloads.fetch(
                    x["url"], xdest, data_dir=data_dir, key=f"{dl_key(rid)}-x{i}", db_path=db_path,
                    expected_sha256=x["sha256"], expected_size=x.get("size"),
                    cancelled=lambda: job.cancelled, on_wait=waiting,
                    extra={"filename": x["filename"], "license_accepted": True},
                )  # fmt: skip
            dest = res_dir(data_dir, rid) / r["filename"]
            digest = downloads.fetch(
                r["url"],
                dest,
                data_dir=data_dir,
                key=dl_key(rid),
                db_path=db_path,
                expected_sha256=r["sha256"],
                expected_size=r.get("size"),
                progress=prog,
                cancelled=lambda: job.cancelled,
                on_wait=waiting,
                extra={"resource_id": rid, "filename": r["filename"], "license_accepted": True},
            )
            _post_install(data_dir, r)
            job.update(result=_write_meta(data_dir, r, digest, "download"), resumable=False)
            job.finish("done")
        except MizajError as exc:
            job.update(error=exc.envelope())
            if exc.error_code == "ERR_TASK_CANCELLED":
                job.update(resumable=False)
                job.finish("cancelled")
            elif downloads.load_state(data_dir, dl_key(rid)) is not None:
                # retries exhausted but the partial is kept: resumable on request / next start
                job.status = "paused"
            else:
                job.update(resumable=False)
                job.finish("failed")
        except Exception as exc:  # noqa: BLE001
            job.update(
                error={"error_code": "ERR_INTERNAL", "message_en": type(exc).__name__},
                resumable=False,
            )
            job.finish("failed")

    threading.Thread(target=run, daemon=True, name=f"mizaj-dl-{rid}").start()


def recover(data_dir: Path, db_path: Path, *, auto: bool = True) -> list[Job]:
    """Startup: list unfinished downloads from <data-dir>/downloads as 'paused' jobs; when the
    online switch is on (and the licence was accepted) resume them automatically."""
    jobs: list[Job] = []
    for st in downloads.list_states(data_dir):
        rid = st.get("resource_id")
        if not rid or _find_job(data_dir, rid) is not None:
            continue
        job = JOBS.add(
            Job(
                "download", resource_id=rid, bytes_done=st.get("bytes_done", 0),
                bytes_total=st.get("total") or st.get("expected_size"), resumable=True,
            )
        )
        job.data_dir = Path(data_dir)  # type: ignore[attr-defined]
        job.status = "paused"
        jobs.append(job)
    if auto and jobs:
        try:
            on = net.get_switch(db_path, "online_resources")
        except Exception:  # noqa: BLE001 - DB not ready: stay paused
            on = False
        if on:
            for job in jobs:
                try:
                    resume(data_dir, db_path, job)
                except MizajError:
                    pass  # unknown resource in the catalog etc.: stays paused
    return jobs


def resume(data_dir: Path, db_path: Path, job: Job) -> Job:
    """Continue a paused/failed-but-resumable download job."""
    if job.status in ("queued", "running"):
        return job
    if job.kind != "download" or not job.fields.get("resumable"):
        raise MizajError(
            "ERR_VALIDATION", 409, "لا يمكن استئناف هذه المهمة.", "Job is not resumable.", {}
        )
    r = find(job.fields["resource_id"])
    st = downloads.load_state(data_dir, dl_key(r["id"]))
    if not st or not st.get("license_accepted"):
        raise MizajError(
            "ERR_LICENSE_NOT_ACCEPTED", 409, "يجب قبول الترخيص.", "Accept the license first.",
            {"license": r["license"], "license_url": r["license_url"]},
        )
    net.require_switch(db_path, "online_resources")
    _launch(job, data_dir, db_path, r)
    return job


def cancel(data_dir: Path, job: Job) -> Job:
    """Cancel a job; a paused download has no thread to notice, so clean it here."""
    job.cancel_event.set()
    if job.kind == "download" and job.status == "paused":
        downloads.discard(data_dir, dl_key(job.fields["resource_id"]))
        job.update(resumable=False)
        job.finish("cancelled")
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
    _post_install(data_dir, r)
    return _write_meta(data_dir, r, digest, "user-file")
