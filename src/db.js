// Database layer — uses Node's built-in SQLite (node:sqlite), no native builds needed.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.HSA_DATA_DIR || path.join(__dirname, '..', 'data');
export const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');

mkdirSync(RECEIPTS_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'hsa.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    original_name TEXT,
    mime TEXT,
    sha256 TEXT UNIQUE,
    source TEXT DEFAULT 'upload',        -- upload | email | import
    received_at TEXT DEFAULT (datetime('now')),
    raw_text TEXT,
    meta TEXT
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    provider TEXT,
    category TEXT DEFAULT 'Other',
    description TEXT,
    amount REAL NOT NULL,
    payment_method TEXT,
    status TEXT DEFAULT 'pending_review', -- pending_review | approved | rejected
    confidence TEXT,                      -- High | Medium | Low
    rationale TEXT,
    reimbursed INTEGER DEFAULT 0,
    date_reimbursed TEXT,
    source_type TEXT DEFAULT 'manual',    -- email | upload | import | manual
    receipt_id INTEGER REFERENCES receipts(id),
    order_ref TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    decided_at TEXT
  );

  CREATE TABLE IF NOT EXISTS discarded (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER REFERENCES receipts(id),
    description TEXT,
    amount REAL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS processed_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT,                            -- email_message_id | file_sha256
    ref TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Emails the poller examined but couldn't turn into a receipt (no supported
  -- attachment, no readable body). Recorded so nothing is silently dropped —
  -- the message stays in the inbox; this is the visible trail of what was passed over.
  CREATE TABLE IF NOT EXISTS skipped_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    from_addr TEXT,
    subject TEXT,
    reason TEXT,
    email_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Pairs of expenses the user confirmed are NOT the same purchase (a < b), so
  -- the possible-duplicate warning never comes back for them.
  CREATE TABLE IF NOT EXISTS not_duplicates (
    a INTEGER NOT NULL,
    b INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (a, b)
  );

  CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
`);

export function audit(event, detail) {
  db.prepare('INSERT INTO audit_log (event, detail) VALUES (?, ?)').run(event, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

// The IRS only counts expenses incurred on or after the HSA was established.
// Approved expenses dated earlier are kept as records but don't count toward
// what can be withdrawn — unless the user marked one as counting (pre_hsa_override),
// e.g. money transferred from an earlier HSA whose start date applies.
export function establishedDate() {
  const d = getSetting('hsa_established', '');
  return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : '';
}
const col = (a, c) => (a ? `${a}.${c}` : c);
/** SQL predicate: an approved expense dated before the HSA, not marked as counting. */
export function recordOnlySql(a = '') {
  const est = establishedDate(); // validated YYYY-MM-DD, safe to inline
  return est ? `(${col(a, 'status')} = 'approved' AND ${col(a, 'date')} < '${est}' AND ${col(a, 'pre_hsa_override')} = 0)` : '0';
}
/** SQL predicate: an approved expense that counts toward withdrawals. */
export const countsSql = (a = '') => `(${col(a, 'status')} = 'approved' AND NOT ${recordOnlySql(a)})`;
/** JS twin of the predicates above, for rows already loaded. */
export function isRecordOnly(e, est = establishedDate()) {
  return !!est && e.status === 'approved' && String(e.date) < est && !e.pre_hsa_override;
}

/** Today as YYYY-MM-DD in the computer's own time zone. (toISOString() is UTC,
 *  which is already tomorrow on a US evening.) */
export function localToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Rounds money to the cent. Amounts are stored as REAL, so every write and every
 *  sum goes through this to keep floating-point drift out of the record. */
export const cents = n => Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : n;

export function sha256File(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const DEFAULT_SETTINGS = {
  ai_provider: 'anthropic-api',   // anthropic-api | openai-api | keywords
  anthropic_api_key: '',
  anthropic_model: 'claude-sonnet-5',
  openai_api_key: '',
  openai_model: 'gpt-4o-mini',
  email_enabled: false,
  email_host: 'imap.gmail.com',
  email_port: 993,
  email_user: '',
  email_password: '',
  email_poll_minutes: 15,
  categories: ['Dental', 'Medical', 'Vision', 'Pharmacy', 'Other'],
  hsa_established: '',            // YYYY-MM-DD; expenses before it don't qualify
};

for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (getSetting(k) === null) setSetting(k, v);
}

// Migration: the claude-cli engine was removed (unreliable inside packaged apps).
if (getSetting('ai_provider') === 'claude-cli') setSetting('ai_provider', 'anthropic-api');
// A model is always concretely set — empty values from older versions get the default.
if (!getSetting('anthropic_model')) setSetting('anthropic_model', 'claude-sonnet-5');
if (!getSetting('openai_model')) setSetting('openai_model', 'gpt-4o-mini');
// Migration: approvals that knowingly override the HSA establishment date are flagged on the row.
if (!db.prepare('PRAGMA table_info(expenses)').all().some(c => c.name === 'pre_hsa_override')) {
  db.exec('ALTER TABLE expenses ADD COLUMN pre_hsa_override INTEGER DEFAULT 0');
}
