#!/bin/sh
# Neko Code installer (macOS / Linux) — downloads a standalone binary; no Bun required.
#   curl -fsSL https://raw.githubusercontent.com/meiiie/neko-core/main/install.sh | sh
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

URL="https://github.com/$REPO/releases/latest/download/$ASSET"
BIN_DIR="${NEKO_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/neko"
mkdir -p "$BIN_DIR"

echo "neko: downloading $ASSET ..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TARGET"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TARGET" "$URL"
else
  echo "neko: need curl or wget installed" >&2; exit 1
fi
chmod +x "$TARGET"

echo "neko: installed to $TARGET"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "neko: add it to your PATH ->  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "neko: verify with 'neko --version', then set up your key with 'neko init-user'."
