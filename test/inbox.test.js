// The HSA Inbox folder and the Print menu entry — against a stand-in "iCloud Drive"
// (HSA_ICLOUD_DIR) and a stand-in PDF Services folder, never the real ones.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, lstatSync, readlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ICLOUD = mkdtempSync(path.join(tmpdir(), 'hsa-icloud-'));
const PDF_SERVICES = mkdtempSync(path.join(tmpdir(), 'hsa-pdfservices-'));
const INBOX = path.join(ICLOUD, 'HSA Tracker', 'Inbox');
let db, setSetting, scanInbox, syncPrintEntry, listJobs;

before(async () => {
  process.env.HSA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'hsa-test-'));
  process.env.HSA_ICLOUD_DIR = ICLOUD;
  process.env.HSA_PDF_SERVICES_DIR = PDF_SERVICES;
  ({ db, setSetting } = await import('../src/db.js'));
  ({ scanInbox, syncPrintEntry } = await import('../src/lib/inbox.js'));
  ({ listJobs } = await import('../src/lib/ingest.js'));
  setSetting('ai_provider', 'keywords');
});

const settle = async () => {
  for (let i = 0; i < 200 && listJobs().some(j => ['queued', 'extracting', 'triaging'].includes(j.status)); i++) await new Promise(r => setTimeout(r, 10));
};
const old = p => { const t = new Date(Date.now() - 60_000); utimesSync(p, t, t); };

test('a receipt saved to the Inbox is imported and moved to Imported', async () => {
  mkdirSync(INBOX, { recursive: true });
  const p = path.join(INBOX, 'pharmacy.txt');
  writeFileSync(p, 'Sample Pharmacy\n10/20/2026\nIbuprofen 200mg 9.99\nTotal 9.99\n');
  old(p);
  assert.equal(await scanInbox(), 1);
  await settle();
  assert.ok(!existsSync(p));
  assert.ok(existsSync(path.join(INBOX, 'Imported', 'pharmacy.txt')));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE original_name = 'pharmacy.txt'").get().n, 1);
});

test('files still arriving, and files the app cannot read, are left alone', async () => {
  const fresh = path.join(INBOX, 'just-saved.pdf');
  writeFileSync(fresh, '%PDF-1.4 still syncing');
  const odd = path.join(INBOX, 'notes.pages');
  writeFileSync(odd, 'x');
  old(odd);
  assert.equal(await scanInbox(), 0);
  assert.ok(existsSync(fresh));
  assert.ok(existsSync(odd));
});

test('the same name imported twice is kept as two files, never overwritten', async () => {
  const p = path.join(INBOX, 'pharmacy.txt');
  writeFileSync(p, 'Sample Pharmacy\n10/21/2026\nBandages 5.49\nTotal 5.49\n');
  old(p);
  await scanInbox();
  await settle();
  assert.deepEqual(readdirSync(path.join(INBOX, 'Imported')).sort(), ['pharmacy (2).txt', 'pharmacy.txt']);
});

test('turning the Inbox off stops imports', async () => {
  setSetting('inbox_enabled', false);
  const p = path.join(INBOX, 'later.txt');
  writeFileSync(p, 'x');
  old(p);
  assert.equal(await scanInbox(), 0);
  assert.ok(existsSync(p));
  setSetting('inbox_enabled', true);
});

test('the Print menu entry points at the Inbox, and goes away when turned off', { skip: process.platform !== 'darwin' }, () => {
  const link = path.join(PDF_SERVICES, 'Save PDF to HSA Tracker');
  syncPrintEntry();
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), INBOX);
  setSetting('print_enabled', false);
  syncPrintEntry();
  assert.ok(!existsSync(link));
  // Something the user put there themselves is never touched.
  writeFileSync(link, 'mine');
  setSetting('print_enabled', true);
  syncPrintEntry();
  assert.ok(!lstatSync(link).isSymbolicLink());
});
