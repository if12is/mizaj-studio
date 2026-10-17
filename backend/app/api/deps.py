from __future__ import annotations

import sqlite3
from collections.abc import Iterator

from fastapi import Request

from app.core.database import connect


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    """Per-request connection; sync dependency => runs in the threadpool.

    FastAPI may run this dependency, the endpoint and the teardown on different threadpool
    threads, so the same-thread check must be off. The connection is never shared between
    requests, so it is still used by one thread at a time.
    """
    conn = connect(request.app.state.db_path, check_same_thread=False)
    try:
        yield conn
    finally:
        conn.close()
