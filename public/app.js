/* HSA Tracker frontend — no-build vanilla SPA */
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const main = $('#main');

const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${Number(m)}/${Number(day)}/${y}`;
};

// Inline stroke icons (Feather-style) so glyph rendering never depends on the OS font.
const ICON_PATHS = {
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  zip: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
};
// Column sorting for every data table. Click a heading to sort, again to flip.
// Works on the rendered DOM (cells may carry data-v with a raw sort value) so
// each view's delegated click handlers keep working, and the choice survives
// the re-render that follows every action.
const sortState = {};
function sortable(table, key) {
  if (!table) return;
  const ths = [...table.querySelectorAll('thead th[data-sort]')];
  const apply = () => {
    const st = sortState[key];
    ths.forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
    if (!st) return;
    const th = ths.find(t => t.dataset.sort === st.col);
    if (!th) return;
    const idx = [...th.parentNode.children].indexOf(th);
    const numeric = th.dataset.type === 'num';
    const tbody = table.tBodies[0];
    const rows = [...tbody.rows].filter(r => !r.querySelector('td.empty'));
    const val = r => {
      const td = r.cells[idx];
      const v = td?.dataset.v ?? td?.textContent.trim() ?? '';
      return numeric ? (parseFloat(v) || 0) : v.toLowerCase();
    };
    rows.map((r, i) => ({ r, i, v: val(r) }))
      .sort((a, b) => ((a.v < b.v ? -1 : a.v > b.v ? 1 : 0) * st.dir) || (a.i - b.i))
      .forEach(({ r }) => tbody.appendChild(r));
    th.classList.add(st.dir > 0 ? 'sort-asc' : 'sort-desc');
  };
  ths.forEach(th => {
    th.classList.add('sortable');
    th.title = 'Sort by ' + th.textContent.trim().toLowerCase();
    th.addEventListener('click', () => {
      const st = sortState[key];
      sortState[key] = st && st.col === th.dataset.sort ? { col: st.col, dir: -st.dir } : { col: th.dataset.sort, dir: 1 };
      apply();
    });
  });
  apply();
}

const icon = (name, size = 14) =>
  `<svg class="bicon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;

async function api(path, opts = {}) {
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'Content-Type': 'application/json', ...opts.headers };
  }
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------- Router ----------------
const views = {};
let currentView = 'dashboard';

function navigate(view, opts = {}) {
  currentView = view;
  closePane();
  closeModal();
  main.onclick = main.onchange = null; // drop the previous view's delegated handlers
  location.hash = '#/' + view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  views[view](opts);
  refreshBadge();
}

$$('.nav-item').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#/', '') || 'dashboard';
  if (v !== currentView && views[v]) navigate(v);
});

// The forwarding address for emailed receipts, shown in the sidebar on every
// page (only when email ingestion is set up). Click copies it.
async function refreshEmailHint() {
  const el = $('#side-email');
  if (!el) return;
  try {
    const s = await api('/settings');
    const addr = s.email_enabled && s.email_user ? String(s.email_user).trim() : '';
    el.hidden = !addr;
    el.dataset.addr = addr;
    el.innerHTML = addr ? `<div class="se-label">Forward receipts to</div><div class="se-addr">${esc(addr)}</div><div class="se-copy">${icon('copy', 12)} click to copy</div>` : '';
  } catch { /* server starting */ }
}
$('#side-email')?.addEventListener('click', async () => {
  const addr = $('#side-email').dataset.addr;
  if (!addr) return;
  try { await navigator.clipboard.writeText(addr); toast('Email address copied'); }
  catch { toast(addr); }
});

async function refreshBadge() {
  try {
    const stats = await api('/stats');
    const badge = $('#review-badge');
    badge.hidden = !stats.pending_count;
    badge.textContent = stats.pending_count;
  } catch { /* server starting */ }
}

