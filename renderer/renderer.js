const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let settings = {};
let connections = [];
let downloads = [];
let queueState = { paused: false, active: 0, queued: 0, pausedJobs: 0, max: 3 };
let torrents = [];
let torrentQueue = { max: 2, active: 0, queued: 0, paused: 0, seeding: 0, held: false };
let updateState = null;
const grabCandidates = [];
const connSpeeds = {};
let onboarding = { slide: 1, choice: null, supported: false, needed: false };

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
// Torrent limits use their own unit (decimal KB/s or MB/s); storage stays kbps.
function torrentLimitUnit() {
  return settings.torrentLimitUnit === 'mb' ? 'mb' : 'kb';
}
function trimLimitNumber(n) {
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(6)));
}
function torrentKbpsToInput(kbps, unit) {
  const v = Number(kbps) || 0;
  return trimLimitNumber(unit === 'mb' ? v / 8000 : v / 8);
}
function torrentInputToKbps(value, unit) {
  const v = Math.max(0, parseFloat(value) || 0);
  return unit === 'mb' ? Math.round(v * 8000) : Math.round(v * 8);
}
function formatTorrentLimit(kbps, unit) {
  const v = Math.max(0, Number(kbps) || 0);
  if (!v) return 'unlimited';
  return `${torrentKbpsToInput(v, unit)} ${unit === 'mb' ? 'MB/s' : 'KB/s'}`;
}
function setTorrentLimitLabels(unit) {
  const label = unit === 'mb' ? 'MB/s' : 'KB/s';
  ['#torrentUploadUnitLabel', '#torrentDownloadUnitLabel',
    '#limitModalUploadUnitLabel', '#limitModalDownloadUnitLabel'].forEach((sel) => {
    const el = $(sel);
    if (el) el.textContent = label;
  });
}
let torrentLimitFormUnit = 'kb'; // unit currently shown in the torrent settings fields
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toast(msg, type = 'success') {
  const c = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 2800);
}

// First-run onboarding: feature tour plus the Start with Windows choice.
async function initOnboarding() {
  let status;
  try { status = await window.api.app.onboardingStatus(); } catch { return; }
  if (!status || !status.needed) return;
  onboarding.needed = true;
  onboarding.supported = !!status.supported;
  if (status.startWithWindows) setOnboardingChoice('yes');
  const overlay = $('#onboarding');
  if (!overlay) return;
  overlay.hidden = false;
  showOnboardingSlide(1);
}

function showOnboardingSlide(n) {
  onboarding.slide = n === 2 ? 2 : 1;
  $$('.onboarding-slide').forEach((el) => {
    el.hidden = Number(el.dataset.slide) !== onboarding.slide;
  });
  $$('.onboarding-dot').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.dot) === onboarding.slide);
  });
  const next = $('#onboardingNext');
  if (next) next.disabled = !onboarding.supported;
  const back = $('#onboardingBack');
  if (back) back.disabled = onboarding.slide !== 2;
  const cont = $('#onboardingContinue');
  if (cont) cont.disabled = !onboarding.choice;
}

function setOnboardingChoice(value) {
  onboarding.choice = value === 'yes' ? 'yes' : 'no';
  for (const [id, choice] of [['#onboardingYes', 'yes'], ['#onboardingNo', 'no']]) {
    const el = $(id);
    if (!el) continue;
    const selected = onboarding.choice === choice;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
  const cont = $('#onboardingContinue');
  if (cont) cont.disabled = false;
}

async function completeOnboarding() {
  if (!onboarding.choice) return;
  const btn = $('#onboardingContinue');
  if (btn) btn.disabled = true;
  try {
    await window.api.settings.set({
      startWithWindows: onboarding.choice === 'yes' ? '1' : '0',
      autoStartPromptShown: '1'
    });
    $('#onboarding').hidden = true;
    await loadSettings();
    if (onboarding.choice === 'no') {
      toast('You can enable Start with Windows later in Settings → Start Ultra Downloader when Windows starts', 'info');
    }
  } catch (e) {
    const overlay = $('#onboarding');
    if (overlay) overlay.hidden = false;
    if (btn) btn.disabled = false;
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''), 'error');
  }
}

$('#onboardingNext').addEventListener('click', () => showOnboardingSlide(2));
$('#onboardingBack').addEventListener('click', () => showOnboardingSlide(1));
$('#onboardingYes').addEventListener('click', () => setOnboardingChoice('yes'));
$('#onboardingNo').addEventListener('click', () => setOnboardingChoice('no'));
$('#onboardingContinue').addEventListener('click', () => { completeOnboarding(); });

const pageMeta = {
  downloads: ['Downloads', 'Manage your download queue'],
  torrents: ['Torrents', 'Download and seed BitTorrent content'],
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
function renderQueueState() {
  const el = $('#queueStatus');
  if (!el) return;
  const max = Number(queueState.max) || Number(settings.maxConcurrentJobs) || 3;
  let text = 'Downloads start automatically.';
  if (queueState.paused) {
    text = `Queue paused · ${queueState.active} running · ${queueState.queued} waiting`;
  } else if (queueState.queued > 0) {
    text = `${queueState.queued} waiting for a free slot · up to ${max} at once`;
  } else if (queueState.active > 0) {
    text = `${queueState.active} active · up to ${max} at once`;
  }
  el.textContent = text;
}

function updateStats() {
  const active = downloads.filter(d => d.status === 'downloading' || d.status === 'assembling').length;
  const queued = downloads.filter(d => d.status === 'queued' || d.status === 'paused').length;
  const done = downloads.filter(d => d.status === 'completed').length;
  $('#statActive').textContent = active;
  $('#statQueued').textContent = queued;
  $('#statDone').textContent = done;
  queueState.active = active;
  queueState.queued = downloads.filter(d => d.status === 'queued').length;
  queueState.pausedJobs = downloads.filter(d => d.status === 'paused').length;
  renderQueueState();
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
  if (d.status === 'queued') {
    return d.totalSize > 0
      ? `${fmtBytes(d.downloaded)} / ${fmtBytes(d.totalSize)} · waiting for a free slot`
      : 'waiting for a free slot';
  }
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
  }
  return bits.filter(Boolean).join(' · ');
}

