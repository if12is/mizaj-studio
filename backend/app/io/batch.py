# ruff: noqa: E501
"""Batch folder processing (7.3.5)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from app.core import security
from app.core.errors import MizajError, validation_error
from app.engine.executor import run_blocking
from app.engine.factory import build_pipeline
from app.io.jobs import Job, JobRegistry

log = logging.getLogger("mizaj.batch")
JOBS = JobRegistry()
SUPPORTED = {"docx", "txt", "md", "srt", "epub", "pdf"}
BATCH_DIR = "batches"  # <data-dir>/batches/<job>.json (plan) + <job>.jsonl (journal)
DONE_SUFFIX = ".done"  # sidecar marker written next to every finished output (8.4.3)
KEEP_FINISHED_STATES = 20


def convert_file(*args: Any, **kw: Any) -> dict[str, Any]:
    from app.io.convert import convert_file  # lazy: python-docx/lxml (startup time)

    return convert_file(*args, **kw)


EXTS = {
    "docx": (".docx",), "txt": (".txt",), "md": (".md", ".markdown"), "srt": (".srt",),
    "epub": (".epub",), "pdf": (".pdf",),
}  # fmt: skip
OUT_EXT = {"pdf": ".txt"}
MAX_FILES = 10_000


def discover(input_dir: Path, output_dir: Path, formats: list[str], recursive: bool) -> list[Path]:
    exts = tuple(e for f in formats for e in EXTS[f])
    it = input_dir.rglob("*") if recursive else input_dir.glob("*")
    out_res = output_dir.resolve()
    files = []
    for p in sorted(it):
        if p.is_symlink() or not p.is_file() or p.name.startswith((".~", "~$")):
            continue
        if p.suffix.lower() not in exts:
            continue
        if not security._within(p.resolve(), input_dir.resolve()):
            continue  # symlinked directory pointing outside the input folder
        if out_res == p.resolve().parent or out_res in p.resolve().parents:
            continue  # never re-process our own output
        files.append(p)
        if len(files) > MAX_FILES:
            raise validation_error(f"too many files (> {MAX_FILES})")
    return files


def _target(
    src: Path, input_dir: Path, output_dir: Path, on_exist: str, taken: set[Path] | None = None
) -> Path | None:
    rel = src.relative_to(input_dir)
    ext = OUT_EXT.get(src.suffix.lower().lstrip("."), src.suffix)
    dst = output_dir / rel.with_suffix(ext)
    if dst.resolve() == src.resolve():
        dst = dst.with_name(dst.stem + "_mizaj" + dst.suffix)
    taken = taken if taken is not None else set()

    def busy(p: Path) -> bool:
        return p.exists() or p in taken

    if busy(dst):
        if on_exist == "skip":
            return None
        if on_exist == "rename":
            n = 1
            while busy(dst.with_name(f"{dst.stem}_{n}{dst.suffix}")):
                n += 1
            dst = dst.with_name(f"{dst.stem}_{n}{dst.suffix}")
    return dst


def validate_request(
    input_dir: str, output_dir: str, formats: list[str], data_dir: Path | None = None
) -> tuple[Path, Path]:
    i = security.safe_dir(input_dir, "input_dir")
    o = security.safe_dir(output_dir, "output_dir", kind="output", data_dir=data_dir)
    if i == o:
        raise validation_error(
            "output_dir must differ from input_dir (inputs are never overwritten)"
        )
    bad = [f for f in formats if f not in SUPPORTED]
    if bad or not formats:
        raise validation_error("unsupported formats", {"allowed": sorted(SUPPORTED), "got": bad})
    return i, o


# ------------------------------------------------------------------ resumable state (8.4.3)
def batches_dir(data_dir: Path) -> Path:
    return Path(data_dir) / BATCH_DIR


def marker_path(dst: Path) -> Path:
    return dst.with_name(dst.name + DONE_SUFFIX)


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def mark_done(dst: Path, src: Path) -> None:
    """Written only after the output is complete: `.done` records the output size."""
    _atomic_write(
        marker_path(dst),
        json.dumps({"src": str(src), "size": dst.stat().st_size, "finished_at": _now()}),
    )


def output_valid(dst: Path) -> bool:
    """A finished output: exists, size > 0 and its `.done` marker records the same size."""
    try:
        size = dst.stat().st_size
        if not dst.is_file() or size <= 0:
            return False
        marker = json.loads(marker_path(dst).read_text(encoding="utf-8"))
        return marker.get("size") == size
    except (OSError, ValueError, AttributeError):
        return False


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _state_file(data_dir: Path, job_id: str) -> Path:
    return batches_dir(data_dir) / f"{job_id}.json"


def _journal_file(data_dir: Path, job_id: str) -> Path:
    return batches_dir(data_dir) / f"{job_id}.jsonl"


def _save_state(job: Job, status: str | None = None) -> None:
    cfg = getattr(job, "cfg", None)
    if cfg is None:
        return
    cfg["status"] = status or job.status
    cfg["updated_at"] = _now()
    try:
        _atomic_write(_state_file(job.data_dir, job.id), json.dumps(cfg, ensure_ascii=False))  # type: ignore[attr-defined]
    except OSError:
        log.warning("could not persist batch state %s", job.id)


def _journal(job: Job, entry: dict[str, Any]) -> None:
    data_dir = getattr(job, "data_dir", None)
    if data_dir is None:
        return
    try:
        with open(_journal_file(data_dir, job.id), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        log.warning("could not append to the batch journal %s", job.id)


def _read_journal(data_dir: Path, job_id: str) -> list[dict[str, Any]]:
    out = []
    try:
        with open(_journal_file(data_dir, job_id), encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue  # a torn last line after a crash
    except OSError:
        pass
    return out


def _job_from_state(data_dir: Path, cfg: dict[str, Any]) -> Job:
    plan = cfg["plan"]
    journal = _read_journal(data_dir, cfg["id"])
    errors = [j["error"] for j in journal if j.get("status") == "error" and j.get("error")]
    skipped = sum(1 for it in plan if it["dst"] is None)
    outputs = [it["dst"] for it in plan if it["dst"] and output_valid(Path(it["dst"]))]
    status = cfg.get("status", "interrupted")
    if status in ("queued", "running"):
        status = "interrupted"  # the process died mid-run
    job = Job(
        "batch", total=len(plan), done=len(outputs) + skipped + len(errors), succeeded=len(outputs),
        skipped=skipped, current=None, outputs=outputs,
    )  # fmt: skip
    job.id = cfg["id"]
    job.status = status
    job.started_at = cfg.get("created_at", job.started_at)
    job.fields["errors"] = errors
    job.fields["resumable"] = status in ("interrupted", "failed", "cancelled") or bool(errors)
    job.data_dir = Path(data_dir)  # type: ignore[attr-defined]
    job.cfg = cfg  # type: ignore[attr-defined]
    return job


def load_job(data_dir: Path, job_id: str) -> Job | None:
    """Job from memory, else rebuilt from its persisted state (after a restart)."""
    job = JOBS.get(job_id)
    if job is not None:
        return job
    if not re.fullmatch(r"[0-9a-f]{6,32}", job_id or ""):
        return None
    try:
        cfg = json.loads(_state_file(data_dir, job_id).read_text(encoding="utf-8"))
        job = _job_from_state(data_dir, cfg)
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if job.status == "interrupted":
        _save_state(job, "interrupted")
    return JOBS.add(job)


def recover(data_dir: Path) -> list[Job]:
    """Startup: register jobs persisted by an earlier run; unfinished ones become 'interrupted'
    (resumable via POST /api/batch/{id}/resume). Old finished states are pruned."""
    d = batches_dir(data_dir)
    if not d.is_dir():
        return []
    files = sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime)
    finished = []
    jobs: list[Job] = []
    for p in files:
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if cfg.get("status") in ("done", "cancelled"):
            finished.append(p)
            continue
        job = load_job(data_dir, p.stem)
        if job is not None:
            jobs.append(job)
    for p in finished[:-KEEP_FINISHED_STATES]:
        p.unlink(missing_ok=True)
        p.with_suffix(".jsonl").unlink(missing_ok=True)
    return jobs


# ------------------------------------------------------------------ run / resume
async def start(
    db_path: Path,
    input_dir: str,
    output_dir: str,
    mode: str,
    level: str,
    formats: list[str],
    recursive: bool,
    on_exist: str = "rename",
    track_changes: bool = False,
    data_dir: Path | None = None,
) -> Job:
    i, o = validate_request(input_dir, output_dir, formats, data_dir)
    files = discover(i, o, formats, recursive)
    o.mkdir(parents=True, exist_ok=True)
    pipeline = await build_pipeline(mode, level, True)
    taken: set[Path] = set()
    plan = []
    for src in files:
        dst = _target(src, i, o, on_exist, taken)
        if dst is not None:
            taken.add(dst)
            marker_path(dst).unlink(missing_ok=True)  # a stale marker must not skip fresh work
        plan.append({"src": str(src), "dst": None if dst is None else str(dst)})
    job = JOBS.add(
        Job("batch", total=len(files), done=0, succeeded=0, skipped=0, current=None, outputs=[])
    )
    job.data_dir = data_dir  # type: ignore[attr-defined]
    job.cfg = {  # type: ignore[attr-defined]
        "id": job.id, "input_dir": str(i), "output_dir": str(o), "mode": mode, "level": level,
        "formats": formats, "recursive": recursive, "on_exist": on_exist,
        "track_changes": track_changes, "plan": plan, "created_at": _now(),
    }  # fmt: skip
    job.fields["resumable"] = data_dir is not None
    if data_dir is not None:
        _journal_file(data_dir, job.id).unlink(missing_ok=True)
        _save_state(job, "queued")
    _launch(job, pipeline, db_path)
    return job


async def resume(job: Job, db_path: Path) -> Job:
    """Continue an interrupted / failed / cancelled batch: outputs that are complete (size > 0
    and a matching `.done` marker) are kept and skipped; everything else is converted again."""
    if job.kind != "batch" or getattr(job, "cfg", None) is None:
        raise MizajError("ERR_VALIDATION", 409, "لا يمكن استئناف هذه المهمة.",
                         "Job is not resumable.", {})  # fmt: skip
    if job.status == "done" and not job.fields["errors"]:
        return job  # nothing left to do
    if job.status in ("queued", "running"):
        raise MizajError("ERR_VALIDATION", 409, "المهمة قيد التنفيذ بالفعل.",
                         "Job is already running.", {})  # fmt: skip
    cfg = job.cfg  # type: ignore[attr-defined]
    pipeline = await build_pipeline(cfg["mode"], cfg["level"], True)
    job.cancel_event.clear()
    job.finished_at = None
    job.update(errors=[], current=None, resumed=0)
    if getattr(job, "data_dir", None) is not None:
        _journal_file(job.data_dir, job.id).unlink(missing_ok=True)  # type: ignore[attr-defined]
    _launch(job, pipeline, db_path)
    return job


def _launch(job: Job, pipeline: Any, db_path: Path) -> None:
    cfg = job.cfg  # type: ignore[attr-defined]
    plan = cfg["plan"]
    o = Path(cfg["output_dir"])
    track_changes = cfg["track_changes"]
    persistent = getattr(job, "data_dir", None) is not None

    async def run() -> None:
        job.status = "running"
        job.update(done=0, succeeded=0, skipped=0, outputs=[], resumable=persistent)
        if persistent:
            _save_state(job, "running")
        try:
            for n, item in enumerate(plan, 1):
                if job.cancelled:
                    job.finish("cancelled")
                    job.update(resumable=persistent)
                    if persistent:
                        _save_state(job)
                    return
                src = Path(item["src"])
                job.update(current=str(src))
                try:
                    if item["dst"] is None:
                        job.update(skipped=job.fields["skipped"] + 1)
                    else:
                        dst = Path(item["dst"])
                        if output_valid(dst):  # finished before the interruption
                            job.update(resumed=job.fields.get("resumed", 0) + 1)
                        else:
                            dst.parent.mkdir(parents=True, exist_ok=True)
                            if not security._within(dst.parent.resolve(), o.resolve()):
                                raise validation_error("output path escapes output_dir")
                            marker_path(dst).unlink(missing_ok=True)
                            await run_blocking(
                                convert_file, src, dst, pipeline, db_path, track_changes
                            )
                            mark_done(dst, src)
                        job.fields["outputs"].append(str(dst))
                        job.update(succeeded=job.fields["succeeded"] + 1)
                except MizajError as exc:
                    err = {"path": str(src), **exc.envelope()}
                    job.add_error(err)
                    _journal(job, {"i": n - 1, "status": "error", "error": err})
                except Exception as exc:  # noqa: BLE001
                    log.exception("batch item failed")
                    err = {
                        "path": str(src),
                        "error_code": "ERR_INTERNAL",
                        "message_en": f"{type(exc).__name__} while processing the file",
                    }
                    job.add_error(err)
                    _journal(job, {"i": n - 1, "status": "error", "error": err})
                job.update(done=n)
                await asyncio.sleep(0)
            job.update(current=None, resumable=bool(job.fields["errors"]) and persistent)
            job.finish("done")
            if persistent:
                _save_state(job)
        except Exception:  # noqa: BLE001
            log.exception("batch crashed")
            job.finish("failed")
            job.update(resumable=persistent)
            if persistent:
                _save_state(job)

    job.task = asyncio.get_running_loop().create_task(run())  # type: ignore[attr-defined]


def snapshot(job: Job) -> dict[str, Any]:
    return job.snapshot()
