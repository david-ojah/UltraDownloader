const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let settings = {};
let connections = [];
let downloads = [];
const grabCandidates = [];
const connSpeeds = {};

function fmtBytes(b) {
  if (!b) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < units.length-1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}
function fmtSpeed(bps) {
  return fmtBytes(bps) + '/s';
}
function fmtDuration(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const s = total / 1000;
  if (s < 10) return s.toFixed(1) + 's';
  if (s < 60) return Math.round(s) + 's';
  const whole = Math.round(s);
  const m = Math.floor(whole / 60), sec = whole % 60;
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`;
  const h = Math.floor(m / 60), min = m % 60;
  if (h < 24) return min ? `${h}h ${min}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
function speedUnit() { return (settings && settings.speedUnit) || 'mbps'; }
function toSpeedValue(bps) {
  if (speedUnit() === 'mbs') return (bps / 1000000).toFixed(2) + ' MB/s';
  return (bps * 8 / 1000000).toFixed(2) + ' Mbps';
}
function kbpsToInput(kbps) {
  return speedUnit() === 'mbs' ? (kbps / 8000) : (kbps / 1000);
}
function inputToKbps(val) {
  const v = parseFloat(val) || 0;
  return speedUnit() === 'mbs' ? Math.round(v * 8000) : Math.round(v * 1000);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toast(msg, type = 'success') {
  const c = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 2800);
}

const pageMeta = {
  downloads: ['Downloads', 'Manage your download queue'],
  finished: ['Finished', 'Downloads that completed successfully'],
  connections: ['Connections', 'Manage network adapters'],
  settings: ['Settings', 'Configure Ultra Downloader']
};

// Tabs / nav
$$('.nav-item').forEach(t => t.addEventListener('click', () => {
  $$('.nav-item').forEach(x => x.classList.remove('active'));
  $$('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
  $('#pageTitle').textContent = pageMeta[t.dataset.tab][0];
  $('#pageSubtitle').textContent = pageMeta[t.dataset.tab][1];
}));

// Stats
function updateStats() {
  const active = downloads.filter(d => d.status === 'downloading' || d.status === 'assembling').length;
  const queued = downloads.filter(d => d.status === 'queued' || d.status === 'paused').length;
  const done = downloads.filter(d => d.status === 'completed').length;
  $('#statActive').textContent = active;
  $('#statQueued').textContent = queued;
  $('#statDone').textContent = done;
  const badge = $('#navFinishedCount');
  if (badge) {
    badge.textContent = done;
    badge.classList.toggle('hidden', done === 0);
  }
}

// ---- Speed / ETA ----
// Rolling 5-second average. A 1-second readout follows every cellular wobble
// and reads as "erratic", while 5 s still reacts quickly to a real change.
const liveSpeeds = new Map(); // download id -> bytes/s
const liveSamples = new Map(); // download id -> [{ t, bytes }]
const SPEED_WINDOW_MS = 5000;

function sampleSpeed(id, bytes) {
  const now = Date.now();
  let arr = liveSamples.get(id);
  if (!arr) { arr = []; liveSamples.set(id, arr); }
  arr.push({ t: now, bytes });
  const cutoff = now - SPEED_WINDOW_MS;
  while (arr.length > 2 && arr[0].t < cutoff) arr.shift();
  const first = arr[0];
  const last = arr[arr.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt < 1) return liveSpeeds.get(id) || 0;
  const sp = Math.max(0, (last.bytes - first.bytes) / dt);
  liveSpeeds.set(id, sp);
  return sp;
}
function clearSpeed(id) {
  liveSpeeds.delete(id);
  liveSamples.delete(id);
}

function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return s + 's left';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s left`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m left`;
  return `${Math.floor(h / 24)}d ${h % 24}h left`;
}

function etaFor(d, speed) {
  if (d.status !== 'downloading') return '';
  if (!d.totalSize || d.downloaded >= d.totalSize) return '';
  if (!speed || speed < 1024) return '';
  return fmtEta((d.totalSize - d.downloaded) / speed);
}

function connChips(d) {
  if (d.status !== 'downloading' || !Array.isArray(d.conns) || d.conns.length === 0) return '';
  const COLORS = ['#35e0d0', '#6dffa8', '#ffc857', '#4dd0e1', '#c3ced8', '#ff8a5b'];
  return d.conns.map((c, i) => {
    const known = connections.find((x) => x.id === c.id);
    const name = (known && known.name) || c.name || c.id;
    const color = COLORS[i % COLORS.length];
    return `<span class="conn-chip"><i style="background:${color}"></i>${escapeHtml(name)} ` +
      `<b>${toSpeedValue(c.speed || 0)}</b></span>`;
  }).join('');
}

function cardPct(d) {
  if (d.status === 'assembling') return Math.min(100, Math.max(0, d.assemblePct || 0));
  return d.totalSize > 0 ? (d.downloaded / d.totalSize * 100) : 0;
}

function progressLine(d, speed) {
  if (d.status === 'assembling') {
    const pct = Math.round(cardPct(d));
    return `${fmtBytes(d.totalSize)} · building final file… ${pct}%`;
  }
  if (d.status === 'completed') {
    // Transfer time only counts while the download was actually running, so a
    // paused stretch never inflates the duration or drags the average down.
    const bits = [fmtBytes(d.totalSize || d.downloaded)];
    const ms = Number(d.activeMs) || 0;
    if (ms > 0) {
      bits.push(`took ${fmtDuration(ms)}`);
      const bytes = Number(d.totalSize) || Number(d.downloaded) || 0;
      const avg = bytes / (ms / 1000);
      if (avg > 0) bits.push(`${toSpeedValue(avg)} avg`);
    }
    return bits.join(' · ');
  }
  const pct = d.totalSize > 0 ? (d.downloaded / d.totalSize * 100) : 0;
  const bits = [`${fmtBytes(d.downloaded)} / ${fmtBytes(d.totalSize)}`];
  if (d.totalSize) bits.push(pct.toFixed(1) + '%');
  if (d.status === 'downloading') {
    bits.push(toSpeedValue(speed || 0));
    bits.push(etaFor(d, speed) || (speed ? '' : 'estimating…'));
  } else if (d.status === 'paused') {
    bits.push('paused');
  } else if (d.status === 'queued') {
    bits.push('waiting to start');
  }
  return bits.filter(Boolean).join(' · ');
}

function activeActions(d) {
  if (d.status === 'assembling') return '<span class="card-meta">finalizing…</span>';
  const canRefresh = d.status === 'failed' || d.status === 'paused' || d.status === 'cancelled';
  return `
    ${d.status === 'queued' ? '<button class="btn sm primary" data-a="start">Start</button>' : ''}
    ${d.status === 'downloading' ? '<button class="btn sm ghost" data-a="pause">Pause</button>' : ''}
    ${d.status === 'paused' ? '<button class="btn sm primary" data-a="resume">Resume</button>' : ''}
    ${canRefresh ? '<button class="btn sm ghost" data-a="refresh" title="Paste a fresh link and keep what was already downloaded">Refresh link</button>' : ''}
    ${d.status !== 'cancelled' ? '<button class="btn sm danger" data-a="cancel">Cancel</button>' : ''}
    ${d.savePath ? '<button class="btn sm ghost" data-a="reveal">Folder</button>' : ''}
    <button class="btn sm danger" data-a="remove">Remove</button>`;
}

function finishedActions() {
  return `
    <button class="btn sm primary" data-a="openfile">Open</button>
    <button class="btn sm ghost" data-a="reveal">Show in folder</button>
    <button class="btn sm danger" data-a="remove">Remove</button>`;
}

function finishedStats(d) {
  const bits = [fmtBytes(d.totalSize || d.downloaded)];
  const ms = Number(d.activeMs) || 0;
  if (ms > 0) {
    bits.push(`<span class="stat-strong">took ${fmtDuration(ms)}</span>`);
    const bytes = Number(d.totalSize) || Number(d.downloaded) || 0;
    const avg = bytes / (ms / 1000);
    if (avg > 0) bits.push(`<span class="stat-strong">${toSpeedValue(avg)} avg</span>`);
  }
  return bits.join('<span class="stat-dot">·</span>');
}

function buildCard(d, finished) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = d.id;
  const speed = liveSpeeds.get(d.id) || 0;
  const pct = cardPct(d);
  card.innerHTML = `
    <div class="card-head">
      <div class="card-title" title="${escapeHtml(d.url)}">${escapeHtml(d.filename || d.url)}</div>
      <span class="status-pill status-${d.status}">${d.status}</span>
    </div>
    <div class="card-meta" data-meta>${finished ? finishedStats(d) : escapeHtml(progressLine(d, speed))}</div>
    <div class="progress"><div data-bar style="width:${pct.toFixed(1)}%"></div></div>
    ${finished ? '' : `<div class="conn-speeds" data-conns>${connChips(d)}</div>`}
    ${d.error && d.status !== 'completed' ? `<div class="card-error">${escapeHtml(d.error)}</div>` : ''}
    <div class="card-row">
      <div class="card-meta" title="${escapeHtml(d.url)}">${escapeHtml(d.url)}</div>
      <div class="card-actions">${finished ? finishedActions(d) : activeActions(d)}</div>
    </div>
  `;
  card.querySelectorAll('[data-a]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const a = btn.dataset.a;
      if (a === 'start') await window.api.downloads.start(d.id);
      if (a === 'pause') await window.api.downloads.pause(d.id);
      if (a === 'resume') await window.api.downloads.resume(d.id);
      if (a === 'cancel') await window.api.downloads.cancel(d.id);
      if (a === 'remove') await window.api.downloads.remove(d.id);
      if (a === 'refresh') { openLinkModal(d); return; }
      if (a === 'reveal') { if (d.savePath) window.api.shell.openPath(d.savePath); }
      if (a === 'openfile') { if (d.savePath) window.api.shell.openFile(d.savePath); }
      await refreshDownloads();
    });
  });
  return card;
}

