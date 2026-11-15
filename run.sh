#!/usr/bin/env bash
# Quick start for the Property Analyser Flask app.
#
# Strategy (same as gk_crm): use the shared venv at
# /Users/vardangupta/deployment/venv if it can import our deps, otherwise
# build a local .venv from requirements.txt.

set -e
cd "$(dirname "$0")"

GLOBAL_VENV="/Users/vardangupta/deployment/venv"
VENV_DIR=".venv"

pick_python() {
  if [ -x "$GLOBAL_VENV/bin/python3" ] \
     && "$GLOBAL_VENV/bin/python3" -c "import dotenv, flask" >/dev/null 2>&1; then
    echo "$GLOBAL_VENV/bin/python3"
    return 0
  fi
  return 1
}

PYTHON="$(pick_python || true)"
if [ -z "$PYTHON" ]; then
  if [ ! -x "$VENV_DIR/bin/python3" ]; then
    echo "[run.sh] creating local venv..."
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install -q --upgrade pip
    "$VENV_DIR/bin/pip" install -q -r requirements.txt
  fi
  PYTHON="$VENV_DIR/bin/python3"
fi

# Optional .env; .env.example documents the knobs.
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[run.sh] created .env from .env.example"
fi

mkdir -p data

echo "[run.sh] starting Property Analyser on http://127.0.0.1:${PORT:-4180}"
exec "$PYTHON" app.py
