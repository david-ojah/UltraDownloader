'use strict';

// Torrent queue and engine integration.
//
// The actual BitTorrent work happens in the native libtorrent addon. This
// module owns the queue, maps libtorrent states onto the app's states, keeps
// the torrents table up to date and forwards events to the renderer:
//
//   queued -> downloading -> checking -> seeding -> completed
//                                  \-> paused / error
//
// Seeding is on by default and continues until the user pauses or removes the
// torrent, or until the configured share ratio is reached.

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { app } = require('electron');

const db = require('./db');
const connections = require('./connections');
const { TorrentEngine } = require('./torrent-engine/engine');
const adapters = require('./torrent-engine/adapters');

const POLL_MS = 2000;
const ACTIVE_STATES = new Set(['downloading', 'checking']);
const POLLED_STATES = new Set(['downloading', 'checking', 'seeding']);

let send = () => {};
let engine = null;
let settings = {};
let pollTimer = null;
let polling = false;
let pumping = false;
let interfacesReady = false;
let queueHeld = false;
let lastQueueJson = '';
const lastStateById = new Map();
const lastFileCountById = new Map();

function emit(channel, payload) {
  try { send(channel, payload); } catch {}
}

function maxActive() {
  return Math.max(1, parseInt(settings.torrentMaxActive, 10) || 2);
}

function seedingAllowed(row) {
  return String(settings.torrentSeeding || '1') === '1' && Number(row && row.seeding) !== 0;
}

function init(sendFn) {
  send = typeof sendFn === 'function' ? sendFn : () => {};
  settings = db.getSettings();
  interfacesReady = false;
  queueHeld = false;
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      poll().catch((e) => console.error('torrent poll:', e && e.message ? e.message : e));
    }, POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }
}

async function ensureEngine() {
  if (engine) return engine;
  const next = new TorrentEngine();
  // The session may be created later by startTorrent/setInterfaces; store the
  // saved global limits first so base_settings_pack uses them.
  await next.setSessionLimits(
    limitKbps(settings.torrentUploadLimitKbps),
    limitKbps(settings.torrentDownloadLimitKbps)
  );
  engine = next;
  interfacesReady = false;
  return engine;
}

// Bind the libtorrent session to the adapters the user enabled. This must run
// before the first startTorrent: applying listen settings to a live session
// was unreliable on Windows with libtorrent 2.0.11.
async function ensureInterfaces() {
  if (interfacesReady || !engine) return;
  if (String(settings.torrentUseAdapters || '1') === '1') {
    const enabled = connections.enabledConnections();
    const addresses = [...new Set(enabled.map((c) => c.localAddress).filter(Boolean))];
    if (addresses.length) {
      let guids = [];
      try {
        const list = await adapters.listAdapters();
        const byAddress = new Map(list.map((a) => [a.address, a.guid]));
        guids = addresses.map((a) => byAddress.get(a) || '');
      } catch (e) {
        console.error('torrent adapters:', e && e.message ? e.message : e);
      }
      const options = { port: parseInt(settings.torrentPort, 10) || 6881 };
      if (guids.length === addresses.length && guids.every(Boolean)) options.guids = guids;
      try {
        await engine.setInterfaces(addresses, options);
      } catch (e) {
        // Keep going with the default listener rather than failing the add.
        console.error('torrent interfaces:', e && e.message ? e.message : e);
      }
    }
  }
  interfacesReady = true;
}