// Downloads rendering: active items only; completed ones move to the Finished tab.
function renderDownloads() {
  const el = $('#downloadList');
  const list = downloads.filter(d => d.status !== 'completed');
  el.innerHTML = '';
  if (list.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">⬇</div><div>No active downloads. Paste a URL above to get started.</div></div>';
  } else {
    for (const d of list) el.appendChild(buildCard(d, false));
  }
  updateStats();
}

function renderFinished() {
  const el = $('#finishedList');
  const list = downloads.filter(d => d.status === 'completed');
  el.innerHTML = '';
  if (list.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">✓</div><div>Nothing finished yet. Completed downloads land here.</div></div>';
  } else {
    for (const d of list) el.appendChild(buildCard(d, true));
  }
  const total = list.reduce((a, d) => a + (d.totalSize || 0), 0);
  $('#finishedSummary').textContent = list.length
    ? `${list.length} completed · ${fmtBytes(total)} total`
    : 'Completed downloads';
  updateStats();
}

// Cheap in-place refresh for the 2x/second progress events.
function updateCardLive(d) {
  const card = document.querySelector(`#downloadList .card[data-id="${d.id}"]`);
  if (!card) { renderDownloads(); return; }
  const speed = liveSpeeds.get(d.id) || 0;
  const meta = card.querySelector('[data-meta]');
  if (meta) meta.textContent = progressLine(d, speed);
  const bar = card.querySelector('[data-bar]');
  if (bar) bar.style.width = cardPct(d).toFixed(1) + '%';
  const chips = card.querySelector('[data-conns]');
  if (chips) chips.innerHTML = connChips(d);
  const pill = card.querySelector('.status-pill');
  if (pill && pill.textContent !== d.status) {
    pill.textContent = d.status;
    pill.className = `status-pill status-${d.status}`;
  }
}

