#!/usr/bin/env bash

# Start the local NeuroSignal API and browser client together.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
web_dir="$project_root/apps/web"
api_pid=""
api_url="http://127.0.0.1:8001"

cleanup() {
  local exit_code=$?

  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

release_port() {
  local port="$1"
  local pids pid attempt

  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN | sort -u)" || true
  if [[ -z "$pids" ]]; then
    return
  fi

  echo "Stopping existing listeners on port $port..."
  while IFS= read -r pid; do
    kill -TERM "$pid" 2>/dev/null || true
  done <<< "$pids"

  for attempt in {1..50}; do
    if ! lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done

  echo "Port $port is still in use; forcing the original listeners to stop..."
  while IFS= read -r pid; do
    if lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done <<< "$pids"

  for attempt in {1..20}; do
    if ! lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done

  echo "Cannot free port $port; startup stopped." >&2
  return 1
}

cd "$project_root"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js from https://nodejs.org/" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to verify that the local API started successfully." >&2
  exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to stop existing listeners on ports 5174 and 8001." >&2
  exit 1
fi

echo "Syncing Python dependencies..."
uv sync --extra dev --extra ica

if [[ ! -d "$web_dir/node_modules" ]]; then
  echo "Installing web dependencies..."
  npm --prefix "$web_dir" ci
fi

release_port 5174
release_port 8001

echo "Starting API at $api_url ..."
# Invoke Uvicorn as a module so a repository rename cannot leave us dependent
# on an absolute interpreter path embedded in .venv/bin/uvicorn.
uv run python -m uvicorn neurobridge_api.main:app \
  --host 127.0.0.1 \
  --port 8001 \
  --reload \
  --reload-dir "$project_root/packages/neurobridge_core/src" \
  --reload-dir "$project_root/apps/api" &
api_pid=$!

api_ready="false"
for _ in {1..50}; do
  if curl --fail --silent --show-error "$api_url/health" >/dev/null 2>&1; then
    api_ready="true"
    break
  fi

  if ! kill -0 "$api_pid" 2>/dev/null; then
    wait "$api_pid"
    echo "The API exited before it became ready; the web app was not started." >&2
    exit 1
  fi

  sleep 0.1
done

if [[ "$api_ready" != "true" ]]; then
  echo "The API did not become ready at $api_url within 5 seconds." >&2
  exit 1
fi

echo "API ready."

echo "Starting web app at http://127.0.0.1:5174 ..."
echo "Press Ctrl+C to stop both services."
npm --prefix "$web_dir" run dev
