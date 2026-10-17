"""Mizaj Studio sidecar entrypoint: `python -m app.main --host 127.0.0.1 --port 0 --data-dir D`."""

from __future__ import annotations

import argparse
import ipaddress
import logging
import socket
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import dictionary, documents, health, projects, settings
from app.core.database import DB_NAME
from app.core.errors import MizajError, install_handlers
from app.core.logging_setup import setup_logging
from app.core.migrations import MigrationError, run_migrations

log = logging.getLogger("mizaj.main")


def create_app(data_dir: Path, migrations_dir: Path | None = None) -> FastAPI:
    """Build an isolated app bound to `data_dir` (logs, db, backups)."""
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(data_dir)
    db_path = data_dir / DB_NAME
    try:
        run_migrations(db_path, data_dir / "backups", migrations_dir)
    except MigrationError as exc:
        raise MizajError(
            "ERR_DB_MIGRATION_FAILED",
            500,
            "فشلت ترقية قاعدة البيانات. تم حفظ نسخة احتياطية.",
            str(exc),
        ) from exc
    app = FastAPI(title="Mizaj Studio Backend", version=health.VERSION)
    app.state.data_dir = data_dir
    app.state.db_path = db_path
    # Renderer runs from file:// (Origin: null) in production or the vite dev server.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["null"],
        allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_handlers(app)
    for mod in (health, projects, documents, settings, dictionary):
        app.include_router(mod.router)
    return app


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.version == 4 and ip.is_loopback


class _Server(uvicorn.Server):
    """Prints the handshake lines once the server has really started."""

    async def startup(self, sockets=None) -> None:  # type: ignore[override]
        await super().startup(sockets=sockets)
        if self.started and sockets:
            port = sockets[0].getsockname()[1]
            print(f"MIZAJ_PORT={port}", flush=True)
            print("MIZAJ_STATUS=READY", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.main")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".mizaj-studio")
    args = parser.parse_args(argv)
    if not _is_loopback(args.host):
        parser.error("refusing to bind to non-loopback host (only 127.0.0.1 is allowed)")
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")

    try:
        app = create_app(args.data_dir)
    except MizajError as exc:
        print(f"{exc.error_code}: {exc.message_en}", file=sys.stderr, flush=True)
        return 3

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", args.port))
    sock.listen(128)
    sock.setblocking(False)
    config = uvicorn.Config(app, log_config=None, access_log=False, lifespan="off")
    server = _Server(config)
    log.info("starting on 127.0.0.1:%d", sock.getsockname()[1])
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