function activeActions(d) {
  if (d.status === 'assembling') return '<span class="card-meta">finalizing…</span>';
  const canRefresh = d.status === 'failed' || d.status === 'paused' || d.status === 'cancelled';
  return `
    ${d.status === 'queued' ? '<button class="btn sm primary" data-a="start">Start now</button>' : ''}
    ${d.status === 'failed' ? '<button class="btn sm primary" data-a="start">Retry</button>' : ''}
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
      if (a === 'start') {
        const r = await window.api.downloads.start(d.id);
        if (r && r.queued) toast('Waiting for a free slot', 'info');
      }
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

// Queue controls
$('#pauseAll').addEventListener('click', async () => {
  const r = await window.api.downloads.pauseAll();
  await refreshDownloads();
  const n = (r && r.paused) || 0;
  toast(n ? `Paused ${n} download${n === 1 ? '' : 's'} — queue is on hold` : 'Queue is on hold');
});
$('#resumeAll').addEventListener('click', async () => {
  const r = await window.api.downloads.resumeAll();
  await refreshDownloads();
  const n = (r && r.resumed) || 0;
  toast(n ? `Resumed ${n} download${n === 1 ? '' : 's'}` : 'Queue resumed');
});

// Quick add
$('#quickAdd').addEventListener('click', async () => {
  const url = $('#quickUrl').value.trim();
  if (!url) return;
  await window.api.downloads.add(url, {});
  $('#quickUrl').value = '';
  await refreshDownloads();
  toast('Download added — starting automatically');
});
$('#quickUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#quickAdd').click(); });

// ---- Torrents --------------------------------------------------------------
function torrentFiles(t) {
  try {
    const list = JSON.parse(t && t.files ? t.files : '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function torrentPct(t) {
  return Math.max(0, Math.min(100, (Number(t.progress) || 0) * 100));
}

function torrentSpeed(kbps) {
  return toSpeedValue((Number(kbps) || 0) * 1000 / 8);
}

function torrentDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60), sec = total % 60;
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`;
  const h = Math.floor(m / 60), min = m % 60;
  if (h < 24) return min ? `${h}h ${min}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function torrentEta(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return 'done';
  return torrentDuration(value);
}

function torrentRatio(t) {
  const done = Number(t.downloaded) || 0;
  return done > 0 ? (Number(t.uploaded) || 0) / done : 0;
}

function torrentStatusClass(state) {
  if (state === 'seeding') return 'status-completed';
  if (state === 'checking') return 'status-downloading';
  if (state === 'error') return 'status-failed';
  return 'status-' + state;
}

function torrentMetaText(t) {
  const pct = torrentPct(t).toFixed(1) + '%';
  const size = `${fmtBytes(t.downloaded || 0)} / ${fmtBytes(t.totalSize || 0)}`;
  if (t.state === 'queued') return `${size} · waiting for a free slot`;
  if (t.state === 'checking') return `${size} · checking pieces · ${pct}`;
  if (t.state === 'seeding') {
    return `${fmtBytes(t.totalSize || t.downloaded || 0)} · seeding · ratio ${torrentRatio(t).toFixed(2)}`;
  }
  if (t.state === 'completed') return `${fmtBytes(t.totalSize || t.downloaded || 0)} · complete`;
  if (t.state === 'paused') return `${size} · ${pct} · paused`;
  if (t.state === 'error') return `${size} · ${pct} · stopped`;
  const upPayload = Math.max(0, Number(t.uploadPayloadKbps) || 0);
  return `${size} · ${pct} · ↓ ${torrentSpeed(t.downKbps)} · ↑ ${torrentSpeed(upPayload)}`;
}

function torrentCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? String(Math.trunc(n)) : '—';
}

function torrentLimitText(t) {
  const unit = torrentLimitUnit();
  const upEffective = Number(t.effectiveUploadLimitKbps);
  const downEffective = Number(t.effectiveDownloadLimitKbps);
  const up = upEffective > 0
    ? upEffective
    : (Number(t.uploadLimitKbps) > 0
      ? Number(t.uploadLimitKbps)
      : (Number(settings.torrentUploadLimitKbps) || 0));
  const down = downEffective > 0
    ? downEffective
    : (Number(t.downloadLimitKbps) > 0
      ? Number(t.downloadLimitKbps)
      : (Number(settings.torrentDownloadLimitKbps) || 0));
  const upText = up > 0 ? `↑ ${formatTorrentLimit(up, unit)}` : '↑ unlimited';
  const downText = down > 0 ? `↓ ${formatTorrentLimit(down, unit)}` : '↓ unlimited';
  return `${downText} · ${upText}`;
}

function torrentDetail(label, value, field, title) {
  const fieldAttr = field ? ` data-tf="${field}"` : '';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<div class="torrent-detail"${titleAttr}><span>${label}</span><b${fieldAttr}>${value}</b></div>`;
}

