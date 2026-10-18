"""Mizaj Studio sidecar entrypoint: `python -m app.main --host 127.0.0.1 --port 0 --data-dir D`."""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import logging
import os
import socket
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import arud as arud_api
from app.api import corrections as corrections_api
from app.api import dialect as dialect_api
from app.api import (
    dictionary,
    documents,
    health,
    packs,
    packs2,
    projects,
    proofread,
    quran,
    resources,
    settings,
    spelling,
    tashkeel,
    tools,
)
from app.api import docx as docx_api
from app.api import io as io_api
from app.api import irab as irab_api
from app.api import legal as legal_api
from app.api import names as names_api
from app.core import security
from app.core.database import DB_NAME
from app.core.errors import MizajError, install_handlers
from app.core.logging_setup import setup_logging
from app.core.migrations import MigrationError, run_migrations
from app.core.watchdog import start_parent_watchdog
from app.engine import config
from app.engine.manager import manager
from app.legal.store import seed_templates
from app.packs2.backup import apply_pending_restore

log = logging.getLogger("mizaj.main")


def create_app(
    data_dir: Path, migrations_dir: Path | None = None, api_token: str | None = None
) -> FastAPI:
    """Build an isolated app bound to `data_dir` (logs, db, backups).

    `api_token` (else env MIZAJ_API_TOKEN): when set, every request except `GET /health` must
    carry `X-Mizaj-Token`. The env var is removed so child processes do not inherit it.
    """
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(data_dir)
    db_path = data_dir / DB_NAME
    config.set_data_dir(data_dir)
    # Finish a backup restore that could not swap files while the app was running.
    apply_pending_restore(data_dir, db_path)
    try:
        run_migrations(db_path, data_dir / "backups", migrations_dir)
    except MigrationError as exc:
        raise MizajError(
            "ERR_DB_MIGRATION_FAILED",
            500,
            "فشلت ترقية قاعدة البيانات. تم حفظ نسخة احتياطية.",
            str(exc),
        ) from exc
    seed_templates(db_path)
    env_token = os.environ.pop(security.TOKEN_ENV, "") or None
    token = api_token or env_token
    if not token:
        security.warn_if_no_token()
    # no interactive docs / schema: the surface is only for the bundled renderer
    app = FastAPI(
        title="Mizaj Studio Backend",
        version=health.VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.api_token = token
    app.state.data_dir = data_dir
    app.state.db_path = db_path
    # Added first = innermost: CORS (added below) answers preflights before the token check.
    app.add_middleware(security.SecurityMiddleware)
    # Renderer runs from file:// (Origin: null) in production or the vite dev server.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["null"],
        allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["*"],
        allow_headers=["Content-Type", "Accept", "Authorization", "X-Mizaj-Token"],
    )
    install_handlers(app)
    for mod in (
        health,
        projects,
        documents,
        settings,
        dictionary,
        tashkeel,
        docx_api,
        packs,
        legal_api,
        spelling,
        proofread,
        arud_api,
        corrections_api,
        dialect_api,
        irab_api,
        names_api,
        quran,
        io_api,
        packs2,
        resources,
        tools,
    ):
        app.include_router(mod.router)
    _recover_interrupted_jobs(data_dir, db_path)
    return app


def _recover_interrupted_jobs(data_dir: Path, db_path: Path) -> None:
    """8.4: list downloads / batch jobs interrupted by a crash or restart as resumable."""
    try:
        from app.io import batch
        from app.resources import manager as resources_manager

        resources_manager.recover(data_dir, db_path)
        batch.recover(data_dir)
    except Exception:  # noqa: BLE001 - recovery must never prevent startup
        log.exception("could not recover interrupted jobs")


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
            # warm the engines in the background; the handshake above is never delayed
            self._warmup_task = asyncio.get_running_loop().create_task(manager.warmup())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.main")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".mizaj-studio")
    parser.add_argument(
        "--parent-pid",
        type=int,
        default=None,
        help="exit when this process dies (default: env MIZAJ_PARENT_PID)",
    )
    parser.add_argument(
        "--api-token",
        default=None,
        help="API token (prefer env MIZAJ_API_TOKEN: argv is visible to other local users)",
    )
    args = parser.parse_args(argv)
    if args.parent_pid is None and os.environ.get("MIZAJ_PARENT_PID", "").isdigit():
        args.parent_pid = int(os.environ["MIZAJ_PARENT_PID"])
    if not _is_loopback(args.host):
        parser.error("refusing to bind to non-loopback host (only 127.0.0.1 is allowed)")
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")

    try:
        app = create_app(args.data_dir, api_token=args.api_token)
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
    if args.parent_pid:

        def _stop() -> None:
            server.should_exit = True

        start_parent_watchdog(args.parent_pid, _stop)
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
