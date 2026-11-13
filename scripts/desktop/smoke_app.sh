#!/usr/bin/env bash
# Smoke-test a built "Neurosignal Testbed.app".
#
#   scripts/desktop/smoke_app.sh "apps/desktop/dist/Neurosignal Testbed.app"
#
# 1) bundle: python runtime + web payload present, signature valid.
# 2) backend exactly as the app launches it (bundled python, -I -u -m neurobridge_api.desktop,
#    cwd Resources/app) under `env -i HOME PATH=/usr/bin:/bin` with a temp data dir: READY line,
#    /api/health, /api/flow/concepts (16), / == bundled index.html, a tiny /api/flow/runs job
#    completes, SIGTERM exits 0 and leaves no python behind.
# 3) the real app: `open -n`, find its backend (port from <userData>/logs/backend.log), /api/health,
#    quit via AppleScript, wait for exit, assert no leftover python from the app.
# 4) signature still valid (nothing was written into the bundle).
# Exits non-zero on the first failure.
#
# Removable volumes: an app opened from an external disk (e.g. /Volumes/Aquatope) triggers macOS's
# "access files on a removable volume" prompt on its first launch (and again for every new ad-hoc
# build). Until someone answers it, removable-volume access stalls for other apps too. So step 3
# launches an internal-disk copy of the bundle unless SMOKE_OPEN_IN_PLACE=1 (use that only when a
# person is at the screen to click 허용, e.g. to time the first launch from the external volume).
set -euo pipefail

[ $# -eq 1 ] || { echo "Usage: [SMOKE_OPEN_IN_PLACE=1] $0 APP_PATH" >&2; exit 2; }
APP="$(cd "$1" && pwd -P)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_ID="local.neurosignal.testbed"
RT_REL="Contents/Resources/app/python-runtime"
PY_REL="$RT_REL/python/bin/python3.12"
RES="$APP/Contents/Resources/app"
PY="$APP/$PY_REL"
WEB="$RES/web"
RECIPE="$REPO/fixtures/recipes/flow-preview.json"
AS_DIR="$HOME/Library/Application Support/$BUNDLE_ID"
READY_TIMEOUT="${SMOKE_READY_TIMEOUT:-240}"
RUN_TIMEOUT="${SMOKE_RUN_TIMEOUT:-600}"
T0=$SECONDS

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
ok() { echo "ok  [$((SECONDS - T0)) s] $*"; }
# Processes whose command line contains a fixed string (never matches this pipeline itself).
procs() { S="$1" ps -axo pid=,command= | S="$1" awk 'index($0, ENVIRON["S"]) { print $1 }'; }
json() { "$PY" -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
now() { "$PY" -I -c 'import time; print(f"{time.time():.1f}")'; }
elapsed() { "$PY" -I -c "import time; print(f'{time.time() - $1:.1f}')"; }

# ---------------------------------------------------------------- 1) bundle
[ -d "$APP/Contents/MacOS" ] || fail "not an app bundle: $APP"
[ -x "$PY" ] && [ ! -L "$PY" ] || fail "bundled python missing: $PY"
[ -f "$WEB/index.html" ] || fail "bundled web app missing: $WEB/index.html"
[ -f "$RECIPE" ] || fail "recipe fixture missing: $RECIPE"
/usr/bin/codesign --verify --deep --strict "$APP" || fail "codesign verification failed"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = "$BUNDLE_ID" ] \
  || fail "unexpected bundle identifier"
[ -z "$(procs "$RES/python-runtime/")" ] || fail "python from this app is already running: $(procs "$RES/python-runtime/" | tr '\n' ' ')"
ok "bundle: $(du -sh "$APP" | cut -f1), python + web present, signature valid"

# ---------------------------------------------------------------- 2) backend as the app runs it
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/nst-smoke.XXXXXX")" && pwd -P)"   # physical path: ps shows /private/var/…
BPID=""; RUN_APP=""
cleanup() {
  if [ -n "$BPID" ] && kill -0 "$BPID" 2>/dev/null; then kill -TERM "$BPID" 2>/dev/null || true; fi
  if [ -n "$RUN_APP" ]; then  # never leave a launched app behind (and never delete it while running)
    for p in $(procs "$RUN_APP/Contents/"); do kill -TERM "$p" 2>/dev/null || true; done
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -z "$(procs "$RUN_APP/Contents/")" ] && break; sleep 1; done
  fi
  /bin/rm -rf "$WORK"
}
trap cleanup EXIT
start=$(now)
(cd "$RES" && exec env -i HOME="$HOME" PATH=/usr/bin:/bin "$PY" -I -u -m neurobridge_api.desktop \
  --data-dir "$WORK/data" --port 0 --parent-pid $$ --ready-stdout --web-dir "$WEB") \
  > "$WORK/stdout.txt" 2> "$WORK/backend.log" &
