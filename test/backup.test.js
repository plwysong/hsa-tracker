// Backups and restore. Everything runs against a throwaway database and a
// stand-in "iCloud Drive" folder (HSA_ICLOUD_DIR) — never the real one.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';

let db, setSetting, getSetting, RECEIPTS_DIR, runBackup, listBackups, restoreBackup, backupFolder;
const ICLOUD = mkdtempSync(path.join(tmpdir(), 'hsa-icloud-'));
const backupsDir = () => path.join(ICLOUD, 'HSA Tracker', 'Backups');

before(async () => {
  process.env.HSA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'hsa-test-'));
  process.env.HSA_ICLOUD_DIR = ICLOUD;
  ({ db, setSetting, getSetting, RECEIPTS_DIR } = await import('../src/db.js'));
  ({ runBackup, listBackups, restoreBackup, backupFolder } = await import('../src/lib/backup.js'));
  writeFileSync(path.join(RECEIPTS_DIR, 'receipt-a.txt'), 'Sample Pharmacy\nAllergy relief 12.50\n');
  const rid = db.prepare("INSERT INTO receipts (filename, original_name, sha256, source, raw_text, provider, doc_date) VALUES ('receipt-a.txt', 'receipt-a.txt', 'abc123', 'upload', 'x', 'Sample Pharmacy', '2026-10-20')").run().lastInsertRowid;
  db.prepare("INSERT INTO expenses (date, provider, description, amount, status, receipt_id, category) VALUES ('2026-10-20', 'Sample Pharmacy', 'Allergy relief', 12.5, 'approved', ?, 'Pharmacy')").run(rid);
  db.prepare("INSERT INTO audit_log (event, detail) VALUES ('approve', '{}')").run();
  setSetting('anthropic_api_key', 'secret-key-from-this-mac');
});

const expenses = () => db.prepare('SELECT description, amount, status FROM expenses ORDER BY id').all().map(r => ({ ...r }));

test('backups go to iCloud Drive by default', () => {
  assert.equal(backupFolder(), path.join(ICLOUD, 'HSA Tracker'));
});

test('a backup holds the records and receipt files, readable copies, and no secrets', async () => {
  const r = await runBackup();
  assert.equal(r.expenses, 1);
  assert.equal(r.receipts, 1);
  const snap = new DatabaseSync(path.join(backupsDir(), r.file), { readOnly: true });
  assert.equal(snap.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get().value, '""');
  assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 1);
  snap.close();
  assert.ok(existsSync(path.join(backupsDir(), 'receipt files', 'abc123.txt')));
  const readable = path.join(ICLOUD, 'HSA Tracker', 'Readable copies');
  assert.ok(existsSync(path.join(readable, 'Tax summary.pdf')));
  assert.match(readFileSync(path.join(readable, 'All records.csv'), 'utf8'), /Allergy relief/);
  assert.ok(existsSync(path.join(readable, 'Receipts', '2026-10-20 Sample Pharmacy (#1).txt')));
  assert.ok(existsSync(path.join(ICLOUD, 'HSA Tracker', 'READ ME.txt')));
  assert.equal(readdirSync(backupsDir()).filter(f => f.endsWith('.partial')).length, 0);
  // This Mac still has its key — only the backup copy was blanked.
  assert.equal(getSetting('anthropic_api_key'), 'secret-key-from-this-mac');
});

test('restore brings back records and missing receipt files, keeps this Mac\'s keys, and saves a safety copy first', async () => {
  const [latest] = listBackups();
  const before = expenses();
  // Things change after the backup: an edit, a new expense, a lost file, a new key.
  db.exec("UPDATE expenses SET amount = 99 WHERE description = 'Allergy relief'");
  db.prepare("INSERT INTO expenses (date, description, amount, status) VALUES ('2026-10-21', 'Added later', 5, 'pending_review')").run();
  rmSync(path.join(RECEIPTS_DIR, 'receipt-a.txt'));
  setSetting('anthropic_api_key', 'newer-key-on-this-mac');
  await new Promise(r => setTimeout(r, 1100)); // snapshot names are per-second

  const r = await restoreBackup(path.join(ICLOUD, 'HSA Tracker'), latest.file);
  assert.deepEqual(expenses(), before);
  assert.equal(r.missingFiles, 0);
  assert.ok(existsSync(path.join(RECEIPTS_DIR, 'receipt-a.txt')));
  assert.equal(getSetting('anthropic_api_key'), 'newer-key-on-this-mac');
  const safety = listBackups().filter(b => b.beforeRestore);
  assert.equal(safety.length, 1);
  assert.equal(safety[0].receipts, 1);
});

test('a backup from an older version (missing a newer column) still restores', async () => {
  const [latest] = listBackups().filter(b => !b.beforeRestore);
  const old = latest.file.replace('.db', '').replace(/(\d{6})$/, '000000') + '.db';
  copyFileSync(path.join(backupsDir(), latest.file), path.join(backupsDir(), old));
  const conn = new DatabaseSync(path.join(backupsDir(), old));
  conn.exec('ALTER TABLE expenses DROP COLUMN triage_engine');
  conn.close();
  await restoreBackup(path.join(ICLOUD, 'HSA Tracker'), old);
  assert.equal(expenses().length, 1);
  assert.equal(db.prepare('SELECT triage_engine FROM expenses').get().triage_engine, null);
});

test('only the newest 30 backups are kept (safety copies aside)', async () => {
  for (let i = 0; i < 35; i++) writeFileSync(path.join(backupsDir(), `HSA-backup-2020-01-01-00${String(i).padStart(2, '0')}00.db`), '');
  await runBackup({ plain: false });
  const files = readdirSync(backupsDir()).filter(f => f.startsWith('HSA-backup-'));
  assert.equal(files.filter(f => !f.includes('before-restore')).length, 30);
  assert.ok(files.some(f => f.includes('before-restore')));
});

test('nothing to back up to when iCloud Drive is off and no folder was chosen', async () => {
  setSetting('backup_dir', '');
  rmSync(ICLOUD, { recursive: true, force: true }); // the stand-in iCloud Drive "turned off"
  assert.equal(backupFolder(), '');
  await assert.rejects(runBackup(), /iCloud Drive isn't turned on/);
  mkdirSync(ICLOUD, { recursive: true });
});
