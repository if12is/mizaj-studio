#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "=== [Mizaj Studio] Setting up Environment in: $ROOT_DIR ==="

# 1. Verify Python version
if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is not installed." >&2
    exit 1
fi

# 2. Setup Python Backend Virtual Environment (using subshell so CWD is safe)
if [ -d "$ROOT_DIR/backend" ]; then
    echo "-> Configuring Python backend virtual environment..."
    (
        cd "$ROOT_DIR/backend"
        python3 -m venv .venv
        "$ROOT_DIR/backend/.venv/bin/pip" install --upgrade pip
        if [ -f "requirements.txt" ]; then
            "$ROOT_DIR/backend/.venv/bin/pip" install -r requirements.txt
        fi
    )
    echo "-> Verifying backend models (dry-run if offline/CI)..."
    "$ROOT_DIR/backend/.venv/bin/python" "$ROOT_DIR/scripts/download_models.py" --verify-or-mock
fi

# 3. Setup Electron + Vue 3 Frontend
if [ -d "$ROOT_DIR/desktop" ]; then
    if ! command -v npm >/dev/null 2>&1; then
        echo "ERROR: npm is not installed." >&2
        exit 1
    fi
    echo "-> Installing Desktop frontend dependencies..."
    (
        cd "$ROOT_DIR/desktop"
        npm install
    )
fi

echo "=== [Mizaj Studio] Environment Setup Complete Successfully ==="
