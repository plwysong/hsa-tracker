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

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Dashboard</h1>
        <div class="sub">Your future tax-free withdrawal balance, documented and audit-ready.</div>
      </div>
      <div class="actions">
        <button class="btn" id="dash-upload">⇪ Upload receipts</button>
        ${s.pending_count ? `<button class="btn primary" id="dash-review">Review ${s.pending_count} pending →</button>` : ''}
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
        <span class="g-actions"><button class="btn small ghost" id="dash-ledger">Full ledger →</button></span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Provider</th><th>Description</th><th>Category</th><th class="num">Amount</th></tr></thead>
        <tbody>${s.recent.map(e => `
          <tr><td>${fmtDate(e.date)}</td><td>${esc(e.provider)}</td><td>${esc(e.description)}</td>
          <td><span class="chip cat">${esc(e.category)}</span></td><td class="num">${money(e.amount)}</td></tr>`).join('') ||
          '<tr><td colspan="5" class="empty">Nothing approved yet</td></tr>'}
        </tbody>
      </table></div>
    </div>`;

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
      <div class="actions"><button class="btn" id="rq-upload">⇪ Upload receipts</button></div>
    </div>

    <div class="filters">
      <input type="search" id="rq-q" placeholder="Search descriptions, rationale…" value="${esc(reviewFilters.q)}">
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
      <button class="btn small ghost" id="rq-select-all">Select all</button>
      <span class="count">${items.length} shown</span>
    </div>

    ${items.length === 0 ? `<div class="card"><div class="empty"><div class="big">✓</div>Queue is clear.<br>Upload a receipt or wait for the next email check.</div></div>` : ''}
    ${[...groups.entries()].map(([key, list]) => renderGroup(key, list)).join('')}

    ${discardedCount ? `<p class="inline-note section-gap">${discardedCount} item${discardedCount === 1 ? ' was' : 's were'} auto-discarded as clearly not eligible — <a href="#/discarded">view them</a>. Nothing is ever deleted.</p>` : ''}

    <div class="bulkbar" id="bulkbar" hidden>
      <span id="bulk-count"></span>
      <button class="btn small good" data-bulk="approve">✓ Approve</button>
      <button class="btn small" data-bulk="reject">✗ Reject</button>
      <span style="flex:1"></span>
      <button class="btn small ghost" id="bulk-clear" style="color:inherit">Clear</button>
    </div>`;

  $('#rq-upload').addEventListener('click', () => $('#file-input').click());
  $('#rq-q').addEventListener('change', e => { reviewFilters.q = e.target.value; views.review(); });
  $('#rq-conf').addEventListener('change', e => { reviewFilters.confidence = e.target.value; views.review(); });
  $('#rq-cat').addEventListener('change', e => { reviewFilters.category = e.target.value; views.review(); });
  $('#rq-src').addEventListener('change', e => { reviewFilters.source = e.target.value; views.review(); });
  $('#rq-select-all').addEventListener('click', () => {
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
        <button class="btn small good" data-group-act="approve" data-ids='${ids}'>✓ Approve all</button>
        <button class="btn small" data-group-act="reject" data-ids='${ids}'>✗ Reject all</button>
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
            <button class="btn small good" data-act="approve" data-id="${e.id}">✓</button>
            <button class="btn small" data-act="edit" data-id="${e.id}">Edit</button>
            <button class="btn small danger" data-act="reject" data-id="${e.id}">✗</button>
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
    <button class="btn small ghost drawer-close">✕</button>
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
        ? `<button class="btn good" data-pane-act="approve">✓ Approve</button>`
        : `<button class="btn primary" data-pane-act="reopen">↩ Re-queue</button>`}
    <button class="btn" data-pane-act="edit">Edit</button>
    ${e.receipt_id ? `<button class="btn" data-pane-act="open-receipt">⎗ Open receipt</button>` : ''}
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
        <button class="btn" id="lg-receipts">⎗ Receipts</button>
        <button class="btn primary" id="lg-add">＋ Add expense</button>
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

    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr>
        <th style="width:26px"><input type="checkbox" id="lg-all" title="Select all"></th>
        <th>Date</th><th class="col-extra">Provider</th><th>Description</th><th class="col-extra">Category</th>
        <th class="num">Amount</th><th>Status</th><th class="col-extra">Reimbursed</th>
      </tr></thead>
      <tbody>
        ${rows.map(e => `
        <tr class="row-click ${paneKey === 'expense:' + e.id ? 'row-selected' : ''}" data-id="${e.id}">
          <td><input type="checkbox" class="lg-check" data-id="${e.id}" ${ledgerSelected.has(e.id) ? 'checked' : ''}></td>
          <td style="white-space:nowrap">${fmtDate(e.date)}</td>
          <td class="col-extra">${esc(e.provider)}</td>
          <td>${esc(e.description)}</td>
          <td class="col-extra"><span class="chip cat">${esc(e.category)}</span></td>
          <td class="num">${money(e.amount)}</td>
          <td><span class="chip status-${e.status}">${e.status.replace('_', ' ')}</span></td>
          <td class="col-extra">${e.reimbursed ? `<span class="good-text">✓ ${fmtDate(e.date_reimbursed)}</span>` : '<span class="muted">No</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">No matching expenses</td></tr>'}
      </tbody>
      ${rows.length ? `<tfoot><tr><td colspan="99" style="text-align:right">Total: ${money(total)}</td></tr></tfoot>` : ''}
    </table></div></div>

    <div class="bulkbar" id="lg-bulkbar" hidden>
      <span id="lg-bulk-count"></span>
      <button class="btn small good" data-bulk="reimburse">✓ Mark reimbursed</button>
      <button class="btn small" data-bulk="unreimburse">Un-reimburse</button>
      <button class="btn small" data-bulk="receipts">⇩ Receipts</button>
      <button class="btn small" data-bulk="csv">⇩ CSV</button>
      <button class="btn small" data-bulk="category">Category…</button>
      <button class="btn small" data-bulk="reject">✗ Reject</button>
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
        await api('/expenses/bulk', { method: 'POST', body: { ids, action: 'reimburse', date_reimbursed: date } });
        done(`${ids.length} marked reimbursed`);
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

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Receipts</h1>
        <div class="sub">Every source document, stored durably and linked to its expenses.</div>
      </div>
      <div class="actions">
        <button class="btn" id="rc-back">← Ledger</button>
        <button class="btn primary" id="rc-upload">⇪ Upload receipts</button>
      </div>
    </div>

    <div class="dropzone" id="rc-dropzone">
      <strong>Drag &amp; drop receipts here</strong> (or anywhere in the app) — PDF, JPG, PNG, HEIC<br>
      <span class="muted">Each file is text-extracted, split into line items, and AI-triaged into the review queue.</span>
    </div>

    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Received</th><th>File</th><th>Source</th><th class="num">Line items</th><th class="num">Discarded</th><th></th></tr></thead>
      <tbody>
        ${receipts.map(r => `
        <tr>
          <td style="white-space:nowrap">${fmtDate(r.received_at)}</td>
          <td>${esc(r.original_name || r.filename)}</td>
          <td><span class="chip src">${esc(r.source)}</span></td>
          <td class="num">${r.expense_count}</td>
          <td class="num">${r.discarded_count}</td>
          <td class="actions-cell">
            <button class="btn small ghost" data-act="open" data-id="${r.id}">⎗ View</button>
            <a class="btn small ghost" href="/api/receipts/${r.id}/file?download=1">⇩ Download</a>
            <button class="btn small ghost" data-act="text" data-id="${r.id}">Extracted text</button>
            <button class="btn small ghost" data-act="retriage" data-id="${r.id}" title="Re-run AI triage on this receipt's extracted text">↻ Re-triage</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">No receipts yet — drop one above.</td></tr>'}
      </tbody>
    </table></div></div>`;

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
      <div class="actions"><button class="btn" id="dc-back">← Review</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>When</th><th>Item</th><th class="num">Amount</th><th>Why discarded</th><th>Receipt</th><th></th></tr></thead>
      <tbody>
        ${rows.map(d => `
        <tr>
          <td style="white-space:nowrap">${fmtDate(d.created_at)}</td>
          <td>${esc(d.description)}</td>
          <td class="num">${d.amount != null ? money(d.amount) : '—'}</td>
          <td class="muted">${esc(d.reason)}</td>
          <td>${d.receipt_id ? `<button class="btn small ghost" data-act="view-receipt" data-rid="${d.receipt_id}">⎗</button>` : '—'}</td>
          <td class="actions-cell">${d.amount != null ? `<button class="btn small ghost" data-act="requeue" data-id="${d.id}">↩ Re-queue</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing discarded yet</td></tr>'}
      </tbody>
    </table></div></div>`;

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
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Backups, AI engine, email ingestion, and history.</div></div></div>

    <h3 style="margin:0 0 10px;font-size:14.5px">Backup &amp; export</h3>
    <div class="export-grid" style="margin-bottom:8px">
      <div class="card export-card">
        <h3>⇩ Everything (zip)</h3>
        <p>Full backup: ledger CSVs, complete JSON, PDF summary, and every receipt file.</p>
        <a class="btn primary" href="/api/export/zip">Download zip</a>
      </div>
      <div class="card export-card">
        <h3>≣ Ledger (CSV)</h3>
        <p>Approved expenses as a spreadsheet-ready CSV.</p>
        <a class="btn" href="/api/export/csv">Approved only</a>
        <a class="btn ghost" href="/api/export/csv?all=1">All records</a>
      </div>
      <div class="card export-card">
        <h3>⎗ Tax summary (PDF)</h3>
        <p>Clean itemized summary with totals — for a tax preparer or the IRS packet.</p>
        <a class="btn" href="/api/export/pdf">Download PDF</a>
      </div>
      <div class="card export-card">
        <h3>{ } Full data (JSON)</h3>
        <p>Machine-readable export of every table, including the audit history below.</p>
        <a class="btn" href="/api/export/json">Download JSON</a>
      </div>
    </div>
    <p class="inline-note" style="margin:0 0 22px">Individual receipts can be downloaded from Ledger → Receipts.</p>

    <div class="settings-form">
      <div class="card settings-section">
        <h3>AI eligibility triage</h3>
        <div class="s-sub">How receipts are split into line items and judged for HSA eligibility.</div>
        <div class="radio-row">
          <label><input type="radio" name="ai" value="anthropic-api" ${s.ai_provider === 'anthropic-api' ? 'checked' : ''}>
            <span><strong>Claude (Anthropic) API key</strong> (recommended)
            <span class="r-sub">Create a key at <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a> and paste it below. Uses Claude Sonnet 5 — costs pennies per receipt.</span></span></label>
          <label><input type="radio" name="ai" value="openai-api" ${s.ai_provider === 'openai-api' ? 'checked' : ''}>
            <span><strong>ChatGPT (OpenAI) API key</strong>
            <span class="r-sub">Same idea with OpenAI's models. Create a key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a> and paste it below. Uses GPT-4o mini — costs pennies per receipt.</span></span></label>
          <label><input type="radio" name="ai" value="keywords" ${s.ai_provider === 'keywords' ? 'checked' : ''}>
            <span><strong>No AI (offline keyword matching)</strong>
            <span class="r-sub">Free and private, but coarse — only flags items with obvious medical keywords.</span></span></label>
        </div>
        <div class="field ai-fields" data-provider="anthropic-api" ${s.ai_provider !== 'anthropic-api' ? 'hidden' : ''}>
          <label>Anthropic API key</label>
          <input type="password" id="set-api-key" value="${esc(s.anthropic_api_key)}" placeholder="sk-ant-…">
        </div>
        <div class="field ai-fields" data-provider="openai-api" ${s.ai_provider !== 'openai-api' ? 'hidden' : ''}>
          <label>OpenAI API key</label>
          <input type="password" id="set-openai-key" value="${esc(s.openai_api_key)}" placeholder="sk-…">
        </div>
        <button class="btn small" id="ai-test">Test triage engine</button><span class="test-result" id="ai-test-result"></span>
      </div>

      <div class="card settings-section">
        <h3>Email ingestion (optional)</h3>
        <div class="s-sub">Point this at a dedicated free email account (e.g. a new Gmail with an <a href="https://myaccount.google.com/apppasswords" target="_blank">app password</a>) and forward receipts to it. The app polls it over IMAP — nothing is exposed publicly, and it only runs while the app is running.</div>
        <div class="field"><label><input type="checkbox" id="set-email-enabled" ${s.email_enabled ? 'checked' : ''} style="width:auto;margin-right:6px">Enable periodic inbox checking</label></div>
        <div class="field"><label>IMAP host</label><input id="set-email-host" value="${esc(s.email_host)}"></div>
        <div class="field"><label>IMAP port</label><input id="set-email-port" type="number" value="${esc(s.email_port)}"></div>
        <div class="field"><label>Email address</label><input id="set-email-user" value="${esc(s.email_user)}" placeholder="my-hsa-receipts@gmail.com"></div>
        <div class="field"><label>App password</label><input id="set-email-pass" type="password" value="${esc(s.email_password)}"></div>
        <div class="field"><label>Check every (minutes)</label><input id="set-email-poll" type="number" value="${esc(s.email_poll_minutes)}"></div>
        <button class="btn small" id="email-check">Check inbox now</button><span class="test-result" id="email-test-result"></span>
        ${emailStat.lastCheck?.at ? `<div class="inline-note" style="margin-top:8px">Last check: ${new Date(emailStat.lastCheck.at).toLocaleString()} — ${emailStat.lastCheck.error ? 'error: ' + esc(emailStat.lastCheck.error) : `processed ${emailStat.lastCheck.result.processed}, skipped ${emailStat.lastCheck.result.skipped}`}</div>` : ''}
      </div>

      <button class="btn primary" id="settings-save">Save settings</button>

      ${navigator.userAgent.includes('Electron') ? '' : `
      <div class="card settings-section" style="margin-top:16px">
        <h3>App</h3>
        <div class="s-sub">HSA Tracker works like a regular app: the icon opens it, and a few minutes after you close this tab it shuts itself down. Receipt processing and email checking happen while it's open.</div>
        <button class="btn small ghost" id="app-quit">Quit now instead of waiting</button>
      </div>`}
    </div>
`;

  $$('input[name="ai"]').forEach(r => r.addEventListener('change', () => {
    const v = document.querySelector('input[name="ai"]:checked').value;
    $$('.ai-fields').forEach(f => f.hidden = f.dataset.provider !== v);
  }));

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
  } });

  $('#settings-save').addEventListener('click', async () => {
    await saveSettings();
    toast('Settings saved');
    views.settings();
  });

  $('#ai-test').addEventListener('click', async e => {
    const out = $('#ai-test-result');
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
  });

  $('#app-quit')?.addEventListener('click', async () => {
    try { await api('/quit', { method: 'POST' }); } catch { }
    document.body.innerHTML = '<div class="empty" style="padding-top:20vh"><div class="big">👋</div><h2>HSA Tracker is closed.</h2><p class="muted">You can close this tab. Click the HSA Tracker icon whenever you want it back.</p></div>';
  });

  $('#email-check').addEventListener('click', async e => {
    const out = $('#email-test-result');
    out.className = 'test-result'; out.textContent = 'Checking…';
    e.target.disabled = true;
    try {
      const r = await api('/email/check', { method: 'POST' });
      out.className = 'test-result ok';
      out.textContent = `✓ Processed ${r.processed} new message${r.processed === 1 ? '' : 's'} (${r.skipped} skipped)`;
      pollJobs();
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
      <div class="field"><label>Date</label><input type="date" id="m-date" value="${esc(item?.date?.slice(0, 10) || new Date().toISOString().slice(0, 10))}"></div>
      <div class="field"><label>Amount</label><input type="number" step="0.01" min="0" id="m-amount" value="${item?.amount ?? ''}"></div>
    </div>
    <div class="field"><label>Provider</label><input id="m-provider" value="${esc(item?.provider || '')}"></div>
    <div class="field"><label>Description</label><input id="m-desc" value="${esc(item?.description || '')}"></div>
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
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  try {
    await api('/upload', { method: 'POST', body: fd });
    pollJobs();
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
      // auto-dismiss finished jobs after a few seconds
      setTimeout(async () => {
        try { await api('/jobs/clear', { method: 'POST' }); renderJobs([]); } catch { }
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
    const icon = active ? '<div class="spin"></div>' : j.status === 'done' ? '<span class="ok">✓</span>' : j.status === 'duplicate' ? '<span class="muted">⧉</span>' : '<span class="err">✗</span>';
    const extra = j.status === 'done' ? `${j.queued} queued for review${j.discarded ? `, ${j.discarded} discarded` : ''}` : (j.detail || statusText[j.status]);
    return `<div class="card job">${icon}<div class="j-body"><div class="j-name">${esc(j.name)}</div><div class="j-detail">${esc(active ? statusText[j.status] : extra)}</div></div></div>`;
  }).join('');
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
    <button class="btn small ghost" id="update-dismiss">✕</button>`;
  el.querySelector('#update-dismiss').onclick = () => el.remove();
  document.body.appendChild(el);
}).catch(() => { });
const initial = location.hash.replace('#/', '') || 'dashboard';
navigate(views[initial] ? initial : 'dashboard');
pollJobs();
