#!/usr/bin/env bash
# Builds Photochooser.app and packages it into a distributable DMG.
set -euo pipefail

APP_NAME="Photochooser"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT_DIR/Support/Info.plist")"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$DIST_DIR/dmg-stage"
DMG_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-universal.dmg"

"$ROOT_DIR/script/build_app.sh"

echo "==> Staging DMG content"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -R "$DIST_DIR/macos/$APP_NAME.app" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"

echo "==> Creating DMG"
rm -f "$DMG_PATH"
hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$STAGE_DIR" \
    -ov \
    -format UDZO \
    -fs HFS+ \
    "$DMG_PATH" >/dev/null

rm -rf "$STAGE_DIR"
shasum -a 256 "$DMG_PATH" | tee "$DMG_PATH.sha256"
echo "Built: $DMG_PATH"
