"""PRAGMA user_version migration runner with pre-upgrade backup."""

from __future__ import annotations

import logging
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from app.core.database import connect

log = logging.getLogger("mizaj.migrations")

DEFAULT_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
_NAME = re.compile(r"^(\d+)_.*\.sql$")


class MigrationError(Exception):
    error_code = "ERR_DB_MIGRATION_FAILED"
    status = 500


def discover(migrations_dir: Path) -> list[tuple[int, Path]]:
    found = []
    for p in Path(migrations_dir).glob("*.sql"):
        m = _NAME.match(p.name)
        if m:
            found.append((int(m.group(1)), p))
    return sorted(found)


def _backup(db_path: Path, backups_dir: Path, old_version: int) -> Path:
    backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    dest = backups_dir / f"mizaj-{stamp}-v{old_version}.db"
    n = 1
    while dest.exists():
        dest = backups_dir / f"mizaj-{stamp}-{n}-v{old_version}.db"
        n += 1
    src = sqlite3.connect(str(db_path))
    dst = sqlite3.connect(str(dest))
    try:
        src.backup(dst)  # safe with WAL
    finally:
        dst.close()
        src.close()
    log.info("database backup created: %s", dest)
    return dest


def run_migrations(db_path: Path, backups_dir: Path, migrations_dir: Path | None = None) -> int:
    """Apply pending migrations; returns the resulting user_version."""
    db_path = Path(db_path)
    migrations = discover(migrations_dir or DEFAULT_MIGRATIONS_DIR)
    existing = db_path.exists() and db_path.stat().st_size > 0
    try:
        conn = connect(db_path)
    except sqlite3.Error as exc:
        raise MigrationError(f"cannot open database: {exc}") from exc
    try:
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        pending = [(v, p) for v, p in migrations if v > current]
        if not pending:
            return current
        if existing:
            try:
                _backup(db_path, Path(backups_dir), current)
            except (sqlite3.Error, OSError) as exc:
                raise MigrationError(f"backup failed: {exc}") from exc
        for version, path in pending:
            sql = path.read_text(encoding="utf-8")
            try:
                conn.executescript(
                    f"BEGIN;\n{sql}\n;\nPRAGMA user_version={int(version)};\nCOMMIT;"
                )
            except sqlite3.Error as exc:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                log.error("migration %s failed: %s", path.name, exc)
                raise MigrationError(f"migration {path.name} failed: {exc}") from exc
            log.info("applied migration %s", path.name)
        return conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()