// ---------------- Charts (hand-rolled SVG, dataviz-spec marks) ----------------
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function barChartH(data, { valueKey = 'total', labelKey = 'label', width = 520 } = {}) {
  // Horizontal bars: ≤24px thick, 4px rounded data-end, square baseline, value at tip.
  if (!data.length) return '<div class="empty">No data yet</div>';
  const max = Math.max(...data.map(d => d[valueKey]));
  const barH = 22, gap = 14, labelW = 90, valueW = 74;
  const chartW = width - labelW - valueW;
  const height = data.length * (barH + gap) - gap + 8;
  const ink2 = css('--ink-2'), muted = css('--muted');
  const colors = [css('--series-1'), css('--series-2'), css('--series-3'), css('--series-4'), css('--series-5')];
  let rows = '';
  data.forEach((d, i) => {
    const y = i * (barH + gap) + 4;
    const w = Math.max(3, (d[valueKey] / max) * chartW);
    const color = colors[i % colors.length];
    const r = Math.min(4, w / 2);
    rows += `
      <text x="${labelW - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="12" fill="${ink2}">${esc(d[labelKey])}</text>
      <path d="M${labelW},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z" fill="${color}">
        <title>${esc(d[labelKey])}: ${money(d[valueKey])}${d.count ? ` (${d.count} item${d.count === 1 ? '' : 's'})` : ''}</title>
      </path>
      <text x="${labelW + w + 7}" y="${y + barH / 2 + 4}" font-size="12" font-weight="600" fill="${ink2}">${money(d[valueKey])}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Bar chart">${rows}</svg>`;
}

function columnChart(data, { valueKey = 'total', labelKey = 'label', width = 520, height = 200 } = {}) {
  // Columns: single measure over time → single hue. Value on cap, hairline baseline.
  if (!data.length) return '<div class="empty">No data yet</div>';
  const max = Math.max(...data.map(d => d[valueKey]));
  const padT = 26, padB = 24, padX = 10;
  const plotH = height - padT - padB;
  const slot = (width - padX * 2) / data.length;
  const barW = Math.min(24, slot * 0.6);
  const color = css('--series-1'), ink2 = css('--ink-2'), muted = css('--muted'), baseline = css('--baseline');
  let marks = '';
  data.forEach((d, i) => {
    const h = Math.max(3, (d[valueKey] / max) * plotH);
    const x = padX + i * slot + (slot - barW) / 2;
    const y = padT + plotH - h;
    const r = Math.min(4, barW / 2, h);
    marks += `
      <path d="M${x},${y + h} v-${h - r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z" fill="${color}">
        <title>${esc(d[labelKey])}: ${money(d[valueKey])}</title>
      </path>
      <text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${ink2}">${money(d[valueKey])}</text>
      <text x="${x + barW / 2}" y="${height - 7}" text-anchor="middle" font-size="11.5" fill="${muted}">${esc(d[labelKey])}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Column chart">
    <line x1="${padX}" y1="${padT + plotH}" x2="${width - padX}" y2="${padT + plotH}" stroke="${baseline}" stroke-width="1"/>
    ${marks}</svg>`;
}

// ---------------- Dashboard ----------------
views.dashboard = async function () {
  main.innerHTML = '<div class="empty">Loading…</div>';
  const s = await api('/stats');
  const catData = s.byCategory.map(c => ({ label: c.category, total: c.total, count: c.count }));
  const yearData = s.byYear.map(y => ({ label: y.year, total: y.total }));

  // First run: skip the wall of zeros and point at the one action that matters.
  // Only when the tracker is truly empty — no receipts stored or discarded either.
  if (!s.approved_count && !s.pending_count && !s.rejected_count && !s.receipts_count && !s.discarded_count) {
    main.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Dashboard</h1>
          <div class="sub">Your future tax-free withdrawal balance, documented and audit-ready.</div>
        </div>
      </div>
      <div class="card welcome">
        <h2>Start with your first receipt</h2>
        <p>Drop a PDF or photo anywhere in this window, or click below. It gets split into line
        items and checked for HSA eligibility — nothing is recorded without your approval.</p>
        <button class="btn primary" id="dash-upload">${icon('upload')} Upload your first receipt</button>
      </div>`;
    $('#dash-upload').addEventListener('click', () => $('#file-input').click());
    return;
  }

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Dashboard</h1>
        <div class="sub">Your future tax-free withdrawal balance, documented and audit-ready.</div>
      </div>
      <div class="actions">
        <button class="btn" id="dash-upload">${icon('upload')} Upload receipts</button>
        ${s.pending_count ? `<button class="btn primary" id="dash-review">Review ${s.pending_count} pending ${icon('arrowRight')}</button>` : ''}
      </div>
    </div>

    <div class="kpis">
      <div class="card kpi hero">
        <div class="label">Available for tax-free withdrawal</div>
        <div class="value">${money(s.unreimbursed_total)}</div>
        <div class="hint">approved &amp; not yet reimbursed</div>
      </div>
      <div class="card kpi">
        <div class="label">Total eligible logged</div>
        <div class="value">${money(s.approved_total)}</div>
        <div class="hint">${s.approved_count} approved expense${s.approved_count === 1 ? '' : 's'}</div>
      </div>
      <div class="card kpi">
        <div class="label">Reimbursed to date</div>
        <div class="value">${money(s.reimbursed_total)}</div>
        <div class="hint">already withdrawn from HSA</div>
      </div>
      <div class="card kpi">
        <div class="label">Pending review</div>
        <div class="value">${money(s.pending_total)}</div>
        <div class="hint">${s.pending_count} item${s.pending_count === 1 ? '' : 's'} awaiting your decision</div>
      </div>
    </div>

    <div class="charts">
      <div class="card chart-card">
        <h3>Approved by category</h3>
        <div class="chart-sub">total eligible spending per category</div>
        ${barChartH(catData)}
      </div>
      <div class="card chart-card">
        <h3>Approved by year</h3>
        <div class="chart-sub">when the eligible expenses were incurred</div>
        ${columnChart(yearData)}
      </div>
    </div>

    <div class="card">
      <div class="group-head"><span class="g-title">Recently approved</span>
        <span class="g-actions"><button class="btn small ghost" id="dash-ledger">Full ledger ${icon('arrowRight')}</button></span></div>
      <div class="table-wrap"><table class="data" id="dash-table">
        <thead><tr><th data-sort="date">Date</th><th data-sort="provider">Provider</th><th data-sort="description">Description</th><th data-sort="category">Category</th><th class="num" data-sort="amount" data-type="num">Amount</th></tr></thead>
        <tbody>${s.recent.map(e => `
          <tr><td data-v="${esc(e.date)}">${fmtDate(e.date)}</td><td>${esc(e.provider)}</td><td>${esc(e.description)}</td>
          <td><span class="chip cat">${esc(e.category)}</span></td><td class="num" data-v="${e.amount}">${money(e.amount)}</td></tr>`).join('') ||
          '<tr><td colspan="5" class="empty">Nothing approved yet</td></tr>'}
        </tbody>
      </table></div>
    </div>`;

  sortable($('#dash-table'), 'dashboard');
  $('#dash-upload')?.addEventListener('click', () => $('#file-input').click());
  $('#dash-review')?.addEventListener('click', () => navigate('review'));
  $('#dash-ledger')?.addEventListener('click', () => navigate('ledger'));
};

// ---------------- Review queue ----------------
const reviewFilters = { confidence: '', category: '', source: '', q: '' };
const selected = new Set();

views.review = async function () {
  main.innerHTML = '<div class="empty">Loading…</div>';
  const params = new URLSearchParams({ status: 'pending_review' });
  for (const [k, v] of Object.entries(reviewFilters)) if (v) params.set(k, v);
  const items = await api('/expenses?' + params);
  const settings = await api('/settings');
  const discardedCount = (await api('/discarded')).length;
  selected.clear();

  // Group by receipt (or order ref, or standalone)
  const groups = new Map();
  for (const e of items) {
    const key = e.receipt_id ? `r${e.receipt_id}` : (e.order_ref ? `o${e.order_ref}` : `provider:${e.provider}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const total = items.reduce((s, e) => s + e.amount, 0);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Review Queue</h1>
        <div class="sub">Nothing reaches the permanent ledger without your approval. ${items.length} item${items.length === 1 ? '' : 's'} · ${money(total)}</div>
      </div>
      <div class="actions"><button class="btn" id="rq-upload">${icon('upload')} Upload receipts</button></div>
    </div>

    ${items.length || Object.values(reviewFilters).some(Boolean) ? `
    <div class="filters">
      <input type="search" id="rq-q" placeholder="Search…" value="${esc(reviewFilters.q)}">
      <select id="rq-conf">
        <option value="">All confidence</option>
        ${['High', 'Medium', 'Low'].map(c => `<option ${reviewFilters.confidence === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <select id="rq-cat">
        <option value="">All categories</option>
        ${(settings.categories || []).map(c => `<option ${reviewFilters.category === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <select id="rq-src">
        <option value="">All sources</option>
        <option value="upload" ${reviewFilters.source === 'upload' ? 'selected' : ''}>Upload</option>
        <option value="email" ${reviewFilters.source === 'email' ? 'selected' : ''}>Email</option>
        <option value="import" ${reviewFilters.source === 'import' ? 'selected' : ''}>Imported</option>
      </select>
      ${items.length ? '<button class="btn small ghost" id="rq-select-all">Select all</button>' : ''}
      <span class="count">${items.length} shown</span>
    </div>` : ''}

    ${items.length === 0 ? `<div class="card"><div class="empty"><div class="big">${icon('check', 34)}</div>Queue is clear.<br>${settings.email_enabled ? 'Upload a receipt or wait for the next email check.' : 'Upload a receipt to get started.'}</div></div>` : ''}
    ${[...groups.entries()].map(([key, list]) => renderGroup(key, list)).join('')}

    ${discardedCount ? `<p class="inline-note section-gap">${discardedCount} item${discardedCount === 1 ? ' was' : 's were'} auto-discarded as clearly not eligible — <a href="#/discarded">view them</a>. Nothing is ever deleted.</p>` : ''}

    <div class="bulkbar" id="bulkbar" hidden>
      <span id="bulk-count"></span>
      <button class="btn small good" data-bulk="approve">${icon('check')} Approve</button>
      <button class="btn small" data-bulk="reject">${icon('x')} Reject</button>
      <span style="flex:1"></span>
      <button class="btn small ghost" id="bulk-clear" style="color:inherit">Clear</button>
    </div>`;

  $('#rq-upload').addEventListener('click', () => $('#file-input').click());
  $('#rq-q')?.addEventListener('change', e => { reviewFilters.q = e.target.value; views.review(); });
  $('#rq-conf')?.addEventListener('change', e => { reviewFilters.confidence = e.target.value; views.review(); });
  $('#rq-cat')?.addEventListener('change', e => { reviewFilters.category = e.target.value; views.review(); });
  $('#rq-src')?.addEventListener('change', e => { reviewFilters.source = e.target.value; views.review(); });
  $('#rq-select-all')?.addEventListener('click', () => {
    const boxes = $$('.item input[type="checkbox"]');
    const allOn = boxes.every(b => b.checked);
    boxes.forEach(b => {
      b.checked = !allOn;
      const id = Number(b.dataset.id);
      b.checked ? selected.add(id) : selected.delete(id);
    });
    updateBulkbar(items);
  });

  main.onchange = e => {
    if (e.target.matches('.item input[type="checkbox"]')) {
      const id = Number(e.target.dataset.id);
      e.target.checked ? selected.add(id) : selected.delete(id);
      updateBulkbar(items);
    }
  };

  main.onclick = async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'approve') { await api(`/expenses/${id}/approve`, { method: 'POST' }); toast('Approved'); views.review(); }
    if (btn.dataset.act === 'reject') { await api(`/expenses/${id}/reject`, { method: 'POST' }); toast('Rejected (kept in records)'); views.review(); }
    if (btn.dataset.act === 'edit') {
      const item = items.find(x => x.id === id);
      editExpenseModal(item, settings, async patch => {
        await api(`/expenses/${id}`, { method: 'PATCH', body: patch });
        toast('Saved');
        views.review();
      }, { showApprove: true, onApprove: async patch => {
        await api(`/expenses/${id}`, { method: 'PATCH', body: patch });
        await api(`/expenses/${id}/approve`, { method: 'POST' });
        toast('Saved & approved');
        views.review();
      } });
    }
    if (btn.dataset.act === 'view-receipt') window.open(`/api/receipts/${btn.dataset.rid}/file`, '_blank');
    if (btn.dataset.groupAct) {
      const ids = JSON.parse(btn.dataset.ids);
      await api('/expenses/bulk', { method: 'POST', body: { ids, action: btn.dataset.groupAct } });
      toast(`${ids.length} item${ids.length === 1 ? '' : 's'} ${btn.dataset.groupAct}${btn.dataset.groupAct === 'approve' ? 'd' : 'ed'}`);
      views.review();
    }
    if (btn.dataset.bulk) {
      const ids = [...selected];
      await api('/expenses/bulk', { method: 'POST', body: { ids, action: btn.dataset.bulk } });
      toast(`${ids.length} item${ids.length === 1 ? '' : 's'} ${btn.dataset.bulk}${btn.dataset.bulk === 'approve' ? 'd' : 'ed'}`);
      selected.clear();
      views.review();
    }
    if (btn.id === 'bulk-clear') {
      selected.clear();
      $$('.item input[type="checkbox"]').forEach(b => b.checked = false);
      updateBulkbar(items);
    }
  };

  function updateBulkbar(items) {
    const bar = $('#bulkbar');
    if (!bar) return;
    bar.hidden = selected.size === 0;
    if (selected.size) {
      const sum = items.filter(i => selected.has(i.id)).reduce((s, i) => s + i.amount, 0);
      $('#bulk-count').textContent = `${selected.size} selected · ${money(sum)}`;
    }
  }
};

function renderGroup(key, list) {
  const first = list[0];
  const sum = list.reduce((s, e) => s + e.amount, 0);
  const ids = JSON.stringify(list.map(e => e.id));
  const title = first.receipt_id
    ? (first.receipt_original_name || first.receipt_filename || `Receipt #${first.receipt_id}`)
    : (first.order_ref ? `${first.provider} — order ${first.order_ref}` : first.provider || 'Ungrouped');
  return `
  <div class="card group">
    <div class="group-head">
      <span class="g-title">${esc(title)}</span>
      <span class="g-meta">${list.length} item${list.length === 1 ? '' : 's'} · ${money(sum)}</span>
      ${first.receipt_id ? `<button class="btn small ghost" data-act="view-receipt" data-rid="${first.receipt_id}">View receipt</button>` : ''}
      <span class="g-actions">
        <button class="btn small good" data-group-act="approve" data-ids='${ids}'>${icon('check')} Approve all</button>
        <button class="btn small" data-group-act="reject" data-ids='${ids}'>${icon('x')} Reject all</button>
      </span>
    </div>
    ${list.map(e => `
      <div class="item">
        <input type="checkbox" data-id="${e.id}">
        <div class="body">
          <div class="desc">${esc(e.description)}</div>
          <div class="meta">
            <span>${fmtDate(e.date)}</span>·<span>${esc(e.provider)}</span>
            <span class="chip cat">${esc(e.category)}</span>
            <span class="chip conf-${esc(e.confidence)}">${esc(e.confidence)} confidence</span>
            <span class="chip src">${esc(e.source_type)}</span>
            ${e.order_ref ? `<span class="muted mono">${esc(e.order_ref)}</span>` : ''}
          </div>
          <div class="rationale">${esc(e.rationale)}</div>
        </div>
        <div style="text-align:right">
          <div class="amount">${money(e.amount)}</div>
          <div class="i-actions" style="margin-top:8px">
            <button class="btn small good" data-act="approve" data-id="${e.id}" title="Approve" aria-label="Approve">${icon('check')}</button>
            <button class="btn small" data-act="edit" data-id="${e.id}">Edit</button>
            <button class="btn small danger" data-act="reject" data-id="${e.id}" title="Reject (kept for audit)" aria-label="Reject">${icon('x')}</button>
          </div>
        </div>
      </div>`).join('')}
  </div>`;
}

// ---------------- Detail pane (reusable split-pane inspector) ----------------
let paneKey = null;

function openPane(key, html, wire) {
  const pane = $('#detail-pane');
  paneKey = key;
  pane.innerHTML = html;
  pane.hidden = false;
  document.querySelector('.layout').classList.add('panel-open');
  pane.querySelector('.drawer-close')?.addEventListener('click', closePane);
  if (wire) wire(pane);
}

function closePane() {
  const pane = $('#detail-pane');
  if (!pane || pane.hidden) return;
  pane.hidden = true;
  pane.innerHTML = '';
  paneKey = null;
  document.querySelector('.layout').classList.remove('panel-open');
  $$('.row-selected').forEach(r => r.classList.remove('row-selected'));
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closePane(); });

function expensePaneHtml(e) {
  return `
  <div class="drawer-head">
    <div>
      <h2>${esc(e.description)}</h2>
      <div class="drawer-amount">${money(e.amount)} <span class="chip status-${e.status}" style="vertical-align:3px">${e.status.replace('_', ' ')}</span></div>
    </div>
    <button class="btn small ghost drawer-close" title="Close" aria-label="Close">${icon('x')}</button>
  </div>
  <div class="drawer-body">
    <div class="drawer-meta">
      <div><div class="m-label">Date of service</div><div class="m-value">${fmtDate(e.date)}</div></div>
      <div><div class="m-label">Provider</div><div class="m-value">${esc(e.provider || '—')}</div></div>
      <div><div class="m-label">Category</div><div class="m-value"><span class="chip cat">${esc(e.category)}</span></div></div>
      <div><div class="m-label">Reimbursed</div><div class="m-value">${e.reimbursed ? `Yes — ${fmtDate(e.date_reimbursed)}` : 'No — available for withdrawal'}</div></div>
      <div><div class="m-label">Source</div><div class="m-value">${esc(e.source_type)}${e.payment_method ? ` · ${esc(e.payment_method)}` : ''}</div></div>
      <div><div class="m-label">AI confidence</div><div class="m-value">${e.confidence ? `<span class="chip conf-${esc(e.confidence)}">${esc(e.confidence)}</span>` : '—'}</div></div>
      ${e.order_ref ? `<div><div class="m-label">Order ref</div><div class="m-value mono">${esc(e.order_ref)}</div></div>` : ''}
      ${e.notes ? `<div><div class="m-label">Notes</div><div class="m-value">${esc(e.notes)}</div></div>` : ''}
    </div>
    ${e.rationale ? `<div class="drawer-section-title">Why it's eligible</div><div class="drawer-rationale">${esc(e.rationale)}</div>` : ''}
    <div class="drawer-section-title">Receipt${e.receipt_original_name ? ` — ${esc(e.receipt_original_name)}` : ''}</div>
    ${e.receipt_id
      ? `<div class="drawer-receipt"><iframe src="/api/receipts/${e.receipt_id}/file#toolbar=0" title="Receipt"></iframe></div>`
      : `<p class="inline-note" style="margin:0">No receipt file attached to this entry.</p>`}
    <div class="drawer-confirm" id="pane-confirm" hidden>
      <div style="font-weight:650;font-size:13px;margin-bottom:3px">Delete this expense forever?</div>
      <div style="font-size:12.5px;color:var(--ink-2);margin-bottom:10px">It disappears from your records and totals permanently. If you're declining it as not eligible, use <strong>Reject</strong> instead — that keeps it for your audit trail.</div>
      <button class="btn small" id="pane-delete-confirm" style="background:var(--critical);border-color:var(--critical);color:#fff">Delete forever</button>
      <button class="btn small ghost" id="pane-delete-cancel">Cancel</button>
    </div>
  </div>
  <div class="drawer-foot">
    ${e.status === 'approved'
      ? `<button class="btn primary" data-pane-act="toggle-reimb">${e.reimbursed ? 'Un-reimburse' : 'Mark reimbursed'}</button>`
      : e.status === 'pending_review'
        ? `<button class="btn good" data-pane-act="approve">${icon('check')} Approve</button>`
        : `<button class="btn primary" data-pane-act="reopen">${icon('undo')} Re-queue</button>`}
    <button class="btn" data-pane-act="edit">Edit</button>
    ${e.receipt_id ? `<button class="btn" data-pane-act="open-receipt">${icon('eye')} Open receipt</button>` : ''}
    <span style="flex:1"></span>
    ${e.status !== 'rejected' ? `<button class="btn ghost danger" data-pane-act="reject">Reject</button>` : ''}
    <button class="btn ghost danger" data-pane-act="delete">Delete</button>
  </div>`;
}

/** Opens the inspector for an expense. `refresh(idToKeepOpen)` re-renders the host view. */
function openExpensePane(e, settings, refresh) {
  openPane('expense:' + e.id, expensePaneHtml(e), pane => {
    pane.onclick = async ev => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      if (btn.id === 'pane-delete-cancel') { pane.querySelector('#pane-confirm').hidden = true; return; }
      if (btn.id === 'pane-delete-confirm') {
        await api(`/expenses/${e.id}`, { method: 'DELETE' });
        toast('Expense deleted');
        closePane();
        refresh();
        return;
      }
      const act = btn.dataset.paneAct;
      if (!act) return;
      if (act === 'delete') {
        const c = pane.querySelector('#pane-confirm');
        c.hidden = false;
        c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      if (act === 'open-receipt') window.open(`/api/receipts/${e.receipt_id}/file`, '_blank');
      if (act === 'edit') {
        editExpenseModal(e, settings, async patch => {
          await api(`/expenses/${e.id}`, { method: 'PATCH', body: patch });
          toast('Saved');
          refresh(e.id);
        });
      }
      if (act === 'approve') { await api(`/expenses/${e.id}/approve`, { method: 'POST' }); toast('Approved'); refresh(e.id); }
      if (act === 'reject') { await api(`/expenses/${e.id}/reject`, { method: 'POST' }); toast('Rejected (kept in records)'); refresh(e.id); }
      if (act === 'reopen') { await api(`/expenses/${e.id}/reopen`, { method: 'POST' }); toast('Moved back to review queue'); refresh(e.id); }
      if (act === 'toggle-reimb') {
        if (e.reimbursed) {
          await api(`/expenses/${e.id}/reimburse`, { method: 'POST', body: { reimbursed: false } });
          toast('Marked not reimbursed');
          refresh(e.id);
        } else {
          reimburseModal(async date => {
            await api(`/expenses/${e.id}/reimburse`, { method: 'POST', body: { reimbursed: true, date_reimbursed: date } });
            toast('Marked reimbursed');
            refresh(e.id);
          });
        }
      }
    };
  });
}

// ---------------- Ledger ----------------
const ledgerFilters = { q: '', category: '', year: '', status: 'approved', reimbursed: '' };
const ledgerSelected = new Set();

views.ledger = async function () {
  main.innerHTML = '<div class="empty">Loading…</div>';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(ledgerFilters)) if (v) params.set(k, v);
  const rows = await api('/expenses?' + params);
  const settings = await api('/settings');
  const stats = await api('/stats');
  const years = [...new Set(stats.byYear.map(y => y.year))];
  const total = rows.reduce((s, e) => s + e.amount, 0);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Ledger</h1>
        <div class="sub">The permanent record. Click any row to inspect its evidence.</div>
      </div>
      <div class="actions">
        <button class="btn" id="lg-receipts">${icon('file')} Receipts</button>
        <button class="btn primary" id="lg-add">${icon('plus')} Add expense</button>
      </div>
    </div>

    <div class="filters">
      <input type="search" id="lg-q" placeholder="Search…" value="${esc(ledgerFilters.q)}">
      <select id="lg-status">
        <option value="approved" ${ledgerFilters.status === 'approved' ? 'selected' : ''}>Approved</option>
        <option value="rejected" ${ledgerFilters.status === 'rejected' ? 'selected' : ''}>Rejected</option>
        <option value="" ${ledgerFilters.status === '' ? 'selected' : ''}>All statuses</option>
      </select>
      <select id="lg-cat">
        <option value="">All categories</option>
        ${(settings.categories || []).map(c => `<option ${ledgerFilters.category === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <select id="lg-year">
        <option value="">All years</option>
        ${years.map(y => `<option ${ledgerFilters.year === y ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <select id="lg-reimb">
        <option value="">Reimbursed &amp; not</option>
        <option value="no" ${ledgerFilters.reimbursed === 'no' ? 'selected' : ''}>Not reimbursed</option>
        <option value="yes" ${ledgerFilters.reimbursed === 'yes' ? 'selected' : ''}>Reimbursed</option>
      </select>
      <span class="count">${rows.length} rows · ${money(total)}</span>
    </div>

    <div class="card"><div class="table-wrap"><table class="data" id="lg-table">
      <thead><tr>
        <th style="width:26px"><input type="checkbox" id="lg-all" title="Select all"></th>
        <th data-sort="date">Date</th><th class="col-extra" data-sort="provider">Provider</th><th data-sort="description">Description</th><th class="col-extra" data-sort="category">Category</th>
        <th class="num" data-sort="amount" data-type="num">Amount</th><th data-sort="status">Status</th><th class="col-extra" data-sort="reimbursed">Reimbursed</th>
      </tr></thead>
      <tbody>
        ${rows.map(e => `
        <tr class="row-click ${paneKey === 'expense:' + e.id ? 'row-selected' : ''}" data-id="${e.id}">
          <td><input type="checkbox" class="lg-check" data-id="${e.id}" ${ledgerSelected.has(e.id) ? 'checked' : ''}></td>
          <td style="white-space:nowrap" data-v="${esc(e.date)}">${fmtDate(e.date)}</td>
          <td class="col-extra">${esc(e.provider)}</td>
          <td>${esc(e.description)}</td>
          <td class="col-extra"><span class="chip cat">${esc(e.category)}</span></td>
          <td class="num" data-v="${e.amount}">${money(e.amount)}</td>
          <td><span class="chip status-${e.status}">${e.status.replace('_', ' ')}</span></td>
          <td class="col-extra" data-v="${e.reimbursed ? esc(e.date_reimbursed || '9999') : ''}">${e.reimbursed ? `<span class="good-text">${icon('check')} ${fmtDate(e.date_reimbursed)}</span>` : '<span class="muted">No</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">No matching expenses</td></tr>'}
      </tbody>
      ${rows.length ? `<tfoot><tr><td colspan="99" style="text-align:right">Total: ${money(total)}</td></tr></tfoot>` : ''}
    </table></div></div>

    <div class="bulkbar" id="lg-bulkbar" hidden>
      <span id="lg-bulk-count"></span>
      <button class="btn small good" data-bulk="reimburse">${icon('check')} Mark reimbursed</button>
      <button class="btn small" data-bulk="unreimburse">Un-reimburse</button>
      <button class="btn small" data-bulk="receipts">${icon('download')} Receipts</button>
      <button class="btn small" data-bulk="csv">${icon('download')} CSV</button>
      <button class="btn small" data-bulk="category">Category…</button>
      <button class="btn small" data-bulk="reject">${icon('x')} Reject</button>
      <button class="btn small danger" data-bulk="delete">Delete…</button>
      <span style="flex:1"></span>
      <button class="btn small ghost" id="lg-bulk-clear" style="color:inherit">Clear</button>
    </div>`;

  const refresh = async keepPaneId => {
    await views.ledger();
    if (!keepPaneId) return;
    try {
      const fresh = await api(`/expenses/${keepPaneId}`);
      const tr = document.querySelector(`tr[data-id="${keepPaneId}"]`);
      tr?.classList.add('row-selected');
      openExpensePane(fresh, settings, refresh);
    } catch {
      closePane();
    }
  };

  sortable($('#lg-table'), 'ledger');
  $('#lg-q').addEventListener('change', e => { ledgerFilters.q = e.target.value; refresh(); });
  $('#lg-status').addEventListener('change', e => { ledgerFilters.status = e.target.value; refresh(); });
  $('#lg-cat').addEventListener('change', e => { ledgerFilters.category = e.target.value; refresh(); });
  $('#lg-year').addEventListener('change', e => { ledgerFilters.year = e.target.value; refresh(); });
  $('#lg-reimb').addEventListener('change', e => { ledgerFilters.reimbursed = e.target.value; refresh(); });
  $('#lg-receipts').addEventListener('click', () => navigate('receipts'));
  $('#lg-add').addEventListener('click', () => {
    editExpenseModal(null, settings, async body => {
      await api('/expenses', { method: 'POST', body });
      toast('Expense added to ledger');
      refresh();
    });
  });

  // Prune selections that no longer match the current filter
  const visibleIds = new Set(rows.map(r => r.id));
  for (const id of [...ledgerSelected]) if (!visibleIds.has(id)) ledgerSelected.delete(id);

  const updateBulkbar = () => {
    const bar = $('#lg-bulkbar');
    if (!bar) return;
    bar.hidden = ledgerSelected.size === 0;
    if (ledgerSelected.size) {
      const sum = rows.filter(r => ledgerSelected.has(r.id)).reduce((s, r) => s + r.amount, 0);
      $('#lg-bulk-count').textContent = `${ledgerSelected.size} selected · ${money(sum)}`;
    }
    const all = $('#lg-all');
    if (all) all.checked = rows.length > 0 && ledgerSelected.size === rows.length;
  };
  updateBulkbar();

  main.onchange = ev => {
    if (ev.target.id === 'lg-all') {
      const on = ev.target.checked;
      ledgerSelected.clear();
      if (on) rows.forEach(r => ledgerSelected.add(r.id));
      $$('.lg-check').forEach(c => c.checked = on);
      updateBulkbar();
    } else if (ev.target.classList.contains('lg-check')) {
      const id = Number(ev.target.dataset.id);
      ev.target.checked ? ledgerSelected.add(id) : ledgerSelected.delete(id);
      updateBulkbar();
    }
  };

  main.onclick = ev => {
    const bulkBtn = ev.target.closest('button[data-bulk]');
    if (bulkBtn) { handleBulk(bulkBtn.dataset.bulk); return; }
    if (ev.target.closest('#lg-bulk-clear')) {
      ledgerSelected.clear();
      $$('.lg-check').forEach(c => c.checked = false);
      updateBulkbar();
      return;
    }
    const tr = ev.target.closest('tr[data-id]');
    if (!tr || ev.target.closest('button, a, input, label')) return;
    const id = Number(tr.dataset.id);
    if (paneKey === 'expense:' + id) { closePane(); return; }
    $$('.row-selected').forEach(r => r.classList.remove('row-selected'));
    tr.classList.add('row-selected');
    const e = rows.find(x => x.id === id);
    if (e) openExpensePane(e, settings, refresh);
  };

  async function handleBulk(action) {
    const ids = [...ledgerSelected];
    if (!ids.length) return;
    const done = async msg => { ledgerSelected.clear(); toast(msg); await refresh(); };

    if (action === 'receipts') { location.href = '/api/export/receipts?ids=' + ids.join(','); return; }
    if (action === 'csv') { location.href = '/api/export/csv?ids=' + ids.join(','); return; }
    if (action === 'reimburse') {
      reimburseModal(async date => {
        const r = await api('/expenses/bulk', { method: 'POST', body: { ids, action: 'reimburse', date_reimbursed: date } });
        done(r.count < ids.length
          ? `${r.count} marked reimbursed (${ids.length - r.count} skipped — only approved expenses can be reimbursed)`
          : `${r.count} marked reimbursed`);
      });
    }
    if (action === 'unreimburse') {
      await api('/expenses/bulk', { method: 'POST', body: { ids, action: 'unreimburse' } });
      done(`${ids.length} marked not reimbursed`);
    }
    if (action === 'reject') {
      await api('/expenses/bulk', { method: 'POST', body: { ids, action: 'reject' } });
      done(`${ids.length} rejected (kept in records)`);
    }
    if (action === 'category') {
      openModal(`
        <h3>Change category for ${ids.length} item${ids.length === 1 ? '' : 's'}</h3>
        <div class="field"><label>Category</label>
          <select id="m-bulk-cat">${(settings.categories || []).map(c => `<option>${c}</option>`).join('')}</select></div>
        <div class="m-actions">
          <button class="btn" data-close>Cancel</button>
          <button class="btn primary" id="m-bulk-cat-ok">Change</button>
        </div>`);
      $('#m-bulk-cat-ok').addEventListener('click', async () => {
        const category = $('#m-bulk-cat').value;
        closeModal();
        await api('/expenses/bulk', { method: 'POST', body: { ids, action: 'category', category } });
        done(`${ids.length} moved to ${category}`);
      });
    }
    if (action === 'delete') {
      openModal(`
        <h3>Delete ${ids.length} expense${ids.length === 1 ? '' : 's'} forever?</h3>
        <p style="font-size:13px;color:var(--ink-2)">They disappear from your records and totals permanently. If you're declining them as not eligible, use <strong>Reject</strong> instead — that keeps them for your audit trail.</p>
        <div class="m-actions">
          <button class="btn" data-close>Cancel</button>
          <button class="btn" id="m-bulk-del-ok" style="background:var(--critical);border-color:var(--critical);color:#fff">Delete forever</button>
        </div>`);
      $('#m-bulk-del-ok').addEventListener('click', async () => {
        closeModal();
        await api('/expenses/bulk', { method: 'POST', body: { ids, action: 'delete' } });
        closePane();
        done(`${ids.length} deleted`);
      });
    }
  }
};

// ---------------- Receipts ----------------
views.receipts = async function () {
  main.innerHTML = '<div class="empty">Loading…</div>';
  const receipts = await api('/receipts');
  const settings = await api('/settings');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Receipts</h1>
        <div class="sub">Every source document, stored durably and linked to its expenses.</div>
      </div>
      <div class="actions">
        <button class="btn" id="rc-back">${icon('arrowLeft')} Ledger</button>
        <button class="btn primary" id="rc-upload">${icon('upload')} Upload receipts</button>
      </div>
    </div>

    <div class="dropzone" id="rc-dropzone">
      <strong>Drag &amp; drop receipts here</strong> (or anywhere in the app) — PDF, JPG, PNG, HEIC<br>
      <span class="muted">Each file is text-extracted, split into line items, and AI-triaged into the review queue.</span>
    </div>

    <div class="card"><div class="table-wrap"><table class="data" id="rc-table">
      <thead><tr><th data-sort="received">Received</th><th data-sort="file">File</th><th data-sort="source">Source</th><th class="num" data-sort="items" data-type="num">Line items</th><th class="num" data-sort="discarded" data-type="num">Discarded</th><th></th></tr></thead>
      <tbody>
        ${receipts.map(r => `
        <tr>
          <td style="white-space:nowrap" data-v="${esc(r.received_at)}">${fmtDate(r.received_at)}</td>
          <td data-v="${esc(r.original_name || r.filename)}">${esc(r.original_name || r.filename)}${!r.has_text && !r.expense_count && !r.discarded_count
            ? `<div class="muted small">Couldn't be read — use Re-triage to try again, or Add expense.</div>` : ''}</td>
          <td><span class="chip src">${esc(r.source)}</span></td>
          <td class="num">${r.expense_count}</td>
          <td class="num">${r.discarded_count}</td>
          <td class="actions-cell">
            <button class="btn small ghost" data-act="open" data-id="${r.id}">${icon('eye')} View</button>
            <a class="btn small ghost" href="/api/receipts/${r.id}/file?download=1">${icon('download')} Download</a>
            <button class="btn small ghost" data-act="text" data-id="${r.id}">Extracted text</button>
            <button class="btn small ghost" data-act="add-expense" data-id="${r.id}" title="Add an expense with this receipt attached as its evidence">${icon('plus')} Add expense</button>
            <button class="btn small ghost" data-act="retriage" data-id="${r.id}" title="Re-run AI triage on this receipt's extracted text">${icon('refresh')} Re-triage</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">No receipts yet — drop one above.</td></tr>'}
      </tbody>
    </table></div></div>`;

  sortable($('#rc-table'), 'receipts');
  $('#rc-back').addEventListener('click', () => navigate('ledger'));
  $('#rc-upload').addEventListener('click', () => $('#file-input').click());
  const dz = $('#rc-dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); uploadFiles(e.dataTransfer.files); });

  main.onclick = async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'open') window.open(`/api/receipts/${btn.dataset.id}/file`, '_blank');
    if (btn.dataset.act === 'add-expense') {
      const receiptId = Number(btn.dataset.id);
      editExpenseModal(null, settings, async body => {
        await api('/expenses', { method: 'POST', body: { ...body, receipt_id: receiptId } });
        toast('Expense added to ledger with this receipt attached');
        views.receipts();
      });
    }
    if (btn.dataset.act === 'retriage') {
      try {
        await api(`/receipts/${btn.dataset.id}/retriage`, { method: 'POST' });
        toast('Re-running triage…');
        pollJobs();
      } catch (err) { toast(err.message); }
    }
    if (btn.dataset.act === 'text') {
      const { raw_text } = await api(`/receipts/${btn.dataset.id}/text`);
      openModal(`<h3>Extracted text</h3>
        <pre class="rawtext">${esc(raw_text || '(no text was extracted)')}</pre>
        <div class="m-actions"><button class="btn" data-close>Close</button></div>`);
    }
  };
};

// ---------------- Discarded ----------------
views.discarded = async function () {
  main.innerHTML = '<div class="empty">Loading…</div>';
  const rows = await api('/discarded');
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Discarded items</h1>
        <div class="sub">Line items the triage judged clearly not HSA-eligible — kept for audit, never silently deleted. Re-queue anything you disagree with.</div>
      </div>
      <div class="actions"><button class="btn" id="dc-back">${icon('arrowLeft')} Review</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data" id="dc-table">
      <thead><tr><th data-sort="when">When</th><th data-sort="item">Item</th><th class="num" data-sort="amount" data-type="num">Amount</th><th data-sort="why">Why discarded</th><th>Receipt</th><th></th></tr></thead>
      <tbody>
        ${rows.map(d => `
        <tr>
          <td style="white-space:nowrap" data-v="${esc(d.created_at)}">${fmtDate(d.created_at)}</td>
          <td>${esc(d.description)}</td>
          <td class="num" data-v="${d.amount ?? ''}">${d.amount != null ? money(d.amount) : '—'}</td>
          <td class="muted">${esc(d.reason)}</td>
          <td>${d.receipt_id ? `<button class="btn small ghost" data-act="view-receipt" data-rid="${d.receipt_id}">${icon('eye')}</button>` : '—'}</td>
          <td class="actions-cell">${d.amount != null ? `<button class="btn small ghost" data-act="requeue" data-id="${d.id}">${icon('undo')} Re-queue</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing discarded yet</td></tr>'}
      </tbody>
    </table></div></div>`;

  sortable($('#dc-table'), 'discarded');
  $('#dc-back').addEventListener('click', () => navigate('review'));

  main.onclick = async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'view-receipt') window.open(`/api/receipts/${btn.dataset.rid}/file`, '_blank');
    if (btn.dataset.act === 'requeue') {
      await api(`/discarded/${btn.dataset.id}/requeue`, { method: 'POST' });
      toast('Moved to review queue');
      navigate('review');
    }
  };
};




// ---------------- Settings ----------------
views.settings = async function () {
  main.innerHTML = '<div class="empty">Loading…</div>';
  const s = await api('/settings');
  const emailStat = await api('/email/status');

  main.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="sub">AI engine, email ingestion, and backups. Changes save automatically.<span class="test-result ok" id="save-status"></span></div></div></div>

    <div class="settings-form">
      <div class="card settings-section">
        <h3>AI eligibility triage</h3>
        <div class="s-sub">How receipts are split into line items and judged for HSA eligibility.</div>
        <div class="radio-row">
          <label><input type="radio" name="ai" value="anthropic-api" ${s.ai_provider === 'anthropic-api' ? 'checked' : ''}>
            <span><strong>Claude (Anthropic) API key</strong> (recommended)
            <span class="r-sub">Create a key at <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a> and paste it below. Uses Claude's Sonnet model, kept up to date automatically — costs pennies per receipt.</span></span></label>
          <div class="field ai-fields" data-provider="anthropic-api" ${s.ai_provider !== 'anthropic-api' ? 'hidden' : ''}>
            <label>Anthropic API key</label>
            <input type="password" id="set-api-key" value="${esc(s.anthropic_api_key)}" placeholder="sk-ant-…">
            <div class="test-row"><button class="btn small ai-test">Test connection</button><span class="test-result"></span></div>
          </div>
          <label><input type="radio" name="ai" value="openai-api" ${s.ai_provider === 'openai-api' ? 'checked' : ''}>
            <span><strong>ChatGPT (OpenAI) API key</strong>
            <span class="r-sub">Same idea with OpenAI's models. Create a key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a> and paste it below. Uses OpenAI's small "mini" model, kept up to date automatically — costs pennies per receipt.</span></span></label>
          <div class="field ai-fields" data-provider="openai-api" ${s.ai_provider !== 'openai-api' ? 'hidden' : ''}>
            <label>OpenAI API key</label>
            <input type="password" id="set-openai-key" value="${esc(s.openai_api_key)}" placeholder="sk-…">
            <div class="test-row"><button class="btn small ai-test">Test connection</button><span class="test-result"></span></div>
          </div>
          <label><input type="radio" name="ai" value="keywords" ${s.ai_provider === 'keywords' ? 'checked' : ''}>
            <span><strong>No AI (offline keyword matching)</strong>
            <span class="r-sub">Free and private, but coarse — only flags items with obvious medical keywords.</span></span></label>
        </div>
      </div>

      <div class="card settings-section">
        <h3>Email ingestion (optional)</h3>
        <div class="s-sub">Point this at a dedicated free email account (e.g. a new Gmail with an <a href="https://myaccount.google.com/apppasswords" target="_blank">app password</a>) and forward receipts to it. The app polls it over IMAP — nothing is exposed publicly, and it only runs while the app is running.</div>
        <div class="field"><label><input type="checkbox" id="set-email-enabled" ${s.email_enabled ? 'checked' : ''} style="width:auto;margin-right:6px">Enable email ingestion</label></div>
        <div id="email-fields" ${s.email_enabled ? '' : 'hidden'}>
          <div class="field"><label>IMAP host</label><input id="set-email-host" value="${esc(s.email_host)}"></div>
          <div class="field"><label>IMAP port</label><input id="set-email-port" type="number" value="${esc(s.email_port)}"></div>
          <div class="field"><label>Email address</label><input id="set-email-user" value="${esc(s.email_user)}" placeholder="my-hsa-receipts@gmail.com"></div>
          <div class="field"><label>App password</label><input id="set-email-pass" type="password" value="${esc(s.email_password)}"></div>
          <div class="field"><label>Check every (minutes)</label><input id="set-email-poll" type="number" value="${esc(s.email_poll_minutes)}"></div>
          <button class="btn small" id="email-check">Check inbox now</button><span class="test-result" id="email-test-result"></span>
          ${emailStat.lastCheck?.at ? `<div class="inline-note" style="margin-top:8px">Last check: ${new Date(emailStat.lastCheck.at).toLocaleString()} — ${emailStat.lastCheck.error ? 'error: ' + esc(emailStat.lastCheck.error) : `processed ${emailStat.lastCheck.result.processed}, skipped ${emailStat.lastCheck.result.skipped}`}</div>` : ''}
          ${emailStat.recentSkipped?.length ? `
          <div class="skipped-emails">
            <div class="se-title">Couldn't be read as receipts (${emailStat.recentSkipped.length})</div>
            <div class="se-note">These emails stayed in your inbox — the app couldn't pull a receipt from them. Handle them manually, or forward one with the receipt as a proper attachment.</div>
            ${emailStat.recentSkipped.map(m => `<div class="se-row"><span class="se-subj">${esc(m.subject || '(no subject)')}</span><span class="se-reason">${esc(m.reason)}</span></div>`).join('')}
          </div>` : ''}
        </div>
      </div>
    </div>

    <h3 style="margin:26px 0 10px;font-size:14.5px">Backup &amp; export</h3>
    <div class="export-grid" style="margin-bottom:8px">
      <div class="card export-card">
        <h3>${icon('zip', 16)} Everything (zip)</h3>
        <p>Full backup: ledger CSVs, complete JSON, PDF summary, and every receipt file.</p>
        <a class="btn primary" href="/api/export/zip">Download zip</a>
      </div>
      <div class="card export-card">
        <h3>${icon('table', 16)} Ledger (CSV)</h3>
        <p>Approved expenses as a spreadsheet-ready CSV.</p>
        <a class="btn" href="/api/export/csv">Approved only</a>
        <a class="btn ghost" href="/api/export/csv?all=1">All records</a>
      </div>
      <div class="card export-card">
        <h3>${icon('file', 16)} Tax summary (PDF)</h3>
        <p>Clean itemized summary with totals — for a tax preparer or the IRS packet.</p>
        <a class="btn" href="/api/export/pdf">Download PDF</a>
      </div>
      <div class="card export-card">
        <h3>${icon('code', 16)} Full data (JSON)</h3>
        <p>Machine-readable export of every table, including the full audit history.</p>
        <a class="btn" href="/api/export/json">Download JSON</a>
      </div>
    </div>
    <p class="inline-note" style="margin:0 0 22px">Individual receipts can be downloaded from Ledger → Receipts.</p>

    ${navigator.userAgent.includes('Electron') ? '' : `
    <div class="settings-form">
      <div class="card settings-section" style="margin-top:16px">
        <h3>App</h3>
        <div class="s-sub">HSA Tracker works like a regular app: the icon opens it, and a few minutes after you close this tab it shuts itself down. Receipt processing and email checking happen while it's open.</div>
        <button class="btn small ghost" id="app-quit">Quit now instead of waiting</button>
      </div>
    </div>`}
`;

  $$('input[name="ai"]').forEach(r => r.addEventListener('change', () => {
    const v = document.querySelector('input[name="ai"]:checked').value;
    $$('.ai-fields').forEach(f => f.hidden = f.dataset.provider !== v);
  }));

  $('#set-email-enabled').addEventListener('change', e => {
    $('#email-fields').hidden = !e.target.checked;
  });

  const saveSettings = () => api('/settings', { method: 'PUT', body: {
    ai_provider: document.querySelector('input[name="ai"]:checked').value,
    anthropic_api_key: $('#set-api-key').value,
    openai_api_key: $('#set-openai-key').value,
    email_enabled: $('#set-email-enabled').checked,
    email_host: $('#set-email-host').value,
    email_port: Number($('#set-email-port').value) || 993,
    email_user: $('#set-email-user').value,
    email_password: $('#set-email-pass').value,
    email_poll_minutes: Number($('#set-email-poll').value) || 15,
  } }).then(r => { refreshEmailHint(); return r; });

  // Auto-save: radios/checkboxes persist immediately, typing is debounced.
  let saveTimer, statusTimer;
  const autoSave = async () => {
    try {
      await saveSettings();
      // Toast is visible wherever you are on the page; the header tick is a quiet
      // secondary cue when you're near the top. (The old header-only indicator was
      // off-screen when editing the email section at the bottom.)
      toast('Settings saved');
      const el = $('#save-status');
      if (el) {
        el.textContent = ' Saved ✓';
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { el.textContent = ''; }, 2000);
      }
    } catch (err) {
      toast('Could not save settings: ' + err.message);
    }
  };
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(autoSave, 600); };
  $$('.settings-form input').forEach(i => {
    i.addEventListener('input', queueSave);
    i.addEventListener('change', queueSave);
  });

  $$('.ai-test').forEach(btn => btn.addEventListener('click', async e => {
    const out = e.target.nextElementSibling;
    out.className = 'test-result'; out.textContent = 'Saving & testing… (can take ~20s)';
    e.target.disabled = true;
    try {
      await saveSettings(); // test what's on screen, not what was saved earlier
      const r = await api('/ai/test', { method: 'POST' });
      out.className = 'test-result ok';
      out.textContent = r.ok ? `✓ ${r.provider === 'openai-api' ? 'OpenAI' : r.provider === 'anthropic-api' ? 'Claude' : r.provider} is working — settings saved` : 'Unexpected response';
    } catch (err) {
      out.className = 'test-result err';
      out.textContent = '✗ ' + err.message;
    }
    e.target.disabled = false;
  }));

  $('#app-quit')?.addEventListener('click', async () => {
    try { await api('/quit', { method: 'POST' }); } catch { }
    document.body.innerHTML = '<div class="empty" style="padding-top:20vh"><div class="big">👋</div><h2>HSA Tracker is closed.</h2><p class="muted">You can close this tab. Click the HSA Tracker icon whenever you want it back.</p></div>';
  });

  $('#email-check').addEventListener('click', async e => {
    const out = $('#email-test-result');
    out.className = 'test-result'; out.textContent = 'Checking…';
    e.target.disabled = true;
    try {
      await saveSettings(); // check with what's on screen, not what was saved earlier
      const r = await api('/email/check', { method: 'POST' });
      out.className = 'test-result ok';
      out.textContent = `✓ Processed ${r.processed} new message${r.processed === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} couldn't be read (see below)` : ''}`;
      pollJobs();
      if (r.skipped) views.settings(); // re-render so the skipped list shows immediately
    } catch (err) {
      out.className = 'test-result err';
      out.textContent = '✗ ' + err.message;
    }
    e.target.disabled = false;
  });
};

// ---------------- Modals ----------------
function openModal(html) {
  const back = $('#modal-backdrop');
  $('#modal').innerHTML = html;
  back.classList.add('show');
  $('#modal').querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() { $('#modal-backdrop').classList.remove('show'); }
$('#modal-backdrop').addEventListener('click', e => { if (e.target.id === 'modal-backdrop') closeModal(); });

function editExpenseModal(item, settings, onSave, { showApprove = false, onApprove } = {}) {
  const isNew = !item;
  openModal(`
    <h3>${isNew ? 'Add expense' : 'Edit expense'}</h3>
    <div class="row2">
      <div class="field"><label>Date <span class="req">*</span></label><input type="date" id="m-date" value="${esc(item?.date?.slice(0, 10) || new Date().toISOString().slice(0, 10))}"></div>
      <div class="field"><label>Amount ($) <span class="req">*</span></label><input type="number" step="0.01" min="0" id="m-amount" placeholder="0.00" value="${item?.amount ?? ''}"></div>
    </div>
    <div class="field"><label>Provider</label><input id="m-provider" value="${esc(item?.provider || '')}"></div>
    <div class="field"><label>Description <span class="req">*</span></label><input id="m-desc" value="${esc(item?.description || '')}"></div>
    <div class="row2">
      <div class="field"><label>Category</label>
        <select id="m-cat">${(settings.categories || ['Dental', 'Medical', 'Vision', 'Pharmacy', 'Other']).map(c => `<option ${item?.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Payment method</label><input id="m-pay" value="${esc(item?.payment_method || '')}"></div>
    </div>
    <div class="field"><label>Order / receipt ref</label><input id="m-order" value="${esc(item?.order_ref || '')}"></div>
    <div class="field"><label>Notes</label><textarea id="m-notes" rows="2" style="width:100%">${esc(item?.notes || '')}</textarea></div>
    <div class="m-actions">
      <button class="btn" data-close>Cancel</button>
      ${showApprove ? '<button class="btn good" id="m-save-approve">Save &amp; approve</button>' : ''}
      <button class="btn primary" id="m-save">${isNew ? 'Add to ledger' : 'Save'}</button>
    </div>`);

  const collect = () => ({
    date: $('#m-date').value,
    amount: Number($('#m-amount').value),
    provider: $('#m-provider').value,
    description: $('#m-desc').value,
    category: $('#m-cat').value,
    payment_method: $('#m-pay').value,
    order_ref: $('#m-order').value,
    notes: $('#m-notes').value,
  });
  const validate = b => {
    if (!b.date || !b.description || !Number.isFinite(b.amount) || b.amount <= 0) {
      toast('Date, description and a positive amount are required');
      return false;
    }
    return true;
  };
  $('#m-save').addEventListener('click', async () => {
    const b = collect();
    if (!validate(b)) return;
    closeModal();
    await onSave(b);
  });
  $('#m-save-approve')?.addEventListener('click', async () => {
    const b = collect();
    if (!validate(b)) return;
    closeModal();
    await onApprove(b);
  });
}

function reimburseModal(onConfirm) {
  openModal(`
    <h3>Mark reimbursed</h3>
    <div class="field"><label>Date reimbursed from HSA</label>
      <input type="date" id="m-reimb-date" value="${new Date().toISOString().slice(0, 10)}"></div>
    <div class="m-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="m-reimb-ok">Mark reimbursed</button>
    </div>`);
  $('#m-reimb-ok').addEventListener('click', async () => {
    const d = $('#m-reimb-date').value;
    closeModal();
    await onConfirm(d);
  });
}

// ---------------- Upload & jobs ----------------
async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  try {
    // The server accepts 20 files per request — send bigger drops in batches
    for (let i = 0; i < files.length; i += 20) {
      const fd = new FormData();
      files.slice(i, i + 20).forEach(f => fd.append('files', f));
      await api('/upload', { method: 'POST', body: fd });
      pollJobs();
      // New items land in the review queue — take the user there so they can
      // watch the triage finish and act on it without hunting for the tab.
      if (currentView !== 'review') navigate('review');
    }
  } catch (err) {
    toast('Upload failed: ' + err.message);
  }
}

$('#file-input').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = ''; });

// Global drag-and-drop
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  $('#drop-overlay').classList.add('show');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.remove('show'); }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.remove('show');
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});

let jobsTimer = null;
async function pollJobs() {
  if (jobsTimer) return;
  const tick = async () => {
    let jobs = [];
    try { jobs = await api('/jobs'); } catch { }
    renderJobs(jobs);
    const active = jobs.some(j => ['queued', 'extracting', 'triaging'].includes(j.status));
    if (active) {
      jobsTimer = setTimeout(tick, 1800);
    } else {
      jobsTimer = null;
      refreshBadge();
      if (jobs.length && (currentView === 'review' || currentView === 'receipts' || currentView === 'dashboard')) views[currentView]();
      // Auto-dismiss successful jobs after a few seconds. Errors stay on screen
      // until the user dismisses them — a failed file must never vanish unseen.
      setTimeout(async () => {
        try {
          await api('/jobs/clear', { method: 'POST', body: {} });
          renderJobs((await api('/jobs').catch(() => [])));
        } catch { }
      }, 6000);
    }
  };
  tick();
}

function renderJobs(jobs) {
  const statusText = {
    queued: 'Queued…', extracting: 'Reading document…', triaging: 'AI eligibility triage…',
    duplicate: 'Duplicate — skipped', error: 'Failed', done: 'Done',
  };
  $('#jobs').innerHTML = jobs.map(j => {
    const active = ['queued', 'extracting', 'triaging'].includes(j.status);
    const mark = active ? '<div class="spin"></div>'
      : j.status === 'done' ? `<span class="ok">${icon('check')}</span>`
      : j.status === 'duplicate' ? `<span class="muted">${icon('copy')}</span>`
      : `<span class="err">${icon('x')}</span>`;
    const extra = j.status === 'done' ? `${j.queued} queued for review${j.discarded ? `, ${j.discarded} discarded` : ''}` : (j.detail || statusText[j.status]);
    const dismiss = j.status === 'error' ? `<button class="btn small ghost job-dismiss" data-job="${j.id}" title="Dismiss">${icon('x')}</button>` : '';
    return `<div class="card job">${mark}<div class="j-body"><div class="j-name">${esc(j.name)}</div><div class="j-detail">${esc(active ? statusText[j.status] : extra)}</div></div>${dismiss}</div>`;
  }).join('');
  $$('.job-dismiss').forEach(b => b.addEventListener('click', async () => {
    try { await api('/jobs/clear', { method: 'POST', body: { id: Number(b.dataset.job) } }); } catch { }
    renderJobs(await api('/jobs').catch(() => []));
  }));
}

// ---------------- Heartbeat (lets the server quit itself after the app is closed) ----------------
const beat = () => fetch('/api/heartbeat', { method: 'POST' }).catch(() => { });
beat();
setInterval(beat, 20000);

// ---------------- Boot ----------------
api('/meta').then(m => { const v = $('#app-version'); if (v && m.version) v.textContent = `v${m.version} · `; }).catch(() => { });
api('/update-check').then(u => {
  if (!u.updateAvailable) return;
  const el = document.createElement('div');
  el.className = 'card update-note';
  el.innerHTML = `<div><strong>Update available</strong><div class="muted" style="font-size:12px">Version ${esc(u.latest)} — you have ${esc(u.current)}</div></div>
    <a class="btn small primary" href="${esc(u.downloadUrl)}" target="_blank">Download</a>
    <button class="btn small ghost" id="update-dismiss" title="Dismiss" aria-label="Dismiss">${icon('x')}</button>`;
  el.querySelector('#update-dismiss').onclick = () => el.remove();
  document.body.appendChild(el);
}).catch(() => { });
const initial = location.hash.replace('#/', '') || 'dashboard';
navigate(views[initial] ? initial : 'dashboard');
pollJobs();
refreshEmailHint();
