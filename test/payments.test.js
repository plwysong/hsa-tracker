// Regression test from a real case: a dental invoice with a 5% prepay discount
// ($6,450.00 listed, $6,127.50 paid) uploaded together with its card slip. The
// app must record only what was paid, keep the two documents linked, and never
// count the payment twice — whichever document arrives first.
//
// Fixtures are anonymized copies of the real OCR text. The AI's answer for the
// invoice is stubbed (canned JSON), so the test is deterministic and needs no
// API key; everything after triage runs for real against a throwaway database.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INVOICE = readFileSync(path.join(here, 'fixtures/prepay-invoice.txt'), 'utf8');
const SLIP = readFileSync(path.join(here, 'fixtures/card-slip.txt'), 'utf8');

// What a correct AI reading of each document looks like.
const AI_INVOICE = {
  provider: 'Harbor View Dentistry', purchase_date: '2026-10-08', order_ref: 'ID: 10001', payment_method: 'MC/Visa',
  document_type: 'itemized', total_paid: 6127.50, discounts: 322.50, payment_ref: null,
  document_summary: 'Dental invoice, paid in full with a 5% prepay discount.',
  items: [
    { description: 'Ortho Retentive Appliance - VIVERA', amount: 275, date: '2026-10-08', category: 'Dental', verdict: 'eligible', confidence: 'High', rationale: 'Orthodontic retainer.' },
    { description: 'Ortho Retentive Appliance - VIVERA', amount: 275, date: '2026-10-08', category: 'Dental', verdict: 'eligible', confidence: 'High', rationale: 'Orthodontic retainer.' },
    { description: 'Invisalign', amount: 5900, date: '2026-10-08', category: 'Dental', verdict: 'eligible', confidence: 'High', rationale: 'Orthodontic treatment.' },
  ],
};
const AI_SLIP = {
  provider: 'Smith/Jones/Lee, Harbor View Dentistry', purchase_date: '2026-10-08', order_ref: 'Transaction 900001', payment_method: 'VISA',
  document_type: 'payment_only', total_paid: 6127.50, discounts: 0, payment_ref: 'VISA 1234 · Transaction 900001',
  document_summary: 'Card payment slip.', items: [],
};

let db, setSetting, retriageReceipt, listJobs, allocateDiscount, triageReceipt;

before(async () => {
  process.env.HSA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'hsa-test-'));
  ({ db, setSetting } = await import('../src/db.js'));
  ({ retriageReceipt, listJobs } = await import('../src/lib/ingest.js'));
  ({ allocateDiscount } = await import('../src/lib/payments.js'));
  ({ triageReceipt } = await import('../src/lib/triage.js'));
  setSetting('ai_provider', 'anthropic-api');
  setSetting('anthropic_api_key', 'test-key');
  globalThis.fetch = async (url, opts) => {
    const prompt = JSON.parse(opts.body).messages[0].content;
    const answer = prompt.includes('CREDIT CARD SALE') ? AI_SLIP : AI_INVOICE;
    return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(answer) }] }) };
  };
});

function addReceipt(name, text) {
  return Number(db.prepare("INSERT INTO receipts (filename, original_name, source, raw_text) VALUES (?, ?, 'upload', ?)")
    .run(name, name, text).lastInsertRowid);
}
async function triage(receiptId) {
  const job = retriageReceipt(receiptId);
  for (let i = 0; i < 200 && !['done', 'error'].includes(job.status); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(job.status, 'done', job.detail);
}
const liveTotal = () => db.prepare("SELECT ROUND(SUM(amount), 2) AS t FROM expenses WHERE status != 'rejected'").get().t;
const reset = () => db.exec('DELETE FROM expenses; DELETE FROM discarded; DELETE FROM receipts;');

test('a document-level discount is spread across the lines, summing to exactly what was paid', () => {
  const lines = allocateDiscount(AI_INVOICE.items, 6127.50, 322.50);
  assert.deepEqual(lines.map(l => l.amount), [261.25, 261.25, 5605]);
  assert.deepEqual(lines.map(l => l.list_amount), [275, 275, 5900]);
  assert.equal(Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100, 6127.50);
});

test("numbers that don't explain each other are left alone (the review check flags them instead)", () => {
  assert.deepEqual(allocateDiscount(AI_INVOICE.items, 6000, 322.50), AI_INVOICE.items);
  assert.deepEqual(allocateDiscount(AI_INVOICE.items, null, 0), AI_INVOICE.items);
});

test('offline keyword mode recognizes a card slip as proof of payment, not an expense', async () => {
  setSetting('ai_provider', 'keywords');
  try {
    const t = await triageReceipt(SLIP);
    assert.equal(t.document_type, 'payment_only');
    assert.equal(t.total_paid, 6127.50);
    assert.equal(t.items.length, 0);
  } finally {
    setSetting('ai_provider', 'anthropic-api');
  }
});

for (const order of ['invoice first', 'slip first']) {
  test(`invoice + card slip (${order}): linked, counted once, at the paid amount`, async () => {
    reset();
    const invoice = addReceipt('invoice.jpeg', INVOICE);
    const slip = addReceipt('slip.jpeg', SLIP);
    for (const id of order === 'invoice first' ? [invoice, slip] : [slip, invoice]) await triage(id);

    assert.equal(liveTotal(), 6127.50, 'only what was paid is counted');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE receipt_id = ?').get(slip).n, 0, 'the slip adds no expense');
    assert.equal(db.prepare('SELECT payment_for FROM receipts WHERE id = ?').get(slip).payment_for, invoice, 'the slip is linked to its invoice');
    const inv = { ...db.prepare('SELECT amount_paid, discounts FROM receipts WHERE id = ?').get(invoice) };
    assert.deepEqual(inv, { amount_paid: 6127.50, discounts: 322.50 });
  });
}

test('a slip with no matching receipt stays unlinked, waiting', async () => {
  reset();
  const slip = addReceipt('slip.jpeg', SLIP);
  await triage(slip);
  const r = { ...db.prepare('SELECT doc_kind, payment_for, amount_paid FROM receipts WHERE id = ?').get(slip) };
  assert.deepEqual(r, { doc_kind: 'payment', payment_for: null, amount_paid: 6127.50 });
  assert.equal(liveTotal(), null);
});
