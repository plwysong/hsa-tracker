#!/bin/bash
# Builds the shareable installer: packages the app, ad-hoc signs it, and wraps
# it in a drag-to-Applications DMG. Output: dist/HSA Tracker Installer.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Packaging app…"
npx electron-builder --mac dir

echo "→ Signing (ad-hoc)…"
codesign --force --deep --sign - "dist/mac-arm64/HSA Tracker.app"
codesign --verify --deep --strict "dist/mac-arm64/HSA Tracker.app"

echo "→ Building DMG…"
STAGE="dist/dmg-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto "dist/mac-arm64/HSA Tracker.app" "$STAGE/HSA Tracker.app"
ln -s /Applications "$STAGE/Applications"
rm -f "dist/HSA Tracker Installer.dmg"
hdiutil create -volname "HSA Tracker" -srcfolder "$STAGE" -ov -format UDZO -quiet "dist/HSA Tracker Installer.dmg"
rm -rf "$STAGE"

echo "✓ Done: dist/HSA Tracker Installer.dmg"