function torrentStatsHtml(t) {
  const chips = [];
  if (t.state !== 'completed') {
    const upPayload = Math.max(0, Number(t.uploadPayloadKbps) || 0);
    const upTotal = Math.max(0, Number(t.upKbps) || 0);
    const upTotalText = upTotal > upPayload + 0.001 ? ` (${torrentSpeed(upTotal)})` : '';
    chips.push(`<span class="conn-chip"><i style="background:var(--accent)"></i>↓ ${torrentSpeed(t.downKbps)}</span>`);
    chips.push(`<span class="conn-chip" title="Payload upload${upTotalText ? '; total in parentheses' : ''}"><i style="background:var(--success)"></i>↑ ${torrentSpeed(upPayload)}${upTotalText}</span>`);
  }
  chips.push(`<span class="conn-chip">${Number(t.peers) || 0} peers</span>`);
  chips.push(`<span class="conn-chip">${Number(t.seeds) || 0} seeds</span>`);
  const target = Number(settings.torrentRatioLimit) || Number(t.ratioLimit) || 0;
  const ratioText = target > 0
    ? `ratio ${torrentRatio(t).toFixed(2)} / ${target.toFixed(2)}`
    : `ratio ${torrentRatio(t).toFixed(2)}`;
  if (Number(t.uploaded) > 0 || target > 0) chips.push(`<span class="conn-chip">${ratioText}</span>`);
  if (t.state === 'downloading' && Number(t.etaSeconds) >= 0) {
    chips.push(`<span class="conn-chip">ETA ${torrentEta(t.etaSeconds)}</span>`);
  }

  const wantedDone = Number(t.totalWantedDone) || Number(t.downloaded) || 0;
  const wantedTotal = Number(t.totalSize) || Number(t.totalWanted) || 0;
  const allUp = Math.max(Number(t.allTimeUpload) || 0, Number(t.uploaded) || 0);
  const allDown = Math.max(Number(t.allTimeDownload) || 0, Number(t.downloaded) || 0);
  const pieces = `${torrentCount(t.pieces)} / ${torrentCount(t.piecesTotal)}`;
  const tracker = t.currentTracker || '';
  const complete = torrentCount(t.numComplete);
  const incomplete = torrentCount(t.numIncomplete);
  const known = torrentCount(t.listPeers);
  const copies = Number(t.distributedCopies) > 0 ? Number(t.distributedCopies).toFixed(2) : '—';
  const nextAnnounce = Number(t.nextAnnounceSec) > 0 ? torrentDuration(t.nextAnnounceSec) : '—';

  const details = [
    torrentDetail('ETA', (t.state === 'seeding' || t.state === 'completed') ? '—' : torrentEta(t.etaSeconds), 'eta'),
    torrentDetail('Ratio', ratioText.replace(/^ratio /, ''), 'ratio'),
    torrentDetail('Wanted', `${fmtBytes(wantedDone)} / ${fmtBytes(wantedTotal)}`, 'wanted'),
    torrentDetail('All-time up', fmtBytes(allUp), 'allup'),
    torrentDetail('All-time down', fmtBytes(allDown), 'alldown'),
    torrentDetail('Pieces', pieces, 'pieces'),
    torrentDetail('Tracker', escapeHtml(tracker || '—'), 'tracker', tracker),
    torrentDetail('Swarm', `${complete} seeds · ${incomplete} peers · ${known} known`, 'swarm'),
    torrentDetail('Connections', `${torrentCount(t.numConnections)} (${torrentCount(t.numUploads)} up)`, 'conns'),
    torrentDetail('Copies', copies, 'copies'),
    torrentDetail('Active', torrentDuration(t.activeSeconds), 'active'),
    torrentDetail('Seeding', torrentDuration(t.seedingSeconds), 'seeding'),
    torrentDetail('Limits', escapeHtml(torrentLimitText(t)), 'limits', torrentLimitText(t)),
    torrentDetail('Next announce', nextAnnounce, 'announce')
  ];
  return `<div class="conn-speeds">${chips.join('')}</div>` +
    `<div class="torrent-detail-grid">${details.join('')}</div>`;
}

function torrentActions(t) {
  const files = torrentFiles(t);
  const canPause = t.state === 'downloading' || t.state === 'checking' || t.state === 'seeding';
  const canResume = t.state === 'paused' || t.state === 'error' || t.state === 'completed';
  return `
    ${canPause ? '<button class="btn sm ghost" data-ta="pause">Pause</button>' : ''}
    ${canResume ? '<button class="btn sm primary" data-ta="resume">Resume</button>' : ''}
    <button class="btn sm ghost" data-ta="limits">Limits</button>
    <button class="btn sm ghost" data-ta="peers">Peers</button>
    <button class="btn sm ghost" data-ta="trackers">Update trackers</button>
    ${files.length ? '<button class="btn sm ghost" data-ta="files">Files</button>' : ''}
    ${t.saveDir ? '<button class="btn sm ghost" data-ta="folder">Folder</button>' : ''}
    <button class="btn sm danger" data-ta="remove">Remove</button>`;
}