BPID=$!
PORT=""; deadline=$((SECONDS + READY_TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
  PORT="$(sed -n 's/^NEUROSIGNAL_READY {"port": \([0-9]*\),.*/\1/p' "$WORK/stdout.txt" | head -1)"
  [ -n "$PORT" ] && break
  kill -0 "$BPID" 2>/dev/null || { tail -30 "$WORK/backend.log" >&2; fail "backend exited before READY"; }
  sleep 0.25
done
[ -n "$PORT" ] || { tail -30 "$WORK/backend.log" >&2; fail "no READY line within ${READY_TIMEOUT} s"; }
BASE="http://127.0.0.1:$PORT"
ok "READY port $PORT after $(elapsed "$start") s (cold temp data dir)"

status=""; deadline=$((SECONDS + 15))
while [ $SECONDS -lt $deadline ]; do
  status="$(curl -sf --max-time 2 "$BASE/api/health" | json 'd.get("status")' 2>/dev/null || true)"
  [ "$status" = ready ] && break
  sleep 0.1
done
[ "$status" = ready ] || fail "/api/health not ready (got '$status')"
ok "/api/health ready"

n="$(curl -sf --max-time 30 "$BASE/api/flow/concepts" | json 'len(d["entries"])')"
[ "$n" = 16 ] || fail "/api/flow/concepts returned $n entries, expected 16"
ok "/api/flow/concepts: 16 entries"

curl -sf --max-time 10 "$BASE/" -o "$WORK/index.html" || fail "GET / failed"
cmp -s "$WORK/index.html" "$WEB/index.html" || fail "GET / is not the bundled index.html"
ok "/ serves the bundled index.html"

"$PY" -I -c '
import json, sys
recipe = json.load(open(sys.argv[1]))
recipe["title"] = "desktop smoke (20 s)"
recipe["simulation"].update(duration_s=20.0, burn_in_s=2.0)
recipe["observation"]["n_sensors"] = 16
recipe["methods"]["gc"]["max_order"] = 8
json.dump(recipe, open(sys.argv[2], "w"))' "$RECIPE" "$WORK/recipe.json"
run_start=$(now)
RUN_ID="$(curl -sf --max-time 30 -H 'content-type: application/json' --data @"$WORK/recipe.json" \
  "$BASE/api/flow/runs" | json 'd["run_id"]')" || fail "POST /api/flow/runs failed"
state=""; deadline=$((SECONDS + RUN_TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
  info="$(curl -sf --max-time 10 "$BASE/api/flow/runs/$RUN_ID?include_result=false")" || fail "GET flow run failed"
  state="$(json 'd["state"] + ("" if (d["job"].get("worker") or {}).get("alive") else ":done")' <<<"$info")"
  case "$state" in completed:done|failed:done|cancelled:done|interrupted:done) break ;; esac
  sleep 1
done
failures="$(json 'd["job"].get("failures")' <<<"$info")"
[ "$state" = completed:done ] && { [ "$failures" = "[]" ] || [ "$failures" = None ]; } \
  || fail "flow run $RUN_ID ended as '$state' failures=$failures"
ok "flow run completed in $(elapsed "$run_start") s (failures $failures)"

kill -TERM "$BPID"
deadline=$((SECONDS + 20))
while [ $SECONDS -lt $deadline ] && kill -0 "$BPID" 2>/dev/null; do sleep 0.25; done
kill -0 "$BPID" 2>/dev/null && fail "backend still running 20 s after SIGTERM"
rc=0; wait "$BPID" || rc=$?
BPID=""
[ "$rc" = 0 ] || fail "backend exit code $rc after SIGTERM"
sleep 1
[ -z "$(procs "$RES/python-runtime/")" ] || fail "leftover python after backend stop: $(procs "$RES/python-runtime/" | tr '\n' ' ')"
[ "$(wc -l < "$WORK/stdout.txt" | tr -d ' ')" = 1 ] || fail "backend stdout carried more than the READY line"
ok "backend stopped cleanly (exit 0), no leftover python"

# ---------------------------------------------------------------- 3) the real app
[ -z "$(procs "Neurosignal Testbed.app/Contents/MacOS/")" ] \
  || fail "another Neurosignal Testbed instance is running; quit it first"
mount_point="$(df -P "$APP" | awk 'NR == 2 { print $6 }')"
if [ "${SMOKE_OPEN_IN_PLACE:-0}" = 1 ] || [ "$mount_point" = / ] || [ "$mount_point" = /System/Volumes/Data ]; then
  RUN_APP="$APP"
else
  RUN_APP="$WORK/run/Neurosignal Testbed.app"
  mkdir -p "$WORK/run"
  copy_start=$SECONDS
  /usr/bin/ditto "$APP" "$RUN_APP"
  ok "app is on $mount_point: launching an internal-disk copy ($((SECONDS - copy_start)) s to copy; SMOKE_OPEN_IN_PLACE=1 opens it in place)"
fi
RUN_PY="$RUN_APP/$PY_REL"
# Remember how far each existing backend.log already goes, so only this launch is read.
shopt -s nullglob
: > "$WORK/offsets"
for log in "$AS_DIR"/*/logs/backend.log; do printf '%s\t%s\n' "$(stat -f %z "$log")" "$log" >> "$WORK/offsets"; done
offset_of() { awk -F '\t' -v p="$1" '$2 == p { print $1; f = 1 } END { if (!f) print 0 }' "$WORK/offsets"; }
app_start=$(now)
/usr/bin/open -n "$RUN_APP"
APORT=""; APID=""; ALOG=""; deadline=$((SECONDS + READY_TIMEOUT)); launched=$SECONDS
while [ $SECONDS -lt $deadline ]; do
  for log in "$AS_DIR"/*/logs/backend.log; do
    off=$(offset_of "$log")
    [ "$(stat -f %z "$log")" -ge "$off" ] || off=0   # rotated
    line="$(tail -c +$((off + 1)) "$log" | grep -E '^\[supervisor\] ready http://127\.0\.0\.1:[0-9]+ pid=[0-9]+' | tail -1 || true)"
    if [ -n "$line" ]; then
      APORT="$(sed -E 's/.*127\.0\.0\.1:([0-9]+) pid=([0-9]+).*/\1/' <<<"$line")"
      APID="$(sed -E 's/.*127\.0\.0\.1:([0-9]+) pid=([0-9]+).*/\2/' <<<"$line")"
      ALOG="$log"; break 2
    fi
  done
  [ -n "$(procs "$RUN_APP/Contents/MacOS/")" ] || [ $((SECONDS - launched)) -lt 10 ] \
    || fail "app is not running (no process under $RUN_APP/Contents/MacOS)"
  sleep 0.5
done
[ -n "$APORT" ] || fail "app backend not ready within ${READY_TIMEOUT} s (see $AS_DIR/*/logs; a pending macOS permission prompt also blocks startup)"
APP_READY_S="$(elapsed "$app_start")"
cmdline="$(ps -o command= -p "$APID" || true)"
case "$cmdline" in
  "$RUN_PY -I -u -m neurobridge_api.desktop "*) ;;
  *) fail "backend pid $APID is not the bundled runtime: '$cmdline'" ;;
esac
parent="$(ps -o ppid= -p "$APID" | tr -d ' ')"
case "$(ps -o command= -p "$parent" || true)" in
  "$RUN_APP/Contents/MacOS/"*) ;;
  *) fail "backend parent $parent is not a process of $RUN_APP" ;;
