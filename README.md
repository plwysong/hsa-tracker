# HSA Tracker

A **local-first HSA eligible expense tracker** with AI receipt triage. Drop in receipts (or forward them to a dedicated email inbox), let AI split them into line items and judge HSA eligibility under IRS Pub 502, then approve or reject each item yourself. Nothing ever reaches the permanent ledger without your explicit approval, and every entry keeps its receipt, rationale, and audit trail forever.

**Why:** IRS rules let you reimburse yourself from an HSA *tax-free at any time in the future* for qualified medical expenses — as long as the expense was incurred after the HSA existed, hasn't already been reimbursed or deducted, and is documented. This app is that documentation. The dashboard's headline number is your accumulated tax-free withdrawal balance.

Everything runs on your own machine: a Node.js server, a SQLite database, and a folder of receipt files. **No hosting, no subscriptions, no cloud storage.** The only network calls are the AI triage (your own Claude or OpenAI API key), optional IMAP email polling, a version check against the GitHub releases page at launch, and a one-time download of the OCR model the first time a photo receipt needs it.

## Install (macOS)

1. **Download the installer** from the [releases page](https://github.com/plwysong/hsa-tracker/releases/latest).
2. Open the DMG and drag **HSA Tracker** into **Applications**.
3. **First launch:** the app isn't code-signed with an Apple developer certificate, so macOS will block the first open. Double-click it, dismiss the warning, then go to System Settings → **Privacy & Security** → scroll down → **Open Anyway**. (On older macOS, right-click the app → **Open** → **Open** is enough.) This happens once per version.
4. In **Settings**, pick an AI engine — for most people, paste a Claude or OpenAI API key (links and instructions are right there in Settings). Then hit *Test triage engine*.

No Node.js, no terminal, no dependencies — the app is fully self-contained.

**Hardware note:** the installer targets Apple Silicon Macs (2020 and later). On an older Intel Mac, run from source instead (below).

## Updating

The app checks the releases page each time it opens and shows an **Update available** notice with a download button when a newer version exists (the running version shows at the bottom of the sidebar). Download the new DMG, drag the app to Applications, click **Replace** — and do the one-time Open Anyway step again, since each unsigned build re-triggers it.

**Updates never touch your data.** The app lives in /Applications; your data lives in `~/Library/Application Support/HSA Tracker/`.

## Features

- **Dashboard** — tax-free withdrawal balance, totals by category and year, recent activity.
- **Drag & drop ingestion** — drop PDF/JPG/PNG/HEIC receipts anywhere in the app. Text is extracted (with OCR fallback for photos), split into line items, and AI-triaged.
- **AI eligibility triage** — each line item gets a verdict, a confidence level, and a plain-English rationale that becomes part of the permanent record. Clearly ineligible items (groceries, electronics…) go to a Discarded log instead of cluttering the queue — never silently deleted, and re-queueable.
- **Review queue** — approve / edit-then-approve / reject, individually, per-receipt, or in bulk. Supplements default to *Low confidence, needs a Letter of Medical Necessity* rather than being decided for you.
- **Ledger** — searchable, filterable permanent record. Mark entries reimbursed when you eventually withdraw. Every row links to its source receipt.
- **Email ingestion (optional)** — point Settings at a dedicated free email account (e.g. a fresh Gmail with an [app password](https://myaccount.google.com/apppasswords)) and forward receipts to it; the app polls it over IMAP while running.
- **Backup & export** — one-click zip of everything (CSV + JSON + PDF summary + all receipt files), or individual formats. The PDF summary is designed to hand to a tax preparer.
- **Audit trail** — every decision, edit, and processing event is logged. Rejected items are kept, not deleted.
- **Idempotent** — re-uploading the same file or re-processing the same email/order never creates duplicates.

## AI triage engines (Settings)

| Engine | Cost | Notes |
|---|---|---|
| **Claude (Anthropic) API key** (default) | Pay-per-use (pennies per receipt) | Get a key at [console.anthropic.com](https://console.anthropic.com). Uses Claude Sonnet 5. |
| **ChatGPT (OpenAI) API key** | Pay-per-use (pennies per receipt) | Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Uses GPT-4o mini. |
| **Offline keywords** | Free | No AI. Coarse — only flags obvious matches. Also used automatically as a fallback if the AI engine fails, with a clear warning on each result. |

## Running from source

Requires [Node.js](https://nodejs.org) 22.13+ (24 LTS recommended), and a copy of this repo (clone it, or Code → Download ZIP).

**No terminal needed:** double-click **`Setup HSA Tracker.command`** in the project folder. If macOS warns it "can't verify the developer", right-click the file → **Open** → **Open**. It installs the app's components and puts an **HSA Tracker** launcher on your Desktop — from then on, double-click that to open the app. `npm run make-launcher` rebuilds the launcher if you move the project folder.

**Terminal:**

```bash
npm install
npm start
```

`npm run app` opens the desktop window (Electron). `npm start` runs headless browser mode instead — open **http://localhost:8321**; in this mode the server quits itself a few minutes after the last tab closes (disable with `HSA_NO_AUTOEXIT=1`, which `npm run dev` sets). Either way the server binds to localhost only — nothing is exposed to your network.

## Building the standalone app

```bash
npm run dist        # self-contained dist/mac-arm64/HSA Tracker.app
npm run installer   # the above + ad-hoc signing + dist/HSA Tracker Installer.dmg
```

The `.app` is fully self-contained — recipients don't need Node.js or anything else. The installer script builds the DMG with `hdiutil` rather than electron-builder's dmg target, because the latter corrupts the ad-hoc code signature.

To publish a new version: bump `version` in package.json, `npm run installer`, then
`gh release create vX.Y.Z "dist/HSA Tracker Installer.dmg" --title "HSA Tracker vX.Y.Z" --notes "..."`. Installed apps see the new release and show the update notice. Packaged builds contain no personal data.

## Where your data lives

- **Installed app:** `~/Library/Application Support/HSA Tracker/data/` — `hsa.db` (ledger, rationale, audit log, settings) plus `receipts/` (every original file).
- **Running from source** (`npm start` / `npm run app`): `hsa-tracker/data/` instead.

**Backing up that one `data/` folder backs up everything** (or just use Backup & Export → zip inside the app). `data/` is `.gitignore`d, so sharing this repo never shares your records.

## Architecture (for tinkerers)

- `electron.js` — desktop-app entry point: runs the server in-process and shows the dashboard in its own window (single-instance; quits on window close).
- `server.js` — Express entry point, localhost-only; also runs standalone for browser mode.
- `src/db.js` — schema + settings. Uses Node's built-in `node:sqlite`, so there are no native build steps.
- `src/lib/extract.js` — PDF text layer via pdfjs-dist, OCR via tesseract.js, HEIC conversion.
- `src/lib/triage.js` — the eligibility prompt, the two API engines, and the keyword fallback.
- `src/lib/ingest.js` — the shared pipeline: dedup → store → extract → triage → queue/discard, with an in-memory job tracker the UI polls.
- `src/lib/email.js` — optional IMAP poller (imapflow + mailparser).
- `src/lib/exporter.js` — CSV / JSON / zip / PDF summary.
- `src/routes/api.js` — the REST API.
- `public/` — no-build vanilla JS SPA; hand-rolled SVG charts.

### Ideas for future phases

Bank/card transaction import, review-queue reminder notifications, partial reimbursement tracking, multi-year tax packets per HSA administrator, multi-user profiles.
