#!/bin/bash
# One-time setup for non-technical users — just double-click this file.
# (If macOS says it can't verify the developer: right-click the file → Open → Open.)
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo ""
echo "  Setting up HSA Tracker…"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js isn't installed yet. It's free — I'll open the download page."
  echo "    1. Click the big download button on the page that opens"
  echo "    2. Run the installer you downloaded (keep clicking Continue)"
  echo "    3. Double-click this Setup file again"
  echo ""
  open "https://nodejs.org"
  read -r -p "  Press Return to close this window… " _
  exit 0
fi

echo "  ✓ Node.js found ($(node --version))"
echo "  → Installing components (one-time, can take a couple of minutes)…"
npm install --no-fund --no-audit

echo "  → Creating the 'HSA Tracker' app on your Desktop…"
bash scripts/make-launcher.sh > /dev/null

echo ""
echo "  ✓ All done! Opening HSA Tracker now."
echo "    From now on, just double-click 'HSA Tracker' on your Desktop"
echo "    (or drag it into your Dock). You can close this window."
echo ""
open "$HOME/Desktop/HSA Tracker.app"