function buildTorrentCard(t) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.torrentId = t.id;
  const pct = torrentPct(t);
  card.innerHTML = `
    <div class="card-head">
      <div class="card-title" title="${escapeHtml(t.source || '')}">${escapeHtml(t.name || t.source || 'Torrent')}</div>
      <span class="status-pill ${torrentStatusClass(t.state)}">${t.state}</span>
    </div>
    <div class="card-meta" data-tmeta>${escapeHtml(torrentMetaText(t))}</div>
    <div class="progress"><div data-tbar style="width:${pct.toFixed(1)}%"></div></div>
    <div class="torrent-stats" data-tstats>${torrentStatsHtml(t)}</div>
    ${t.error && t.state === 'error' ? `<div class="card-error">${escapeHtml(t.error)}</div>` : ''}
    <div class="card-row">
      <div class="card-meta" title="${escapeHtml(t.source || '')}">${escapeHtml(t.source || '')}</div>
      <div class="card-actions">${torrentActions(t)}</div>
    </div>
  `;
  card.querySelectorAll('[data-ta]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.ta;
      try {
        if (action === 'pause') await window.api.torrents.pause(t.id);
        if (action === 'resume') await window.api.torrents.resume(t.id);
        if (action === 'remove') {
          const result = await window.api.torrents.remove(t.id);
          if (result && result.cancelled) return;
        }
        if (action === 'folder') { if (t.saveDir) window.api.shell.openPath(t.saveDir); return; }
        if (action === 'files') { openFileModal(t); return; }
        if (action === 'limits') { openLimitModal(t); return; }
        if (action === 'peers') { openPeerModal(t); return; }
        if (action === 'trackers') {
          try {
            await window.api.torrents.updateTrackers(t.id);
            toast('Trackers updated');
          } catch (e) {
            toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''), 'error');
          }
          await refreshTorrents();
          return;
        }
        await refreshTorrents();
      } catch (e) {
        toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''), 'error');
      }
    });
  });
  return card;
}

function updateTorrentStats() {
  const el = $('#torrentQueueStatus');
  if (!el) return;
  const max = Number(torrentQueue.max) || Number(settings.torrentMaxActive) || 2;
  if (torrentQueue.held) {
    el.textContent = `Torrent queue paused · ${torrentQueue.paused} stopped · Resume all to continue`;
    return;
  }
  const bits = [];
  if (torrentQueue.active > 0) bits.push(`${torrentQueue.active} active · up to ${max} at once`);
  if (torrentQueue.queued > 0) bits.push(`${torrentQueue.queued} waiting`);
  if (torrentQueue.seeding > 0) bits.push(`${torrentQueue.seeding} seeding`);
  if (torrentQueue.paused > 0) bits.push(`${torrentQueue.paused} paused`);
  el.textContent = bits.length ? bits.join(' · ') : 'Torrents start automatically.';
}

function renderTorrents() {
  const el = $('#torrentList');
  if (!el) return;
  el.innerHTML = '';
  if (torrents.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">🧲</div><div>No torrents yet. Paste a magnet link or a .torrent URL above, or open a .torrent file.</div></div>';
  } else {
    for (const t of torrents) el.appendChild(buildTorrentCard(t));
  }
  updateTorrentStats();
}

async function refreshTorrents() {
  try {
    torrents = await window.api.torrents.list();
  } catch (e) {
    console.error('torrent list:', e);
    return;
  }
  renderTorrents();
  try {
    const state = await window.api.torrents.queueState();
    if (state) torrentQueue = { ...torrentQueue, ...state };
  } catch {}
  updateTorrentStats();
}

function updateTorrentCardLive(p) {
  const t = torrents.find((x) => x.id === p.id);
  if (!t) { refreshTorrents(); return; }
  Object.assign(t, {
    progress: p.progress,
    downloaded: p.downloaded,
    totalSize: p.totalSize,
    uploaded: p.uploaded,
    downKbps: p.downKbps,
    upKbps: p.upKbps,
    uploadPayloadKbps: p.uploadPayloadKbps,
    downloadPayloadKbps: p.downloadPayloadKbps,
    peers: p.peers,
    seeds: p.seeds,
    pieces: p.pieces,
    piecesTotal: p.piecesTotal,
    etaSeconds: p.etaSeconds,
    totalDone: p.totalDone,
    totalWantedDone: p.totalWantedDone,
    allTimeUpload: p.allTimeUpload,
    allTimeDownload: p.allTimeDownload,
    currentTracker: p.currentTracker,
    nextAnnounceSec: p.nextAnnounceSec,
    numComplete: p.numComplete,
    numIncomplete: p.numIncomplete,
    listPeers: p.listPeers,
    distributedCopies: p.distributedCopies,
    numConnections: p.numConnections,
    numUploads: p.numUploads,
    activeSeconds: p.activeSeconds,
    seedingSeconds: p.seedingSeconds,
    effectiveUploadLimitKbps: p.uploadLimitKbps,
    effectiveDownloadLimitKbps: p.downloadLimitKbps,
  });
  const card = document.querySelector(`#torrentList .card[data-torrent-id="${p.id}"]`);
  if (!card) { renderTorrents(); return; }
  const meta = card.querySelector('[data-tmeta]');
  if (meta) meta.textContent = torrentMetaText(t);
  const bar = card.querySelector('[data-tbar]');
  if (bar) bar.style.width = torrentPct(t).toFixed(1) + '%';
  const stats = card.querySelector('[data-tstats]');
  if (stats) stats.innerHTML = torrentStatsHtml(t);
  const pill = card.querySelector('.status-pill');
  if (pill) {
    pill.textContent = t.state;
    pill.className = `status-pill ${torrentStatusClass(t.state)}`;
  }
}

$('#addTorrent').addEventListener('click', async () => {
  const source = $('#quickMagnet').value.trim();
  if (!source) return;
  const btn = $('#addTorrent');
  btn.disabled = true;
  try {
    await window.api.torrents.add(source);
    $('#quickMagnet').value = '';
    await refreshTorrents();
    toast('Torrent added');
  } catch (e) {
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''), 'error');
  } finally {
    btn.disabled = false;
  }
});
$('#torrentBrowseBtn').addEventListener('click', async () => {
  try {
    const file = await window.api.torrents.chooseFile();
    if (!file) return;
    $('#quickMagnet').value = file;
    $('#quickMagnet').focus();
  } catch (e) {
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''), 'error');
  }
});
$('#quickMagnet').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addTorrent').click(); });

