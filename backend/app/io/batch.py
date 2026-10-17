# ruff: noqa: E501
"""Batch folder processing (7.3.5)."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from app.core.errors import MizajError, validation_error
from app.engine.executor import run_blocking
from app.engine.factory import build_pipeline
from app.io.convert import convert_file
from app.io.jobs import Job, JobRegistry

log = logging.getLogger("mizaj.batch")
JOBS = JobRegistry()
SUPPORTED = {"docx", "txt", "md", "srt", "epub", "pdf"}
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
        if out_res == p.resolve().parent or out_res in p.resolve().parents:
            continue  # never re-process our own output
        files.append(p)
        if len(files) > MAX_FILES:
            raise validation_error(f"too many files (> {MAX_FILES})")
    return files


def _target(src: Path, input_dir: Path, output_dir: Path, on_exist: str) -> Path | None:
    rel = src.relative_to(input_dir)
    ext = OUT_EXT.get(src.suffix.lower().lstrip("."), src.suffix)
    dst = output_dir / rel.with_suffix(ext)
    if dst.resolve() == src.resolve():
        dst = dst.with_name(dst.stem + "_mizaj" + dst.suffix)
    if dst.exists():
        if on_exist == "skip":
            return None
        if on_exist == "rename":
            n = 1
            while dst.with_name(f"{dst.stem}_{n}{dst.suffix}").exists():
                n += 1
            dst = dst.with_name(f"{dst.stem}_{n}{dst.suffix}")
    return dst


def validate_request(input_dir: str, output_dir: str, formats: list[str]) -> tuple[Path, Path]:
    i, o = Path(input_dir), Path(output_dir)
    if not i.is_absolute() or not o.is_absolute():
        raise validation_error("input_dir and output_dir must be absolute paths")
    if not i.is_dir():
        raise validation_error("input_dir does not exist", {"input_dir": input_dir})
    if i.resolve() == o.resolve():
        raise validation_error(
            "output_dir must differ from input_dir (inputs are never overwritten)"
        )
    bad = [f for f in formats if f not in SUPPORTED]
    if bad or not formats:
        raise validation_error("unsupported formats", {"allowed": sorted(SUPPORTED), "got": bad})
    return i, o


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
) -> Job:
    i, o = validate_request(input_dir, output_dir, formats)
    files = discover(i, o, formats, recursive)
    o.mkdir(parents=True, exist_ok=True)
    pipeline = await build_pipeline(mode, level, True)
    job = JOBS.add(
        Job("batch", total=len(files), done=0, succeeded=0, skipped=0, current=None, outputs=[])
    )

    async def run() -> None:
        job.status = "running"
        try:
            for n, src in enumerate(files, 1):
                if job.cancelled:
                    job.finish("cancelled")
                    return
                job.update(current=str(src))
                try:
                    dst = _target(src, i, o, on_exist)
                    if dst is None:
                        job.update(skipped=job.fields["skipped"] + 1)
                    else:
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        await run_blocking(convert_file, src, dst, pipeline, db_path, track_changes)
                        job.fields["outputs"].append(str(dst))
                        job.update(succeeded=job.fields["succeeded"] + 1)
                except MizajError as exc:
                    job.add_error({"path": str(src), **exc.envelope()})
                except Exception as exc:  # noqa: BLE001
                    log.exception("batch item failed")
                    job.add_error(
                        {"path": str(src), "error_code": "ERR_INTERNAL", "message_en": str(exc)}
                    )
                job.update(done=n)
                await asyncio.sleep(0)
            job.update(current=None)
            job.finish("done")
        except Exception:  # noqa: BLE001
            log.exception("batch crashed")
            job.finish("failed")

    job.task = asyncio.get_running_loop().create_task(run())  # type: ignore[attr-defined]
    return job


def snapshot(job: Job) -> dict[str, Any]:
    return job.snapshot()
