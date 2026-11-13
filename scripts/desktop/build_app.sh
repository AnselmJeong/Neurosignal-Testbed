#!/usr/bin/env bash
# Build the self-contained, relocatable "Neurosignal Testbed.app" (arm64 macOS).
#
#   scripts/desktop/build_app.sh [--build-only|--run|--install|--dmg]
#
#   --build-only  build apps/desktop/dist/"Neurosignal Testbed.app" (default)
#   --run         build, then open the app
#   --install     build, then copy it to /Volumes/Aquatope/Applications (replaces the old copy
#                 only after the new one is complete and verified)
#   --dmg         build, then create apps/desktop/dist/"Neurosignal Testbed-<version>-arm64.dmg"
#
# Steps: web (npm ci + build) -> python runtime (build_python_runtime.sh) -> electrobun build
# --env=stable -> unpack the real .app from the self-extractor -> payload checks -> Info.plist ->
# ad-hoc codesign + verify -> stage-and-swap into apps/desktop/dist (previous kept as
# "Neurosignal Testbed.previous.<ts>.app"). Logs: apps/desktop/build/*.log.
set -euo pipefail

MODE="${1:---build-only}"
case "$MODE" in
  --build-only|--run|--install|--dmg) ;;
  *) echo "Usage: $0 [--build-only|--run|--install|--dmg]" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$REPO/apps/desktop"
WEB="$REPO/apps/web"
BUILD="$DESKTOP/build"
DIST="$DESKTOP/dist"
APP_NAME="Neurosignal Testbed"
APP_BUNDLE="$DIST/$APP_NAME.app"
INSTALL_DIR="${NST_INSTALL_DIR:-/Volumes/Aquatope/Applications}"
BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
RUNTIME_PY="$BUILD/python-runtime/python/bin/python3.12"
APP_PY_REL="Contents/Resources/app/python-runtime/python/bin/python3.12"
APP_WEB_REL="Contents/Resources/app/web"

die() { echo "build_app: $*" >&2; exit 1; }
step_t=$SECONDS
step() { echo "==> [$((SECONDS - step_t)) s] $*"; }

[ "$(uname -m)" = arm64 ] || die "arm64 macOS only"
[ -x "$BUN_BIN" ] || die "bun not found (set BUN_BIN)"
[ -x "$NPM_BIN" ] || die "npm not found (set NPM_BIN)"
mkdir -p "$BUILD" "$DIST"

# 1) web app -> apps/web/dist (served by the backend at /, API at /api on the same origin)
step "web: npm ci + npm run build"
(cd "$WEB" && "$NPM_BIN" ci --no-audit --no-fund && "$NPM_BIN" run build) > "$BUILD/web.log" 2>&1 \
  || { tail -40 "$BUILD/web.log" >&2; die "web build failed (see $BUILD/web.log)"; }

# 2) relocatable python runtime -> apps/desktop/build/python-runtime
step "python runtime"
"$REPO/scripts/desktop/build_python_runtime.sh" > "$BUILD/python-runtime.log" 2>&1 \
  || { tail -40 "$BUILD/python-runtime.log" >&2; die "python runtime build failed (see $BUILD/python-runtime.log)"; }
tail -1 "$BUILD/python-runtime.log"

# electrobun.config.ts silently skips payload that does not exist: refuse to build without it.
[ -x "$RUNTIME_PY" ] || die "missing $RUNTIME_PY"
[ -f "$WEB/dist/index.html" ] || die "missing $WEB/dist/index.html"

