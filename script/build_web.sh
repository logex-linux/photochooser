#!/usr/bin/env bash
# Builds the web deliverables (single-file HTML + static folder).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/web"
node build.mjs

mkdir -p "$ROOT_DIR/dist"
cp "$ROOT_DIR/web/dist/photochooser.html" "$ROOT_DIR/dist/photochooser.html"
echo "Copied to $ROOT_DIR/dist/photochooser.html"