$('#pauseAllTorrents').addEventListener('click', async () => {
  const active = torrents.filter((t) => ['downloading', 'checking', 'seeding'].includes(t.state));
  if (!active.length && !torrents.some((t) => t.state === 'queued')) {
    toast('No active or waiting torrents', 'info');
    return;
  }
  const r = await window.api.torrents.pauseAll();
  await refreshTorrents();
  toast(`Torrent queue paused${r && r.paused ? ` · ${r.paused} stopped` : ''}`);
});
$('#resumeAllTorrents').addEventListener('click', async () => {
  const r = await window.api.torrents.resumeAll();
  await refreshTorrents();
  const n = (r && r.resumed) || 0;
  toast(n ? `Resumed ${n} torrent${n === 1 ? '' : 's'}` : 'Torrent queue resumed');
});

// ---- Torrent file selection ----
let fileModalId = null;
let fileModalFiles = [];

function openFileModal(t) {
  const files = torrentFiles(t);
  if (!files.length) {
    toast('The file list appears after the torrent metadata arrives', 'info');
    return;
  }
  fileModalId = t.id;
  fileModalFiles = files;
  const list = $('#fileModalList');
  list.innerHTML = '';
  for (const file of files) {
    const row = document.createElement('label');
    row.className = 'torrent-file-row';
    row.innerHTML = `
      <input type="checkbox" data-file-index="${file.index}" ${Number(file.priority) !== 0 ? 'checked' : ''} />
      <span class="torrent-file-name">${escapeHtml(file.name)}</span>
      <span class="torrent-file-size">${fmtBytes(file.size)}</span>
    `;
    list.appendChild(row);
  }
  $('#fileModalError').textContent = '';
  $('#fileModal').classList.add('open');
}

function closeFileModal() {
  $('#fileModal').classList.remove('open');
  fileModalId = null;
  fileModalFiles = [];
  $('#fileModalError').textContent = '';
}

$('#fileModalClose').addEventListener('click', closeFileModal);
$('#fileModalCancel').addEventListener('click', closeFileModal);
$('#fileModal').addEventListener('click', (e) => { if (e.target.id === 'fileModal') closeFileModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#fileModal').classList.contains('open')) closeFileModal();
});

