import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { db, RECEIPTS_DIR, getSetting, setSetting, audit, establishedDate, countsSql, recordOnlySql, localToday, cents } from '../db.js';
import { ingestDocument, retriageReceipt, listJobs, clearFinishedJobs } from '../lib/ingest.js';
import { linkPayments } from '../lib/payments.js';
import { isSupported } from '../lib/extract.js';
import { testProvider } from '../lib/triage.js';
import { checkEmailNow, emailStatus, restartEmailPolling } from '../lib/email.js';
import { ledgerCsv, fullJson, fullZip, receiptsZip, allReceiptsZip, summaryPdfBuffer } from '../lib/exporter.js';

export const api = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// try/catch (not Promise.resolve(fn(...))) so synchronous throws — e.g. SQLite
// constraint errors — return JSON too instead of Express's HTML stack page.
const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = d => {
  const s = String(d);
  if (!DATE_RE.test(s)) return false;
  const [y, m, day] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
};
const isValidAmount = a => Number.isFinite(Number(a)) && Number(a) > 0;

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
  // Totals and charts cover expenses that count toward withdrawals; records-only
  // (dated before the HSA) are reported separately. Reimbursed is what actually left the HSA.
  const counts = countsSql(), recordOnly = recordOnlySql();
  const totals = db.prepare(`
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN ${counts} THEN amount END), 0), 2) AS approved_total,
      ROUND(COALESCE(SUM(CASE WHEN status = 'approved' AND reimbursed = 1 THEN amount END), 0), 2) AS reimbursed_total,
      ROUND(COALESCE(SUM(CASE WHEN ${counts} AND reimbursed = 0 THEN amount END), 0), 2) AS unreimbursed_total,
      ROUND(COALESCE(SUM(CASE WHEN ${recordOnly} THEN amount END), 0), 2) AS record_only_total,
      COALESCE(SUM(CASE WHEN ${recordOnly} THEN 1 ELSE 0 END), 0) AS record_only_count,
      COALESCE(SUM(CASE WHEN ${recordOnly} AND reimbursed = 1 THEN 1 ELSE 0 END), 0) AS record_only_reimbursed_count,
      ROUND(COALESCE(SUM(CASE WHEN status = 'pending_review' THEN amount END), 0), 2) AS pending_total,
      COALESCE(SUM(CASE WHEN ${counts} THEN 1 ELSE 0 END), 0) AS approved_count,
      COALESCE(SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END), 0) AS pending_count,
      COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected_count
    FROM expenses
  `).get();
  const byCategory = db.prepare(`
    SELECT category, ROUND(SUM(amount), 2) AS total, COUNT(*) AS count
    FROM expenses WHERE ${counts} GROUP BY category ORDER BY total DESC
  `).all();
  const byYear = db.prepare(`
    SELECT substr(date, 1, 4) AS year, ROUND(SUM(amount), 2) AS total, COUNT(*) AS count
    FROM expenses WHERE ${counts} GROUP BY year ORDER BY year
  `).all();
  const byMonth = db.prepare(`
    SELECT substr(date, 1, 7) AS month, ROUND(SUM(amount), 2) AS total
    FROM expenses WHERE ${counts} GROUP BY month ORDER BY month
  `).all();
  const recent = db.prepare(`
    SELECT e.*, r.filename AS receipt_filename FROM expenses e
    LEFT JOIN receipts r ON r.id = e.receipt_id
    WHERE e.status = 'approved' ORDER BY e.decided_at DESC, e.id DESC LIMIT 8
  `).all();
  const receipts_count = db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
  const discarded_count = db.prepare('SELECT COUNT(*) AS n FROM discarded').get().n;
  // Documents waiting on the user besides line items: ones that produced nothing (not still
  // being read) and card slips not yet linked. Review's badge counts them too.
  const busy = new Set(listJobs().filter(j => ['queued', 'extracting', 'triaging'].includes(j.status)).map(j => j.receiptId));
  const attention_count = db.prepare(`
    SELECT r.id FROM receipts r
    WHERE COALESCE(r.doc_kind, '') != 'payment' AND COALESCE(r.attention_dismissed, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.receipt_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM discarded d WHERE d.receipt_id = r.id)`).all().filter(r => !busy.has(r.id)).length;
  const waiting_payment_count = db.prepare(`
    SELECT COUNT(*) AS n FROM receipts r WHERE r.doc_kind = 'payment' AND r.payment_for IS NULL
      AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.receipt_id = r.id)`).get().n;
  res.json({
    ...totals,
    receipts_count, discarded_count, attention_count, waiting_payment_count,
    byCategory, byYear, byMonth, recent,
  });
}));

