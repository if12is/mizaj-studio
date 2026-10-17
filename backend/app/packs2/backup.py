# ruff: noqa: E501
"""Full local backup / restore (`.mizajbackup`, 7.11.6): sqlite online-backup snapshot of the
database + downloaded resources (+ optionally models) in one zip with sha256 manifest."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.api.health import VERSION
from app.core.errors import MizajError
from app.core.migrations import DEFAULT_MIGRATIONS_DIR, discover, run_migrations
from app.packs2.schema import MAX_MEMBERS, safe_member

MARKER = "pending_restore.json"
DB_MEMBER = "db/mizaj.db"
_CHUNK = 1 << 20
MAX_BACKUP_BYTES = 16 * 1024**3


def _bad(reason: str, **d: Any) -> MizajError:
    return MizajError("ERR_BACKUP_INVALID", 422, "ملف النسخة الاحتياطية غير صالح.",
                      f"Invalid backup: {reason}", {"reason": reason, **d})  # fmt: skip


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while c := f.read(_CHUNK):
            h.update(c)
    return h.hexdigest()


def export_backup(
    db_path: Path, data_dir: Path, target: Path, include_models: bool = False
) -> dict:
    data_dir, target = Path(data_dir), Path(target)
    with tempfile.TemporaryDirectory(prefix="mizaj-bk-") as tmp:
        snap = Path(tmp) / "mizaj.db"
        src = sqlite3.connect(str(db_path))
        dst = sqlite3.connect(str(snap))
        try:
            src.backup(dst)
            uv = dst.execute("PRAGMA user_version").fetchone()[0]
        finally:
            dst.close()
            src.close()
        entries: list[tuple[str, Path]] = [(DB_MEMBER, snap)]
        roots = ["resources"] + (["models"] if include_models else [])
        for r in roots:
            base = data_dir / r
            if base.is_dir():
                for p in sorted(base.rglob("*")):
                    if (
                        p.is_file()
                        and not p.is_symlink()
                        and p.suffix != ".part"
                        and not p.name.startswith(".tmp")
                    ):
                        entries.append((f"{r}/{p.relative_to(base).as_posix()}", p))
        files = [{"path": n, "size": p.stat().st_size, "sha256": _sha(p)} for n, p in entries]
        manifest = {
            "format": 1, "kind": "backup", "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "app_version": VERSION, "db_user_version": uv, "includes_models": include_models,
            "files": files,
        }  # fmt: skip
        part = target.with_name(f".~mizaj_tmp.{uuid.uuid4().hex[:8]}.mizajbackup")
        try:
            with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                zf.writestr("manifest.json", json.dumps(manifest, indent=1))
                for n, p in entries:
                    zf.write(p, n)
            os.replace(part, target)
        finally:
            part.unlink(missing_ok=True)
    return {"path": str(target), "files": len(files), "bytes": sum(f["size"] for f in files),
            "db_user_version": uv, "includes_models": include_models}  # fmt: skip


def read_backup_manifest(zf: zipfile.ZipFile) -> dict[str, Any]:
    names = zf.namelist()
    if len(names) > MAX_MEMBERS * 20:
        raise _bad("too many files")
    for n in names:
        safe_member(n)
    try:
        m = json.loads(zf.read("manifest.json").decode("utf-8"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _bad("manifest.json missing or invalid") from exc
    if not isinstance(m, dict) or m.get("format") != 1 or m.get("kind") != "backup":
        raise _bad("not a Mizaj backup (need format 1, kind 'backup')")
    files = m.get("files")
    if not isinstance(files, list) or not any(
        f.get("path") == DB_MEMBER for f in files if isinstance(f, dict)
    ):
        raise _bad("backup has no database")
    total = 0
    for f in files:
        if (
            not isinstance(f, dict)
            or not isinstance(f.get("size"), int)
            or not isinstance(f.get("sha256"), str)
        ):
            raise _bad("malformed file entry")
        p = safe_member(f.get("path"))
        if not (p == DB_MEMBER or p.startswith(("resources/", "models/"))):
            raise _bad("unexpected path in backup", path=p)
        total += f["size"]
    if total > MAX_BACKUP_BYTES:
        raise _bad("backup too large")
    declared = {f["path"] for f in files}
    if set(names) - declared - {"manifest.json"}:
        raise _bad("file not listed in manifest")
    return m


def inspect_backup(path: Path) -> dict[str, Any]:
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise _bad("not a valid zip archive") from exc
    with zf:
        m = read_backup_manifest(zf)
    latest = max((v for v, _ in discover(DEFAULT_MIGRATIONS_DIR)), default=0)
    return {**{k: v for k, v in m.items() if k != "files"}, "files": len(m["files"]),
            "restorable": m.get("db_user_version", 0) <= latest, "app_schema_version": latest}  # fmt: skip


def stage_restore(path: Path, data_dir: Path) -> Path:
    """Extract + verify into <data-dir>/.restore-<id>/ and integrity-check the database."""
    stage = Path(data_dir) / f".restore-{uuid.uuid4().hex[:8]}"
    try:
        try:
            zf = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError) as exc:
            raise _bad("not a valid zip archive") from exc
        with zf:
            m = read_backup_manifest(zf)
            for f in m["files"]:
                dest = stage / f["path"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                h, n = hashlib.sha256(), 0
                try:
                    with zf.open(f["path"]) as s, open(dest, "wb") as o:
                        while c := s.read(_CHUNK):
                            n += len(c)
                            if n > f["size"]:
                                raise _bad("member larger than declared", path=f["path"])
                            h.update(c)
                            o.write(c)
                except (zipfile.BadZipFile, KeyError, RuntimeError) as exc:
                    raise _bad("corrupt member", path=f["path"]) from exc
                if n != f["size"] or h.hexdigest() != f["sha256"].lower():
                    raise _bad("sha256 mismatch", path=f["path"])
        db = stage / DB_MEMBER
        try:
            conn = sqlite3.connect(str(db))
            try:
                ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
                uv = conn.execute("PRAGMA user_version").fetchone()[0]
                conn.execute("SELECT 1 FROM settings LIMIT 1")
            finally:
                conn.close()
        except sqlite3.Error as exc:
            raise _bad(f"database unreadable: {exc}") from exc
        latest = max((v for v, _ in discover(DEFAULT_MIGRATIONS_DIR)), default=0)
        if ok != "ok":
            raise _bad("database integrity check failed")
        if uv > latest:
            raise MizajError("ERR_BACKUP_TOO_NEW", 422, "النسخة أحدث من إصدار التطبيق الحالي.",
                             "Backup was made by a newer app version.", {"db_user_version": uv})  # fmt: skip
        return stage
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def _swap_dir(stage_sub: Path, final: Path) -> None:
    old = None
    if final.exists():
        old = final.with_name(f".old-{final.name}-{uuid.uuid4().hex[:6]}")
        final.rename(old)
    try:
        stage_sub.rename(final)
    except OSError:
        if old is not None:
            old.rename(final)
        raise
    if old is not None:
        shutil.rmtree(old, ignore_errors=True)


def swap_in(stage: Path, data_dir: Path, db_path: Path) -> dict[str, Any]:
    """Safety-copy the live DB, then replace DB (+WAL/SHM) and resources/models."""
    data_dir = Path(data_dir)
    safety = None
    if Path(db_path).exists():
        (data_dir / "backups").mkdir(exist_ok=True)
        safety = (
            data_dir / "backups" / f"pre-restore-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.db"
        )
        src, dst = sqlite3.connect(str(db_path)), sqlite3.connect(str(safety))
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
    for suffix in ("-wal", "-shm"):
        Path(str(db_path) + suffix).unlink(missing_ok=True)
    os.replace(stage / DB_MEMBER, db_path)
    for sub in ("resources", "models"):
        if (stage / sub).is_dir():
            _swap_dir(stage / sub, data_dir / sub)
    shutil.rmtree(stage, ignore_errors=True)
    run_migrations(db_path, data_dir / "backups")
    return {"safety_backup": str(safety) if safety else None}


def restore(path: Path, data_dir: Path, db_path: Path) -> dict[str, Any]:
    """Validate, stage, then swap now; if the OS refuses (locked files) leave a pending marker
    that `apply_pending_restore` completes on the next start."""
    data_dir = Path(data_dir)
    stage = stage_restore(path, data_dir)
    try:
        res = swap_in(stage, data_dir, db_path)
        return {"status": "restored", **res}
    except OSError as exc:
        (data_dir / MARKER).write_text(json.dumps({"stage": stage.name}), encoding="utf-8")
        return {"status": "pending", "reason": str(exc),
                "note": "Restart the app to finish the restore."}  # fmt: skip


def apply_pending_restore(data_dir: Path, db_path: Path) -> bool:
    """Call once at startup BEFORE run_migrations. True when a pending restore was applied."""
    marker = Path(data_dir) / MARKER
    if not marker.is_file():
        return False
    try:
        stage = Path(data_dir) / json.loads(marker.read_text("utf-8"))["stage"]
        if stage.parent != Path(data_dir) or not (stage / DB_MEMBER).is_file():
            raise ValueError("stage missing")
        swap_in(stage, data_dir, db_path)
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        return False
    finally:
        pass
    marker.unlink(missing_ok=True)
    return True