$('#fileModalSave').addEventListener('click', async () => {
  const id = fileModalId;
  if (id == null) return;
  const boxes = $$('#fileModalList input[type=checkbox]');
  const priorities = [];
  boxes.forEach((box, i) => {
    priorities[fileModalFiles[i].index] = box.checked ? 4 : 0;
  });
  if (!priorities.some((p) => p > 0)) {
    $('#fileModalError').textContent = 'Select at least one file.';
    return;
  }
  const btn = $('#fileModalSave');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  $('#fileModalError').textContent = '';
  try {
    await window.api.torrents.setFilePriorities(id, priorities);
    closeFileModal();
    await refreshTorrents();
    toast('File selection saved');
  } catch (e) {
    $('#fileModalError').textContent = String((e && e.message) || e)
      .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
});

// ---- Torrent speed limits and peers ----
let limitModalId = null;
let limitModalUnit = 'kb';
let limitModalTorrent = null;
// Only fields the user actually changed are sent on save. An untouched field
// goes as null so its stored per-torrent override is kept.
let limitModalTouched = { upload: false, download: false };
let peerModalId = null;

function limitModalEffectiveText(t) {
  const unit = limitModalUnit;
  const globalUp = Number(settings.torrentUploadLimitKbps) || 0;
  const globalDown = Number(settings.torrentDownloadLimitKbps) || 0;
  const upOverride = Number(t.uploadLimitKbps) || 0;
  const downOverride = Number(t.downloadLimitKbps) || 0;
  const liveUp = Number(t.effectiveUploadLimitKbps);
  const liveDown = Number(t.effectiveDownloadLimitKbps);
  const describe = (override, global, live) => {
    const value = live > 0 ? live : (override > 0 ? override : global);
    if (!(value > 0)) return 'unlimited';
    const source = override > 0
      ? 'per-torrent override'
      : (global > 0 ? 'inherited from global' : 'applied by the engine');
    return `${formatTorrentLimit(value, unit)} (${source})`;
  };
  return `Currently effective: ↓ ${describe(downOverride, globalDown, liveDown)} · ↑ ${describe(upOverride, globalUp, liveUp)}`;
}

function openLimitModal(t) {
  limitModalId = t.id;
  limitModalTorrent = t;
  limitModalUnit = torrentLimitUnit();
  limitModalTouched = { upload: false, download: false };
  $('#limitModalName').textContent = t.name || t.source || 'this torrent';
  $('#limitModalUnit').value = limitModalUnit;
  $('#limitModalUpload').value = torrentKbpsToInput(Number(t.uploadLimitKbps) || 0, limitModalUnit);
  $('#limitModalDownload').value = torrentKbpsToInput(Number(t.downloadLimitKbps) || 0, limitModalUnit);
  setTorrentLimitLabels(limitModalUnit);
  $('#limitModalEffective').textContent = limitModalEffectiveText(t);
  $('#limitModalError').textContent = '';
  $('#limitModal').classList.add('open');
}

function closeLimitModal() {
  $('#limitModal').classList.remove('open');
  limitModalId = null;
  limitModalTorrent = null;
  limitModalTouched = { upload: false, download: false };
  $('#limitModalError').textContent = '';
}

$('#limitModalClose').addEventListener('click', closeLimitModal);
$('#limitModalCancel').addEventListener('click', closeLimitModal);
$('#limitModal').addEventListener('click', (e) => { if (e.target.id === 'limitModal') closeLimitModal(); });
$('#limitModalUpload').addEventListener('input', () => { limitModalTouched.upload = true; });
$('#limitModalDownload').addEventListener('input', () => { limitModalTouched.download = true; });
$('#limitModalInherit').addEventListener('click', () => {
  // 0 on a torrent means "use the global limit", not "unlimited".
  $('#limitModalUpload').value = 0;
  $('#limitModalDownload').value = 0;
  limitModalTouched = { upload: true, download: true };
});
// Switching the unit converts the entered speeds, so the limit keeps its value.
$('#limitModalUnit').addEventListener('change', () => {
  const unit = $('#limitModalUnit').value === 'mb' ? 'mb' : 'kb';
  if (unit === limitModalUnit) return;
  for (const sel of ['#limitModalUpload', '#limitModalDownload']) {
    const kbps = torrentInputToKbps($(sel).value, limitModalUnit);
    $(sel).value = torrentKbpsToInput(kbps, unit);
  }
  limitModalUnit = unit;
  setTorrentLimitLabels(unit);
  if (limitModalTorrent) {
    $('#limitModalEffective').textContent = limitModalEffectiveText(limitModalTorrent);
  }
});

$('#limitModalSave').addEventListener('click', async () => {
  const id = limitModalId;
  if (id == null) return;
  const btn = $('#limitModalSave');
  const unit = $('#limitModalUnit').value === 'mb' ? 'mb' : 'kb';
  // null keeps the stored override for a field the user did not edit. 0 is an
  // explicit "inherit the global limit" only when that field was edited.
  const uploadKbps = limitModalTouched.upload
    ? torrentInputToKbps($('#limitModalUpload').value, unit) : null;
  const downloadKbps = limitModalTouched.download
    ? torrentInputToKbps($('#limitModalDownload').value, unit) : null;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  $('#limitModalError').textContent = '';
  try {
    await window.api.torrents.setLimits(id, uploadKbps, downloadKbps);
    closeLimitModal();
    await refreshTorrents();
    toast('Speed limits saved');
  } catch (e) {
    $('#limitModalError').textContent = String((e && e.message) || e)
      .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save limits';
  }
});

const PEER_FLAG_BITS = [
  [1 << 0, 'interested'], [1 << 1, 'choked'], [1 << 2, 'peer interested'],
  [1 << 3, 'peer choked'], [1 << 4, 'ext'], [1 << 5, 'outgoing'],
  [1 << 7, 'connecting'], [1 << 10, 'seed'], [1 << 12, 'snubbed'],
  [1 << 13, 'upload only'], [1 << 16, 'i2p'], [1 << 17, 'uTP'],
  [1 << 18, 'TLS'], [1 << 19, 'RC4'], [1 << 20, 'encrypted']
];
const PEER_SOURCE_BITS = [
  [1 << 0, 'tracker'], [1 << 1, 'DHT'], [1 << 2, 'PEX'],
  [1 << 3, 'LSD'], [1 << 4, 'resume'], [1 << 5, 'incoming']
];

function peerBitsText(value, bits) {
  const flags = Number(value) || 0;
  const out = bits.filter(([bit]) => (flags & bit) !== 0).map(([, label]) => label);
  return out.join(' · ');
}

function peerFlagsText(value) {
  return peerBitsText(value, PEER_FLAG_BITS);
}

function peerSourceText(value) {
  return peerBitsText(value, PEER_SOURCE_BITS);
}

function peerConnectionText(value) {
  const type = Number(value) || 0;
  if (type & 4) return 'HTTP seed';
  if (type & 2) return 'web seed';
  return 'BitTorrent';
}

function peerRowHtml(p) {
  const host = String(p.ip || '');
  const ip = host ? `${host.includes(':') ? '[' + host + ']' : host}${p.port ? ':' + p.port : ''}` : '—';
  const progress = `${((Number(p.progress) || 0) * 100).toFixed(1)}%`;
  const flags = peerFlagsText(p.flags);
  const source = peerSourceText(p.source);
  const connection = peerConnectionText(p.connectionType);
  const totalDown = fmtBytes(p.totalDownload);
  const totalUp = fmtBytes(p.totalUpload);
  const local = p.localAddress ? ` · local ${p.localAddress}` : '';
  const title = `${ip} · ${progress} · ${flags || 'no flags'} · ${source || 'unknown source'} · ${connection} · RTT ${torrentCount(p.rtt)} ms · total ↓ ${totalDown} · ↑ ${totalUp}${local}`;
  return `
    <div class="peer-row" title="${escapeHtml(title)}">
      <div class="peer-ip">${escapeHtml(ip)}${p.seed ? ' <span class="peer-seed">seed</span>' : ''}</div>
      <div class="peer-client">${escapeHtml(p.client || 'Unknown')}</div>
      <div class="peer-rates">↓ ${torrentSpeed(p.downKbps)} · ↑ ${torrentSpeed(p.upKbps)}</div>
      <div class="peer-progress">${progress} · ${torrentCount(p.pieces)} pcs</div>
      <div class="peer-flags">${escapeHtml(flags || source || '—')}</div>
    </div>`;
}

async function openPeerModal(t) {
  peerModalId = t.id;
  $('#peerModalName').textContent = t.name || t.source || 'this torrent';
  $('#peerModalError').textContent = '';
  $('#peerModalList').innerHTML = '<div class="peer-empty">Loading peers…</div>';
  $('#peerModal').classList.add('open');
  try {
    const result = await window.api.torrents.getPeerList(t.id);
    if (peerModalId !== t.id) return;
    const peers = Array.isArray(result && result.peers) ? result.peers : [];
    if (!peers.length) {
      $('#peerModalList').innerHTML =
        '<div class="peer-empty">No connected peers right now. The tracker or DHT may still be finding some.</div>';
      return;
    }
    $('#peerModalList').innerHTML = peers.map(peerRowHtml).join('');
  } catch (e) {
    if (peerModalId !== t.id) return;
    $('#peerModalList').innerHTML = '';
    $('#peerModalError').textContent = String((e && e.message) || e)
      .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
  }
}

function closePeerModal() {
  $('#peerModal').classList.remove('open');
  peerModalId = null;
  $('#peerModalList').innerHTML = '';
  $('#peerModalError').textContent = '';
}

$('#peerModalClose').addEventListener('click', closePeerModal);
$('#peerModal').addEventListener('click', (e) => { if (e.target.id === 'peerModal') closePeerModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#limitModal').classList.contains('open')) closeLimitModal();
  if ($('#peerModal').classList.contains('open')) closePeerModal();
});


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
  $('#torrentSaveDir').value = settings.torrentSaveDir || '';
  $('#torrentMaxActive').value = settings.torrentMaxActive || 2;
  $('#torrentPort').value = settings.torrentPort || 6881;
  const tUpKbps = parseInt(settings.torrentUploadLimitKbps || '0', 10) || 0;
  const tDownKbps = parseInt(settings.torrentDownloadLimitKbps || '0', 10) || 0;
  const tUnit = torrentLimitUnit();
  $('#torrentLimitUnit').value = tUnit;
  $('#torrentUploadLimit').value = torrentKbpsToInput(tUpKbps, tUnit);
  $('#torrentDownloadLimit').value = torrentKbpsToInput(tDownKbps, tUnit);
  setTorrentLimitLabels(tUnit);
  torrentLimitFormUnit = tUnit;
  $('#torrentSeeding').checked = String(settings.torrentSeeding || '1') === '1';
  $('#torrentRatioLimit').value = settings.torrentRatioLimit || 0;
  $('#torrentUseAdapters').checked = String(settings.torrentUseAdapters || '1') === '1';
  torrentQueue.max = parseInt(settings.torrentMaxActive || '2', 10) || 2;
  $('#setAutoUpdates').checked = String(settings.autoCheckUpdates || '1') === '1';
  $('#setAutoStart').checked = String(settings.startWithWindows || '0') === '1';
  try {
    const info = await window.api.app.info();
    if (info.platform !== 'win32' || !info.packaged) {
      $('#setAutoStart').disabled = true;
      $('#setAutoStartHint').textContent = 'Available in the installed Windows app.';
    }
  } catch {}
  queueState.max = parseInt(settings.maxConcurrentJobs || '3', 10) || 3;
  renderQueueState();
}
$('#setFolderBtn').addEventListener('click', async () => {
  const folder = await window.api.downloads.chooseFolder();
  if (folder) $('#setDownloadDir').value = folder;
});
$('#setTempDirBtn').addEventListener('click', async () => {
  const folder = await window.api.downloads.chooseFolder();
  if (folder) $('#setTempDir').value = folder;
});
$('#torrentSaveDirBtn').addEventListener('click', async () => {
  const folder = await window.api.torrents.chooseFolder();
  if (folder) $('#torrentSaveDir').value = folder;
});
// Changing the settings unit converts the fields, so the speed keeps its value.
$('#torrentLimitUnit').addEventListener('change', () => {
  const unit = $('#torrentLimitUnit').value === 'mb' ? 'mb' : 'kb';
  if (unit === torrentLimitFormUnit) return;
  for (const sel of ['#torrentUploadLimit', '#torrentDownloadLimit']) {
    const kbps = torrentInputToKbps($(sel).value, torrentLimitFormUnit);
    $(sel).value = torrentKbpsToInput(kbps, unit);
  }
  torrentLimitFormUnit = unit;
  setTorrentLimitLabels(unit);
});
$('#saveTorrentSettings').addEventListener('click', async () => {
  const tUnit = $('#torrentLimitUnit').value === 'mb' ? 'mb' : 'kb';
  const upKbps = torrentInputToKbps($('#torrentUploadLimit').value, tUnit);
  const downKbps = torrentInputToKbps($('#torrentDownloadLimit').value, tUnit);
  const port = parseInt($('#torrentPort').value, 10) || 6881;
  if (port < 1024 || port > 65535) {
    toast('Choose a listening port between 1024 and 65535', 'error');
    return;
  }
  try {
    await window.api.settings.set({
      torrentSaveDir: $('#torrentSaveDir').value.trim(),
      torrentMaxActive: $('#torrentMaxActive').value,
      torrentPort: String(port),
      torrentUploadLimitKbps: String(upKbps),
      torrentDownloadLimitKbps: String(downKbps),
      torrentLimitUnit: tUnit,
      torrentSeeding: $('#torrentSeeding').checked ? '1' : '0',
      torrentRatioLimit: $('#torrentRatioLimit').value,
      torrentUseAdapters: $('#torrentUseAdapters').checked ? '1' : '0'
    });
  } catch (e) {
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
    return;
  }
  await loadSettings();
  await refreshTorrents();
  toast('Torrent settings saved');
});
function renderUpdateBanner(s) {
  const banner = $('#updateBanner');
  if (!banner) return;
  const version = s.version || '';
  const dismissed = String(settings.updateBannerDismissed || '');
  const visible = s.state === 'downloading' ||
    ((s.state === 'available' || s.state === 'ready') && version && version !== dismissed);
  if (!visible) { banner.hidden = true; return; }
  banner.hidden = false;
  const text = $('#updateBannerText');
  if (s.state === 'downloading') {
    text.textContent = `Downloading update${version ? ' ' + version : ''}…`;
  } else if (s.state === 'ready') {
    text.textContent = `Version ${version || 'update'} is ready to install.`;
  } else {
    text.textContent = `Ultra Downloader ${version || 'update'} is available to download.`;
  }
  $('#updateBannerDownload').hidden = s.state !== 'available';
  $('#updateBannerInstall').hidden = s.state !== 'ready';
  const wrap = $('#updateBannerProgressWrap');
  if (s.state === 'downloading') {
    const pct = Math.max(0, Math.min(100, Number(s.percent) || 0));
    wrap.hidden = false;
    $('#updateBannerBar').style.width = pct.toFixed(1) + '%';
    $('#updateBannerPercent').textContent = Math.round(pct) + '%';
  } else {
    wrap.hidden = true;
  }
}