esac
status="$(curl -sf --max-time 5 "http://127.0.0.1:$APORT/api/health" | json 'd.get("status")' || true)"
[ "$status" = ready ] || fail "app backend /api/health: '$status'"
curl -sf --max-time 5 "http://127.0.0.1:$APORT/" -o /dev/null || fail "app backend GET / failed"
ok "app launched: backend pid $APID port $APORT ready after $APP_READY_S s (log $ALOG)"

quit_start=$(now)
# The first before-quit is vetoed while the backend stops, so AppleScript reports
# "User canceled (-128)"; the app exits shortly afterwards.
/usr/bin/osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
deadline=$((SECONDS + 30))
while [ $SECONDS -lt $deadline ]; do
  [ -z "$(procs "$RUN_APP/Contents/MacOS/")" ] && ! kill -0 "$APID" 2>/dev/null && break
  sleep 0.25
done
if [ -n "$(procs "$RUN_APP/Contents/MacOS/")" ] || kill -0 "$APID" 2>/dev/null; then
  fail "app did not exit within 30 s of quit"
fi
sleep 1
[ -z "$(procs "$RUN_APP/$RT_REL/")" ] || fail "leftover python after app quit: $(procs "$RUN_APP/$RT_REL/" | tr '\n' ' ')"
tail -c +$(($(offset_of "$ALOG") + 1)) "$ALOG" | grep '^\[supervisor\] backend exited code=0' >/dev/null \
  || fail "backend did not exit with code 0 on quit (see $ALOG)"
ok "app quit in $(elapsed "$quit_start") s; backend exited 0; no leftover python"

# ---------------------------------------------------------------- 4) bundle untouched
/usr/bin/codesign --verify --deep --strict "$APP" || fail "signature broken after running (something wrote into the bundle)"
[ "$RUN_APP" = "$APP" ] || /usr/bin/codesign --verify --deep --strict "$RUN_APP" \
  || fail "signature of the launched copy broken after running"
ok "signature still valid after running"
echo "SMOKE PASS: $APP (app ready ${APP_READY_S} s after open, total $((SECONDS - T0)) s)"
