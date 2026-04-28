const socket = io();

const state = {
  accounts: [],
  targets: [],
  recentRtt: new Map(), // targetId -> array of {rtt, ts}
};

const $ = (id) => document.getElementById(id);

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function refresh() {
  const [stats, accounts, targets] = await Promise.all([
    fetchJSON('/api/stats'),
    fetchJSON('/api/accounts'),
    fetchJSON('/api/targets'),
  ]);
  state.accounts = accounts;
  state.targets = targets;
  renderStats(stats);
  render();
}

function renderStats(s) {
  $('stat-accounts').textContent = s.accountCount;
  $('stat-targets').textContent = s.targetCount;
  $('stat-probes').textContent = s.probesLastHour;
  $('stat-ackrate').textContent = s.ackRate == null ? '--' : `${(s.ackRate * 100).toFixed(0)}%`;
}

function rttClass(rtt, ageMs) {
  if (ageMs > 30000) return 'rtt-stale';
  if (rtt == null) return 'rtt-stale';
  if (rtt < 800) return 'rtt-low';
  if (rtt < 1500) return 'rtt-mid';
  return 'rtt-high';
}

function fmtAge(ms) {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function renderSparkline(targetId) {
  const series = state.recentRtt.get(targetId) ?? [];
  if (series.length < 2) return '';
  const w = 80, h = 18;
  const max = Math.max(...series.map((p) => p.rtt), 100);
  const points = series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = h - (p.rtt / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="sparkline" width="${w}" height="${h}"><polyline fill="none" stroke="#1f6feb" stroke-width="1" points="${points}"/></svg>`;
}

function render() {
  const container = $('accounts-container');
  $('empty-state').classList.toggle('hidden', state.accounts.length > 0);
  container.innerHTML = state.accounts.map(renderAccount).join('');

  document.querySelectorAll('[data-act="del-account"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteAccount(parseInt(btn.dataset.id, 10)));
  });
  document.querySelectorAll('[data-act="show-qr"]').forEach((btn) => {
    btn.addEventListener('click', () => showQrModal(parseInt(btn.dataset.id, 10)));
  });
  document.querySelectorAll('[data-act="add-target"]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = parseInt(form.dataset.id, 10);
      const num = form.querySelector('input[name=raw_number]').value;
      const name = form.querySelector('input[name=display_name]').value;
      addTarget(id, num, name);
    });
  });
  document.querySelectorAll('[data-act="del-target"]').forEach((btn) => {
    btn.addEventListener('click', () => deleteTarget(parseInt(btn.dataset.id, 10)));
  });
}

function renderAccount(acc) {
  const accTargets = state.targets.filter((t) => t.account_id === acc.id);
  const stats = acc.windowStats ?? {};
  const ackRate = stats.sent > 0 ? (stats.acked / stats.sent) * 100 : null;
  return `
    <div class="account-card" data-account="${acc.id}">
      <div class="account-head">
        <h2>${escapeHtml(acc.name)}</h2>
        <span class="status-pill ${acc.status}">${acc.status}</span>
        <div style="flex:1"></div>
        ${acc.status === 'qr' ? `<button data-act="show-qr" data-id="${acc.id}">scan QR</button>` : ''}
        <button class="danger" data-act="del-account" data-id="${acc.id}">remove</button>
      </div>
      <div class="account-meta">
        <span>${accTargets.length} targets</span>
        <span><b>${stats.sent ?? 0}</b> probes / 5m</span>
        <span>ack rate <b>${ackRate == null ? '--' : ackRate.toFixed(0) + '%'}</b></span>
        <span>avg RTT <b>${stats.avg_rtt ? Math.round(stats.avg_rtt) + 'ms' : '--'}</b></span>
      </div>
      ${renderTargetTable(accTargets)}
      <form class="add-target-row" data-act="add-target" data-id="${acc.id}">
        <input name="raw_number" placeholder="phone number e.g. 31612345678" required>
        <input name="display_name" placeholder="label (optional)">
        <button type="submit">+ target</button>
      </form>
    </div>
  `;
}

function renderTargetTable(targets) {
  if (targets.length === 0) return '<div style="color:#8b949e;font-size:12px;padding:8px 0;">no targets</div>';
  const now = Date.now();
  const rows = targets.map((t) => {
    const series = state.recentRtt.get(t.id) ?? [];
    const last = series[series.length - 1];
    const ageMs = last ? now - last.ts : null;
    const cls = rttClass(last?.rtt, ageMs ?? Infinity);
    const ws = t.windowStats ?? {};
    const targetAckRate = ws.sent > 0 ? (ws.acked / ws.sent) * 100 : null;
    return `
      <tr>
        <td>${escapeHtml(t.display_name || t.jid.split('@')[0])}</td>
        <td style="color:#8b949e;font-family:ui-monospace,monospace;">${escapeHtml(t.jid)}</td>
        <td class="rtt-cell ${cls}">${last?.rtt != null ? last.rtt + 'ms' : '--'}</td>
        <td>${renderSparkline(t.id)}</td>
        <td>${last ? fmtAge(ageMs) + ' ago' : '--'}</td>
        <td>${targetAckRate == null ? '--' : targetAckRate.toFixed(0) + '%'}</td>
        <td><button class="secondary" data-act="del-target" data-id="${t.id}">x</button></td>
      </tr>
    `;
  }).join('');
  return `
    <table class="target-table">
      <thead><tr><th>name</th><th>jid</th><th>last RTT</th><th>spark</th><th>seen</th><th>ack 5m</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function addAccount() {
  const name = prompt('Account name (any label, e.g. "main"):');
  if (!name) return;
  try {
    const acc = await fetchJSON('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    await refresh();
    setTimeout(() => showQrModal(acc.id), 500);
  } catch (err) {
    alert(err.message);
  }
}

async function deleteAccount(id) {
  if (!confirm('Logout and remove this account? Auth state will be deleted.')) return;
  await fetchJSON(`/api/accounts/${id}`, { method: 'DELETE' });
  await refresh();
}

async function addTarget(accountId, rawNumber, displayName) {
  try {
    await fetchJSON('/api/targets', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, raw_number: rawNumber, display_name: displayName || null }),
    });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteTarget(id) {
  await fetchJSON(`/api/targets/${id}`, { method: 'DELETE' });
  await refresh();
}

async function showQrModal(accountId) {
  const modal = $('modal');
  const body = $('modal-body');
  modal.classList.remove('hidden');
  const update = async () => {
    const data = await fetchJSON(`/api/accounts/${accountId}/qr`);
    if (data.status === 'open') {
      body.innerHTML = '<h3>paired</h3><p>account is connected.</p>';
      setTimeout(() => closeModal(), 1500);
      refresh();
      return;
    }
    if (!data.qrDataUrl) {
      body.innerHTML = `<h3>waiting for QR...</h3><p>status: ${data.status}</p>`;
    } else {
      body.innerHTML = `
        <h3>scan with WhatsApp</h3>
        <p style="color:#8b949e;font-size:12px;">Settings → Linked Devices → Link a Device</p>
        <img class="qr-image" src="${data.qrDataUrl}" />
      `;
    }
  };
  await update();
  const interval = setInterval(update, 2000);
  $('modal-close').onclick = () => {
    clearInterval(interval);
    closeModal();
  };
  modal._interval = interval;
}

function closeModal() {
  const modal = $('modal');
  if (modal._interval) clearInterval(modal._interval);
  modal.classList.add('hidden');
}

function pushProbe(targetId, rtt, ts) {
  const series = state.recentRtt.get(targetId) ?? [];
  series.push({ rtt, ts });
  while (series.length > 60) series.shift();
  state.recentRtt.set(targetId, series);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

socket.on('account:status', () => refresh());
socket.on('account:qr', () => {});
socket.on('probe', (p) => {
  pushProbe(p.targetId, p.rttMs, p.ackAt);
  // light re-render: only update tables, no full refresh, but easiest is targeted.
  // For simplicity refresh on a debounce.
  scheduleRender();
});
socket.on('presence', () => {});

let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => {
    renderPending = false;
    render();
  }, 500);
}

setInterval(() => fetchJSON('/api/stats').then(renderStats).catch(() => {}), 5000);
setInterval(refresh, 15000);

$('btn-add-account').addEventListener('click', addAccount);
refresh();