let lastCompletedCount = null;
async function refreshDownloads() {
  downloads = await window.api.downloads.list();
  for (const id of new Set([...liveSpeeds.keys(), ...liveSamples.keys()])) {
    if (!downloads.some(d => d.id === id && (d.status === 'downloading' || d.status === 'assembling'))) clearSpeed(id);
  }
  renderDownloads();
  renderFinished();
  const done = downloads.filter(d => d.status === 'completed').length;
  if (lastCompletedCount !== null && done > lastCompletedCount) {
    toast('Download complete — moved to Finished');
  }
  lastCompletedCount = done;
}

$('#clearFinished').addEventListener('click', async () => {
  const done = downloads.filter(d => d.status === 'completed');
  if (!done.length) return;
  for (const d of done) await window.api.downloads.remove(d.id, { silent: true });
  lastCompletedCount = 0;
  await refreshDownloads();
  toast(`Cleared ${done.length} finished item${done.length === 1 ? '' : 's'} from the list (files kept)`);
});

// Quick add
$('#quickAdd').addEventListener('click', async () => {
  const url = $('#quickUrl').value.trim();
  if (!url) return;
  await window.api.downloads.add(url, {});
  $('#quickUrl').value = '';
  await refreshDownloads();
  toast('Download added to queue');
});
$('#quickUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#quickAdd').click(); });


