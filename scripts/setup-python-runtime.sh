#!/bin/bash
# ============================================================
# Setup embedded Python runtime for Abu
# Downloads python-build-standalone, strips unnecessary modules,
# and pre-installs document generation packages.
#
# Usage:
#   ./scripts/setup-python-runtime.sh          # auto-detect platform
#   ./scripts/setup-python-runtime.sh clean     # remove existing runtime
# ============================================================

set -euo pipefail

PYTHON_VERSION="3.12.8"
PBS_RELEASE="20250106"
TARGET_DIR="src-tauri/python-runtime"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_PATH="$ROOT_DIR/$TARGET_DIR"

# ── Clean command ──
if [[ "${1:-}" == "clean" ]]; then
  echo "[setup-python] Removing $TARGET_DIR..."
  rm -rf "$TARGET_PATH"
  echo "[setup-python] Done."
  exit 0
fi

# ── Skip if already exists ──
if [[ -d "$TARGET_PATH/bin" ]] || [[ -d "$TARGET_PATH/python.exe" ]] || [[ -f "$TARGET_PATH/bin/python3" ]]; then
  echo "[setup-python] Python runtime already exists at $TARGET_DIR, skipping. Use 'clean' to rebuild."
  exit 0
fi

# ── Detect platform ──
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  Darwin-arm64)
    TRIPLE="aarch64-apple-darwin"
    ;;
  Darwin-x86_64)
    TRIPLE="x86_64-apple-darwin"
    ;;
  Linux-x86_64)
    TRIPLE="x86_64-unknown-linux-gnu"
    ;;
  Linux-aarch64)
    TRIPLE="aarch64-unknown-linux-gnu"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    TRIPLE="x86_64-pc-windows-msvc-shared"
    ;;
  *)
    echo "[setup-python] Error: Unsupported platform $OS-$ARCH"
    exit 1
    ;;
esac

echo "[setup-python] Platform: $OS-$ARCH → $TRIPLE"

# ── Download ──
FILENAME="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${TRIPLE}-install_only.tar.gz"
URL="https://github.com/indygreg/python-build-standalone/releases/download/${PBS_RELEASE}/${FILENAME}"
TMP_DIR="$(mktemp -d)"

echo "[setup-python] Downloading python-build-standalone..."
echo "  URL: $URL"
curl -L --progress-bar "$URL" -o "$TMP_DIR/$FILENAME"

# ── Extract ──
echo "[setup-python] Extracting..."
tar xzf "$TMP_DIR/$FILENAME" -C "$TMP_DIR"

# python-build-standalone extracts to a "python/" directory
mv "$TMP_DIR/python" "$TARGET_PATH"
rm -rf "$TMP_DIR"

echo "[setup-python] Extracted to $TARGET_DIR"

# ── Strip unnecessary modules (save ~40MB) ──
echo "[setup-python] Stripping unnecessary modules..."
LIBDIR="$TARGET_PATH/lib/python3.12"

# Large modules not needed for document generation
STRIP_DIRS=(
  "test" "tests"
  "tkinter" "_tkinter"
  "idlelib"
  "turtledemo" "turtle.py"
  "ensurepip"
  "lib2to3"
  "pydoc_data"
  "unittest/test"
  "distutils"
)

for dir in "${STRIP_DIRS[@]}"; do
  if [[ -e "$LIBDIR/$dir" ]]; then
    rm -rf "$LIBDIR/$dir"
    echo "  Removed $dir"
  fi
done

# Remove include/share (C headers, man pages — not needed at runtime)
rm -rf "$TARGET_PATH/include" "$TARGET_PATH/share"

# Remove .opt-2.pyc files (optimizer level 2, rarely useful)
find "$TARGET_PATH" -name "*.opt-2.pyc" -delete 2>/dev/null || true

echo "[setup-python] Stripped."

# ── Determine Python binary path ──
if [[ -f "$TARGET_PATH/bin/python3" ]]; then
  PYTHON_BIN="$TARGET_PATH/bin/python3"
elif [[ -f "$TARGET_PATH/python.exe" ]]; then
  PYTHON_BIN="$TARGET_PATH/python.exe"
else
  echo "[setup-python] Error: Cannot find python binary in $TARGET_PATH"
  exit 1
fi

# ── Install document generation packages ──
echo "[setup-python] Installing Python packages..."

# Bootstrap pip first
"$PYTHON_BIN" -m ensurepip --default-pip 2>/dev/null || true

"$PYTHON_BIN" -m pip install --no-cache-dir --quiet \
  python-pptx \
  python-docx \
  openpyxl \
  Pillow \
  fpdf2 \
  lxml

echo "[setup-python] Packages installed."

# ── Remove pip/setuptools after install (not needed at runtime) ──
"$PYTHON_BIN" -m pip uninstall -y pip setuptools 2>/dev/null || true
rm -rf "$LIBDIR/ensurepip" 2>/dev/null || true

# ── macOS code signing ──
if [[ "$OS" == "Darwin" ]] && [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "[setup-python] Signing binaries for macOS..."
  find "$TARGET_PATH" \( -name "*.so" -o -name "*.dylib" -o -name "python3" -o -name "python3.12" \) \
    -exec codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp {} \; 2>/dev/null || true
  echo "[setup-python] Signing done."
elif [[ "$OS" == "Darwin" ]]; then
  echo "[setup-python] Note: No APPLE_SIGNING_IDENTITY set, skipping code signing."
  echo "  For distribution builds, set APPLE_SIGNING_IDENTITY env var."
fi

# ── Summary ──
SIZE=$(du -sh "$TARGET_PATH" | cut -f1)
echo ""
echo "[setup-python] ✓ Python runtime ready at $TARGET_DIR ($SIZE)"
echo "  Python: $("$PYTHON_BIN" --version 2>&1)"
echo "  Packages: python-pptx, python-docx, openpyxl, Pillow, fpdf2, lxml"