# 3) electrobun stable build.
#    The python runtime is held aside meanwhile so the config does not copy it: Electrobun 2.0.6's
#    build.copy dereferences symlinks and resets mtimes, and pushing ~31k files through its copy,
#    tar and zstd takes ~15 min on an external disk. It is added with ditto in step 5 instead.
HELD="$BUILD/.python-runtime.held"
UNPACK_DIR=""; STAGED_APP=""
cleanup() {
  if [ -d "$HELD" ] && [ ! -e "$BUILD/python-runtime" ]; then /bin/mv "$HELD" "$BUILD/python-runtime"; fi
  if [ -n "$UNPACK_DIR" ]; then /bin/rm -rf "$UNPACK_DIR"; fi
  if [ -n "$STAGED_APP" ]; then /bin/rm -rf "$STAGED_APP"; fi
}
trap cleanup EXIT
step "electrobun build --env=stable"
/bin/rm -rf "$HELD" "$BUILD/stable-macos-arm64"
/bin/mv "$BUILD/python-runtime" "$HELD"
(cd "$DESKTOP" && "$BUN_BIN" install --frozen-lockfile && "$BUN_BIN" x electrobun build --env=stable) \
  > "$BUILD/electrobun.log" 2>&1 \
  || { tail -40 "$BUILD/electrobun.log" >&2; die "electrobun build failed (see $BUILD/electrobun.log)"; }
/bin/mv "$HELD" "$BUILD/python-runtime"
BUILT_APP="$BUILD/stable-macos-arm64/$APP_NAME.app"
[ -d "$BUILT_APP" ] || die "electrobun output not found: $BUILT_APP (see $BUILD/electrobun.log)"

# 4) the stable output is a self-extracting installer whose cross-volume rename fails on external
#    disks: ship the real bundle from its archive instead.
step "unpack + stage"
STAGED_APP="$DIST/.$APP_NAME.next.app"
/bin/rm -rf "$STAGED_APP"
UNPACK_DIR="$(mktemp -d "$BUILD/unpack.XXXXXX")"
ARCHIVE="$(find "$BUILT_APP/Contents/Resources" -maxdepth 1 -name '*.tar.zst' -print -quit)"
if [ -n "$ARCHIVE" ]; then
  /usr/bin/tar -xf "$ARCHIVE" -C "$UNPACK_DIR"
  INNER="$(find "$UNPACK_DIR" -maxdepth 1 -name '*.app' -print -quit)"
  [ -n "$INNER" ] || die "no .app inside $ARCHIVE"
  /bin/mv "$INNER" "$STAGED_APP"   # same volume: rename, no copy
else
  /usr/bin/ditto "$BUILT_APP" "$STAGED_APP"
fi
/bin/rm -rf "$UNPACK_DIR"; UNPACK_DIR=""

# 5) payload: the runtime via ditto (symlinks, modes, mtimes preserved; APFS clones, so no data
#    copy on the same volume), then check it is complete and runnable.
APP_RUNTIME="$STAGED_APP/Contents/Resources/app/python-runtime"
[ ! -e "$APP_RUNTIME" ] || die "electrobun unexpectedly bundled a python runtime; expected it held aside"
/usr/bin/ditto --clone "$BUILD/python-runtime" "$APP_RUNTIME"
[ -x "$STAGED_APP/$APP_PY_REL" ] && [ ! -L "$STAGED_APP/$APP_PY_REL" ] || die "bundled python missing: $APP_PY_REL"
[ -f "$STAGED_APP/$APP_WEB_REL/index.html" ] || die "bundled web app missing: $APP_WEB_REL/index.html"
src_links=$(find "$BUILD/python-runtime" -type l | wc -l | tr -d ' ')
app_links=$(find "$APP_RUNTIME" -type l | wc -l | tr -d ' ')
[ "$src_links" = "$app_links" ] || die "symlinks lost in bundled runtime ($app_links of $src_links)"
env -i HOME="$HOME" PATH=/usr/bin:/bin "$STAGED_APP/$APP_PY_REL" -I -c 'import neurobridge_api.desktop' \
  || die "bundled python cannot import neurobridge_api.desktop"

# 6) Info.plist
PLIST="$STAGED_APP/Contents/Info.plist"
plist_set() { # key type value
  /usr/libexec/PlistBuddy -c "Set :$1 $3" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$PLIST"
}
plist_set NSRemovableVolumesUsageDescription string "외장 볼륨에 있는 신호 데이터와 분석 결과를 읽고 저장합니다."
# Electrobun 2.0.6 writes CFBundleVersion only; Finder/About read the short version string.
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $VERSION" "$PLIST"
# Keep Electrobun's minimum if it sets one; otherwise declare the floor this build is tested on.
/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 13.0' "$PLIST"
/usr/bin/plutil -lint "$PLIST" >/dev/null

