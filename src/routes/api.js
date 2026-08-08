import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { db, RECEIPTS_DIR, getSetting, setSetting, audit } from '../db.js';
import { ingestDocument, retriageReceipt, listJobs, clearFinishedJobs } from '../lib/ingest.js';
import { isSupported } from '../lib/extract.js';
import { testProvider } from '../lib/triage.js';
import { checkEmailNow, emailStatus, restartEmailPolling } from '../lib/email.js';
import { ledgerCsv, fullJson, fullZip, receiptsZip, summaryPdfBuffer } from '../lib/exporter.js';

export const api = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ---------- App meta ----------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
api.get('/meta', (req, res) => res.json({ version: pkg.version }));

// Update notifications: checks the public GitHub releases page (at most hourly)
// and tells the UI when a newer version exists.
const UPDATE_REPO = 'plwysong/hsa-tracker';
let updateCache = { at: 0, data: null };
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
api.get('/update-check', wrap(async (req, res) => {
  if (updateCache.data && Date.now() - updateCache.at < 3600 * 1000) return res.json(updateCache.data);
  let out = { current: pkg.version, updateAvailable: false };
  try {
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'user-agent': 'hsa-tracker', accept: 'application/vnd.github+json' },
    });
    if (r.ok) {
      const rel = await r.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      const dmg = (rel.assets || []).find(a => a.name.endsWith('.dmg'));
      out = {
        current: pkg.version,
        latest,
        updateAvailable: isNewer(latest, pkg.version),
        downloadUrl: dmg ? dmg.browser_download_url : (rel.html_url || ''),
      };
    }
  } catch { /* offline or rate-limited — stay quiet */ }
  updateCache = { at: Date.now(), data: out };
  res.json(out);
}));

// ---------- Stats / dashboard ----------
api.get('/stats', wrap((req, res) => {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'approved' THEN amount END), 0) AS approved_total,
      COALESCE(SUM(CASE WHEN status = 'approved' AND reimbursed = 1 THEN amount END), 0) AS reimbursed_total,
      COALESCE(SUM(CASE WHEN status = 'pending_review' THEN amount END), 0) AS pending_total,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_count,
      COALESCE(SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END), 0) AS pending_count,
      COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected_count
    FROM expenses
  `).get();
  const byCategory = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS count
    FROM expenses WHERE status = 'approved' GROUP BY category ORDER BY total DESC
  `).all();
  const byYear = db.prepare(`
    SELECT substr(date, 1, 4) AS year, SUM(amount) AS total, COUNT(*) AS count
    FROM expenses WHERE status = 'approved' GROUP BY year ORDER BY year
  `).all();
  const byMonth = db.prepare(`
    SELECT substr(date, 1, 7) AS month, SUM(amount) AS total
    FROM expenses WHERE status = 'approved' GROUP BY month ORDER BY month
  `).all();
  const recent = db.prepare(`
    SELECT e.*, r.filename AS receipt_filename FROM expenses e
    LEFT JOIN receipts r ON r.id = e.receipt_id
    WHERE e.status = 'approved' ORDER BY e.decided_at DESC, e.id DESC LIMIT 8
  `).all();
  res.json({
    ...totals,
    unreimbursed_total: totals.approved_total - totals.reimbursed_total,
    byCategory, byYear, byMonth, recent,
  });
}));

