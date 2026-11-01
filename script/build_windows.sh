#!/usr/bin/env bash
# Builds the Windows x64 portable app (Electron shell around the web UI).
# Runs on macOS/Linux; no Wine required because the Electron binary is prebuilt.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT_DIR/Support/Info.plist")"
OUT_DIR="$ROOT_DIR/dist/windows"
ZIP_PATH="$ROOT_DIR/dist/Photochooser-${VERSION}-windows-x64.zip"

echo "==> Building web assets"
cd "$ROOT_DIR/web"
node build.mjs

rm -rf "$ROOT_DIR/desktop/web"
cp -R "$ROOT_DIR/web/dist/web" "$ROOT_DIR/desktop/web"

echo "==> Installing desktop dependencies"
cd "$ROOT_DIR/desktop"
if [[ ! -d node_modules ]]; then
    npm install --no-audit --no-fund
fi

echo "==> Packaging Windows x64"
rm -rf "$OUT_DIR"
npx electron-packager . Photochooser \
    --platform=win32 \
    --arch=x64 \
    --out="$OUT_DIR" \
    --overwrite \
    --asar \
    --prune=true \
    --ignore="^/(tests|dist)$"

echo "==> Stamping icon and version info"
node "$ROOT_DIR/desktop/set-icon.mjs" "$OUT_DIR/Photochooser-win32-x64/Photochooser.exe"

echo "==> Zipping"
rm -f "$ZIP_PATH"
cd "$OUT_DIR"
zip -qry "$ZIP_PATH" "Photochooser-win32-x64"

du -sh "$OUT_DIR/Photochooser-win32-x64" "$ZIP_PATH"
echo "Built: $ZIP_PATH"
