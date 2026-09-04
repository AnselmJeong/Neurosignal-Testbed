#!/usr/bin/env bash

# Start the local NeuroSignal API and browser client together.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
web_dir="$project_root/apps/web"
api_pid=""

cleanup() {
  local exit_code=$?

  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

cd "$project_root"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js from https://nodejs.org/" >&2
  exit 1
fi

echo "Syncing Python dependencies..."
uv sync --extra dev --extra ica

if [[ ! -d "$web_dir/node_modules" ]]; then
  echo "Installing web dependencies..."
  npm --prefix "$web_dir" ci
fi

echo "Starting API at http://127.0.0.1:8001 ..."
uv run uvicorn neurobridge_api.main:app \
  --host 127.0.0.1 \
  --port 8001 \
  --reload \
  --reload-dir "$project_root/packages/neurobridge_core/src" \
  --reload-dir "$project_root/apps/api" &
api_pid=$!

echo "Starting web app at http://127.0.0.1:5174 ..."
echo "Press Ctrl+C to stop both services."
npm --prefix "$web_dir" run dev
