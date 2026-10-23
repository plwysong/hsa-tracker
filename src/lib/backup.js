// Backups to a folder the user's own cloud syncs — iCloud Drive by default.
//
// The live database stays on this Mac (a database being synced while it's written
// can corrupt). Instead, a complete snapshot is copied into the backup folder
// after changes, so a lost or replaced Mac never means lost records:
//
//   HSA Tracker/
//     Backups/HSA-backup-2026-10-23-1142.db   one consistent snapshot each (last 30 kept)
//     Backups/receipt files/<sha256>.<ext>     every receipt file, stored once
//     Readable copies/                         receipts named by date and provider, the
//                                              tax summary PDF and a spreadsheet — usable
//                                              in Finder without this app
//
// API keys and the email password are never written to a backup.
import { existsSync, mkdirSync, readdirSync, copyFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { db, RECEIPTS_DIR, getSetting, setSetting, audit, SECRET_KEYS } from '../db.js';
import { ledgerCsv, summaryPdfBuffer } from './exporter.js';

// HSA_ICLOUD_DIR points tests (and test copies of the app) at a stand-in folder,
// so they never write into the real iCloud Drive.
const ICLOUD_ROOT = process.env.HSA_ICLOUD_DIR || path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
const KEEP = 30;
const QUIET_MS = Number(process.env.HSA_BACKUP_QUIET_MS) || 3 * 60 * 1000; // back up once things have been quiet this long…
const MAX_WAIT_MS = 30 * 60 * 1000; // …or after this long, even if changes keep coming
const SNAPSHOT = /^HSA-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(-before-restore)?\.db$/;
// Settings that belong to this Mac rather than to the records: never copied over by a restore.
const MACHINE_KEYS = [...SECRET_KEYS, 'backup_dir', 'backup_auto', 'backup_plain', 'backup_last_at', 'backup_last_error', 'backup_last_audit', 'backup_last_counts'];

export const icloudAvailable = () => existsSync(ICLOUD_ROOT);
export const icloudFolder = () => path.join(ICLOUD_ROOT, 'HSA Tracker');
/** Where backups go: the folder the user chose, else iCloud Drive when it's turned on, else nowhere. */
export function backupFolder() {
  return getSetting('backup_dir', '') || (icloudAvailable() ? icloudFolder() : '');
}

const maxAudit = () => db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').get().n;
const stamp = (d = new Date()) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-')
  + '-' + [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
const storeName = r => r.sha256 ? r.sha256 + path.extname(r.filename) : `file-${r.filename}`;

function countsOf(conn) {
  return {
    expenses: conn.prepare("SELECT COUNT(*) AS n FROM expenses WHERE status = 'approved'").get().n,
    receipts: conn.prepare('SELECT COUNT(*) AS n FROM receipts').get().n,
  };
}

/** Writes a file into the (possibly syncing) folder under a temporary name, then renames it,
 *  so a half-written file is never mistaken for a finished one. */
function placeFile(from, to) {
  const partial = to + '.partial';
  copyFileSync(from, partial);
  renameSync(partial, to);
}

let running = false;

/**
 * Makes one backup now. Returns the status. `label` marks special snapshots
 * (the safety copy taken before a restore); `plain: false` skips the readable copies.
 */
export async function runBackup({ label = '', plain = getSetting('backup_plain', true) } = {}) {
  const folder = backupFolder();
  if (!folder) throw new Error("iCloud Drive isn't turned on on this Mac — choose another folder for backups in Settings.");
  if (running) throw new Error('A backup is already running.');
  running = true;
  const tmp = path.join(os.tmpdir(), `hsa-backup-${process.pid}-${Date.now()}.db`);
  try {
    const dir = path.join(folder, 'Backups');
    const store = path.join(dir, 'receipt files');
    mkdirSync(store, { recursive: true });

    // 1. A consistent copy of the database, with this Mac's secrets taken out.
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const snap = new DatabaseSync(tmp);
    snap.prepare(`UPDATE settings SET value = '""' WHERE key IN (${SECRET_KEYS.map(() => '?').join(', ')})`).run(...SECRET_KEYS);
    const counts = countsOf(snap);
    snap.close();
    const name = `HSA-backup-${stamp()}${label ? '-' + label : ''}.db`;
    placeFile(tmp, path.join(dir, name));

    // 2. Receipt files, each stored once under its content fingerprint.
    for (const r of db.prepare('SELECT filename, sha256 FROM receipts WHERE filename IS NOT NULL').all()) {
      const from = path.join(RECEIPTS_DIR, r.filename);
      const to = path.join(store, storeName(r));
      if (existsSync(from) && (!existsSync(to) || statSync(to).size !== statSync(from).size)) placeFile(from, to);
    }

    // 3. Keep the newest snapshots; safety copies taken before a restore are kept too.
    const regular = readdirSync(dir).filter(f => SNAPSHOT.test(f) && !f.includes('-before-restore')).sort().reverse();
    for (const old of regular.slice(KEEP)) rmSync(path.join(dir, old), { force: true });

    // 4. Readable copies: what a person (or a tax preparer) can open in 20 years.
    if (plain) await writeReadableCopies(folder);
    writeReadMe(folder);

    audit('backup', { file: name, ...counts });
    setSetting('backup_last_at', new Date().toISOString());
    setSetting('backup_last_error', '');
    setSetting('backup_last_counts', counts);
    setSetting('backup_last_audit', maxAudit()); // after the audit entry above, so it doesn't count as a change
    return { file: name, ...counts };
  } catch (err) {
    setSetting('backup_last_error', err.message);
    throw err;
  } finally {
    rmSync(tmp, { force: true });
    running = false;
  }
}

async function writeReadableCopies(folder) {
  const out = path.join(folder, 'Readable copies');
  const files = path.join(out, 'Receipts');
  mkdirSync(files, { recursive: true });
  // "2026-10-08 Harbor View Dentistry (#12).pdf" — a card slip sorts right after its receipt.
  const rows = db.prepare(`SELECT r.id, r.filename, r.original_name, r.payment_for, r.doc_date, r.provider, r.received_at,
      (SELECT MIN(date) FROM expenses e WHERE e.receipt_id = r.id) AS line_date,
      (SELECT provider FROM expenses e WHERE e.receipt_id = r.id AND COALESCE(provider, '') != '' LIMIT 1) AS line_provider
    FROM receipts r WHERE r.filename IS NOT NULL`).all();
  const byId = new Map(rows.map(r => [r.id, r]));
  const clean = s => String(s).replace(/[\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 70);
  const base = r => `${(r.doc_date || r.line_date || String(r.received_at)).slice(0, 10)} ${clean(r.provider || r.line_provider || path.parse(r.original_name || r.filename).name)}`;
  const wanted = new Map();
  for (const r of rows) {
    const paid = r.payment_for && byId.get(r.payment_for);
    const name = paid ? `${base(paid)} (#${paid.id}) - proof of payment` : `${base(r)} (#${r.id})`;
    wanted.set(name + path.extname(r.filename).toLowerCase(), r.filename);
  }
  // Mirror, not pile: names that changed or receipts that were deleted don't linger.
  for (const f of readdirSync(files)) if (!wanted.has(f)) rmSync(path.join(files, f), { recursive: true, force: true });
  for (const [name, file] of wanted) {
    const from = path.join(RECEIPTS_DIR, file);
    const to = path.join(files, name);
    if (existsSync(from) && (!existsSync(to) || statSync(to).size !== statSync(from).size)) placeFile(from, to);
  }
  const pdf = path.join(out, 'Tax summary.pdf');
  writeFileSync(pdf + '.partial', await summaryPdfBuffer());
  renameSync(pdf + '.partial', pdf);
  const csv = path.join(out, 'All records.csv');
  writeFileSync(csv + '.partial', ledgerCsv({ approvedOnly: false }));
  renameSync(csv + '.partial', csv);
}

function writeReadMe(folder) {
  const p = path.join(folder, 'READ ME.txt');
  if (existsSync(p)) return;
  writeFileSync(p, `HSA Tracker backups
===================

Backups/           Complete backups HSA Tracker can restore from (Settings → Backup →
                   Restore, or "Used HSA Tracker before?" on a new Mac). The newest 30
                   are kept. "receipt files" holds every receipt they need.
Readable copies/   Your receipts named by date and provider, the tax summary PDF and a
                   spreadsheet of every record — these open without HSA Tracker.

API keys and email passwords are never stored here.
`);
}

/** Backups in a folder (the backup folder by default), newest first, with what each holds. */
export function listBackups(folder = backupFolder()) {
  const dir = path.join(folder || '', 'Backups');
  if (!folder || !existsSync(dir)) return [];
  return readdirSync(dir).filter(f => SNAPSHOT.test(f)).sort().reverse().map(file => {
    const [, y, mo, d, h, mi, s, before] = file.match(SNAPSHOT);
    let counts = { expenses: null, receipts: null };
    try {
      const conn = new DatabaseSync(path.join(dir, file), { readOnly: true });
      counts = countsOf(conn);
      conn.close();
    } catch { /* still syncing down, or not a backup — listed without counts */ }
    return { file, folder, at: `${y}-${mo}-${d}T${h}:${mi}:${s}`, beforeRestore: !!before, ...counts };
  });
}

/**
 * Replaces this Mac's records with a backup's. Takes a safety backup of what's
 * here first, brings back any receipt files that are missing, and keeps this
 * Mac's own settings (API keys, email password, backup choices).
 */
export async function restoreBackup(folder, file) {
  if (!SNAPSHOT.test(file || '')) throw new Error('Choose a backup to restore.');
  const src = path.join(folder, 'Backups', file);
  if (!existsSync(src)) throw new Error("That backup isn't there — if it's in iCloud Drive, it may still be downloading.");

  // What's on this Mac now is saved first, so a restore can always be undone.
  if (countsOf(db).receipts || countsOf(db).expenses) {
    if (backupFolder()) await runBackup({ label: 'before-restore', plain: false });
    else throw new Error('Choose a backup folder in Settings first, so what is on this Mac can be saved before restoring.');
  }

  const keep = Object.fromEntries(MACHINE_KEYS.map(k => [k, getSetting(k)]).filter(([, v]) => v !== null));

  // Receipt files the backup needs, from its "receipt files" store.
  const snap = new DatabaseSync(src, { readOnly: true });
  const needed = snap.prepare('SELECT filename, sha256 FROM receipts WHERE filename IS NOT NULL').all();
  snap.close();
  let missing = 0;
  for (const r of needed) {
    const to = path.join(RECEIPTS_DIR, r.filename);
    const from = path.join(folder, 'Backups', 'receipt files', storeName(r));
    if (existsSync(to)) continue;
    if (existsSync(from)) copyFileSync(from, to); else missing++;
  }

  // Table by table, only the columns both sides have — a backup from an older
  // version restores into this one, and newer columns keep their defaults.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')").all().map(t => t.name);
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('ATTACH DATABASE ? AS src').run(src);
  try {
    db.exec('BEGIN');
    try {
      for (const t of tables) {
        db.exec(`DELETE FROM main."${t}"`); // a table the backup doesn't have yet starts empty
        if (!db.prepare('SELECT 1 FROM src.sqlite_master WHERE name = ?').get(t)) continue;
        const theirs = db.prepare("SELECT name FROM pragma_table_info(?, 'src')").all(t).map(c => c.name);
        const ours = new Set(db.prepare("SELECT name FROM pragma_table_info(?, 'main')").all(t).map(c => c.name));
        const cols = theirs.filter(c => ours.has(c)).map(c => `"${c}"`).join(', ');
        if (cols) db.exec(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM src."${t}"`);
      }
      for (const [k, v] of Object.entries(keep)) setSetting(k, v);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  } finally {
    db.exec('DETACH DATABASE src');
    db.exec('PRAGMA foreign_keys = ON');
  }
  audit('restore', { file, missingFiles: missing });
  setSetting('backup_last_audit', maxAudit());
  return { ...countsOf(db), missingFiles: missing };
}

/** Status for Settings and the sidebar. */
export function backupStatus() {
  const folder = backupFolder();
  return {
    folder,
    isICloud: !!folder && folder === icloudFolder() && !getSetting('backup_dir', ''),
    icloudAvailable: icloudAvailable(),
    auto: getSetting('backup_auto', true),
    plain: getSetting('backup_plain', true),
    lastAt: getSetting('backup_last_at', ''),
    lastError: getSetting('backup_last_error', ''),
    lastCounts: getSetting('backup_last_counts', null),
    changesSince: maxAudit() > getSetting('backup_last_audit', 0),
    hasRecords: Object.values(countsOf(db)).some(Boolean),
    running,
  };
}

// Automatic backups: shortly after things go quiet, never more than half an hour behind.
let timer = null;
export function startBackupSchedule() {
  if (timer) return;
  let seen = maxAudit(), lastChange = null, firstChange = null;
  timer = setInterval(() => {
    if (running || !getSetting('backup_auto', true) || !backupFolder()) return;
    // Nothing to protect yet (say, a new Mac before its restore): an empty backup would
    // only crowd out the real ones.
    const c = countsOf(db);
    if (!c.receipts && !c.expenses) return;
    const now = maxAudit();
    if (now !== seen) { seen = now; lastChange = Date.now(); firstChange ??= lastChange; }
    if (now <= getSetting('backup_last_audit', 0)) { lastChange = firstChange = null; return; }
    // lastChange null: the changes happened before this launch, so back up right away.
    const quiet = lastChange === null || Date.now() - lastChange >= QUIET_MS;
    const overdue = firstChange !== null && Date.now() - firstChange >= MAX_WAIT_MS;
    if (quiet || overdue) runBackup().then(() => { lastChange = firstChange = null; }).catch(err => console.error('Backup failed:', err.message));
  }, Number(process.env.HSA_BACKUP_TICK_MS) || 60 * 1000);
  timer.unref?.();
}
