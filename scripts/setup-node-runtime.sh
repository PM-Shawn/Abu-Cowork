#!/bin/bash
# ============================================================
# Setup embedded Node.js runtime for Abu
# Downloads the official Node.js LTS distribution and strips
# docs/headers so npx-based MCP servers can run without the
# user installing Node.js. Mirrors setup-python-runtime.sh.
#
# The bundled Node bin dir is appended to the child PATH inside
# the Rust `mcp_spawn` command (system Node still wins if present).
#
# Usage:
#   ./scripts/setup-node-runtime.sh              # auto-detect platform
#   ./scripts/setup-node-runtime.sh clean        # remove existing runtime
#   NODE_VERSION=22.14.0 ./scripts/setup-node-runtime.sh   # override version
# ============================================================

set -euo pipefail

# Pinned Node.js LTS (overridable via NODE_VERSION env). Bump deliberately.
NODE_VERSION="${NODE_VERSION:-22.14.0}"
TARGET_DIR="src-tauri/node-runtime"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_PATH="$ROOT_DIR/$TARGET_DIR"

# ── Clean command ──
if [[ "${1:-}" == "clean" ]]; then
  echo "[setup-node] Removing $TARGET_DIR..."
  rm -rf "$TARGET_PATH"
  echo "[setup-node] Done."
  exit 0
fi

# ── Skip if already exists ──
if [[ -f "$TARGET_PATH/bin/node" ]] || [[ -f "$TARGET_PATH/node.exe" ]]; then
  echo "[setup-node] Node runtime already exists at $TARGET_DIR, skipping. Use 'clean' to rebuild."
  exit 0
fi

# ── Detect platform ──
OS="$(uname -s)"
ARCH="$(uname -m)"
IS_WINDOWS=0

case "$OS-$ARCH" in
  Darwin-arm64)
    NODE_PLATFORM="darwin-arm64"; EXT="tar.gz" ;;
  Darwin-x86_64)
    NODE_PLATFORM="darwin-x64"; EXT="tar.gz" ;;
  Linux-x86_64)
    NODE_PLATFORM="linux-x64"; EXT="tar.gz" ;;
  Linux-aarch64)
    NODE_PLATFORM="linux-arm64"; EXT="tar.gz" ;;
  MINGW*|MSYS*|CYGWIN*)
    NODE_PLATFORM="win-x64"; EXT="zip"; IS_WINDOWS=1 ;;
  *)
    echo "[setup-node] Error: Unsupported platform $OS-$ARCH"
    exit 1 ;;
esac

echo "[setup-node] Platform: $OS-$ARCH → node-v${NODE_VERSION}-${NODE_PLATFORM}"

# ── Download ──
DIRNAME="node-v${NODE_VERSION}-${NODE_PLATFORM}"
FILENAME="${DIRNAME}.${EXT}"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${FILENAME}"
TMP_DIR="$(mktemp -d)"

echo "[setup-node] Downloading Node.js..."
echo "  URL: $URL"
curl -fL --progress-bar "$URL" -o "$TMP_DIR/$FILENAME"

# ── Extract ──
echo "[setup-node] Extracting..."
if [[ "$EXT" == "zip" ]]; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$TMP_DIR/$FILENAME" -d "$TMP_DIR"
  else
    # Windows CI without unzip — fall back to PowerShell Expand-Archive.
    # PowerShell cannot resolve MSYS/Git-Bash POSIX paths (/tmp/...), so
    # translate them to native Windows paths first.
    ZIP_WIN="$(cygpath -w "$TMP_DIR/$FILENAME" 2>/dev/null || echo "$TMP_DIR/$FILENAME")"
    DEST_WIN="$(cygpath -w "$TMP_DIR" 2>/dev/null || echo "$TMP_DIR")"
    powershell.exe -NoProfile -Command "Expand-Archive -Force '$ZIP_WIN' '$DEST_WIN'"
  fi
else
  tar xzf "$TMP_DIR/$FILENAME" -C "$TMP_DIR"
fi

# The archive extracts to "node-v${VERSION}-${PLATFORM}/". Remove any leftover
# partial target first, so `mv` replaces it instead of nesting inside it.
rm -rf "$TARGET_PATH"
mv "$TMP_DIR/$DIRNAME" "$TARGET_PATH"
rm -rf "$TMP_DIR"

echo "[setup-node] Extracted to $TARGET_DIR"

# ── Strip unnecessary files (headers, docs, man pages) ──
echo "[setup-node] Stripping unnecessary files..."
rm -rf "$TARGET_PATH/include" "$TARGET_PATH/share"
# Keep LICENSE: Node.js is MIT-licensed and redistributing its binaries requires
# retaining the license text. Only drop the changelog/readme.
rm -f "$TARGET_PATH"/CHANGELOG.md "$TARGET_PATH"/README.md 2>/dev/null || true
# npm docs are large and never needed at runtime; keep npm/npx themselves.
find "$TARGET_PATH" -type d -name docs -path '*node_modules/npm*' -exec rm -rf {} + 2>/dev/null || true
# corepack ships a second package manager we don't use.
rm -rf "$TARGET_PATH/lib/node_modules/corepack" 2>/dev/null || true
rm -f "$TARGET_PATH/bin/corepack" "$TARGET_PATH/corepack" "$TARGET_PATH/corepack.cmd" 2>/dev/null || true

echo "[setup-node] Stripped."

# ── Determine Node binary path ──
if [[ -f "$TARGET_PATH/bin/node" ]]; then
  NODE_BIN="$TARGET_PATH/bin/node"
elif [[ -f "$TARGET_PATH/node.exe" ]]; then
  NODE_BIN="$TARGET_PATH/node.exe"
else
  echo "[setup-node] Error: Cannot find node binary in $TARGET_PATH"
  exit 1
fi

# ── macOS code signing (best-effort; the release workflow re-signs with the
#    hardened runtime + entitlements, which is what notarization requires) ──
if [[ "$OS" == "Darwin" ]] && [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "[setup-node] Signing node binary for macOS..."
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$NODE_BIN" 2>/dev/null || true
  echo "[setup-node] Signing done."
elif [[ "$OS" == "Darwin" ]]; then
  echo "[setup-node] Note: No APPLE_SIGNING_IDENTITY set, skipping code signing."
fi

# ── Summary ──
SIZE=$(du -sh "$TARGET_PATH" | cut -f1)
echo ""
echo "[setup-node] ✓ Node runtime ready at $TARGET_DIR ($SIZE)"
if [[ "$IS_WINDOWS" == "0" ]]; then
  echo "  Node: $("$NODE_BIN" --version 2>&1)"
fi
