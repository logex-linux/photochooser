#!/usr/bin/env bash
# Builds a universal (arm64 + x86_64) Photochooser.app bundle.
set -euo pipefail

APP_NAME="Photochooser"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build"
DIST_DIR="$ROOT_DIR/dist/macos"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"

cd "$ROOT_DIR"

echo "==> Building release binary (universal)"
swift build -c release --arch arm64 --arch x86_64

BIN_PATH="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/$APP_NAME"
if [[ ! -f "$BIN_PATH" ]]; then
    echo "error: binary not found at $BIN_PATH" >&2
    exit 1
fi

echo "==> Generating icon"
ICON_PATH="$(swift "$ROOT_DIR/script/make_icon.swift" "$BUILD_DIR/icon")"

echo "==> Assembling $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "$BIN_PATH" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
cp "$ROOT_DIR/Support/Info.plist" "$APP_BUNDLE/Contents/Info.plist"
cp "$ICON_PATH" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
printf 'APPL????' > "$APP_BUNDLE/Contents/PkgInfo"

echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null

lipo -info "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
du -sh "$APP_BUNDLE"
echo "Built: $APP_BUNDLE"
