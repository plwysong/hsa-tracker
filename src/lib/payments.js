// What was actually paid, and which documents belong together.
//
// HSA reimbursement is limited to what was actually paid, so a document-level
// discount (a prepay credit, a coupon, an insurance payment) is spread across the
// lines it reduced. And a payment-only document — a card slip — is proof that an
// itemized receipt was paid, not a purchase of its own: it creates no expenses and
// is linked to the receipt it pays for, so the pair is kept and counted together.
import { db, cents } from '../db.js';

/**
 * Spreads a document-level discount across the lines in proportion to their
 * listed price, so each line holds what was actually paid for it. Only applies
 * when the numbers explain each other (lines − discounts = paid); otherwise the
 * lines are returned unchanged and the review "adds up" check flags the gap.
 * Returned lines keep their original price in list_amount.
 */
export function allocateDiscount(items, totalPaid, discounts) {
  const listSum = cents(items.reduce((s, i) => s + i.amount, 0));
  if (!(totalPaid > 0) || !(discounts > 0) || !items.length) return items;
  if (Math.abs(listSum - discounts - totalPaid) > 0.011 || totalPaid >= listSum) return items;
  const factor = totalPaid / listSum;
  const out = items.map(i => ({ ...i, list_amount: i.amount, amount: cents(i.amount * factor) }));
  // Rounding remainder goes to the largest line, so the lines sum to exactly what was paid.
  const remainder = cents(totalPaid - out.reduce((s, i) => s + i.amount, 0));
  if (remainder) {
    const big = out.reduce((a, b) => (b.amount > a.amount ? b : a));
    big.amount = cents(big.amount + remainder);
  }
  return out;
}

/** Saves the document-level facts triage read from a receipt. */
export function recordDocument(receiptId, triage) {
  // Re-triage may change a document's kind; an itemized receipt can't be a payment for another.
  db.prepare(`UPDATE receipts SET doc_kind = ?, doc_date = ?, provider = ?, amount_paid = ?, discounts = ?, payment_ref = ?,
    payment_for = CASE WHEN ? = 'payment' THEN payment_for END
    WHERE id = ?`).run(
    triage.document_type === 'payment_only' ? 'payment' : 'itemized',
    triage.purchase_date || null, triage.provider || null,
    triage.total_paid ? cents(triage.total_paid) : null, triage.discounts ? cents(triage.discounts) : 0,
    triage.payment_ref || triage.payment_method || null,
    triage.document_type === 'payment_only' ? 'payment' : 'itemized', receiptId);
}

// Provider names vary between an invoice and its card slip ("Harbor View Dentistry"
// vs "Smith/Jones/Lee, Harbor View Dentistry"), so compare distinctive words.
const GENERIC = new Set(['dental', 'dentistry', 'dentist', 'medical', 'clinic', 'center', 'centre', 'group',
  'pharmacy', 'health', 'healthcare', 'care', 'family', 'office', 'associates', 'practice', 'services',
  'store', 'wholesale', 'corp', 'company', 'with', 'from', 'road', 'street', 'suite']);
const words = p => new Set(String(p || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter(w => w.length >= 4 && !GENERIC.has(w)));
export function sameProvider(p, q) {
  const a = words(p), b = words(q);
  if (!a.size || !b.size) return true; // unknown provider: let amount and date decide
  for (const w of a) if (b.has(w)) return true;
  return false;
}

const MATCH_DAYS = 7;
// The paid total of an itemized receipt: what the document says was paid, else
// the sum of its live lines.
const PAID_SQL = `COALESCE(r.amount_paid,
  (SELECT ROUND(SUM(amount), 2) FROM expenses e WHERE e.receipt_id = r.id AND e.status != 'rejected'))`;
const DATE_SQL = `COALESCE(r.doc_date, (SELECT MIN(date) FROM expenses e WHERE e.receipt_id = r.id))`;

function bestMatch(candidates, date) {
  if (!candidates.length) return null;
  const dist = d => (date && d ? Math.abs(new Date(d) - new Date(date)) : 0);
  candidates.sort((a, b) => dist(a.date) - dist(b.date));
  // Two equally good candidates is ambiguous — leave it for the user to link.
  if (candidates.length > 1 && dist(candidates[0].date) === dist(candidates[1].date)) return null;
  return candidates[0];
}

/**
 * Links payment documents to the itemized receipts they pay for: same paid amount,
 * dates within a week, matching provider. Run after any document is recorded —
 * either side may arrive first. Returns the ids it linked.
 */
export function linkPayments(receiptId) {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  if (!r) return [];
  const linked = [];
  const near = `(? IS NULL OR ${DATE_SQL} IS NULL OR ABS(julianday(${DATE_SQL}) - julianday(?)) <= ${MATCH_DAYS})`;
  if (r.doc_kind === 'payment') {
    if (r.payment_for || r.payment_unlinked || !r.amount_paid) return [];
    // A slip that still carries its own expense would count the payment twice if linked.
    if (db.prepare("SELECT 1 FROM expenses WHERE receipt_id = ? AND status != 'rejected'").get(r.id)) return [];
    const cands = db.prepare(`
      SELECT r.id, r.provider, ${DATE_SQL} AS date,
        (SELECT provider FROM expenses e WHERE e.receipt_id = r.id LIMIT 1) AS line_provider
      FROM receipts r
      WHERE r.id != ? AND COALESCE(r.doc_kind, 'itemized') = 'itemized'
        AND ABS(${PAID_SQL} - ?) < 0.005 AND ${near}
        AND NOT EXISTS (SELECT 1 FROM receipts p WHERE p.payment_for = r.id)
    `).all(r.id, r.amount_paid, r.doc_date, r.doc_date)
      .filter(c => sameProvider(r.provider, c.provider || c.line_provider));
    const m = bestMatch(cands, r.doc_date);
    if (m) {
      db.prepare('UPDATE receipts SET payment_for = ? WHERE id = ?').run(m.id, r.id);
      linked.push(r.id);
    }
  } else {
    if (db.prepare('SELECT 1 FROM receipts WHERE payment_for = ?').get(r.id)) return [];
    const paid = db.prepare(`SELECT ${PAID_SQL} AS paid, ${DATE_SQL} AS date FROM receipts r WHERE r.id = ?`).get(r.id);
    if (!paid?.paid) return [];
    const provider = r.provider || db.prepare('SELECT provider FROM expenses WHERE receipt_id = ? LIMIT 1').get(r.id)?.provider;
    const cands = db.prepare(`
      SELECT r.id, r.provider, ${DATE_SQL} AS date FROM receipts r
      WHERE r.doc_kind = 'payment' AND r.payment_for IS NULL AND COALESCE(r.payment_unlinked, 0) = 0
        AND ABS(r.amount_paid - ?) < 0.005 AND ${near}
        AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.receipt_id = r.id AND e.status != 'rejected')
    `).all(paid.paid, paid.date, paid.date)
      .filter(c => sameProvider(provider, c.provider));
    const m = bestMatch(cands, paid.date);
    if (m) {
      db.prepare('UPDATE receipts SET payment_for = ? WHERE id = ?').run(r.id, m.id);
      linked.push(m.id);
    }
  }
  return linked;
}