// Connections
async function renderConnections(forced) {
  const list = Array.isArray(forced) ? forced : await window.api.connections.list();
  connections = list;
  const el = $('#connList');
  el.innerHTML = '';
  if (list.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">🌐</div><div>No connections detected.</div></div>';
    return;
  }
  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const curSpeed = connSpeeds[c.id] || 0;
    const maxSpeed = Math.max(1, ...list.map(x => connSpeeds[x.id] || 0));
    const pct = Math.min(100, (curSpeed / maxSpeed) * 100);
    card.innerHTML = `
      <div class="conn-card">
        <div class="conn-info">
          <div class="conn-name">${escapeHtml(c.name)}</div>
          <div class="conn-addr">${c.localAddress}</div>
          <div class="conn-speed" data-speed="${c.id}" style="color:var(--accent);font-weight:600;margin-top:6px;font-size:13px">${toSpeedValue(curSpeed)}</div>
          <div class="speed-bar" style="margin-top:8px"><div style="width:${pct}%"></div></div>
        </div>
        <div class="conn-stats">
          <span class="conn-badge ${c.enabled ? 'on' : 'off'}">${c.enabled ? 'Enabled' : 'Disabled'}</span>
          <input class="cap-input" type="number" min="0" step="0.1" value="${kbpsToInput(c.capKbps)}" data-cap placeholder="cap" />
          <span class="card-meta">${speedUnit()==='mbs'?'MB/s':'Mbps'}</span>
          <button class="btn sm ghost" data-a="toggle">${c.enabled ? 'Disable' : 'Enable'}</button>
        </div>
      </div>
    `;
    card.querySelector('[data-a="toggle"]').addEventListener('click', async () => {
      await window.api.connections.setEnabled(c.id, !c.enabled);
      await renderConnections();
    });
    const capInput = card.querySelector('[data-cap]');
    capInput.addEventListener('change', async () => {
      await window.api.connections.setCap(c.id, inputToKbps(capInput.value));
      toast('Speed cap updated');
    });
    el.appendChild(card);
  }
}
// ---- Refresh an expired link ----
let linkModalId = null;

function openLinkModal(d) {
  linkModalId = d.id;
  $('#linkModalFile').textContent = d.filename || 'this download';
  const saved = d.downloaded ? `${fmtBytes(d.downloaded)} of ${fmtBytes(d.totalSize)} already downloaded` : '';
  const remain = d.totalSize && d.downloaded ? `${fmtBytes(Math.max(0, d.totalSize - d.downloaded))} to go` : '';
  $('#linkModalNote').textContent = [saved, remain].filter(Boolean).join(' — ');
  $('#linkModalError').textContent = d.error && d.status !== 'completed' ? d.error : '';
  $('#linkModalInput').value = /^https?:\/\//i.test(d.url || '') ? d.url : '';
  $('#linkModal').classList.add('open');
  setTimeout(() => {
    const input = $('#linkModalInput');
    input.focus();
    input.select();
  }, 30);
}

function closeLinkModal() {
  $('#linkModal').classList.remove('open');
  linkModalId = null;
  $('#linkModalError').textContent = '';
}

$('#linkModalClose').addEventListener('click', closeLinkModal);
$('#linkModalCancel').addEventListener('click', closeLinkModal);
$('#linkModal').addEventListener('click', (e) => { if (e.target.id === 'linkModal') closeLinkModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#linkModal').classList.contains('open')) closeLinkModal();
});