function renderUpdateStatus(s) {
  if (!s) return;
  updateState = s;
  $('#updateStatusText').textContent = s.message || 'No update check yet.';
  const progress = $('#updateProgress');
  if (s.state === 'downloading' && Number(s.percent) > 0) {
    progress.style.display = 'block';
    progress.value = Number(s.percent) || 0;
  } else {
    progress.style.display = 'none';
  }
  $('#installUpdateBtn').style.display = s.state === 'ready' ? 'inline-flex' : 'none';
  renderUpdateBanner(s);
}

$('#setAutoUpdates').addEventListener('change', async () => {
  const enabled = $('#setAutoUpdates').checked ? '1' : '0';
  try {
    await window.api.settings.set({ autoCheckUpdates: enabled });
    settings.autoCheckUpdates = enabled;
    toast(enabled === '1' ? 'Update checks enabled at startup' : 'Startup update checks disabled');
  } catch (e) {
    $('#setAutoUpdates').checked = !$('#setAutoUpdates').checked;
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
  }
});
$('#setAutoStart').addEventListener('change', async () => {
  const enabled = $('#setAutoStart').checked ? '1' : '0';
  try {
    await window.api.settings.set({ startWithWindows: enabled });
    settings.startWithWindows = enabled;
    toast(enabled === '1'
      ? 'Windows will start Ultra Downloader in the tray'
      : 'Ultra Downloader will not start with Windows');
  } catch (e) {
    $('#setAutoStart').checked = !$('#setAutoStart').checked;
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
  }
});
$('#checkUpdatesBtn').addEventListener('click', async () => {
  try {
    const s = await window.api.updater.check();
    renderUpdateStatus(s);
  } catch (e) {
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
  }
});
$('#installUpdateBtn').addEventListener('click', async () => {
  try {
    const r = await window.api.updater.promptInstall();
    if (r && r.error) toast(r.error, 'info');
  } catch (e) {
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
  }
});
$('#openReleasesBtn').addEventListener('click', () => window.api.updater.openReleases());

