from __future__ import annotations

import sqlite3
from collections.abc import Iterator

from fastapi import Request

from app.core.database import connect


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    """Per-request connection; sync dependency => runs in the threadpool."""
    conn = connect(request.app.state.db_path)
    try:
        yield conn
    finally:
        conn.close()
