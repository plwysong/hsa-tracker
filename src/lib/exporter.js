// Backup & export: CSV/JSON ledger, full zip (ledger + every receipt file),
// and a clean PDF summary suitable for a tax preparer.
import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { db, RECEIPTS_DIR, establishedDate, isRecordOnly, cents } from '../db.js';

function allExpenses(status = null, ids = null) {
  const clauses = [];
  if (status) clauses.push(`e.status = '${status}'`);
  if (ids && ids.length) clauses.push(`e.id IN (${ids.map(n => Number(n)).join(',')})`);
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return db.prepare(`
    SELECT e.*, r.filename AS receipt_filename, r.original_name AS receipt_original_name,
      (SELECT group_concat(p.filename, '; ') FROM receipts p WHERE p.payment_for = e.receipt_id) AS payment_proof
    FROM expenses e LEFT JOIN receipts r ON r.id = e.receipt_id
    ${where}
    ORDER BY e.date, e.id
  `).all();
}

// A receipt and its linked proof of payment travel together: in every zip they
// share one folder named for the purchase, e.g. "2026-10-08 Harbor View Dentistry (#12)".
// Receipts without a linked payment stay loose, as before.
function receiptZipPaths(receiptIds = null) {
  const all = db.prepare(`SELECT r.id, r.filename, r.payment_for, r.doc_date, r.provider, r.received_at,
    (SELECT MIN(date) FROM expenses e WHERE e.receipt_id = r.id) AS line_date,
    (SELECT provider FROM expenses e WHERE e.receipt_id = r.id LIMIT 1) AS line_provider FROM receipts r`).all();
  const byId = new Map(all.map(r => [r.id, r]));
  const folderOf = new Map();
  for (const p of all) {
    const r = p.payment_for && byId.get(p.payment_for);
    if (!r) continue;
    const name = `${r.doc_date || r.line_date || String(r.received_at).slice(0, 10)} ${r.provider || r.line_provider || 'Receipt'}`
      .replace(/[\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) + ` (#${r.id})`;
    folderOf.set(r.id, name);
    folderOf.set(p.id, name);
  }
  // A requested receipt brings its linked payment (or the receipt it pays for) along.
  let wanted = all;
  if (receiptIds) {
    const ids = new Set(receiptIds);
    for (const r of all) if (ids.has(r.payment_for)) ids.add(r.id);
    for (const id of [...ids]) { const pf = byId.get(id)?.payment_for; if (pf) ids.add(pf); }
    wanted = all.filter(r => ids.has(r.id));
  }
  return wanted.filter(r => r.filename)
    .map(r => ({ file: r.filename, zipPath: folderOf.has(r.id) ? `${folderOf.get(r.id)}/${r.filename}` : r.filename }));
}

/** Streams a zip of every receipt file (including any that produced no expense), with the full records CSV. */
export function allReceiptsZip(res) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  archive.append(ledgerCsv({ approvedOnly: false }), { name: 'HSA-all-records.csv' });
  for (const { file, zipPath } of receiptZipPaths()) {
    const p = path.join(RECEIPTS_DIR, file);
    if (existsSync(p)) archive.file(p, { name: zipPath });
  }
  return archive.finalize();
}

