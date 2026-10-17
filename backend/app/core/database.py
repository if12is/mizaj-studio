"""SQLite helpers (WAL, pragmas, serialized writes with retry)."""

from __future__ import annotations

import logging
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

log = logging.getLogger("mizaj.db")

DB_NAME = "mizaj.db"


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def connect(db_path: Path, check_same_thread: bool = True) -> sqlite3.Connection:
    """Open a connection in autocommit mode (transactions managed via `write`)."""
    conn = sqlite3.connect(
        str(db_path), timeout=5.0, isolation_level=None, check_same_thread=check_same_thread
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


@contextmanager
def write(
    conn: sqlite3.Connection, retries: int = 5, delay: float = 0.1
) -> Iterator[sqlite3.Connection]:
    """Serialized write transaction; retries BEGIN IMMEDIATE on 'database is locked'."""
    attempt = 0
    while True:
        try:
            conn.execute("BEGIN IMMEDIATE")
            break
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() or attempt >= retries:
                raise
            attempt += 1
            log.warning("database locked, retry %d/%d", attempt, retries)
            time.sleep(delay * attempt)
    try:
        yield conn
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
