// Shared ingestion pipeline: file buffer → dedup → store → extract text → AI triage
// → pending review queue (eligible / needs_judgment) + discarded log (not_eligible).
// Runs async with an in-memory job tracker so the UI can show live progress.
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { db, RECEIPTS_DIR, sha256File, audit } from '../db.js';
import { extractText } from './extract.js';
import { triageReceipt } from './triage.js';

const jobs = new Map();
let jobCounter = 0;

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.id - a.id).slice(0, 30);
}

// Auto-dismissal never clears errors — a failed file must stay on screen until the
// user dismisses it (by id) or explicitly clears everything.
export function clearFinishedJobs({ id = null, includeErrors = false } = {}) {
  for (const [jid, j] of jobs) {
    if (id != null) { if (jid === Number(id)) jobs.delete(jid); continue; }
    if (j.status === 'done' || j.status === 'duplicate' || (includeErrors && j.status === 'error')) jobs.delete(jid);
  }
}

function safeName(name) {
  return name.replace(/[^\w.\- ']/g, '_').slice(0, 180);
}

/**
 * Ingest one document. Returns the job object immediately; processing continues async.
 * meta: { originalName, mime, source: 'upload'|'email', sourceDetail }
 */
export function ingestDocument(buffer, meta) {
  const job = {
    id: ++jobCounter,
    name: meta.originalName,
    source: meta.source,
    status: 'queued',        // queued | extracting | triaging | done | duplicate | error
    detail: '',
    receiptId: null,
    queued: 0,
    discarded: 0,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  processJob(job, buffer, meta).catch(err => {
    job.status = 'error';
    job.detail = err.message;
    audit('ingest_error', { file: meta.originalName, error: err.message });
  });
  return job;
}

/**
 * Re-run triage on an already-stored receipt (e.g. after an AI failure or a
 * provider change). Existing pending items from this receipt are replaced;
 * approved/rejected items are left untouched.
 */
export function retriageReceipt(receiptId) {
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  if (!receipt) throw new Error('Receipt not found');

  const job = {
    id: ++jobCounter,
    name: `Re-triage: ${receipt.original_name || receipt.filename}`,
    source: 'retriage',
    status: 'triaging',
    detail: '',
    receiptId,
    queued: 0,
    discarded: 0,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  (async () => {
    // A receipt whose extraction failed (or was cut short by a crash) has no text
    // yet — re-read the stored file first, so Re-triage is the recovery path.
    if (!hasText(receipt.raw_text)) {
      job.status = 'extracting';
      const buffer = readFileSync(path.join(RECEIPTS_DIR, receipt.filename));
      receipt.raw_text = await extractInto(receiptId, buffer, receipt.mime, receipt.original_name, sourceDetailOf(receipt));
      if (!hasText(receipt.raw_text)) throw new Error('Stored, but no readable text could be extracted — add line items manually with "Add expense".');
      job.status = 'triaging';
    }
    const triage = await triageReceipt(receipt.raw_text);
    // Replace this receipt's previous *pending* candidates and discards so re-runs don't stack
    // duplicates. Rows the user created themselves (manual adds, re-queued discards) are kept —
    // a re-triage must never wipe an explicit user decision.
    db.prepare("DELETE FROM expenses WHERE receipt_id = ? AND status = 'pending_review' AND source_type != 'manual'").run(receiptId);
    db.prepare('DELETE FROM discarded WHERE receipt_id = ?').run(receiptId);
    // Any expense the user already touched — approved, rejected, or a manual row
    // they created/re-queued — is left as-is and must not be re-added. Matched by
    // amount, consumed one-for-one so two legitimately same-priced lines both count.
    const kept = db.prepare("SELECT amount FROM expenses WHERE receipt_id = ?").all(receiptId)
      .map(r => r.amount);
    let skipped = 0;
    triage.items = triage.items.filter(item => {
      // Only items that would become expenses can match an already-decided expense
      // amount. not_eligible items always pass through to the discarded log.
      if (item.verdict === 'not_eligible') return true;
      const i = kept.findIndex(a => Math.abs(a - item.amount) < 0.005);
      if (i === -1) return true;
      kept.splice(i, 1);
      skipped++;
      return false;
    });
    insertTriageResults(job, receiptId, triage, receipt.source);
    job.status = 'done';
    const keptNote = skipped ? `${skipped} item${skipped === 1 ? '' : 's'} you already decided left untouched. ` : '';
    job.detail = keptNote + (triage.ai_error
      ? `AI triage unavailable — used keyword fallback. (${triage.ai_error})`
      : (triage.document_summary || ''));
    audit('retriage', { receiptId, queued: job.queued, discarded: job.discarded, provider: triage.ai_provider });
  })().catch(err => {
    job.status = 'error';
    job.detail = err.message;
    audit('retriage_error', { receiptId, error: err.message });
  });
  return job;
}

const hasText = (t) => !!t && t.trim().length >= 10;

// The receipt's meta column holds source details (email headers etc.) plus the
// extraction outcome; strip the outcome so it is rewritten, not stacked.
function sourceDetailOf(receipt) {
  const { extractMethod, extractError, ...detail } = JSON.parse(receipt.meta || '{}');
  return detail;
}

// Extract text from a receipt's bytes and record the outcome on the row. Throws
// on failure (after recording it) so the caller can surface it.
async function extractInto(receiptId, buffer, mime, originalName, sourceDetail) {
  let text, method;
  try {
    ({ text, method } = await extractText(buffer, mime, originalName));
  } catch (err) {
    db.prepare('UPDATE receipts SET meta = ? WHERE id = ?')
      .run(JSON.stringify({ extractMethod: 'failed', extractError: err.message, ...sourceDetail }), receiptId);
    throw err;
  }
  db.prepare('UPDATE receipts SET raw_text = ?, meta = ? WHERE id = ?')
    .run(text, JSON.stringify({ extractMethod: method, ...sourceDetail }), receiptId);
  return text;
}

function insertTriageResults(job, receiptId, triage, sourceType) {
  const insExpense = db.prepare(`
    INSERT INTO expenses (date, provider, category, description, amount, payment_method, status,
      confidence, rationale, source_type, receipt_id, order_ref)
    VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?)
  `);
  const insDiscarded = db.prepare('INSERT INTO discarded (receipt_id, description, amount, reason) VALUES (?, ?, ?, ?)');
  const docDate = triage.purchase_date || new Date().toISOString().slice(0, 10);
  for (const item of triage.items) {
    if (item.verdict === 'not_eligible') {
      insDiscarded.run(receiptId, item.description, item.amount, item.rationale || 'Not HSA-eligible.');
      job.discarded++;
    } else {
      insExpense.run(item.date || docDate, triage.provider || 'Unknown', item.category || 'Other',
        item.description, item.amount, triage.payment_method || null,
        item.confidence || 'Low', item.rationale || '', sourceType, receiptId,
        triage.order_ref ? String(triage.order_ref) : null);
      job.queued++;
    }
  }
}

async function processJob(job, buffer, meta) {
  // Idempotency: same file content is never processed twice
  const hash = sha256File(buffer);
  const existing = db.prepare(`
    SELECT id, filename, mime, original_name, source, meta, raw_text,
      (SELECT COUNT(*) FROM expenses e WHERE e.receipt_id = receipts.id) AS expense_count
    FROM receipts WHERE sha256 = ?`).get(hash);
  if (existing) {
    job.receiptId = existing.id;
    if (!hasText(existing.raw_text) && !existing.expense_count) {
      // Stored earlier but never read (extraction failed or the app crashed mid-way).
      // Dropping the same file again is the natural "try again" — resume from the
      // stored copy rather than turning the user away.
      job.name = existing.original_name || existing.filename;
      await extractAndTriage(job, existing.id, buffer, existing.mime, existing.original_name, existing.source, sourceDetailOf(existing));
      return;
    }
    job.status = 'duplicate';
    job.detail = `Identical file already processed (receipt #${existing.id}) — skipped to avoid duplicate entries. Find it under Ledger → Receipts.`;
    return;
  }

  // Store the original file durably
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${stamp} ${safeName(meta.originalName)}`.replace(/(\.[a-z0-9]+)?$/i, m => m || '');
  let finalName = filename;
  let n = 1;
  while (db.prepare('SELECT 1 FROM receipts WHERE filename = ?').get(finalName)) {
    const ext = path.extname(filename);
    finalName = filename.slice(0, filename.length - ext.length) + ` (${++n})` + ext;
  }
  writeFileSync(path.join(RECEIPTS_DIR, finalName), buffer);

  // Record the receipt BEFORE extraction, so even an unreadable file shows up in
  // the Receipts tab and rides along in backups — never silently dropped.
  const res = db.prepare('INSERT INTO receipts (filename, original_name, mime, sha256, source, raw_text, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(finalName, meta.originalName, meta.mime, hash, meta.source, '',
      JSON.stringify({ ...meta.sourceDetail }));
  const receiptId = Number(res.lastInsertRowid);
  job.receiptId = receiptId;
  db.prepare('INSERT OR IGNORE INTO processed_sources (kind, ref) VALUES (?, ?)').run('file_sha256', hash);

  await extractAndTriage(job, receiptId, buffer, meta.mime, meta.originalName, meta.source, meta.sourceDetail);
}

async function extractAndTriage(job, receiptId, buffer, mime, originalName, source, sourceDetail = {}) {
  job.status = 'extracting';
  let text;
  try {
    text = await extractInto(receiptId, buffer, mime, originalName, sourceDetail);
  } catch (err) {
    job.status = 'error';
    job.detail = `The file was stored but could not be read (${err.message}) — drop it again to retry, or add its line items manually from Ledger → Receipts.`;
    audit('ingest_extract_error', { file: originalName, receiptId, error: err.message });
    return;
  }

  if (!hasText(text)) {
    job.status = 'done';
    job.detail = 'Stored, but no readable text could be extracted — add line items manually from Ledger → Receipts.';
    audit('ingest_no_text', { file: originalName, receiptId });
    return;
  }

  job.status = 'triaging';
  const triage = await triageReceipt(text);

  // Order-level dedup, per line item: an amount already tracked under this order id
  // is skipped (consumed one-for-one), but genuinely new items — e.g. the rest of a
  // partially-shipped order — still get queued.
  let dupNote = '';
  if (triage.order_ref) {
    const existing = db.prepare("SELECT amount FROM expenses WHERE order_ref = ? AND order_ref != ''")
      .all(String(triage.order_ref)).map(r => r.amount);
    if (existing.length) {
      let dupes = 0;
      triage.items = triage.items.filter(item => {
        // Only eligible/needs_judgment items become expenses and can collide with
        // an already-tracked amount. not_eligible items always pass through to the
        // discarded log — never silently dropped by dedup.
        if (item.verdict === 'not_eligible') return true;
        const i = existing.findIndex(a => Math.abs(a - item.amount) < 0.005);
        if (i === -1) return true;
        existing.splice(i, 1);
        dupes++;
        return false;
      });
      // Only short-circuit as a pure duplicate when there is genuinely nothing left
      // to record — neither a new expense nor a not_eligible item to log as discarded.
      if (!triage.items.length) {
        job.status = 'duplicate';
        job.detail = `All items from order ${triage.order_ref} are already in the tracker — skipped to avoid duplicates. Receipt file was kept.`;
        audit('ingest_order_dup', { file: originalName, orderRef: triage.order_ref });
        return;
      }
      if (dupes) dupNote = `${dupes} item${dupes === 1 ? '' : 's'} already tracked under order ${triage.order_ref} skipped. `;
    }
  }

  insertTriageResults(job, receiptId, triage, source);

  job.status = 'done';
  job.detail = dupNote + (triage.ai_error
    ? `AI triage unavailable — used keyword fallback. Re-check results. (${triage.ai_error})`
    : (triage.document_summary || ''));
  audit('ingest_done', { file: originalName, receiptId, queued: job.queued, discarded: job.discarded, provider: triage.ai_provider });
}
