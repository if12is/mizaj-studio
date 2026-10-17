#!/usr/bin/env python3
"""Tashkeel accuracy harness entry point (DER / WER). See backend/eval/run_eval.py."""

import os
import sys

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

from eval.run_eval import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
