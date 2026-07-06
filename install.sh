#!/bin/sh
# Neko Code installer (macOS / Linux) — downloads a standalone binary; no Bun required.
#   curl -fsSL https://neko.holilihu.online/install.sh | sh
set -e

REPO="meiiie/neko-core"
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  Linux-x86_64)              ASSET="neko-linux-x64" ;;
  Linux-aarch64|Linux-arm64) ASSET="neko-linux-arm64" ;;
  Darwin-arm64)              ASSET="neko-macos-arm64" ;;
  Darwin-x86_64)             ASSET="neko-macos-x64" ;;
  *) echo "neko: unsupported platform '$OS-$ARCH'. Build from source: https://github.com/$REPO" >&2; exit 1 ;;
esac

# Resolve the real latest tag first so the user sees WHAT is being installed.
echo "Fetching latest version..."
TAG="$(curl -fsSL --max-time 15 -H 'User-Agent: neko-installer' "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
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
echo "${VER:-Installed} -> $TARGET"

# PATH: always report the state.
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "$BIN_DIR is already on your PATH." ;;
  *) echo "Add it to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"   (then restart your shell)" ;;
esac

# SHADOW CHECK — an old `neko` earlier on PATH wins over this install; name it precisely.
FOUND="$(command -v neko 2>/dev/null || true)"
if [ -n "$FOUND" ] && [ "$FOUND" != "$TARGET" ]; then
  echo "WARNING: another neko is on your PATH and can SHADOW this install:"
  echo "  $FOUND"
  echo "If a new shell still reports an old version, remove it:  rm \"$FOUND\""
fi

echo ""
echo "Run 'neko' to get started!  (first time: 'neko init-user' to set up your API key)"