function resolveSaveDir(opts = {}) {
  let dir = String(opts.saveDir || settings.torrentSaveDir || '').trim();
  if (!dir) dir = String(settings.downloadDir || '').trim();
  if (!dir) dir = path.join(app.getPath('downloads'), 'UltraDownloader');
  dir = path.resolve(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeSource(source) {
  const raw = String(source || '').trim();
  if (!raw) throw new Error('A magnet link or .torrent is required');
  if (/^magnet:\?/i.test(raw)) return { source: raw, kind: 'magnet' };
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('Invalid .torrent URL'); }
    if (!/\.torrent$/i.test(url.pathname)) throw new Error('Expected a .torrent URL or a magnet link');
    return { source: url.toString(), kind: 'url' };
  }
  if (/^file:\/\//i.test(raw)) {
    let file;
    try { file = fileURLToPath(raw); } catch { throw new Error('Invalid .torrent file path'); }
    if (!fs.existsSync(file)) throw new Error('The .torrent file no longer exists');
    return { source: file, kind: 'file' };
  }
  const file = path.resolve(raw);
  if (fs.existsSync(file) && /\.torrent$/i.test(file)) return { source: file, kind: 'file' };
  throw new Error('Expected a magnet link, a .torrent URL or a .torrent file');
}

function downloadTorrentFile(url) {
  return new Promise((resolve, reject) => {
    const target = path.join(
      app.getPath('temp'),
      `ud-torrent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.torrent`
    );
    const follow = (current, redirects) => {
      const mod = /^https:/i.test(current) ? https : http;
      const req = mod.get(current, {
        timeout: 30000,
        headers: { 'User-Agent': 'UltraDownloader' },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 5) { reject(new Error('Too many redirects fetching the .torrent')); return; }
          let next;
          try { next = new URL(res.headers.location, current).toString(); } catch {
            reject(new Error('Invalid redirect fetching the .torrent'));
            return;
          }
          follow(next, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Could not fetch the .torrent (HTTP ${res.statusCode})`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) {
            req.destroy(new Error('The .torrent file is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            fs.writeFileSync(target, Buffer.concat(chunks));
            resolve(target);
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Timed out fetching the .torrent')));
      req.on('error', reject);
    };
    follow(url, 0);
  });
}

function limitKbps(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function applyLimits(row) {
  if (!engine || !row || !row.infoHash) return;
  const upload = limitKbps(row.uploadLimitKbps) || limitKbps(settings.torrentUploadLimitKbps);
  const download = limitKbps(row.downloadLimitKbps) || limitKbps(settings.torrentDownloadLimitKbps);
  try {
    await engine.setLimits(row.infoHash, upload, download);
  } catch {}
}

async function startRow(row) {
  const native = await ensureEngine();
  await ensureInterfaces();
  let local = row.source;
  let temp = null;
  if (/^https?:\/\//i.test(local)) {
    temp = await downloadTorrentFile(local);
    local = temp;
  }
  try {
    const result = await native.startTorrent(local, row.saveDir);
    if (!result || !result.infoHash) throw new Error('torrent engine did not return an info hash');
    await applyLimits({ ...row, infoHash: result.infoHash });
    const patch = { infoHash: result.infoHash };
    if (result.name) patch.name = result.name;
    if (result.saveDir) patch.saveDir = result.saveDir;
    db.updateTorrent(row.id, patch);
    if (row.files) {
      try {
        const stored = JSON.parse(row.files);
        if (Array.isArray(stored) && stored.length) {
          await native.setFilePriorities(result.infoHash, stored.map((f) => Number(f.priority) || 0));
        }
      } catch {}
    }
    return result;
  } finally {
    if (temp) {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

async function add(source, opts = {}) {
  const normalized = normalizeSource(source);
  const saveDir = resolveSaveDir(opts);
  const native = await ensureEngine();
  await ensureInterfaces();

  let local = normalized.source;
  let temp = null;
  if (normalized.kind === 'url') {
    temp = await downloadTorrentFile(normalized.source);
    local = temp;
  }
  let result;
  try {
    result = await native.startTorrent(local, saveDir);
  } finally {
    if (temp) {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
  if (!result || !result.infoHash) throw new Error('The torrent engine did not return an info hash');

  let row = db.getTorrentByHash(result.infoHash);
  let created = false;
  if (row) {
    db.updateTorrent(row.id, {
      source: normalized.source,
      saveDir: row.saveDir || saveDir,
      name: result.name || row.name || '',
      error: null,
    });
    if (row.state === 'paused') {
      try { await native.pauseTorrent(result.infoHash); } catch {}
    } else if (row.state === 'completed' && !seedingAllowed(row)) {
      try { await native.pauseTorrent(result.infoHash); } catch {}
    } else {
      if (row.state === 'queued' || queueHeld) {
        try { await native.pauseTorrent(result.infoHash); } catch {}
      }
      db.updateTorrent(row.id, { state: 'queued' });
    }
    row = db.getTorrent(row.id);
  } else {
    const active = db.listTorrents().filter((r) => ACTIVE_STATES.has(r.state)).length;
    const state = queueHeld || active >= maxActive() ? 'queued' : 'downloading';
    if (state === 'queued') {
      try { await native.pauseTorrent(result.infoHash); } catch {}
    }
    const id = db.createTorrent({
      source: normalized.source,
      infoHash: result.infoHash,
      name: result.name || '',
      saveDir,
      state,
      seeding: String(settings.torrentSeeding || '1') === '1' ? 1 : 0,
      ratioLimit: Number(settings.torrentRatioLimit) || 0,
    });
    row = db.getTorrent(id);
    created = true;
  }
  await applyLimits(row);

  if (Array.isArray(opts.priorities) && opts.priorities.length) {
    try {
      const updated = await setFilePriorities(row.id, opts.priorities);
      row = updated || row;
    } catch (e) {
      console.error('torrent priorities at add:', e && e.message ? e.message : e);
    }
  }

  lastStateById.set(row.id, row.state);
  if (created) emit('torrent:added', row);
  else emit('torrent:update', row);
  emitQueue();
  await pumpQueue();
  return db.getTorrent(row.id);
}

async function pause(id) {
  const row = db.getTorrent(id);
  if (!row) throw new Error('torrent not found');
  if (engine && row.infoHash) {
    try {
      await engine.pauseTorrent(row.infoHash);
    } catch (e) {
      if (!/unknown infoHash/i.test(e && e.message ? e.message : '')) throw e;
    }
  }
  db.updateTorrent(id, { state: 'paused', downKbps: 0, upKbps: 0 });
  emit('torrent:update', db.getTorrent(id));
  if (!queueHeld) await pumpQueue();
  emitQueue();
  return db.getTorrent(id);
}

async function pauseAll() {
  queueHeld = true;
  const rows = db.listTorrents().filter((r) =>
    ACTIVE_STATES.has(r.state) || r.state === 'seeding' || r.state === 'queued');
  for (const row of rows) {
    if (engine && row.infoHash) {
      try { await engine.pauseTorrent(row.infoHash); } catch {}
    }
    db.updateTorrent(row.id, { state: 'paused', downKbps: 0, upKbps: 0 });
    emit('torrent:update', db.getTorrent(row.id));
  }
  emitQueue();
  return { paused: rows.length, held: true };
}

async function resumeAll() {
  queueHeld = false;
  const rows = db.listTorrents().filter((r) => r.state === 'paused');
  for (const row of rows) {
    db.updateTorrent(row.id, { state: 'queued', error: null });
    await applyLimits(row);
    emit('torrent:update', db.getTorrent(row.id));
  }
  await pumpQueue();
  emitQueue();
  return { resumed: rows.length, held: false };
}

async function resume(id) {
  const row = db.getTorrent(id);
  if (!row) throw new Error('torrent not found');
  const native = await ensureEngine();
  await ensureInterfaces();
  if (row.infoHash) {
    try {
      await native.resumeTorrent(row.infoHash);
    } catch (e) {
      if (/unknown infoHash/i.test(e && e.message ? e.message : '')) await startRow(row);
      else throw e;
    }
  } else {
    await startRow(row);
  }
  await applyLimits(db.getTorrent(id));
  // Starting one card explicitly works even while the rest of the queue is
  // held; it only stays queued when every active slot is already taken.
  const active = db.listTorrents().filter((r) => r.id !== id && ACTIVE_STATES.has(r.state)).length;
  if (active < maxActive()) {
    db.updateTorrent(id, { state: 'downloading', error: null });
  } else {
    try { await native.pauseTorrent(row.infoHash); } catch {}
    db.updateTorrent(id, { state: 'queued', error: null });
  }
  emit('torrent:update', db.getTorrent(id));
  if (!queueHeld) await pumpQueue();
  emitQueue();
  return db.getTorrent(id);
}

async function remove(id, opts = {}) {
  const row = db.getTorrent(id);
  if (!row) return { removed: false };
  if (engine && row.infoHash) {
    try {
      await engine.removeTorrent(row.infoHash, !!opts.deleteFiles);
    } catch (e) {
      if (!/unknown infoHash/i.test(e && e.message ? e.message : '')) {
        console.error('torrent remove:', e && e.message ? e.message : e);
      }
    }
  }
  db.deleteTorrent(id);
  lastStateById.delete(id);
  lastFileCountById.delete(id);
  emit('torrent:removed', { id, infoHash: row.infoHash, name: row.name });
  await pumpQueue();
  emitQueue();
  return { removed: true, row };
}

async function setFilePriorities(id, priorities) {
  const row = db.getTorrent(id);
  if (!row) throw new Error('torrent not found');
  if (!row.infoHash) throw new Error('torrent has not started yet');
  const native = await ensureEngine();
  await ensureInterfaces();
  const list = (Array.isArray(priorities) ? priorities : []).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(7, Math.trunc(n))) : 4;
  });
  const result = await native.setFilePriorities(row.infoHash, list);
  const files = Array.isArray(result.files) ? result.files : [];
  db.updateTorrent(id, { files: JSON.stringify(files) });
  const fresh = db.getTorrent(id);
  emit('torrent:update', fresh);
  return fresh;
}

async function setLimits(id, uploadKbps, downloadKbps) {
  const row = db.getTorrent(id);
  if (!row) throw new Error('torrent not found');
  // A null field means the user did not edit it, so keep the stored override.
  // 0 is an explicit "inherit the global limit"; >0 is an explicit override.
  const patch = {};
  if (uploadKbps !== null && uploadKbps !== undefined) {
    patch.uploadLimitKbps = Math.max(0, Number(uploadKbps) || 0);
  }
  if (downloadKbps !== null && downloadKbps !== undefined) {
    patch.downloadLimitKbps = Math.max(0, Number(downloadKbps) || 0);
  }
  if (Object.keys(patch).length) db.updateTorrent(id, patch);
  const fresh = db.getTorrent(id);
  await applyLimits(fresh);
  emit('torrent:update', fresh);
  return fresh;
}

async function getPeerList(id) {
  const row = db.getTorrent(id);
  if (!row) throw new Error('torrent not found');
  if (!row.infoHash) return { infoHash: '', peers: [] };
  const native = await ensureEngine();
  await ensureInterfaces();
  return native.getPeerList(row.infoHash);
}

async function updateTrackers(id) {
  const row = db.getTorrent(id);
  if (!row) throw new Error('torrent not found');
  if (!row.infoHash) throw new Error('torrent has not started yet');
  const native = await ensureEngine();
  await ensureInterfaces();
  const result = await native.updateTrackers(row.infoHash);
  const fresh = db.getTorrent(id);
  emit('torrent:update', fresh);
  return result;
}

function queueState() {
  const rows = db.listTorrents();
  return {
    max: maxActive(),
    active: rows.filter((r) => ACTIVE_STATES.has(r.state)).length,
    queued: rows.filter((r) => r.state === 'queued').length,
    paused: rows.filter((r) => r.state === 'paused').length,
    seeding: rows.filter((r) => r.state === 'seeding').length,
    held: queueHeld,
  };
}

function emitQueue() {
  const state = queueState();
  const json = JSON.stringify(state);
  if (json !== lastQueueJson) {
    lastQueueJson = json;
    emit('torrent:queue', state);
  }
}

async function pumpQueue() {
  if (pumping || queueHeld || !engine) return;
  pumping = true;
  try {
    const rows = db.listTorrents();
    let active = rows.filter((r) => ACTIVE_STATES.has(r.state)).length;
    const max = maxActive();
    const queued = rows.filter((r) => r.state === 'queued').sort((a, b) => a.id - b.id);
    for (const row of queued) {
      if (active >= max) {
        if (row.infoHash) {
          try { await engine.pauseTorrent(row.infoHash); } catch {}
        }
        continue;
      }
      try {
        if (row.infoHash) {
          try {
            await engine.resumeTorrent(row.infoHash);
          } catch (e) {
            if (/unknown infoHash/i.test(e && e.message ? e.message : '')) await startRow(row);
            else throw e;
          }
        } else {
          await startRow(row);
        }
        db.updateTorrent(row.id, { state: 'downloading', error: null });
        const fresh = db.getTorrent(row.id);
        lastStateById.set(fresh.id, fresh.state);
        emit('torrent:update', fresh);
        active += 1;
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        db.updateTorrent(row.id, { state: 'error', error: message });
        emit('torrent:error', { id: row.id, error: message });
        emit('torrent:update', db.getTorrent(row.id));
      }
    }
  } finally {
    pumping = false;
    emitQueue();
  }
}

function mapState(status, row) {
  if (status.error) return 'error';
  switch (status.state) {
    case 'checking_files':
    case 'checking_resume_data':
      return 'checking';
    case 'downloading_metadata':
    case 'downloading':
      return 'downloading';
    case 'finished':
    case 'seeding':
      return seedingAllowed(row) ? 'seeding' : 'completed';
    default:
      return row.state === 'paused' ? 'paused' : 'queued';
  }
}

async function poll() {
  if (polling) return;
  const tracked = db.listTorrents().filter((r) => POLLED_STATES.has(r.state) || r.state === 'queued');
  // The addon loads lazily. When rows exist but no engine has been created
  // yet (first tick after startup), create and bind it before polling.
  if (!engine) {
    if (!tracked.length) return;
    try {
      await ensureEngine();
      await ensureInterfaces();
    } catch (e) {
      console.error('torrent engine start:', e && e.message ? e.message : e);
      return;
    }
  }
  polling = true;
  try {
    const native = engine;
    const rows = tracked.filter((r) => POLLED_STATES.has(r.state) && r.infoHash && native);
    for (const row of rows) {
      let status;
      try {
        status = await native.getStatus(row.infoHash);
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        if (/unknown infoHash/i.test(message)) {
          db.updateTorrent(row.id, { state: 'queued', downKbps: 0, upKbps: 0, peers: 0, seeds: 0 });
          emit('torrent:update', db.getTorrent(row.id));
        } else {
          console.error('torrent status:', message);
        }
        continue;
      }

      let state = mapState(status, row);
      const files = Array.isArray(status.files) ? status.files : [];
      const completed = state === 'completed' || state === 'seeding';
      const patch = {
        name: status.name || row.name || '',
        totalSize: Math.max(0, Number(status.totalWanted) || Number(row.totalSize) || 0),
        downloaded: Math.max(0, Number(status.totalDone) || 0),
        uploaded: Math.max(0, Number(status.uploaded) || 0),
        progress: Math.max(0, Math.min(1, Number(status.progress) || 0)),
        downKbps: Math.max(0, Number(status.downKbps) || 0),
        upKbps: Math.max(0, Number(status.upKbps) || 0),
        uploadPayloadKbps: Math.max(0, Number(status.uploadPayloadKbps) || 0),
        downloadPayloadKbps: Math.max(0, Number(status.downloadPayloadKbps) || 0),
        peers: Math.max(0, Number(status.peers) || 0),
        seeds: Math.max(0, Number(status.seeds) || 0),
        pieces: Math.max(0, Number(status.pieces) || 0),
        piecesTotal: Math.max(0, Number(status.piecesTotal) || 0),
        etaSeconds: Number.isFinite(Number(status.etaSeconds)) ? Math.trunc(Number(status.etaSeconds)) : -1,
        totalDone: Math.max(0, Number(status.totalDone) || 0),
        totalWantedDone: Math.max(0, Number(status.totalWantedDone) || 0),
        allTimeUpload: Math.max(0, Number(status.allTimeUpload) || 0),
        allTimeDownload: Math.max(0, Number(status.allTimeDownload) || 0),
        currentTracker: String(status.currentTracker || ''),
        nextAnnounceSec: Math.max(0, Math.trunc(Number(status.nextAnnounceSec) || 0)),
        numComplete: Number.isFinite(Number(status.numComplete)) ? Math.trunc(Number(status.numComplete)) : -1,
        numIncomplete: Number.isFinite(Number(status.numIncomplete)) ? Math.trunc(Number(status.numIncomplete)) : -1,
        listPeers: Math.max(0, Math.trunc(Number(status.listPeers) || 0)),
        distributedCopies: Math.max(0, Number(status.distributedCopies) || 0),
        numConnections: Math.max(0, Math.trunc(Number(status.numConnections) || 0)),
        numUploads: Math.max(0, Math.trunc(Number(status.numUploads) || 0)),
        activeSeconds: Math.max(0, Math.trunc(Number(status.activeSeconds) || 0)),
        seedingSeconds: Math.max(0, Math.trunc(Number(status.seedingSeconds) || 0)),
        state,
        error: status.error || null,
        files: JSON.stringify(files),
        finishedAt: completed ? (row.finishedAt || Date.now()) : row.finishedAt,
      };
      // uploadLimitKbps/downloadLimitKbps on the row are user overrides where
      // 0 means "inherit the global limit"; the engine reports the effective
      // values in the live progress event instead of overwriting them here.

      // Stop seeding when the user turned it off, this torrent opted out, or
      // the share ratio limit was reached.
      if (state === 'seeding') {
        const ratioLimit = Number(settings.torrentRatioLimit || row.ratioLimit || 0);
        const ratio = patch.downloaded > 0 ? patch.uploaded / patch.downloaded : 0;
        if (!seedingAllowed(row) || (ratioLimit > 0 && ratio >= ratioLimit)) {
          try { await native.pauseTorrent(row.infoHash); } catch {}
          patch.state = 'completed';
          patch.downKbps = 0;
          patch.upKbps = 0;
          state = 'completed';
        }
      }

      db.updateTorrent(row.id, patch);
      const fresh = db.getTorrent(row.id);
      const previousState = lastStateById.get(row.id);
      const previousFiles = lastFileCountById.get(row.id);
      if (previousState !== fresh.state || previousFiles !== files.length) {
        lastStateById.set(row.id, fresh.state);
        lastFileCountById.set(row.id, files.length);
        emit('torrent:update', fresh);
        if (fresh.state === 'error' && previousState !== 'error') {
          emit('torrent:error', { id: fresh.id, error: fresh.error });
        }
      }
      emit('torrent:progress', {
        id: fresh.id,
        infoHash: fresh.infoHash,
        name: fresh.name,
        state: fresh.state,
        progress: fresh.progress,
        downloaded: fresh.downloaded,
        totalSize: fresh.totalSize,
        uploaded: fresh.uploaded,
        downKbps: fresh.downKbps,
        upKbps: fresh.upKbps,
        uploadPayloadKbps: fresh.uploadPayloadKbps,
        downloadPayloadKbps: fresh.downloadPayloadKbps,
        peers: fresh.peers,
        seeds: fresh.seeds,
        pieces: fresh.pieces,
        piecesTotal: fresh.piecesTotal,
        etaSeconds: fresh.etaSeconds,
        totalDone: fresh.totalDone,
        totalWantedDone: fresh.totalWantedDone,
        allTimeUpload: fresh.allTimeUpload,
        allTimeDownload: fresh.allTimeDownload,
        currentTracker: fresh.currentTracker,
        nextAnnounceSec: fresh.nextAnnounceSec,
        numComplete: fresh.numComplete,
        numIncomplete: fresh.numIncomplete,
        listPeers: fresh.listPeers,
        distributedCopies: fresh.distributedCopies,
        numConnections: fresh.numConnections,
        numUploads: fresh.numUploads,
        activeSeconds: fresh.activeSeconds,
        seedingSeconds: fresh.seedingSeconds,
        uploadLimitKbps: Math.max(0, Number(status.uploadLimitKbps) || 0),
        downloadLimitKbps: Math.max(0, Number(status.downloadLimitKbps) || 0),
      });
    }
    await pumpQueue();
    emitQueue();
  } finally {
    polling = false;
  }
}

async function autostart() {
  settings = db.getSettings();
  const rows = db.listTorrents();
  if (!rows.length) return;
  const seedingOn = String(settings.torrentSeeding || '1') === '1';
  for (const row of rows) {
    if (row.state === 'paused') continue;
    if (row.state === 'error') {
      db.updateTorrent(row.id, { state: 'queued', error: null });
      continue;
    }
    if (row.state === 'completed') {
      if (seedingOn && Number(row.seeding) !== 0) db.updateTorrent(row.id, { state: 'queued' });
      continue;
    }
    if (POLLED_STATES.has(row.state) || row.state === 'queued') {
      db.updateTorrent(row.id, { state: 'queued', error: null });
    }
  }
  try {
    await ensureEngine();
  } catch (e) {
    console.error('torrent autostart:', e && e.message ? e.message : e);
    return;
  }
  await ensureInterfaces();
  await pumpQueue();
  for (const row of db.listTorrents()) {
    if (row.infoHash) await applyLimits(row);
  }
  emitQueue();
}

function setSettings(next) {
  const previousPort = String(settings.torrentPort || '');
  const previousUpload = Number(settings.torrentUploadLimitKbps) || 0;
  const previousDownload = Number(settings.torrentDownloadLimitKbps) || 0;
  settings = next || db.getSettings();
  const uploadLimit = limitKbps(settings.torrentUploadLimitKbps);
  const downloadLimit = limitKbps(settings.torrentDownloadLimitKbps);
  const limitsChanged = uploadLimit !== previousUpload || downloadLimit !== previousDownload;
  if (limitsChanged && engine) {
    engine.setSessionLimits(uploadLimit, downloadLimit).catch(() => {});
  }
  // Per-torrent overrides win over the global limit, so reapply every row.
  if (limitsChanged && engine) {
    for (const row of db.listTorrents()) applyLimits(row);
  }
  const portChanged = String(settings.torrentPort || '') !== previousPort;
  if (portChanged && engine) {
    const busy = db.listTorrents().some((r) => ACTIVE_STATES.has(r.state) || r.state === 'seeding');
    if (!busy) {
      const old = engine;
      engine = null;
      interfacesReady = false;
      try { old.stop().catch(() => {}); } catch {}
    } else {
      console.warn('torrent port change will apply after the active torrents stop');
    }
  }
}

function shutdown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const old = engine;
  engine = null;
  interfacesReady = false;
  if (old) {
    try { old.stop().catch(() => {}); } catch {}
  }
}

module.exports = {
  init,
  add,
  pause,
  pauseAll,
  resumeAll,
  resume,
  remove,
  queueState,
  autostart,
  shutdown,
  poll,
  setFilePriorities,
  setLimits,
  getPeerList,
  updateTrackers,
  setSettings,
};
