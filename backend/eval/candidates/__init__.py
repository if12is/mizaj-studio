"""Bake-off candidates that run outside the app (7.1.8). Eval-only, never shipped."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

RUNNER = Path(__file__).with_name("shakkala_runner.py")


def run_shakkala(sentences: list[str]) -> list[str]:
    """Run Shakkala (MIT, TensorFlow) in a separate interpreter given by MIZAJ_SHAKKALA_PYTHON."""
    py = os.environ.get("MIZAJ_SHAKKALA_PYTHON")
    if not py or not Path(py).exists():
        raise RuntimeError("set MIZAJ_SHAKKALA_PYTHON to a Python with tensorflow + shakkala")
    proc = subprocess.run(
        [py, str(RUNNER)],
        input=json.dumps(sentences),
        capture_output=True,
        text=True,
        timeout=3600,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"shakkala failed: {proc.stderr[-300:]}")
    line = proc.stdout.strip().splitlines()[-1]
    outs = json.loads(line)["outputs"]
    if len(outs) != len(sentences):
        raise RuntimeError("shakkala output count mismatch")
    return outs


__all__ = ["run_shakkala"]