$('#linkModalSave').addEventListener('click', async () => {
  const id = linkModalId;
  const url = $('#linkModalInput').value.trim();
  const errEl = $('#linkModalError');
  if (!/^https?:\/\//i.test(url)) { errEl.textContent = 'Enter a valid http(s) link.'; return; }
  const btn = $('#linkModalSave');
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  errEl.textContent = '';
  try {
    await window.api.downloads.refreshLink(id, url);
    closeLinkModal();
    await window.api.downloads.resume(id);
    toast('Link verified — resuming from where it stopped');
  } catch (e) {
    errEl.textContent = String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify & resume';
    await refreshDownloads();
  }
});
$('#linkModalInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#linkModalSave').click();
});
$('#linkModalInput').addEventListener('input', () => { $('#linkModalError').textContent = ''; });

// Settings
async function loadSettings() {
  settings = await window.api.settings.get();
  $('#setDownloadDir').value = settings.downloadDir || '';
  $('#setTempDir').value = settings.tempDir || '';
  $('#setMaxJobs').value = settings.maxConcurrentJobs || 3;
  $('#setMaxChunk').value = settings.maxChunkSizeMB || 512;
  $('#setTargetStreams').value = settings.targetStreams || 4;
  $('#setMaxConn').value = settings.maxConnectionsPerDownload || 4;
  $('#setMaxStreams').value = settings.maxStreamsPerConnection || 32;
  const unit = settings.speedUnit || 'mbps';
  $('#setSpeedUnit').value = unit;
  // convert stored kbps to selected unit for display
  const gKbps = parseInt(settings.globalSpeedLimitKbps || '0', 10) || 0;
  $('#setGlobalSpeed').value = unit === 'mbs' ? (gKbps / 8000) : (gKbps / 1000);
}
$('#setFolderBtn').addEventListener('click', async () => {
  const folder = await window.api.downloads.chooseFolder();
  if (folder) $('#setDownloadDir').value = folder;
});
$('#setTempDirBtn').addEventListener('click', async () => {
  const folder = await window.api.downloads.chooseFolder();
  if (folder) $('#setTempDir').value = folder;
});
$('#saveSettings').addEventListener('click', async () => {
  const unit = $('#setSpeedUnit').value;
  const gVal = parseFloat($('#setGlobalSpeed').value) || 0;
  const gKbps = unit === 'mbs' ? Math.round(gVal * 8000) : Math.round(gVal * 1000);
  try {
    await window.api.settings.set({
      downloadDir: $('#setDownloadDir').value.trim(),
      tempDir: $('#setTempDir').value.trim(),
      maxConcurrentJobs: $('#setMaxJobs').value,
      maxChunkSizeMB: $('#setMaxChunk').value,
      targetStreams: $('#setTargetStreams').value,
      maxConnectionsPerDownload: $('#setMaxConn').value,
      maxStreamsPerConnection: $('#setMaxStreams').value,
      globalSpeedLimitKbps: gKbps,
      speedUnit: unit
    });
  } catch (e) {
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
    return;
  }
  settings.speedUnit = unit;
  await loadSettings();
  toast('Settings saved');
});

// Events from main
window.api.on('download:added', () => refreshDownloads());
window.api.on('download:update', () => refreshDownloads());
window.api.on('download:progress', (p) => {
  const d = downloads.find(x => x.id === p.id);
  if (!d) { refreshDownloads(); return; }
  d.downloaded = p.downloaded;
  if (p.total) d.totalSize = p.total;
  if (Array.isArray(p.conns)) d.conns = p.conns;
  sampleSpeed(p.id, p.downloaded);
  updateCardLive(d);
});
window.api.on('download:assembling', (p) => {
  if (!p) return;
  const d = downloads.find((x) => x.id === p.id);
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  if (!d) { refreshDownloads(); return; }
  d.status = p.finished ? 'completed' : 'assembling';
  d.assemblePct = pct;
  updateCardLive(d);
});
window.api.on('download:removed', () => refreshDownloads());
window.api.on('connections:update', (list) => {
  if (Array.isArray(list)) connections = list;
  renderConnections(list);
});
window.api.on('speeds:update', (arr) => {
  for (const s of (arr || [])) {
    connSpeeds[s.id] = s.speed;
    const el = document.querySelector(`[data-speed="${s.id}"]`);
    if (el) el.textContent = toSpeedValue(s.speed);
  }
});

// Init
(async () => {
  await loadSettings();
  await renderConnections();
  await refreshDownloads();
})();
