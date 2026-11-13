#!/usr/bin/env bash
# Build the relocatable Python runtime that ships inside the desktop app.
#
#   apps/desktop/build/python-runtime/python/bin/python3.12 -I -u -m neurobridge_api.desktop ...
#
# Approach (d-spike decision B): a pristine python-build-standalone CPython (installed by uv,
# relocatable via @executable_path rpaths), plus the locked third-party deps exported from
# uv.lock (no dev deps, extras simulation+metrics+pac) and the project as a non-editable wheel.
# The runtime is rebuilt from scratch on every run (idempotent) and only replaces the previous
# one after its import smoke test has passed. Build-time tools (uv) come from the shell PATH;
# the result needs nothing from PATH, uv, Homebrew or the repo .venv at run time.
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
OUT="${OUT:-$REPO/apps/desktop/build/python-runtime}"
PY_VERSION="${PY_VERSION:-3.12.11}"          # keep equal to the dev .venv interpreter
UV_BIN="${UV_BIN:-$(command -v uv || true)}"
[ -x "$UV_BIN" ] || { echo "build_python_runtime: uv not found (set UV_BIN)" >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "build_python_runtime: arm64 macOS only" >&2; exit 1; }

started=$SECONDS
mkdir -p "$(dirname "$OUT")"
# Work next to the output so the final rename stays on the same volume.
WORK="$(mktemp -d "$(dirname "$OUT")/.python-runtime.XXXXXX")"
trap '/bin/rm -rf "$WORK"' EXIT
STAGE="$WORK/python-runtime"
mkdir -p "$STAGE"

# 1) pristine python-build-standalone
UV_PYTHON_INSTALL_DIR="$WORK/pyinst" "$UV_BIN" python install "$PY_VERSION" --no-bin
/bin/mv "$WORK/pyinst/cpython-$PY_VERSION-macos-aarch64-none" "$STAGE/python"
/bin/rm -f "$STAGE/python/lib/python3.12/EXTERNALLY-MANAGED"   # we own this interpreter
PY="$STAGE/python/bin/python3.12"

# 2) locked third-party deps (runtime extras only) + project wheel (non-editable)
(cd "$REPO" && "$UV_BIN" export --frozen --no-dev --no-editable --no-emit-project \
  --extra simulation --extra metrics --extra pac --no-hashes -o "$WORK/req.txt" >/dev/null)
(cd "$REPO" && "$UV_BIN" build --wheel --out-dir "$WORK/wheels" >/dev/null)
"$UV_BIN" pip install --python "$PY" --no-cache --link-mode=copy \
  --compile-bytecode -r "$WORK/req.txt" "$WORK"/wheels/*.whl

# 3) trim things the backend never uses (~40 MB)
/bin/rm -rf "$STAGE/python/lib/python3.12/site-packages/pip" \
  "$STAGE/python/lib/python3.12/idlelib" "$STAGE/python/lib/python3.12/tkinter" \
  "$STAGE/python/lib/python3.12/test" "$STAGE/python/lib/python3.12/ensurepip"

# 4) bytecode that never goes stale: the runtime ends up inside a signed .app, so Python must not
#    write __pycache__ there. Timestamp pycs would be rejected (and rewritten) if a copy step
#    changed source mtimes; unchecked-hash pycs are used as-is. -I ignores PYTHONDONTWRITEBYTECODE.
#    A few vendored files are not valid Python 3 (they fail at import anyway); list, don't fail.
env -i HOME="$HOME" PATH=/usr/bin:/bin "$PY" -I -W ignore -m compileall -q -f -j 0 \
  --invalidation-mode unchecked-hash "$STAGE/python/lib/python3.12" > "$WORK/compileall.log" 2>&1 \
  || { echo "compileall: files that do not compile (ignored):"; grep -E '^\*\*\* Error compiling' "$WORK/compileall.log" || cat "$WORK/compileall.log"; }

# 5) smoke: imports resolve from the runtime only (scrubbed env, isolated mode)
env -i HOME="$HOME" PATH=/usr/bin:/bin "$PY" -I -c \
  'import neurobridge_api.main, neurobridge_api.desktop, tvb.simulator.lab, numba, mne_connectivity, specparam, tensorpac, antropy, bct; print("runtime ok")'

# 6) swap into place only after the smoke test passed
/bin/rm -rf "$OUT"
/bin/mv "$STAGE" "$OUT"
echo "python runtime: $OUT ($(du -sh "$OUT" | cut -f1), $((SECONDS - started)) s)"
