// Ways to get receipts in without an email account:
//
//  • The HSA Inbox folder — anything saved to "HSA Tracker/Inbox" (in iCloud Drive by
//    default, next to the backups) is imported, then moved to Inbox/Imported. On an
//    iPhone: Share → Save to Files → HSA Tracker → Inbox.
//  • "Save PDF to HSA Tracker" in the Print dialog's PDF menu — a link to that same
//    folder in ~/Library/PDF Services, the standard macOS place for such entries.
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSetting, setSetting, audit } from '../db.js';
import { backupFolder, backupStatus } from './backup.js';
import { ingestDocument } from './ingest.js';

const TYPES = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.txt': 'text/plain', '.csv': 'text/csv', '.eml': 'message/rfc822',
  '.html': 'text/html', '.htm': 'text/html',
};
const SETTLE_MS = 5000; // a file this new may still be copying or syncing — wait for the next look
// Tests and test copies point this at a stand-in, so they never touch the real Print menu.
const PDF_SERVICES = process.env.HSA_PDF_SERVICES_DIR || path.join(os.homedir(), 'Library', 'PDF Services');
const PRINT_NAME = 'Save PDF to HSA Tracker';

export const inboxFolder = () => { const f = backupFolder(); return f ? path.join(f, 'Inbox') : ''; };
/** The Print menu entry is only managed by the desktop app on a Mac (or when a test forces it). */
const printAvailable = () => process.platform === 'darwin' && (!!process.versions.electron || !!process.env.HSA_PDF_SERVICES_DIR);

function ensureInbox() {
  const dir = inboxFolder();
  if (!dir) return '';
  mkdirSync(path.join(dir, 'Imported'), { recursive: true });
  const readMe = path.join(dir, 'About this folder.txt');
  if (!existsSync(readMe)) {
    writeFileSync(readMe, 'Save receipts here — PDFs, photos, saved emails — and HSA Tracker adds them for review\n'
      + 'automatically, then moves them to "Imported". From an iPhone: Share → Save to Files → HSA Tracker → Inbox.\n');
  }
  return dir;
}

async function uniqueTarget(dir, name) {
  const { name: stem, ext } = path.parse(name);
  for (let n = 1; ; n++) {
    const p = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try { await stat(p); } catch { return p; }
  }
}

let scanning = false;
/** Imports whatever is waiting in the Inbox folder. Returns how many files were taken in. */
export async function scanInbox() {
  if (scanning || !getSetting('inbox_enabled', true)) return 0;
  const dir = ensureInbox();
  if (!dir) return 0;
  scanning = true;
  let count = 0;
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith('.') || name === 'Imported' || name === 'About this folder.txt' || name.endsWith('.partial')) continue;
      const mime = TYPES[path.extname(name).toLowerCase()];
      if (!mime) continue; // files the app can't read are left where they are
      const p = path.join(dir, name);
      const st = await stat(p);
      if (!st.isFile() || Date.now() - st.mtimeMs < SETTLE_MS) continue;
      // Async read: a file iCloud hasn't downloaded yet is fetched without stalling the app.
      const buffer = await readFile(p);
      ingestDocument(buffer, { originalName: name, mime, source: 'upload', sourceDetail: { via: 'inbox' } });
      await rename(p, await uniqueTarget(path.join(dir, 'Imported'), name));
      count++;
    }
    if (count) {
      setSetting('inbox_last_import', { at: new Date().toISOString(), count });
      audit('inbox_import', { count });
    }
  } finally {
    scanning = false;
  }
  return count;
}

/** Adds or removes "Save PDF to HSA Tracker" in the Print dialog's PDF menu to match the setting. */
export function syncPrintEntry() {
  if (!printAvailable()) return;
  const link = path.join(PDF_SERVICES, PRINT_NAME);
  const target = getSetting('print_enabled', true) && getSetting('inbox_enabled', true) ? ensureInbox() : '';
  let current = null;
  try { current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : 'not-a-link'; } catch { /* none yet */ }
  if (current === 'not-a-link') return; // something the user put there themselves — leave it alone
  if (target && current === target) return;
  if (current) unlinkSync(link);
  if (target) {
    mkdirSync(PDF_SERVICES, { recursive: true });
    symlinkSync(target, link);
  }
}

export function intakeStatus() {
  return {
    inbox: {
      folder: inboxFolder(),
      label: backupStatus().isICloud ? 'iCloud Drive › HSA Tracker › Inbox' : inboxFolder().replace(/^\/Users\/[^/]+/, '~'),
      enabled: getSetting('inbox_enabled', true),
      lastImport: getSetting('inbox_last_import', null),
    },
    print: { available: printAvailable(), enabled: getSetting('print_enabled', true) },
  };
}

let timer = null;
export function startInboxWatcher() {
  if (timer) return;
  try { syncPrintEntry(); } catch (err) { console.error('Print menu entry:', err.message); }
  const tick = () => scanInbox().catch(err => console.error('Inbox:', err.message));
  tick();
  timer = setInterval(tick, Number(process.env.HSA_INBOX_TICK_MS) || 15 * 1000);
  timer.unref?.();
}
