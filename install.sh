#!/bin/sh
# Neko Code installer (macOS / Linux) — downloads a standalone binary; no Bun required.
#   Latest:  curl -fsSL https://neko.holilihu.online/install.sh | sh
#   Pinned:  curl -fsSL https://neko.holilihu.online/install.sh | sh -s -- --version 0.7.7
#            (or set NEKO_VERSION=v0.7.7 before the one-liner)
set -e

REPO="meiiie/neko-core"
OS="$(uname -s)"
ARCH="$(uname -m)"

# --version <x.y.z> / -v <x.y.z> / a bare version argument (via `sh -s -- ...`) pins an exact release;
# falls back to the NEKO_VERSION env. The arg form is the cleaner rollback UX (no separate env line).
PIN="${NEKO_VERSION:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --version|-v) PIN="$2"; shift 2 ;;
    --version=*)  PIN="${1#*=}"; shift ;;
    [0-9]*.[0-9]*.[0-9]*|v[0-9]*.[0-9]*.[0-9]*) PIN="$1"; shift ;;
    *) shift ;;
  esac
done

case "$OS-$ARCH" in
  Linux-x86_64)              ASSET="neko-linux-x64" ;;
  Linux-aarch64|Linux-arm64) ASSET="neko-linux-arm64" ;;
  Darwin-arm64)              ASSET="neko-macos-arm64" ;;
  Darwin-x86_64)             ASSET="neko-macos-x64" ;;
  *) echo "neko: unsupported platform '$OS-$ARCH'. Build from source: https://github.com/$REPO" >&2; exit 1 ;;
esac

# Pinned install / ROLLBACK path: PIN (from --version / NEKO_VERSION) is an exact release; else latest.
case "$PIN" in
  v[0-9]*.[0-9]*.[0-9]*) TAG="$PIN"; echo "Pinned version: $TAG" ;;
  [0-9]*.[0-9]*.[0-9]*)  TAG="v$PIN"; echo "Pinned version: $TAG" ;;
  *)
    echo "Fetching latest version..."
    TAG="$(curl -fsSL --max-time 15 -H 'User-Agent: neko-installer' "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
    ;;
esac
LABEL="${TAG:-latest}"
echo "Installing Neko Code $LABEL ($ASSET)..."
if [ -n "$TAG" ]; then URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
else URL="https://github.com/$REPO/releases/latest/download/$ASSET"; fi

BIN_DIR="${NEKO_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/neko"
mkdir -p "$BIN_DIR"

if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --progress-bar "$URL" -o "$TARGET"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TARGET" "$URL"
else
  echo "neko: need curl or wget installed" >&2; exit 1
fi
chmod +x "$TARGET"

# Verify the binary actually runs; report its REAL version.
VER="$("$TARGET" version 2>/dev/null | head -1 || true)"
echo "  Installed to $TARGET"
echo "${VER:-Installed}"

# A PINNED install (NEKO_VERSION) is a HOLD: pause auto-update so the daily updater can't drag this
# exact version forward again. auto_update:false is honored by every release >= 0.7.4 (the one being
# installed), so the pin sticks. Uses python/node/sed as available; falls back to a hint. Resume: neko update.
if [ -n "$PIN" ]; then
  CFG_DIR="${HOME}/.neko-core"; CFG="${CFG_DIR}/config.json"; mkdir -p "$CFG_DIR"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CFG" <<'PY' 2>/dev/null && PINNED=1 || PINNED=0
import json,sys,os
p=sys.argv[1]
d={}
if os.path.exists(p):
    try: d=json.load(open(p))
    except Exception: d={}
d["auto_update"]=False
json.dump(d,open(p,"w"),indent=2)
PY
  else
    PINNED=0
  fi
  if [ "${PINNED:-0}" = "1" ]; then echo "  Pinned to $LABEL - auto-update paused so it holds. Resume with: neko update"
  else echo "  To hold this version, set \"auto_update\": false in ~/.neko-core/config.json (resume with: neko update)"; fi
fi

# PATH: always report the state.
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "  $BIN_DIR is already on your PATH." ;;
  *) echo "  Add it to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"   (then restart your shell)" ;;
esac

# SHADOW HEALING — an old `neko` earlier on PATH wins over this install. If it IS an older neko-core
# (verified by running it), remove it automatically; anything else is only reported, never touched.
NEWV="$(printf '%s' "$VER" | sed -n 's/^neko-core *\([0-9][0-9.]*\).*/\1/p')"
FOUND="$(command -v neko 2>/dev/null || true)"
if [ -n "$FOUND" ] && [ "$FOUND" != "$TARGET" ]; then
  OV="$("$FOUND" version 2>/dev/null | head -1 || true)"
  case "$OV" in neko-core*) ;; *) OV="$("$FOUND" --version 2>/dev/null | head -1 || true)" ;; esac  # pre-v0.3 CLIs only knew --version
  OLDV="$(printf '%s' "$OV" | sed -n 's/^neko-core *\([0-9][0-9.]*\).*/\1/p')"
  LOWEST="$(printf '%s\n%s\n' "$OLDV" "$NEWV" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)"
  if [ -n "$OLDV" ] && [ -n "$NEWV" ] && [ "$OLDV" != "$NEWV" ] && [ "$LOWEST" = "$OLDV" ]; then
    if rm -f "$FOUND" 2>/dev/null; then
      echo "  Removed outdated neko-core $OLDV at $FOUND (it shadowed this install)."
    else
      echo "WARNING: an OLD neko ($OV) shadows this install and could not be removed:"
      echo "  $FOUND    -> remove it:  rm \"$FOUND\""
    fi
  else
    echo "NOTE: another neko executable is on your PATH and may shadow this install:"
    echo "  $FOUND"
  fi
fi

echo ""
echo "Run 'neko' to get started!  (first time: 'neko init-user' to set up your API key)"
echo "  neko doctor   - check your setup (provider / model / API key)"
echo "  neko --yolo   - auto-approve mode: Neko runs tools without asking"
