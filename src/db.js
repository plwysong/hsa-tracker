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
};

for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (getSetting(k) === null) setSetting(k, v);
}

// Migration: the claude-cli engine was removed (unreliable inside packaged apps).
if (getSetting('ai_provider') === 'claude-cli') setSetting('ai_provider', 'anthropic-api');
// A model is always concretely set — empty values from older versions get the default.
if (!getSetting('anthropic_model')) setSetting('anthropic_model', 'claude-sonnet-5');
if (!getSetting('openai_model')) setSetting('openai_model', 'gpt-4o-mini');