# 7) ad-hoc signature over the final bundle
step "codesign"
/usr/bin/codesign --force --deep --sign - "$STAGED_APP" > "$BUILD/signing.log" 2>&1 \
  || { tail -20 "$BUILD/signing.log" >&2; die "codesign failed (see $BUILD/signing.log)"; }
step "codesign --verify"
/usr/bin/codesign --verify --deep --strict "$STAGED_APP" || die "codesign verification failed"

# 8) swap into dist, keeping the previous build
# keep exactly one previous build (each is ~876 MB)
/bin/rm -rf "$DIST/$APP_NAME".previous.*.app
if [ -d "$APP_BUNDLE" ]; then /bin/mv "$APP_BUNDLE" "$DIST/$APP_NAME.previous.$(date +%Y%m%d%H%M%S).app"; fi
/bin/mv "$STAGED_APP" "$APP_BUNDLE"
step "built $APP_BUNDLE (version $VERSION, $(du -sh "$APP_BUNDLE" | cut -f1))"

case "$MODE" in
  --build-only) ;;
  --run) /usr/bin/open -n "$APP_BUNDLE" ;;
  --install)
    [ -d "$INSTALL_DIR" ] || die "install dir not found: $INSTALL_DIR"
    TARGET="$INSTALL_DIR/$APP_NAME.app"
    NEXT="$INSTALL_DIR/.$APP_NAME.next.app"
    /bin/rm -rf "$NEXT"
    /usr/bin/ditto --clone "$APP_BUNDLE" "$NEXT"
    /usr/bin/codesign --verify --deep --strict "$NEXT" || { /bin/rm -rf "$NEXT"; die "installed copy failed verification"; }
    if [ -n "$(S="$TARGET/Contents/" ps -axo pid=,command= | S="$TARGET/Contents/" awk 'index($0, ENVIRON["S"]) { print $1 }')" ]; then
      /bin/rm -rf "$NEXT"; die "$TARGET is running; quit it first"
    fi
    if [ -d "$TARGET" ]; then
      OLD="$INSTALL_DIR/.$APP_NAME.old.$(date +%Y%m%d%H%M%S).app"
      /bin/mv "$TARGET" "$OLD"
      /bin/mv "$NEXT" "$TARGET"
      /bin/rm -rf "$OLD"
    else
      /bin/mv "$NEXT" "$TARGET"
    fi
    step "installed $TARGET"
    ;;
  --dmg)
    step "dmg"
    DMG_PATH="$DIST/$APP_NAME-$VERSION-arm64.dmg"
    WORK_DIR="$(mktemp -d "$BUILD/dmg-stage.XXXXXX")"
    # macOS can reject mount points on external volumes: mount under the local temp dir.
    MOUNT_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/nst-dmg-mount.XXXXXX")"
    trap '/usr/bin/hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true; rmdir "$MOUNT_DIR" 2>/dev/null || true; /bin/rm -rf "$WORK_DIR"' EXIT
    mkdir "$WORK_DIR/contents"
    /usr/bin/ditto --clone "$APP_BUNDLE" "$WORK_DIR/contents/$APP_NAME.app"
    ln -s /Applications "$WORK_DIR/contents/Applications"
    /usr/bin/hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$WORK_DIR/contents" -format UDZO "$WORK_DIR/out.dmg"
    /usr/bin/hdiutil verify -quiet "$WORK_DIR/out.dmg"
    /usr/bin/hdiutil attach -quiet -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$WORK_DIR/out.dmg"
    /usr/bin/codesign --verify --deep --strict "$MOUNT_DIR/$APP_NAME.app"
    /usr/bin/hdiutil detach -quiet "$MOUNT_DIR"
    /bin/mv -f "$WORK_DIR/out.dmg" "$DMG_PATH"
    step "dmg $DMG_PATH ($(du -sh "$DMG_PATH" | cut -f1))"
    ;;
esac
