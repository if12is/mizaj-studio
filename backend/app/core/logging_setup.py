"""Logging: rotating file + stderr. Never stdout (reserved for handshake lines)."""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_NAME = "mizaj-backend.log"
_TAG = "_mizaj_handler"
_FMT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def setup_logging(data_dir: Path, level: str | None = None) -> Path:
    log_dir = Path(data_dir) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / LOG_NAME
    lvl = getattr(
        logging, (level or os.environ.get("MIZAJ_LOG_LEVEL", "INFO")).upper(), logging.INFO
    )

    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, _TAG, False):
            root.removeHandler(h)
            h.close()
    fh = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
    sh = logging.StreamHandler(sys.stderr)
    for h in (fh, sh):
        h.setFormatter(logging.Formatter(_FMT))
        setattr(h, _TAG, True)
        root.addHandler(h)
    root.setLevel(lvl)
    return log_path


def shutdown_logging() -> None:
    """Close Mizaj's handlers so the log file can be deleted (Windows keeps open files locked)."""
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, _TAG, False):
            root.removeHandler(h)
            h.close()
