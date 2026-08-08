// Shared ingestion pipeline: file buffer → dedup → store → extract text → AI triage
// → pending review queue (eligible / needs_judgment) + discarded log (not_eligible).
// Runs async with an in-memory job tracker so the UI can show live progress.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { db, RECEIPTS_DIR, sha256File, audit } from '../db.js';
import { extractText } from './extract.js';
import { triageReceipt } from './triage.js';

const jobs = new Map();
let jobCounter = 0;

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.id - a.id).slice(0, 30);
}

export function clearFinishedJobs() {
  for (const [id, j] of jobs) {
    if (j.status === 'done' || j.status === 'error' || j.status === 'duplicate') jobs.delete(id);
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
  if (!receipt.raw_text || receipt.raw_text.trim().length < 10) throw new Error('This receipt has no extracted text to triage — add entries manually instead.');

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
    const triage = await triageReceipt(receipt.raw_text);
    // Replace this receipt's previous *pending* candidates and discards so re-runs don't stack duplicates
    db.prepare("DELETE FROM expenses WHERE receipt_id = ? AND status = 'pending_review'").run(receiptId);
    db.prepare('DELETE FROM discarded WHERE receipt_id = ?').run(receiptId);
    // Items the user already approved/rejected from this receipt stay decided —
    // don't re-queue them. Matched by amount (consumed one-for-one, so two
    // legitimate same-priced line items still both count).
    const decided = db.prepare("SELECT amount FROM expenses WHERE receipt_id = ? AND status != 'pending_review'").all(receiptId)
      .map(r => r.amount);
    let skipped = 0;
    triage.items = triage.items.filter(item => {
      const i = decided.findIndex(a => Math.abs(a - item.amount) < 0.005);
      if (i === -1) return true;
      decided.splice(i, 1);
      skipped++;
      return false;
    });
    insertTriageResults(job, receiptId, triage, receipt.source);
    if (skipped) job.detail = `${skipped} already-decided item${skipped === 1 ? '' : 's'} left untouched. `;
    job.status = 'done';
    job.detail = triage.ai_error
      ? `AI triage unavailable — used keyword fallback. (${triage.ai_error})`
      : (triage.document_summary || '');
    audit('retriage', { receiptId, queued: job.queued, discarded: job.discarded, provider: triage.ai_provider });
  })().catch(err => {
    job.status = 'error';
    job.detail = err.message;
    audit('retriage_error', { receiptId, error: err.message });
  });
  return job;
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
  const existing = db.prepare('SELECT id, filename FROM receipts WHERE sha256 = ?').get(hash);
  if (existing) {
    job.status = 'duplicate';
    job.receiptId = existing.id;
    job.detail = `Identical file already processed (receipt #${existing.id}) — skipped to avoid duplicate entries.`;
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

  job.status = 'extracting';
  const { text, method } = await extractText(buffer, meta.mime, meta.originalName);

  const res = db.prepare('INSERT INTO receipts (filename, original_name, mime, sha256, source, raw_text, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(finalName, meta.originalName, meta.mime, hash, meta.source, text,
      JSON.stringify({ extractMethod: method, ...meta.sourceDetail }));
  const receiptId = Number(res.lastInsertRowid);
  job.receiptId = receiptId;
  db.prepare('INSERT OR IGNORE INTO processed_sources (kind, ref) VALUES (?, ?)').run('file_sha256', hash);

  if (!text || text.trim().length < 10) {
    job.status = 'done';
    job.detail = 'Stored, but no readable text could be extracted — add line items manually from the Receipts tab.';
    audit('ingest_no_text', { file: meta.originalName, receiptId });
    return;
  }

  job.status = 'triaging';
  const triage = await triageReceipt(text);

  // Order-level dedup: if we've already ingested this order id, skip re-queuing
  if (triage.order_ref) {
    const dup = db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE order_ref = ? AND order_ref != ''").get(String(triage.order_ref)).n;
    if (dup > 0) {
      job.status = 'duplicate';
      job.detail = `Order ${triage.order_ref} already has ${dup} entr${dup === 1 ? 'y' : 'ies'} in the tracker — skipped to avoid duplicates. Receipt file was kept.`;
      audit('ingest_order_dup', { file: meta.originalName, orderRef: triage.order_ref });
      return;
    }
  }

  insertTriageResults(job, receiptId, triage, meta.source);

  job.status = 'done';
  job.detail = triage.ai_error
    ? `AI triage unavailable — used keyword fallback. Re-check results. (${triage.ai_error})`
    : (triage.document_summary || '');
  audit('ingest_done', { file: meta.originalName, receiptId, queued: job.queued, discarded: job.discarded, provider: triage.ai_provider });
}
