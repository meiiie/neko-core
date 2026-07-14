#!/bin/sh
# Neko Code installer (macOS / Linux) — downloads a standalone binary; no Bun required.
#   Latest:  curl -fsSL https://neko.holilihu.online/install.sh | sh
#   Pinned:  curl -fsSL https://neko.holilihu.online/install.sh | sh -s -- --version 0.9.0
#            (or set NEKO_VERSION=v0.9.0 before the one-liner)
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
    if command -v curl >/dev/null 2>&1; then
      TAG="$(curl -fsSL --max-time 15 -H 'User-Agent: neko-installer' "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
      case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) ;;
        *) FINAL="$(curl -fsSL --max-time 15 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
           TAG="$(printf '%s' "$FINAL" | sed -n 's#^.*/releases/tag/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$#\1#p')" ;;
      esac
    elif command -v wget >/dev/null 2>&1; then
      TAG="$(wget -qO- --timeout=15 --header='User-Agent: neko-installer' "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
      case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) ;;
        *) TAG="$(wget --server-response --spider --timeout=15 "https://github.com/$REPO/releases/latest" 2>&1 | sed -n 's#.*[Ll]ocation: .*/releases/tag/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*#\1#p' | tail -1 || true)" ;;
      esac
    fi
    ;;
esac
LABEL="${TAG:-latest}"
case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "neko: could not resolve a stable release tag" >&2; exit 1 ;; esac
echo "Installing Neko Code $LABEL ($ASSET)..."
if [ -n "$TAG" ]; then URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
else URL="https://github.com/$REPO/releases/latest/download/$ASSET"; fi
SUM_URL="$URL.sha256"

BIN_DIR="${NEKO_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/neko"
mkdir -p "$BIN_DIR"
STAGE="$BIN_DIR/.neko-download-$$"
SUM_STAGE="$STAGE.sha256"
cleanup() { rm -f "$STAGE" "$SUM_STAGE"; }
trap cleanup EXIT HUP INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --progress-bar "$URL" -o "$STAGE"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$STAGE" "$URL"
else
  echo "neko: need curl or wget installed" >&2; exit 1
fi

# v0.10.0+ publishes one checksum asset beside every binary. Older pinned releases remain installable
# through the version probe below because those historical releases predate checksum sidecars.
MAJOR="$(printf '%s' "$TAG" | sed 's/^v//' | cut -d. -f1)"
MINOR="$(printf '%s' "$TAG" | sed 's/^v//' | cut -d. -f2)"
REQUIRE_SUM=0
if [ "${MAJOR:-0}" -gt 0 ] || [ "${MINOR:-0}" -ge 10 ]; then REQUIRE_SUM=1; fi
GOT_SUM=0
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 "$SUM_URL" -o "$SUM_STAGE" 2>/dev/null && GOT_SUM=1 || true
else
  wget -qO "$SUM_STAGE" "$SUM_URL" 2>/dev/null && GOT_SUM=1 || true
fi
if [ "$GOT_SUM" = 1 ]; then
  EXPECTED="$(awk 'NR==1 {print $1}' "$SUM_STAGE")"
  case "$EXPECTED" in *[!0-9a-fA-F]*|'') echo "neko: release checksum is invalid" >&2; exit 1 ;; esac
  if [ "${#EXPECTED}" -ne 64 ]; then echo "neko: release checksum is invalid" >&2; exit 1; fi
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$STAGE" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$STAGE" | awk '{print $1}')"
  else echo "neko: need sha256sum or shasum to verify this release" >&2; exit 1; fi
  if [ "$(printf '%s' "$ACTUAL" | tr 'A-F' 'a-f')" != "$(printf '%s' "$EXPECTED" | tr 'A-F' 'a-f')" ]; then
    echo "neko: downloaded SHA-256 does not match the release" >&2; exit 1
  fi
  VERIFY_NOTE="SHA-256 verified"
elif [ "$REQUIRE_SUM" = 1 ]; then
  echo "neko: release $TAG is missing its required checksum asset" >&2; exit 1
else
  echo "  Historical release: checksum sidecar unavailable; using the signed tag + version probe."
  VERIFY_NOTE="version verified"
fi
chmod +x "$STAGE"

# Verify before atomically replacing the working binary. POSIX rename keeps the old install intact on
# any download/checksum/version failure and lets an already-running old process finish safely.
VER="$("$STAGE" version 2>/dev/null | head -1 || true)"
NEWV="$(printf '%s' "$VER" | sed -n 's/^neko-core *\([0-9][0-9.]*\).*/\1/p')"
if [ -z "$NEWV" ] || [ "v$NEWV" != "$TAG" ]; then
  echo "neko: downloaded binary failed its version probe (expected $TAG, got '$VER')" >&2; exit 1
fi
mv -f "$STAGE" "$TARGET"
echo "  Installed to $TARGET"
echo "$VER installed ($VERIFY_NOTE)"

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
echo "Run 'neko' to get started."
echo "  Inside Neko: /login connects ChatGPT, an API key, or another provider."
echo "               /browser starts optional signed-in Chrome setup (no Bun command needed)."
echo "  neko doctor - check provider / model / authentication"
