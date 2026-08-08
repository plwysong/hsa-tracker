# CLAUDE.md — agent guide for HSA Tracker

Local-first Mac desktop app (Electron + Express + Node built-in `node:sqlite`, no-build vanilla JS frontend). See README.md for the full feature and architecture overview. This file covers how to *operate* on the project.

## Commands

- `npm start` — headless browser mode at http://localhost:8321 (auto-quits ~3 min after the last tab closes; heartbeats from the page keep it alive)
- `npm run dev` — same, with `--watch` and auto-exit disabled (`HSA_NO_AUTOEXIT=1`)
- `npm run app` — the real desktop window (Electron)
- `npm run installer` — full production build: packages the app, ad-hoc signs it, produces `dist/HSA Tracker Installer.dmg`
- `npm run make-launcher` — (legacy) rebuilds a Desktop launcher app; normally unused since the app installs to /Applications

## Release process

1. Bump `version` in package.json (semver — the in-app update notice compares against GitHub releases)
2. `npm run installer`
3. `gh release create vX.Y.Z "dist/HSA Tracker Installer.dmg" --title "HSA Tracker vX.Y.Z" --notes "..."`
4. Commit + push. Installed apps poll `releases/latest` (hourly cache) and show an update notice.

To deploy the current build to this machine's /Applications:
`pkill -f "Applications/HSA Tracker.app/Contents/MacOS"; rm -rf "/Applications/HSA Tracker.app"; ditto "dist/mac-arm64/HSA Tracker.app" "/Applications/HSA Tracker.app"; open -a "HSA Tracker"`
(Always `rm -rf` before `ditto` — copying over an existing bundle merges files and breaks the code signature.)

## Hard-won gotchas

- **Never use electron-builder's dmg target** — it corrupts the ad-hoc signature. `scripts/make-installer.sh` (used by `npm run installer`) builds the DMG with hdiutil instead.
- **Packaged app data** lives at `~/Library/Application Support/HSA Tracker/data/` (explicit `HSA_DATA_DIR` set in electron.js — don't trust Electron's userData naming). Folder-mode data lives in `./data/` (gitignored). **Updates must never touch user data.**
- `node:sqlite` prints an ExperimentalWarning on start — normal, ignore.
- Port 8321; server binds 127.0.0.1 only. `EADDRINUSE` means an app instance is already running and is tolerated (server reuses it).
- AI triage providers: `anthropic-api` (default, Claude Sonnet 5), `openai-api` (GPT-4o mini), `keywords` (offline fallback — also engaged automatically on API failure). On a "model not found" API error the code self-heals by querying the provider's model list and switching (see `resolveModelNotFound` in src/lib/triage.js).
- The frontend is no-build: edits to `public/` are served immediately in dev, but the packaged app bundles them — rebuild + redeploy for /Applications changes.

## Privacy rules (this repo is PUBLIC)

- Commits must use the repo-local git identity (already configured: the GitHub noreply email). Never commit with a personal email.
- Never commit: `data/`, any `*.db`, receipt files, `src/seed-data.json` (legacy), `CLAUDE.local.md`, or anything containing real names of medical providers, order numbers, addresses, or API keys. The .gitignore enforces this — do not weaken it.
- Anything user-specific belongs in `CLAUDE.local.md` (gitignored), never in this file or the README.
- Before any force-push or history operation, remember: GitHub retains orphaned commits and lists their SHAs in the public activity feed — history rewrites do not remove data from GitHub's servers.