/** Streams a zip containing just the receipt files behind the given expense ids. */
export function receiptsZip(ids, res) {
  const receiptIds = [...new Set(allExpenses(null, ids).map(e => e.receipt_id).filter(Boolean))];
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  archive.append(ledgerCsv({ approvedOnly: false, ids }), { name: 'selected-expenses.csv' });
  for (const { file, zipPath } of receiptZipPaths(receiptIds)) {
    const p = path.join(RECEIPTS_DIR, file);
    if (existsSync(p)) archive.file(p, { name: zipPath });
  }
  return archive.finalize();
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Receipt/email text can start with =, +, -, or @, which spreadsheets execute
  // as formulas. Neutralize with a leading apostrophe (plain numbers excepted).
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ledgerCsv({ approvedOnly = true, ids = null } = {}) {
  const rows = allExpenses(approvedOnly ? 'approved' : null, ids);
  const header = ['Date', 'Provider', 'Category', 'Description', 'Amount', 'Payment Method', 'Status',
    'Confidence', 'Eligibility Rationale', 'Counts Toward Withdrawals', 'Reimbursed from HSA', 'Date Reimbursed', 'Source', 'Order/Receipt Ref', 'Receipt File', 'Proof of Payment', 'List Price', 'Notes'];
  const lines = [header.join(',')];
  const est = establishedDate();
  for (const e of rows) {
    const counts = e.status !== 'approved' ? '' : isRecordOnly(e, est) ? 'No - dated before HSA established (record only)' : 'Yes';
    lines.push([e.date, e.provider, e.category, e.description, e.amount?.toFixed(2), e.payment_method,
      e.status, e.confidence, e.rationale, counts, e.reimbursed ? 'Yes' : 'No', e.date_reimbursed,
      e.source_type, e.order_ref, e.receipt_filename, e.payment_proof, e.list_amount != null ? e.list_amount.toFixed(2) : '', e.notes].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

export function fullJson() {
  return JSON.stringify({
    exported_at: new Date().toISOString(),
    expenses: allExpenses(),
    receipts: db.prepare(`SELECT id, filename, original_name, mime, sha256, source, received_at, meta,
      doc_kind, doc_date, provider, amount_paid, discounts, payment_ref, payment_for FROM receipts ORDER BY id`).all(),
    discarded: db.prepare('SELECT * FROM discarded ORDER BY id').all(),
    audit_log: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
  }, null, 2);
}

/** Streams a zip of everything (ledger CSV + JSON + PDF summary + all receipt files) to `res`. */
export async function fullZip(res) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  archive.append(ledgerCsv({ approvedOnly: true }), { name: 'HSA-expenses-approved.csv' });
  archive.append(ledgerCsv({ approvedOnly: false }), { name: 'HSA-all-records.csv' });
  archive.append(fullJson(), { name: 'HSA-full-backup.json' });
  archive.append(await summaryPdfBuffer(), { name: 'HSA-summary.pdf' });
  for (const { file, zipPath } of receiptZipPaths()) {
    const p = path.join(RECEIPTS_DIR, file);
    if (existsSync(p)) archive.file(p, { name: `receipts/${zipPath}` });
  }
  archive.finalize();
  return archive;
}

// The PDF is read by people, so it uses the app's M/D/YYYY; CSV/JSON keep ISO for software.
function usDate(d) {
  const [y, m, day] = String(d || '').slice(0, 10).split('-');
  return y && m && day ? `${Number(m)}/${Number(day)}/${y}` : String(d || '');
}

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Renders the IRS-facing PDF summary; resolves with the finished Buffer. */
export function summaryPdfBuffer() {
  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const finished = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // Totals and the itemized ledger cover expenses that count toward withdrawals;
  // records-only (dated before the HSA was established) get their own section.
  const est = establishedDate();
  const all = allExpenses('approved');
  const approved = all.filter(e => !isRecordOnly(e, est));
  const records = all.filter(e => isRecordOnly(e, est));
  const sum = list => cents(list.reduce((s, e) => s + e.amount, 0));
  const total = sum(approved);
  const reimbursed = sum(approved.filter(e => e.reimbursed));

  doc.fontSize(18).font('Helvetica-Bold').text('HSA Eligible Expense Summary');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#555')
    .text(`Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} — approved, documented HSA-eligible expenses. Each entry is backed by a stored receipt or statement.`);
  doc.moveDown(1);

  doc.fillColor('#000').fontSize(12).font('Helvetica-Bold');
  doc.text(`Total eligible expenses logged: ${money(total)}`);
  doc.text(`Reimbursed from HSA to date: ${money(reimbursed)}`);
  doc.text(`Available for future tax-free withdrawal: ${money(cents(total - reimbursed))}`);
  if (est) {
    doc.fontSize(10).font('Helvetica').fillColor('#555').text(`HSA established ${usDate(est)}. Expenses dated earlier are not counted above${records.length ? ' — see "Kept as records" at the end' : ''}.`);
    doc.fillColor('#000');
  }
  doc.moveDown(1);

  // By category / by year
  const byCat = {}, byYear = {};
  for (const e of approved) {
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    const y = (e.date || '').slice(0, 4);
    byYear[y] = (byYear[y] || 0) + e.amount;
  }
  doc.fontSize(11).font('Helvetica-Bold').text('By category:', { continued: false });
  doc.font('Helvetica').fontSize(10);
  for (const [c, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) doc.text(`   ${c}: ${money(cents(v))}`);
  doc.moveDown(0.5);
  doc.fontSize(11).font('Helvetica-Bold').text('By year:');
  doc.font('Helvetica').fontSize(10);
  for (const [y, v] of Object.entries(byYear).sort()) doc.text(`   ${y}: ${money(cents(v))}`);
  doc.moveDown(1);

  // Ledger table
  doc.fontSize(11).font('Helvetica-Bold').text('Itemized expenses');
  doc.moveDown(0.3);
  const cols = [
    { key: 'date', label: 'Date', w: 62 },
    { key: 'provider', label: 'Provider', w: 110 },
    { key: 'category', label: 'Category', w: 55 },
    { key: 'description', label: 'Description', w: 195 },
    { key: 'amount', label: 'Amount', w: 55, align: 'right' },
    { key: 'reimbursed', label: 'Reimb.', w: 35 },
  ];
  const startX = doc.page.margins.left;

  const drawHeader = () => {
    const y = doc.y;
    let x = startX;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#000');
    for (const c of cols) { doc.text(c.label, x, y, { width: c.w - 6, align: c.align || 'left' }); x += c.w; }
    doc.y = y + 12;
    doc.moveTo(startX, doc.y).lineTo(startX + cols.reduce((s, c) => s + c.w, 0), doc.y).strokeColor('#999').lineWidth(0.5).stroke();
    doc.y += 5;
  };
  drawHeader();

  const drawRows = list => {
    doc.font('Helvetica').fontSize(8);
    for (const e of list) {
      const rowData = {
        date: usDate(e.date), provider: e.provider || '', category: e.category || '',
        description: (e.description || '') + (e.list_amount != null ? ` (after discount; list ${money(e.list_amount)})` : '')
          + (e.payment_proof ? ' · proof of payment on file' : ''),
        amount: money(e.amount), reimbursed: e.reimbursed ? 'Yes' : 'No',
      };
      const heights = cols.map(c => doc.heightOfString(String(rowData[c.key]), { width: c.w - 6 }));
      const rowH = Math.max(...heights) + 4;
      if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        drawHeader();
        doc.font('Helvetica').fontSize(8);
      }
      const y = doc.y;
      let x = startX;
      for (const c of cols) {
        doc.fillColor('#000').text(String(rowData[c.key]), x, y, { width: c.w - 6, align: c.align || 'left' });
        x += c.w;
      }
      doc.y = y + rowH;
    }
  };
  drawRows(approved);

  if (records.length) {
    if (doc.y + 80 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.x = startX;
    doc.moveDown(1.5);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000').text(`Kept as records — dated before the HSA was established (${usDate(est)})`, startX);
    doc.fontSize(9).font('Helvetica').fillColor('#555').text(
      `Not counted in any total above: the IRS only allows tax-free reimbursement of expenses incurred after the HSA was established. ${money(sum(records))} across ${records.length} item${records.length === 1 ? '' : 's'}.` +
      (records.some(e => e.reimbursed) ? ' Items marked "Yes" under Reimb. were withdrawn from the HSA — review these with a tax preparer.' : ''), startX);
    doc.fillColor('#000');
    doc.moveDown(0.5);
    drawHeader();
    drawRows(records);
  }

  doc.end();
  return finished;
}