// Update banner (visible on every tab while an update is available/ready)
$('#updateBannerDownload').addEventListener('click', async () => {
  try {
    const r = await window.api.updater.download();
    if (r && r.error) toast(r.error, 'info');
  } catch (e) {
    toast(String((e && e.message) || e));
  }
});
$('#updateBannerInstall').addEventListener('click', async () => {
  try {
    const r = await window.api.updater.promptInstall();
    if (r && r.error) toast(r.error, 'info');
  } catch (e) {
    toast(String((e && e.message) || e));
  }
});
$('#updateBannerReleases').addEventListener('click', () => window.api.updater.openReleases());
$('#updateBannerDismiss').addEventListener('click', async () => {
  const version = updateState && updateState.version;
  if (version) {
    settings.updateBannerDismissed = version;
    try { await window.api.settings.set({ updateBannerDismissed: version }); } catch {}
  }
  $('#updateBanner').hidden = true;
});
$('#getFirefoxExtension').addEventListener('click', async () => {
  try {
    const r = await window.api.firefox.openExtension();
    if (!r || !r.opened) toast('Could not open the extension page');
  } catch (e) {
    toast(String((e && e.message) || e));
  }
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
window.api.on('queue:update', (s) => {
  if (!s) return;
  queueState = { ...queueState, ...s };
  renderQueueState();
});
window.api.on('torrent:added', () => refreshTorrents());
window.api.on('torrent:update', () => refreshTorrents());
window.api.on('torrent:progress', (p) => {
  if (!p) return;
  updateTorrentCardLive(p);
});
window.api.on('torrent:removed', () => refreshTorrents());
window.api.on('torrent:error', (p) => {
  if (p && p.error) toast(`Torrent: ${p.error}`, 'error');
  refreshTorrents();
});
window.api.on('torrent:queue', (s) => {
  if (!s) return;
  torrentQueue = { ...torrentQueue, ...s };
  updateTorrentStats();
});
window.api.on('update:status', (s) => renderUpdateStatus(s));
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
  await initOnboarding();
  await renderConnections();
  await refreshDownloads();
  await refreshTorrents();
  try {
    const qs = await window.api.downloads.queueState();
    if (qs) { queueState = { ...queueState, ...qs }; renderQueueState(); }
  } catch {}
  try {
    const tq = await window.api.torrents.queueState();
    if (tq) { torrentQueue = { ...torrentQueue, ...tq }; updateTorrentStats(); }
  } catch {}
  try {
    const info = await window.api.app.info();
    $('#appVersion').textContent = info && info.version ? `Ready · v${info.version}` : 'Ready';
  } catch {}
  try {
    renderUpdateStatus(await window.api.updater.status());
  } catch {}
})();