// ---------- Expenses ----------
api.get('/expenses', wrap((req, res) => {
  const { status, category, year, q, confidence, source, reimbursed } = req.query;
  const clauses = [], params = [];
  if (status) { clauses.push('e.status = ?'); params.push(status); }
  if (category) { clauses.push('e.category = ?'); params.push(category); }
  if (year) { clauses.push('substr(e.date, 1, 4) = ?'); params.push(String(year)); }
  if (confidence) { clauses.push('e.confidence = ?'); params.push(confidence); }
  if (source) { clauses.push('e.source_type = ?'); params.push(source); }
  if (reimbursed === 'yes') clauses.push('e.reimbursed = 1');
  if (reimbursed === 'no') clauses.push('e.reimbursed = 0');
  if (q) {
    clauses.push('(e.description LIKE ? OR e.provider LIKE ? OR e.rationale LIKE ? OR e.order_ref LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT e.*, r.filename AS receipt_filename, r.original_name AS receipt_original_name, r.source AS receipt_source
    FROM expenses e LEFT JOIN receipts r ON r.id = e.receipt_id
    ${where} ORDER BY e.date DESC, e.id DESC
  `).all(...params);
  res.json(rows);
}));

api.get('/expenses/:id(\\d+)', wrap((req, res) => {
  const row = db.prepare(`
    SELECT e.*, r.filename AS receipt_filename, r.original_name AS receipt_original_name
    FROM expenses e LEFT JOIN receipts r ON r.id = e.receipt_id WHERE e.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
}));

api.delete('/expenses/:id', wrap((req, res) => {
  const row = db.prepare('SELECT id, description, amount FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  audit('delete', { id: row.id, description: row.description, amount: row.amount });
  res.json({ ok: true });
}));

api.post('/expenses', wrap((req, res) => {
  const { date, provider, category, description, amount, payment_method, notes, receipt_id, order_ref } = req.body;
  if (!date || !description || !Number.isFinite(Number(amount))) {
    return res.status(400).json({ error: 'date, description and a numeric amount are required' });
  }
  const r = db.prepare(`
    INSERT INTO expenses (date, provider, category, description, amount, payment_method, status, confidence, rationale, source_type, receipt_id, order_ref, notes, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, 'approved', 'High', 'Manually added by user.', 'manual', ?, ?, ?, ?)
  `).run(date, provider || '', category || 'Other', description, Number(amount), payment_method || null,
    receipt_id || null, order_ref || null, notes || null, new Date().toISOString());
  audit('manual_add', { id: Number(r.lastInsertRowid), description, amount });
  res.json({ id: Number(r.lastInsertRowid) });
}));

api.patch('/expenses/:id', wrap((req, res) => {
  const allowed = ['date', 'provider', 'category', 'description', 'amount', 'payment_method', 'notes', 'order_ref', 'confidence'];
  const sets = [], params = [];
  for (const k of allowed) {
    if (k in req.body) { sets.push(`${k} = ?`); params.push(k === 'amount' ? Number(req.body[k]) : req.body[k]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' });
  sets.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  audit('edit', { id: Number(req.params.id), fields: Object.keys(req.body) });
  res.json({ ok: true });
}));

function decide(id, status) {
  db.prepare("UPDATE expenses SET status = ?, decided_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, new Date().toISOString(), id);
}

api.post('/expenses/:id/approve', wrap((req, res) => {
  decide(req.params.id, 'approved');
  audit('approve', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

api.post('/expenses/:id/reject', wrap((req, res) => {
  decide(req.params.id, 'rejected');
  audit('reject', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

api.post('/expenses/:id/reopen', wrap((req, res) => {
  decide(req.params.id, 'pending_review');
  audit('reopen', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

api.post('/expenses/bulk', wrap((req, res) => {
  const { ids, action, date_reimbursed, category } = req.body;
  const ACTIONS = ['approve', 'reject', 'reopen', 'reimburse', 'unreimburse', 'delete', 'category'];
  if (!Array.isArray(ids) || !ids.length || !ACTIONS.includes(action)) {
    return res.status(400).json({ error: `ids array and action (${ACTIONS.join('|')}) required` });
  }
  if (action === 'category' && !category) return res.status(400).json({ error: 'category required' });
  for (const id of ids) {
    if (action === 'approve') decide(id, 'approved');
    else if (action === 'reject') decide(id, 'rejected');
    else if (action === 'reopen') decide(id, 'pending_review');
    else if (action === 'reimburse') db.prepare("UPDATE expenses SET reimbursed = 1, date_reimbursed = ?, updated_at = datetime('now') WHERE id = ?").run(date_reimbursed || new Date().toISOString().slice(0, 10), id);
    else if (action === 'unreimburse') db.prepare("UPDATE expenses SET reimbursed = 0, date_reimbursed = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
    else if (action === 'delete') db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    else if (action === 'category') db.prepare("UPDATE expenses SET category = ?, updated_at = datetime('now') WHERE id = ?").run(category, id);
  }
  audit('bulk_' + action, { count: ids.length, ids, date_reimbursed, category });
  res.json({ ok: true, count: ids.length });
}));

api.post('/expenses/:id/reimburse', wrap((req, res) => {
  const { reimbursed, date_reimbursed } = req.body;
  db.prepare("UPDATE expenses SET reimbursed = ?, date_reimbursed = ?, updated_at = datetime('now') WHERE id = ?")
    .run(reimbursed ? 1 : 0, reimbursed ? (date_reimbursed || new Date().toISOString().slice(0, 10)) : null, req.params.id);
  audit('reimburse', { id: Number(req.params.id), reimbursed: !!reimbursed });
  res.json({ ok: true });
}));

// ---------- Upload & processing jobs ----------
api.post('/upload', upload.array('files', 20), wrap((req, res) => {
  const jobs = [];
  for (const f of req.files || []) {
    if (!isSupported(f.mimetype, f.originalname)) {
      jobs.push({ name: f.originalname, status: 'error', detail: `Unsupported file type (${f.mimetype})` });
      continue;
    }
    jobs.push(ingestDocument(f.buffer, { originalName: f.originalname, mime: f.mimetype, source: 'upload', sourceDetail: {} }));
  }
  res.json({ jobs });
}));

api.get('/jobs', wrap((req, res) => res.json(listJobs())));
api.post('/jobs/clear', wrap((req, res) => { clearFinishedJobs(); res.json({ ok: true }); }));

// ---------- Receipts ----------
api.get('/receipts', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.filename, r.original_name, r.mime, r.source, r.received_at, r.meta,
      (SELECT COUNT(*) FROM expenses e WHERE e.receipt_id = r.id) AS expense_count,
      (SELECT COUNT(*) FROM discarded d WHERE d.receipt_id = r.id) AS discarded_count
    FROM receipts r ORDER BY r.received_at DESC, r.id DESC
  `).all();
  res.json(rows);
}));

api.get('/receipts/:id/file', wrap((req, res) => {
  const r = db.prepare('SELECT filename, mime, original_name FROM receipts WHERE id = ?').get(req.params.id);
  if (!r || !r.filename) return res.status(404).json({ error: 'Receipt not found' });
  const p = path.join(RECEIPTS_DIR, r.filename);
  if (!existsSync(p)) return res.status(404).json({ error: 'Receipt file missing on disk' });
  if (r.mime) res.type(r.mime);
  const download = req.query.download === '1';
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(r.original_name || r.filename)}"`);
  res.sendFile(p);
}));

api.post('/receipts/:id/retriage', wrap((req, res) => {
  res.json(retriageReceipt(Number(req.params.id)));
}));

api.get('/receipts/:id/text', wrap((req, res) => {
  const r = db.prepare('SELECT raw_text FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });
  res.json({ raw_text: r.raw_text || '' });
}));

// ---------- Discarded log & audit trail ----------
api.get('/discarded', wrap((req, res) => {
  res.json(db.prepare(`
    SELECT d.*, r.filename AS receipt_filename, r.original_name AS receipt_original_name
    FROM discarded d LEFT JOIN receipts r ON r.id = d.receipt_id
    ORDER BY d.id DESC
  `).all());
}));

api.post('/discarded/:id/requeue', wrap((req, res) => {
  const d = db.prepare('SELECT * FROM discarded WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (!Number.isFinite(d.amount) || d.amount <= 0) return res.status(400).json({ error: 'This entry has no amount — add it manually from the Ledger instead.' });
  const r = db.prepare(`
    INSERT INTO expenses (date, provider, category, description, amount, status, confidence, rationale, source_type, receipt_id)
    VALUES (?, ?, 'Other', ?, ?, 'pending_review', 'Low', ?, 'manual', ?)
  `).run(new Date().toISOString().slice(0, 10), '', d.description, d.amount,
    `Originally auto-discarded ("${d.reason}") — re-queued by user for reconsideration.`, d.receipt_id);
  audit('requeue_discarded', { discardedId: d.id, newExpenseId: Number(r.lastInsertRowid) });
  res.json({ id: Number(r.lastInsertRowid) });
}));

api.get('/audit', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
}));

// ---------- Settings ----------
const SETTING_KEYS = ['ai_provider', 'anthropic_api_key', 'openai_api_key', 'email_enabled', 'email_host', 'email_port', 'email_user', 'email_password', 'email_poll_minutes', 'categories'];
const SECRET_KEYS = ['anthropic_api_key', 'openai_api_key', 'email_password'];

api.get('/settings', wrap((req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  // Don't ship secrets to the UI — just whether they're set
  for (const k of SECRET_KEYS) out[k] = out[k] ? '••••set••••' : '';
  res.json(out);
}));

api.put('/settings', wrap((req, res) => {
  for (const k of SETTING_KEYS) {
    if (!(k in req.body)) continue;
    const v = req.body[k];
    if (SECRET_KEYS.includes(k) && v === '••••set••••') continue; // unchanged
    setSetting(k, v);
  }
  restartEmailPolling();
  audit('settings_update', { keys: Object.keys(req.body) });
  res.json({ ok: true });
}));

api.post('/ai/test', wrap(async (req, res) => {
  res.json(await testProvider());
}));

// ---------- Email ----------
api.get('/email/status', wrap((req, res) => res.json(emailStatus())));
api.post('/email/check', wrap(async (req, res) => res.json(await checkEmailNow())));

// ---------- App lifecycle ----------
api.post('/quit', wrap((req, res) => {
  audit('quit', 'Server stopped from the UI');
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
}));

// ---------- Export ----------
api.get('/export/csv', wrap((req, res) => {
  const ids = req.query.ids ? String(req.query.ids).split(',').map(Number).filter(Number.isFinite) : null;
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="HSA-ledger.csv"');
  res.send(ledgerCsv({ approvedOnly: !ids && req.query.all !== '1', ids }));
}));

api.get('/export/receipts', wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Number.isFinite);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  res.type('application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="HSA-receipts-selection.zip"');
  await receiptsZip(ids, res);
}));

api.get('/export/json', wrap((req, res) => {
  res.type('application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="HSA-full-backup.json"');
  res.send(fullJson());
}));

api.get('/export/pdf', wrap(async (req, res) => {
  res.type('application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="HSA-summary.pdf"');
  res.send(await summaryPdfBuffer());
}));

api.get('/export/zip', wrap(async (req, res) => {
  res.type('application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="HSA-full-backup-${new Date().toISOString().slice(0, 10)}.zip"`);
  await fullZip(res);
}));
