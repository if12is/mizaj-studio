"""Offline `.mizajpack` model packs: validate, verify, extract atomically.

Format: a zip with `manifest.json` {format:1, kind:"models", version, files:[{path, sha256,
size}]} plus the declared files (paths relative to <data-dir>/models/, e.g.
"catt_eo/encoder.onnx").
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from app.core import security
from app.core.errors import pack_invalid

log = logging.getLogger("mizaj.packs")
MANIFEST = "manifest.json"
INFO_FILE = "pack.json"
MAX_TOTAL_BYTES = 4 * 1024**3
MAX_MEMBERS = 5000
_CHUNK = 1 << 20


def _safe_rel(path: Any) -> PurePosixPath:
    if not isinstance(path, str) or not path or "\\" in path or "\x00" in path:
        raise pack_invalid("unsafe file path in manifest", {"path": str(path)})
    p = PurePosixPath(path)
    if p.is_absolute() or ".." in p.parts or (p.parts and p.parts[0].endswith(":")):
        raise pack_invalid("path escapes the models directory (zip-slip)", {"path": path})
    if len(p.parts) < 2:
        raise pack_invalid("files must live in a sub-directory, e.g. catt_eo/", {"path": path})
    return p


def read_manifest(zf: zipfile.ZipFile) -> dict[str, Any]:
    try:
        raw = zf.read(MANIFEST)
    except KeyError as exc:
        raise pack_invalid("manifest.json is missing") from exc
    try:
        m = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise pack_invalid("manifest.json is not valid JSON") from exc
    if not isinstance(m, dict) or m.get("format") != 1 or m.get("kind") != "models":
        raise pack_invalid("unsupported manifest (need format 1, kind 'models')")
    if not isinstance(m.get("version"), str) or not m["version"]:
        raise pack_invalid("manifest has no version")
    files = m.get("files")
    if not isinstance(files, list) or not files:
        raise pack_invalid("manifest lists no files")
    if len(files) > MAX_MEMBERS:
        raise pack_invalid("manifest lists too many files")
    for f in files:
        if not isinstance(f, dict) or not isinstance(f.get("sha256"), str):
            raise pack_invalid("malformed file entry in manifest")
        if not isinstance(f.get("size"), int) or f["size"] < 0:
            raise pack_invalid("malformed file size in manifest")
        _safe_rel(f.get("path"))
    if sum(f["size"] for f in files) > MAX_TOTAL_BYTES:
        raise pack_invalid("pack is too large")
    return m


def apply_pack(pack_path: Path, data_dir: Path) -> dict[str, Any]:
    """Blocking. Verifies every file's sha256 while extracting into a temp dir, then swaps
    each top-level model directory into <data-dir>/models/ with renames."""
    models = Path(data_dir) / "models"
    models.mkdir(parents=True, exist_ok=True)
    tmp = models / f".tmp-pack-{uuid.uuid4().hex[:10]}"
    try:
        try:
            zf = zipfile.ZipFile(pack_path)
        except (zipfile.BadZipFile, OSError) as exc:
            raise pack_invalid("not a valid zip archive") from exc
        with zf:
            security.check_zip(
                zf, max_members=MAX_MEMBERS, max_total=MAX_TOTAL_BYTES, max_member=MAX_TOTAL_BYTES,
                max_ratio=1000, error=lambda r: pack_invalid(r),
            )  # fmt: skip
            manifest = read_manifest(zf)
            names = {i.filename: i for i in zf.infolist()}
            tmp.mkdir()
            for entry in manifest["files"]:
                rel = _safe_rel(entry["path"])
                info = names.get(str(rel))
                if info is None:
                    raise pack_invalid("file listed in manifest is missing", {"path": str(rel)})
                if info.file_size != entry["size"]:
                    raise pack_invalid("size mismatch", {"path": str(rel)})
                dest = tmp.joinpath(*rel.parts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                h = hashlib.sha256()
                try:
                    with zf.open(info) as src, open(dest, "wb") as out:
                        while chunk := src.read(_CHUNK):
                            h.update(chunk)
                            out.write(chunk)
                except (zipfile.BadZipFile, RuntimeError) as exc:
                    raise pack_invalid("corrupt archive member", {"path": str(rel)}) from exc
                if h.hexdigest() != entry["sha256"].lower():
                    raise pack_invalid("sha256 mismatch", {"path": str(rel)})
        _swap_in(tmp, models)
        info = {
            "version": manifest["version"],
            "installed_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "files": [{"path": f["path"], "size": f["size"]} for f in manifest["files"]],
        }
        (models / INFO_FILE).write_text(json.dumps(info, indent=2), encoding="utf-8")
        log.info("applied model pack %s", manifest["version"])
        return info
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _swap_in(tmp: Path, models: Path) -> None:
    """Replace each top-level dir of `tmp` inside `models` (rename old aside, rename new in,
    roll back on failure)."""
    done: list[tuple[Path, Path | None]] = []
    try:
        for new in sorted(p for p in tmp.iterdir() if p.is_dir()):
            final = models / new.name
            old = None
            if final.exists():
                old = models / f".old-{new.name}-{uuid.uuid4().hex[:8]}"
                final.rename(old)
            done.append((final, old))
            new.rename(final)
    except OSError:
        for final, old in reversed(done):
            shutil.rmtree(final, ignore_errors=True)
            if old is not None:
                old.rename(final)
        raise
    for _, old in done:
        if old is not None:
            shutil.rmtree(old, ignore_errors=True)


def installed_info(data_dir: Path) -> dict[str, Any] | None:
    f = Path(data_dir) / "models" / INFO_FILE
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