// ---------- Possible duplicates ----------
// The same purchase can arrive twice in different forms (an emailed receipt and a
// photo of the paper one). Identical files are caught at upload; this catches the
// rest: same date, same amount, similar provider, on different receipts (lines of
// one receipt never match each other — two boxes on one order are two purchases).
// Only approved and pending rows take part. It warns, never blocks for good: the
// user can confirm "not a duplicate", which is remembered per pair.
const LIVE = "('approved', 'pending_review')";
const providerKey = p => String(p || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
const similarProvider = (p, q) => {
  const a = providerKey(p), b = providerKey(q);
  return !a || !b || a === 'unknow' || b === 'unknow' || a === b;
};
const pairKey = (x, y) => (x < y ? [x, y] : [y, x]);
const isDismissed = (x, y) => !!db.prepare('SELECT 1 FROM not_duplicates WHERE a = ? AND b = ?').get(...pairKey(x, y));

/** Possible duplicates for one expense-shaped object ({id?, date, amount, provider, receipt_id}). */
function duplicatesOf(e) {
  return db.prepare(`
    SELECT id, date, provider, description, amount, status, receipt_id FROM expenses
    WHERE status IN ${LIVE} AND date = ? AND ROUND(amount, 2) = ROUND(?, 2) AND id != ?
      AND NOT (? IS NOT NULL AND receipt_id IS ?)
  `).all(e.date, Number(e.amount), e.id ?? -1, e.receipt_id ?? null, e.receipt_id ?? null)
    .filter(o => similarProvider(e.provider, o.provider) && (e.id == null || !isDismissed(e.id, o.id)));
}

/** Map of expense id → its possible duplicates, across every live expense. */
function duplicateMap() {
  const pairs = db.prepare(`
    SELECT x.id AS id, y.id AS other, x.provider AS p, y.provider AS q
    FROM expenses x JOIN expenses y
      ON x.date = y.date AND ROUND(x.amount, 2) = ROUND(y.amount, 2) AND x.id != y.id
    WHERE x.status IN ${LIVE} AND y.status IN ${LIVE}
      AND NOT (x.receipt_id IS NOT NULL AND x.receipt_id IS y.receipt_id)
  `).all();
  const map = new Map();
  for (const r of pairs) {
    if (!similarProvider(r.p, r.q) || isDismissed(r.id, r.other)) continue;
    if (!map.has(r.id)) map.set(r.id, []);
    map.get(r.id).push(r.other);
  }
  return map;
}
function withDuplicates(rows) {
  const map = duplicateMap();
  if (!map.size) return rows;
  const brief = db.prepare('SELECT id, date, provider, description, amount, status FROM expenses WHERE id = ?');
  for (const r of rows) if (map.has(r.id)) r.duplicates = map.get(r.id).map(id => brief.get(id));
  return rows;
}
function dismissDuplicates(id, others) {
  const ins = db.prepare('INSERT OR IGNORE INTO not_duplicates (a, b) VALUES (?, ?)');
  for (const o of others) ins.run(...pairKey(Number(id), Number(o)));
}
const possibleDuplicate = (res, matches) => res.status(409).json({
  code: 'possible_duplicate', matches,
  error: 'This looks like an expense already in your expenses — same date, amount and provider.',
});

// ---------- Expenses ----------
api.get('/expenses', wrap((req, res) => {
  const { status, category, year, q, confidence, source, reimbursed, receipt_id, pre_hsa } = req.query;
  const clauses = [], params = [];
  if (receipt_id) { clauses.push('e.receipt_id = ?'); params.push(Number(receipt_id)); }
  if (status) { clauses.push('e.status = ?'); params.push(status); }
  if (category) { clauses.push('e.category = ?'); params.push(category); }
  if (year) { clauses.push('substr(e.date, 1, 4) = ?'); params.push(String(year)); }
  if (confidence) { clauses.push('e.confidence = ?'); params.push(confidence); }
  if (source) { clauses.push('e.source_type = ?'); params.push(source); }
  if (reimbursed === 'yes') clauses.push('e.reimbursed = 1');
  if (reimbursed === 'no') clauses.push('e.reimbursed = 0');
  if (pre_hsa === '1') { clauses.push('e.date < ?'); params.push(establishedDate() || '0000-00-00'); }
  if (q) {
    clauses.push("(e.description LIKE ? ESCAPE '\\' OR e.provider LIKE ? ESCAPE '\\' OR e.rationale LIKE ? ESCAPE '\\' OR e.order_ref LIKE ? ESCAPE '\\')");
    const like = `%${String(q).replace(/[\\%_]/g, c => '\\' + c)}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT e.*, r.filename AS receipt_filename, r.original_name AS receipt_original_name, r.mime AS receipt_mime, r.source AS receipt_source
    FROM expenses e LEFT JOIN receipts r ON r.id = e.receipt_id
    ${where} ORDER BY e.date DESC, e.id DESC
  `).all(...params);
  for (const r of rows) r.payment_proofs = r.receipt_id ? paymentProofs(r.receipt_id) : [];
  res.json(withDuplicates(rows));
}));

api.get('/expenses/:id(\\d+)', wrap((req, res) => {
  const row = db.prepare(`
    SELECT e.*, r.filename AS receipt_filename, r.original_name AS receipt_original_name, r.mime AS receipt_mime
    FROM expenses e LEFT JOIN receipts r ON r.id = e.receipt_id WHERE e.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.payment_proofs = row.receipt_id ? paymentProofs(row.receipt_id) : [];
  res.json(withDuplicates([row])[0]);
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
  if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (!description) return res.status(400).json({ error: 'description is required' });
  if (!isValidAmount(amount)) return res.status(400).json({ error: 'amount must be a positive number' });
  const est = establishedDate();
  const before = est && date < est;
  if (before && !PRE_HSA.includes(req.body.pre_hsa)) return beforeEstablished(res, est, 1, 1);
  const dups = duplicatesOf({ date, amount, provider, receipt_id: receipt_id || null });
  if (dups.length && !req.body.not_duplicate) return possibleDuplicate(res, dups);
  const r = db.prepare(`
    INSERT INTO expenses (date, provider, category, description, amount, payment_method, status, confidence, rationale, source_type, receipt_id, order_ref, notes, decided_at, pre_hsa_override)
    VALUES (?, ?, ?, ?, ?, ?, 'approved', 'High', 'Manually added by user.', 'manual', ?, ?, ?, ?, ?)
  `).run(date, provider || '', category || 'Other', description, cents(amount), payment_method || null,
    receipt_id || null, order_ref || null, notes || null, new Date().toISOString(), before && req.body.pre_hsa === 'count' ? 1 : 0);
  if (dups.length) dismissDuplicates(r.lastInsertRowid, dups.map(d => d.id));
  audit('manual_add', { id: Number(r.lastInsertRowid), description, amount, ...(before && { before_established: est, pre_hsa: req.body.pre_hsa }), ...(dups.length && { not_duplicate_of: dups.map(d => d.id) }) });
  res.json({ id: Number(r.lastInsertRowid) });
}));

api.patch('/expenses/:id', wrap((req, res) => {
  const allowed = ['date', 'provider', 'category', 'description', 'amount', 'payment_method', 'notes', 'order_ref', 'confidence'];
  if ('date' in req.body && !isValidDate(req.body.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if ('amount' in req.body && !isValidAmount(req.body.amount)) return res.status(400).json({ error: 'amount must be a positive number' });
  const sets = [], params = [];
  for (const k of allowed) {
    if (k in req.body) { sets.push(`${k} = ?`); params.push(k === 'amount' ? cents(req.body[k]) : req.body[k]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' });
  sets.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  audit('edit', { id: Number(req.params.id), fields: Object.keys(req.body) });
  res.json({ ok: true });
}));

// Approving an expense dated before the HSA was established needs an explicit
// choice (the UI asks): 'record' keeps it as a record that doesn't count toward
// withdrawals; 'count' marks it as counting anyway (pre_hsa_override).
const PRE_HSA = ['record', 'count'];
function predating(ids) {
  const est = establishedDate();
  if (!est) return [];
  return ids.filter(id => {
    const row = db.prepare('SELECT date FROM expenses WHERE id = ?').get(id);
    return row && row.date < est;
  });
}
const beforeEstablished = (res, est, count, total) => res.status(409).json({
  code: 'before_established', established: est, count, total,
  error: `${total === 1 ? 'This expense is' : `${count} of ${total} expenses ${count === 1 ? 'is' : 'are'}`} dated before your HSA was established (${est}).`,
});

function decide(id, status, override = false) {
  return db.prepare("UPDATE expenses SET status = ?, decided_at = ?, pre_hsa_override = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, new Date().toISOString(), override ? 1 : 0, id).changes;
}

api.post('/expenses/:id/approve', wrap((req, res) => {
  const early = predating([Number(req.params.id)]).length > 0;
  const choice = req.body?.pre_hsa;
  if (early && !PRE_HSA.includes(choice)) return beforeEstablished(res, establishedDate(), 1, 1);
  const self = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  const dups = self ? duplicatesOf(self) : [];
  if (dups.length && !req.body?.not_duplicate) return possibleDuplicate(res, dups);
  if (dups.length) dismissDuplicates(self.id, dups.map(d => d.id));
  if (!decide(req.params.id, 'approved', early && choice === 'count')) return res.status(404).json({ error: 'Not found' });
  audit('approve', { id: Number(req.params.id), ...(early && { before_established: establishedDate(), pre_hsa: choice }), ...(dups.length && { not_duplicate_of: dups.map(d => d.id) }) });
  res.json({ ok: true });
}));

// "Not a duplicate": remember every current match for this expense.
api.post('/expenses/:id/not-duplicate', wrap((req, res) => {
  const self = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!self) return res.status(404).json({ error: 'Not found' });
  const others = duplicatesOf(self).map(d => d.id);
  dismissDuplicates(self.id, others);
  audit('not_duplicate', { id: self.id, of: others });
  res.json({ ok: true, count: others.length });
}));

// Switch an approved pre-HSA expense between record-only and counting.
api.post('/expenses/:id/pre-hsa', wrap((req, res) => {
  const row = db.prepare('SELECT status FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'approved' || !predating([Number(req.params.id)]).length) {
    return res.status(400).json({ error: 'Only approved expenses dated before your HSA was established can be switched' });
  }
  const count = !!req.body?.count;
  db.prepare("UPDATE expenses SET pre_hsa_override = ?, updated_at = datetime('now') WHERE id = ?").run(count ? 1 : 0, req.params.id);
  audit('pre_hsa', { id: Number(req.params.id), counts: count, before_established: establishedDate() });
  res.json({ ok: true });
}));

api.post('/expenses/:id/reject', wrap((req, res) => {
  if (!decide(req.params.id, 'rejected')) return res.status(404).json({ error: 'Not found' });
  audit('reject', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

api.post('/expenses/:id/reopen', wrap((req, res) => {
  if (!decide(req.params.id, 'pending_review')) return res.status(404).json({ error: 'Not found' });
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
  const early = action === 'approve' ? predating(ids) : [];
  if (early.length && !PRE_HSA.includes(req.body.pre_hsa)) return beforeEstablished(res, establishedDate(), early.length, ids.length);
  // Matches inside the batch count too (the same purchase from two receipts approved together).
  const dupPairs = action !== 'approve' ? [] : ids.flatMap(id => {
    const self = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    return self ? duplicatesOf(self).map(d => ({ id: Number(id), other: d })) : [];
  });
  if (dupPairs.length && !req.body.not_duplicate) {
    const seen = new Set();
    return possibleDuplicate(res, dupPairs.map(p => p.other).filter(o => !seen.has(o.id) && seen.add(o.id)));
  }
  for (const p of dupPairs) dismissDuplicates(p.id, [p.other.id]);
  let affected = 0;
  for (const id of ids) {
    if (action === 'approve') affected += decide(id, 'approved', early.includes(id) && req.body.pre_hsa === 'count');
    else if (action === 'reject') affected += decide(id, 'rejected');
    else if (action === 'reopen') affected += decide(id, 'pending_review');
    else if (action === 'reimburse') affected += db.prepare("UPDATE expenses SET reimbursed = 1, date_reimbursed = ?, updated_at = datetime('now') WHERE id = ? AND status = 'approved'").run(date_reimbursed || localToday(), id).changes;
    else if (action === 'unreimburse') affected += db.prepare("UPDATE expenses SET reimbursed = 0, date_reimbursed = NULL, updated_at = datetime('now') WHERE id = ?").run(id).changes;
    else if (action === 'delete') affected += db.prepare('DELETE FROM expenses WHERE id = ?').run(id).changes;
    else if (action === 'category') affected += db.prepare("UPDATE expenses SET category = ?, updated_at = datetime('now') WHERE id = ?").run(category, id).changes;
  }
  audit('bulk_' + action, { count: affected, ids, date_reimbursed, category, ...(early.length && { before_established: establishedDate(), pre_hsa: req.body.pre_hsa, pre_hsa_ids: early }) });
  res.json({ ok: true, count: affected });
}));

api.post('/expenses/:id/reimburse', wrap((req, res) => {
  const { reimbursed, date_reimbursed } = req.body;
  const row = db.prepare('SELECT status FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (reimbursed && row.status !== 'approved') {
    return res.status(400).json({ error: 'Only approved expenses can be marked reimbursed' });
  }
  db.prepare("UPDATE expenses SET reimbursed = ?, date_reimbursed = ?, updated_at = datetime('now') WHERE id = ?")
    .run(reimbursed ? 1 : 0, reimbursed ? (date_reimbursed || localToday()) : null, req.params.id);
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
api.post('/jobs/clear', wrap((req, res) => { clearFinishedJobs(req.body || {}); res.json({ ok: true }); }));

// ---------- Receipts ----------
api.get('/receipts', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.filename, r.original_name, r.mime, r.source, r.received_at, r.meta,
      r.doc_kind, r.doc_date, r.provider, r.amount_paid, r.discounts, r.payment_ref, r.payment_for, r.payment_unlinked, r.attention_dismissed,
      (length(trim(r.raw_text)) >= 10) AS has_text,
      ROUND((SELECT COALESCE(SUM(amount), 0) FROM expenses e WHERE e.receipt_id = r.id AND e.status != 'rejected')
        + (SELECT COALESCE(SUM(amount), 0) FROM discarded d WHERE d.receipt_id = r.id), 2) AS lines_total,
      (SELECT COUNT(*) FROM expenses e WHERE e.receipt_id = r.id) AS expense_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.receipt_id = r.id AND e.status = 'approved') AS approved_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.receipt_id = r.id AND e.status = 'pending_review') AS pending_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.receipt_id = r.id AND e.status = 'rejected') AS rejected_count,
      (SELECT COUNT(*) FROM discarded d WHERE d.receipt_id = r.id) AS discarded_count,
      -- Receipts stored before v1.7 have no provider/date/amount of their own; their lines do.
      (SELECT provider FROM expenses e WHERE e.receipt_id = r.id AND COALESCE(provider, '') != '' ORDER BY id LIMIT 1) AS items_provider,
      (SELECT MIN(date) FROM expenses e WHERE e.receipt_id = r.id) AS items_date,
      ROUND((SELECT SUM(amount) FROM expenses e WHERE e.receipt_id = r.id AND e.status != 'rejected'), 2) AS items_total
    FROM receipts r ORDER BY r.received_at DESC, r.id DESC
  `).all();
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const r of rows) {
    r.payments = rows.filter(p => p.payment_for === r.id).map(p => ({ id: p.id, name: p.original_name || p.filename, payment_ref: p.payment_ref, amount_paid: p.amount_paid }));
    if (r.payment_for) { const t = byId.get(r.payment_for); r.payment_for_name = t ? (t.original_name || t.filename) : null; }
  }
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

// Permanent removal of a receipt and everything derived from it. Reject keeps
// data for the audit trail; this is the one path that truly drops it, so the UI
// confirms with exact counts first. The file's hash record goes too, so the same
// document can be uploaded again later on purpose (an emailed receipt's message
// id is kept, or the poller would bring it straight back).
api.delete('/receipts/:id', wrap((req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM expenses WHERE receipt_id = ? AND status = 'approved') AS approved,
      (SELECT COUNT(*) FROM expenses WHERE receipt_id = ? AND status != 'approved') AS other,
      (SELECT COUNT(*) FROM discarded WHERE receipt_id = ?) AS discarded`).get(r.id, r.id, r.id);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM expenses WHERE receipt_id = ?').run(r.id);
    db.prepare('DELETE FROM discarded WHERE receipt_id = ?').run(r.id);
    db.prepare('DELETE FROM receipts WHERE id = ?').run(r.id);
    db.prepare('UPDATE receipts SET payment_for = NULL WHERE payment_for = ?').run(r.id);
    if (r.sha256) db.prepare("DELETE FROM processed_sources WHERE kind = 'file_sha256' AND ref = ?").run(r.sha256);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (r.filename) {
    const p = path.join(RECEIPTS_DIR, r.filename);
    if (existsSync(p)) unlinkSync(p);
  }
  audit('receipt_delete', { id: r.id, file: r.original_name || r.filename, source: r.source, ...counts });
  res.json({ ok: true, ...counts });
}));

// ---------- Proof of payment ----------
// A payment-only document (card slip) backs an itemized receipt instead of
// creating an expense. Auto-linked at ingest; these let the user fix or override.
function paymentProofs(receiptId) {
  return db.prepare('SELECT id, original_name, filename, mime, payment_ref, amount_paid FROM receipts WHERE payment_for = ?').all(receiptId)
    .map(p => ({ id: p.id, name: p.original_name || p.filename, filename: p.filename, mime: p.mime, payment_ref: p.payment_ref, amount_paid: p.amount_paid }));
}
const paymentDoc = id => db.prepare("SELECT * FROM receipts WHERE id = ? AND doc_kind = 'payment'").get(id);

api.post('/receipts/:id/link', wrap((req, res) => {
  const p = paymentDoc(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not a proof-of-payment document' });
  const target = db.prepare("SELECT id FROM receipts WHERE id = ? AND COALESCE(doc_kind, 'itemized') = 'itemized'").get(req.body?.receipt_id);
  if (!target) return res.status(400).json({ error: 'Choose an itemized receipt to link it to' });
  if (db.prepare("SELECT 1 FROM expenses WHERE receipt_id = ? AND status != 'rejected'").get(p.id)) {
    return res.status(400).json({ error: 'This payment has its own expense. Reject that expense first, so the payment isn\'t counted twice.' });
  }
  db.prepare('UPDATE receipts SET payment_for = ?, payment_unlinked = 0 WHERE id = ?').run(target.id, p.id);
  audit('payment_link', { payment: p.id, receipt: target.id });
  res.json({ ok: true });
}));

api.post('/receipts/:id/unlink', wrap((req, res) => {
  const p = paymentDoc(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not a proof-of-payment document' });
  db.prepare('UPDATE receipts SET payment_for = NULL, payment_unlinked = 1 WHERE id = ?').run(p.id);
  audit('payment_unlink', { payment: p.id, receipt: p.payment_for });
  res.json({ ok: true });
}));

// No itemized receipt will ever come: record the payment itself as one expense.
api.post('/receipts/:id/dismiss', wrap((req, res) => {
  const r = db.prepare('UPDATE receipts SET attention_dismissed = 1 WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Receipt not found' });
  audit('receipt_dismissed', { receiptId: Number(req.params.id) });
  res.json({ ok: true });
}));

api.post('/receipts/:id/record-payment', wrap((req, res) => {
  const p = paymentDoc(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not a proof-of-payment document' });
  if (p.payment_for) return res.status(400).json({ error: 'This payment is linked to a receipt — unlink it first.' });
  if (!(p.amount_paid > 0)) return res.status(400).json({ error: 'No amount was read from this payment — add the expense by hand instead.' });
  const r = db.prepare(`
    INSERT INTO expenses (date, provider, category, description, amount, payment_method, status, confidence, rationale, source_type, receipt_id)
    VALUES (?, ?, 'Other', 'Payment (no itemized receipt)', ?, ?, 'pending_review', 'Low', ?, 'manual', ?)
  `).run(p.doc_date || localToday(), p.provider || '', cents(p.amount_paid), p.payment_ref || null,
    'Recorded from a proof of payment with no itemized receipt. An itemized receipt is stronger evidence — add one if you can.', p.id);
  db.prepare('UPDATE receipts SET payment_unlinked = 1 WHERE id = ?').run(p.id);
  audit('payment_recorded_as_expense', { payment: p.id, expense: Number(r.lastInsertRowid) });
  res.json({ id: Number(r.lastInsertRowid) });
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
  if (!Number.isFinite(d.amount) || d.amount <= 0) return res.status(400).json({ error: 'This entry has no amount — add it by hand from Expenses instead.' });
  // Date and provider come from the receipt's other line items, else from the
  // receipt itself — not today and blank, which the user would have to fix by hand.
  const sibling = d.receipt_id
    ? db.prepare('SELECT date, provider FROM expenses WHERE receipt_id = ? ORDER BY id LIMIT 1').get(d.receipt_id)
    : null;
  const doc = d.receipt_id ? db.prepare('SELECT doc_date, provider FROM receipts WHERE id = ?').get(d.receipt_id) : null;
  // A move, not a copy: the reason travels into the new row's rationale and the
  // audit log, and the discarded entry can't be re-queued a second time.
  db.exec('BEGIN');
  try {
    const r = db.prepare(`
      INSERT INTO expenses (date, provider, category, description, amount, status, confidence, rationale, source_type, receipt_id)
      VALUES (?, ?, 'Other', ?, ?, 'pending_review', 'Low', ?, 'manual', ?)
    `).run(sibling?.date || doc?.doc_date || localToday(), sibling?.provider || doc?.provider || '', d.description, cents(d.amount),
      `Originally set aside as not eligible ("${d.reason}") — sent back to Review by the user.`, d.receipt_id);
    db.prepare('DELETE FROM discarded WHERE id = ?').run(d.id);
    audit('requeue_discarded', { discardedId: d.id, reason: d.reason, newExpenseId: Number(r.lastInsertRowid) });
    db.exec('COMMIT');
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}));

api.get('/audit', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
}));

// ---------- Settings ----------
const SETTING_KEYS = ['ai_provider', 'anthropic_api_key', 'openai_api_key', 'email_enabled', 'email_host', 'email_port', 'email_user', 'email_password', 'email_poll_minutes', 'categories', 'hsa_established'];
const SECRET_KEYS = ['anthropic_api_key', 'openai_api_key', 'email_password'];

api.get('/settings', wrap((req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  // Don't ship secrets to the UI — just whether they're set
  for (const k of SECRET_KEYS) out[k] = out[k] ? '••••set••••' : '';
  res.json(out);
}));

const AI_PROVIDERS = ['anthropic-api', 'openai-api', 'keywords'];
api.put('/settings', wrap((req, res) => {
  if ('ai_provider' in req.body && !AI_PROVIDERS.includes(req.body.ai_provider)) {
    return res.status(400).json({ error: `ai_provider must be one of: ${AI_PROVIDERS.join(', ')}` });
  }
  if (req.body.hsa_established && !isValidDate(req.body.hsa_established)) {
    return res.status(400).json({ error: 'hsa_established must be YYYY-MM-DD' });
  }
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
  let ids = null;
  if (req.query.ids != null && req.query.ids !== '') {
    ids = String(req.query.ids).split(',').map(Number).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: 'ids must be a comma-separated list of numbers' });
  } else if (req.query.ids === '') {
    return res.status(400).json({ error: 'ids must be a comma-separated list of numbers' });
  }
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="HSA-expenses.csv"');
  res.send(ledgerCsv({ approvedOnly: !ids && req.query.all !== '1', ids }));
}));

api.get('/export/receipts', wrap(async (req, res) => {
  if (req.query.all === '1') {
    res.type('application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="HSA-all-receipts.zip"');
    return allReceiptsZip(res);
  }
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
  res.setHeader('Content-Disposition', `attachment; filename="HSA-full-backup-${localToday()}.zip"`);
  await fullZip(res);
}));
