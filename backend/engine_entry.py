"""PyInstaller entry point for the frozen sidecar (same CLI as `python -m app.main`)."""

import multiprocessing
import sys

if __name__ == "__main__":
    multiprocessing.freeze_support()  # no-op unless a child process is spawned by a library
    from app.main import main

    sys.exit(main())
