#!/usr/bin/env bash
# Builds every deliverable: macOS DMG, Windows x64 zip, single-file HTML.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/script/build_dmg.sh"
"$ROOT_DIR/script/build_web.sh"
"$ROOT_DIR/script/build_windows.sh"

echo
echo "==> Artifacts"
ls -lh "$ROOT_DIR/dist"/*.dmg "$ROOT_DIR/dist"/*.zip "$ROOT_DIR/dist"/*.html
