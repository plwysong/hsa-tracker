// Backup & export: CSV/JSON ledger, full zip (ledger + every receipt file),
// and a clean PDF summary suitable for a tax preparer.
import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { db, RECEIPTS_DIR } from '../db.js';

function allExpenses(status = null, ids = null) {
  const clauses = [];
  if (status) clauses.push(`e.status = '${status}'`);
  if (ids && ids.length) clauses.push(`e.id IN (${ids.map(n => Number(n)).join(',')})`);
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return db.prepare(`
    SELECT e.*, r.filename AS receipt_filename, r.original_name AS receipt_original_name
    FROM expenses e LEFT JOIN receipts r ON r.id = e.receipt_id
    ${where}
    ORDER BY e.date, e.id
  `).all();
}

/** Streams a zip containing just the receipt files behind the given expense ids. */
export function receiptsZip(ids, res) {
  const rows = allExpenses(null, ids).filter(e => e.receipt_filename);
  const seen = new Set();
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  archive.append(ledgerCsv({ approvedOnly: false, ids }), { name: 'selected-expenses.csv' });
  for (const e of rows) {
    if (seen.has(e.receipt_filename)) continue;
    seen.add(e.receipt_filename);
    const p = path.join(RECEIPTS_DIR, e.receipt_filename);
    if (existsSync(p)) archive.file(p, { name: e.receipt_filename });
  }
  return archive.finalize();
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ledgerCsv({ approvedOnly = true, ids = null } = {}) {
  const rows = allExpenses(approvedOnly ? 'approved' : null, ids);
  const header = ['Date', 'Provider', 'Category', 'Description', 'Amount', 'Payment Method', 'Status',
    'Confidence', 'Eligibility Rationale', 'Reimbursed from HSA', 'Date Reimbursed', 'Source', 'Order/Receipt Ref', 'Receipt File', 'Notes'];
  const lines = [header.join(',')];
  for (const e of rows) {
    lines.push([e.date, e.provider, e.category, e.description, e.amount?.toFixed(2), e.payment_method,
      e.status, e.confidence, e.rationale, e.reimbursed ? 'Yes' : 'No', e.date_reimbursed,
      e.source_type, e.order_ref, e.receipt_filename, e.notes].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

export function fullJson() {
  return JSON.stringify({
    exported_at: new Date().toISOString(),
    expenses: allExpenses(),
    receipts: db.prepare('SELECT id, filename, original_name, mime, sha256, source, received_at, meta FROM receipts ORDER BY id').all(),
    discarded: db.prepare('SELECT * FROM discarded ORDER BY id').all(),
    audit_log: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
  }, null, 2);
}

/** Streams a zip of everything (ledger CSV + JSON + PDF summary + all receipt files) to `res`. */
export async function fullZip(res) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  archive.append(ledgerCsv({ approvedOnly: true }), { name: 'HSA-ledger-approved.csv' });
  archive.append(ledgerCsv({ approvedOnly: false }), { name: 'HSA-all-records.csv' });
  archive.append(fullJson(), { name: 'HSA-full-backup.json' });
  archive.append(await summaryPdfBuffer(), { name: 'HSA-summary.pdf' });
  const receipts = db.prepare('SELECT filename FROM receipts').all();
  for (const r of receipts) {
    const p = path.join(RECEIPTS_DIR, r.filename);
    if (r.filename && existsSync(p)) archive.file(p, { name: `receipts/${r.filename}` });
  }
  archive.finalize();
  return archive;
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

  const approved = allExpenses('approved');
  const total = approved.reduce((s, e) => s + e.amount, 0);
  const reimbursed = approved.filter(e => e.reimbursed).reduce((s, e) => s + e.amount, 0);

  doc.fontSize(18).font('Helvetica-Bold').text('HSA Eligible Expense Summary');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#555')
    .text(`Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} — approved, documented HSA-eligible expenses. Each entry is backed by a stored receipt or statement.`);
  doc.moveDown(1);

  doc.fillColor('#000').fontSize(12).font('Helvetica-Bold');
  doc.text(`Total eligible expenses logged: ${money(total)}`);
  doc.text(`Reimbursed from HSA to date: ${money(reimbursed)}`);
  doc.text(`Available for future tax-free withdrawal: ${money(total - reimbursed)}`);
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
  for (const [c, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) doc.text(`   ${c}: ${money(v)}`);
  doc.moveDown(0.5);
  doc.fontSize(11).font('Helvetica-Bold').text('By year:');
  doc.font('Helvetica').fontSize(10);
  for (const [y, v] of Object.entries(byYear).sort()) doc.text(`   ${y}: ${money(v)}`);
  doc.moveDown(1);

  // Ledger table
  doc.fontSize(11).font('Helvetica-Bold').text('Itemized ledger');
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

  doc.font('Helvetica').fontSize(8);
  for (const e of approved) {
    const rowData = {
      date: e.date, provider: e.provider || '', category: e.category || '',
      description: e.description || '', amount: money(e.amount), reimbursed: e.reimbursed ? 'Yes' : 'No',
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

  doc.end();
  return finished;
}
