const http = require('http');
const https = require('https');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const db = require('./db');
const connections = require('./connections');

let send = null;
const jobs = new Map(); // id -> job
const connSpeeds = new Map(); // connectionId -> { bytes, lastTime, speed }

// ---- Dynamic chunk / stream planning ----
// The file is split into about (2 * connections) chunks, and each active
// connection runs a small number of parallel range downloads. More
// connections => finer chunks and fewer streams per connection; fewer
// connections => larger chunks and more streams per connection.
const MIN_CHUNK_BYTES = 1 * 1024 * 1024; // 1 MB floor
const MAX_STREAMS_PER_CONN = 2;          // streams a connection starts with
const CHUNKS_PER_STREAM = 2;             // chunks available per stream (rebalancing)
// Ramp up extra streams per adapter only while doing so measurably raises that
// adapter's own throughput (see the hill climb in runChunks).
const RAMP_WINDOW_MS = 2000;
// Absolute ceiling on concurrent streams for one download, regardless of how
// many adapters or how high the per-connection setting is. 64 curl processes
// is already far past what any home line can absorb.
const MAX_TOTAL_STREAMS = 64;

// Split the file into ranges. The bulk is cut at chunkSize, but the final
// region is split across every stream so one stream is never left ploughing
// through a lopsided tail on its own.
function planRanges(totalSize, connCount, settings) {
  const n = Math.max(1, connCount);
  const target = Math.max(1, parseInt(settings.targetStreams || '4', 10) || 4);
  const maxChunk = Math.max(MIN_CHUNK_BYTES,
    (parseFloat(settings.maxChunkSizeMB) || 512) * 1024 * 1024);
  const streamsPerConn = Math.min(MAX_STREAMS_PER_CONN,
    Math.max(1, Math.ceil(target / n)));
  const streams = Math.max(1, n * streamsPerConn);
  const chunksPerConn = Math.max(CHUNKS_PER_STREAM, streamsPerConn);
  let chunkSize = Math.floor(totalSize / (n * chunksPerConn));
  chunkSize = Math.max(MIN_CHUNK_BYTES, Math.min(maxChunk, chunkSize));

  const ranges = [];
  let pos = 0;
  if (totalSize <= chunkSize) {
    // small file: spread it across the streams we have
    const parts = (totalSize >= streams * MIN_CHUNK_BYTES) ? streams : 1;
    const each = Math.floor(totalSize / parts);
    for (let i = 0; i < parts; i++) {
      const len = (i === parts - 1) ? (totalSize - pos) : each;
      ranges.push({ start: pos, end: pos + len - 1 });
      pos += len;
    }
    return { ranges, chunkSize: Math.max(...ranges.map(r => r.end - r.start + 1)), streamsPerConn };
  }

  const full = Math.floor(totalSize / chunkSize);
  for (let i = 0; i < full; i++) {
    ranges.push({ start: pos, end: pos + chunkSize - 1 });
    pos += chunkSize;
  }
  const remainder = totalSize - pos;
  if (remainder > 0) {
    const parts = (remainder >= streams * MIN_CHUNK_BYTES) ? streams : 1;
    const each = Math.floor(remainder / parts);
    for (let i = 0; i < parts; i++) {
      const len = (i === parts - 1) ? (totalSize - pos) : each;
      ranges.push({ start: pos, end: pos + len - 1 });
      pos += len;
    }
  }
  return { ranges, chunkSize: Math.max(...ranges.map(r => r.end - r.start + 1)), streamsPerConn };
}

function planChunks(totalSize, connCount, settings) {
  const plan = planRanges(totalSize, connCount, settings);
  return { chunkSize: plan.chunkSize, numChunks: plan.ranges.length, streamsPerConn: plan.streamsPerConn };
}

function init(sendFn) {
  send = sendFn;
  setInterval(() => {
    const arr = [];
    for (const [id, cs] of connSpeeds.entries()) {
      const speed = cs.bytes || 0; // bytes in last second
      cs.speed = speed;
      cs.bytes = 0;
      arr.push({ id, speed });
    }
    emit('speeds:update', arr);
  }, 1000);
}

function emit(channel, payload) { if (send) send(channel, payload); }

function parseFilename(url, headers) {
  const cd = headers['content-disposition'];
  if (cd) {
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i.exec(cd);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    }
  }
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    if (base) return decodeURIComponent(base);
  } catch {}
  return 'download.bin';
}

function uniquePath(dir, name) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let full = path.join(dir, name);
  if (!fs.existsSync(full)) return full;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${stem} (${i})${ext}`))) i++;
  return path.join(dir, `${stem} (${i})${ext}`);
}

// ---- On-disk layout -------------------------------------------------------
// Chunks are written to small part files inside a hidden per-download folder.
// The finished file is only built once every range is complete, so a 70 GB
// download occupies ~70 GB while it runs instead of reserving the full size
// up front and then filling it.
const PARTS_DIRNAME = '.ud-parts';

function partsDirFor(savePath, id) {
  return path.join(path.dirname(savePath), PARTS_DIRNAME, String(id));
}
function partPathFor(dir, idx) { return path.join(dir, `${idx}.part`); }
function ensurePartsDir(savePath, id) {
  const dir = partsDirFor(savePath, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function removePartsDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

// Join the parts into the final file, deleting each part as soon as its bytes
// are safely in place. Peak usage is therefore the download plus one part.
async function assembleFile(job, id, savePath, totalSize, chunks) {
  const partsDir = job.partsDir || partsDirFor(savePath, id);
  const ordered = chunks.slice().sort((a, b) => a.start - b.start);
  db.updateDownload(id, { status: 'assembling', downloaded: totalSize, error: null });
  emit('download:update', db.getDownload(id));
  emit('download:assembling', { id, done: 0, total: totalSize });

  const tmpFinal = `${savePath}.ud-assembling`;
  let outFd = null;
  try {
    // Only about one part of extra space is needed: each part is deleted as
    // soon as its bytes are in the final file. Check before starting so a
    // nearly-full disk fails with a clear message instead of a raw ENOSPC.
    const maxPart = ordered.reduce((a, c) => Math.max(a, c.end - c.start + 1), 0);
    if (typeof fs.statfsSync === 'function') {
      try {
        const sf = fs.statfsSync(path.dirname(savePath));
        const freeBytes = sf.bavail * sf.bsize;
        if (freeBytes < maxPart + 64 * 1024 * 1024) {
          throw new Error(`not enough free space to build the final file — needs about ${humanSize(maxPart)} more`);
        }
      } catch (e) {
        if (!e.code) throw e; // keep our own message, ignore statfs failures
      }
    }
    // Any existing file at the destination is an incomplete placeholder (an
    // older build preallocated it); drop it so we never need both.
    if (fileSize(savePath) >= 0) try { fs.rmSync(savePath, { force: true }); } catch {}
    outFd = fs.openSync(tmpFinal, 'w');
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
    let totalWritten = 0;
    let lastEmit = 0;
    for (const c of ordered) {
      const len = c.end - c.start + 1;
      const part = partPathFor(partsDir, c.idx);
      if (fileSize(part) < len) {
        const err = new Error(`part files are missing or incomplete (part ${c.idx}) — remove this download and add the link again`);
        err.partialAssembly = true;
        throw err;
      }
      const inFd = fs.openSync(part, 'r');
      try {
        let pos = 0;
        while (pos < len) {
          const n = Math.min(buf.length, len - pos);
          const got = await new Promise((res, rej) =>
            fs.read(inFd, buf, 0, n, pos, (e, b) => (e ? rej(e) : res(b))));
          if (!got) throw new Error(`short read from part ${c.idx}`);
          await new Promise((res, rej) =>
            fs.write(outFd, buf, 0, got, totalWritten, (e) => (e ? rej(e) : res())));
          pos += got;
          totalWritten += got;
          const now = Date.now();
          if (now - lastEmit > 500) {
            lastEmit = now;
            emit('download:assembling', { id, done: totalWritten, total: totalSize });
          }
        }
      } finally {
        fs.closeSync(inFd);
      }
      try { fs.unlinkSync(part); } catch {}
    }
    fs.closeSync(outFd);
    outFd = null;
    const size = fileSize(tmpFinal);
    if (size !== totalSize) throw new Error(`assembled file is ${size} bytes, expected ${totalSize}`);
    fs.renameSync(tmpFinal, savePath);
    removePartsDir(partsDir);
    db.updateDownload(id, { status: 'completed', downloaded: totalSize, error: null });
    emit('download:assembling', { id, done: totalSize, total: totalSize, finished: true });
    emit('download:update', db.getDownload(id));
  } catch (e) {
    if (outFd !== null) { try { fs.closeSync(outFd); } catch {} }
    try { fs.rmSync(tmpFinal, { force: true }); } catch {}
    throw e;
  }
}

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      localAddress: opts.localAddress,
      family: opts.localAddress ? 4 : undefined,
      agent: mod === https ? httpsAgent : httpAgent,
      timeout: opts.timeout || 30000
    }, (res) => {
      // redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return request(next, opts).then(resolve).catch(reject);
      }
      resolve({ res, finalUrl: url });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function headInfo(url) {
  const { res } = await request(url, { method: 'HEAD' });
  res.resume();
  const code = res.statusCode || 0;
  // A dead/expired link answers 404/410/403 with a tiny HTML error body. Treat
  // that as a failure instead of "a 87-byte file", which used to wipe the
  // download and mark it completed.
  if (code >= 400) {
    const err = new Error(httpMessage(code));
    err.httpStatus = code;
    throw err;
  }
  const size = parseInt(res.headers['content-length'] || '0', 10) || 0;
  const ar = /bytes/i.test(res.headers['accept-ranges'] || '');
  if (size <= 0) {
    const err = new Error('server did not report a file size');
    err.httpStatus = code;
    throw err;
  }
  return { size, acceptRanges: ar, headers: res.headers, finalUrl: url, status: code };
}

function httpMessage(code) {
  if (code === 410) return 'download link expired (HTTP 410) — use Refresh link';
  if (code === 403) return 'access denied (HTTP 403) — the link may have expired';
  if (code === 404) return 'file not found (HTTP 404) — the link may have expired';
  if (code === 429) return 'rate limited by the server (HTTP 429) — try again shortly';
  return `server returned HTTP ${code}`;
}

async function addJob(url, opts = {}) {
  const settings = db.getSettings();
  const dir = (opts.saveDir) || settings.downloadDir;
  const id = db.createDownload({ url, filename: null, savePath: null, totalSize: 0 });
  // store desired dir in a side map
  jobs.set(id, { id, url, saveDir: dir, paused: false, cancelled: false, chunks: [], startedAt: null });
  emit('download:added', { id, url });
  return id;
}

async function start(id) {
  const job = jobs.get(id) || { id, url: db.getDownload(id).url, saveDir: db.getSettings().downloadDir, paused: false, cancelled: false, chunks: [] };
  jobs.set(id, job);
  const row = db.getDownload(id);
  job.url = row.url;
  job.paused = false;
  job.cancelled = false;
  job.active = true;

  try {
    // Everything is already on disk (the app quit while the final file was
    // being built, for example). Build it without touching the network: the
    // link may be long dead by now.
    const existing = db.getChunks(id);
    if (existing.length > 0 && row.totalSize > 0 && row.savePath &&
        existing.every((c) => c.status === 'completed')) {
      job.partsDir = partsDirFor(row.savePath, id);
      job.savePath = row.savePath;
      job.totalSize = row.totalSize;
      if (fileSize(row.savePath) === row.totalSize) {
        removePartsDir(job.partsDir);
        db.updateDownload(id, { status: 'completed', downloaded: row.totalSize, error: null });
        emit('download:update', db.getDownload(id));
        return;
      }
      job.chunks = existing.map((c) => ({
        dbId: c.id, idx: c.idx, start: c.start, end: c.end,
        downloaded: c.downloaded || 0, status: 'completed'
      }));
      await assembleFile(job, id, row.savePath, row.totalSize, job.chunks);
      return;
    }

    // head
    const info = await headInfo(job.url);
    // A resumed job must still be the same file. If the link now points at a
    // different object, filling the old ranges would corrupt the file.
    if (row.totalSize > 0 && info.size !== row.totalSize) {
      throw new Error(`file size changed (was ${row.totalSize}, link now ${info.size}) — use Refresh link`);
    }
    const filename = parseFilename(job.url, info.headers);
    const dir = job.saveDir || db.getSettings().downloadDir;
    const savePath = row.savePath || uniquePath(dir, filename);
    const totalSize = info.size;
    const acceptRanges = info.acceptRanges;

    db.updateDownload(id, { filename, savePath, totalSize, acceptRanges: acceptRanges ? 1 : 0, status: 'downloading', error: null });
    emit('download:update', db.getDownload(id));

    // Parts sit next to the destination, so building the final file is a local
    // copy and never needs a second volume.
    const partsDir = ensurePartsDir(savePath, id);
    job.partsDir = partsDir;

    if (!acceptRanges || totalSize <= 0) {
      await downloadSingle(job, id, savePath, totalSize);
      return;
    }

    const settings = db.getSettings();
    const allEnabled = connections.enabledConnections();
    const configuredMax = parseInt(settings.maxConnectionsPerDownload, 10);
    const maxConn = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : allEnabled.length;
    const conns = allEnabled.slice(0, maxConn);
    if (conns.length === 0) {
      await downloadSingle(job, id, savePath, totalSize);
      return;
    }
    const nConns = conns.length;
    const plan = planRanges(totalSize, nConns, settings);

    // reuse existing chunks if present (resume)
    let chunks = db.getChunks(id);
    if (chunks.length > 0) {
      for (const c of chunks) if (c.status !== 'completed') db.updateChunk(c.id, { status: 'pending' });
    }
    if (chunks.length === 0) {
      chunks = [];
      plan.ranges.forEach((r, idx) => {
        // round-robin across connections so work is spread evenly
        chunks.push({ idx, start: r.start, end: r.end, downloaded: 0, connectionId: conns[idx % nConns].id, status: 'pending' });
      });
      db.replaceChunks(id, chunks.map(c => ({ idx: c.idx, start: c.start, end: c.end, downloaded: 0, connectionId: c.connectionId, status: 'pending' })));
      chunks = db.getChunks(id);
    }

    // map to runtime shape
    const rtChunks = chunks.map(c => ({
      dbId: c.id, idx: c.idx, start: c.start, end: c.end,
      downloaded: c.downloaded || 0, connectionId: c.connectionId, status: c.status === 'completed' ? 'completed' : 'pending', retries: 0
    }));

    // Chunks are written to part files; nothing is reserved at savePath yet.
    job.chunks = rtChunks;
    job.savePath = savePath;
    job.totalSize = totalSize;
    job.startedAt = Date.now();
    job.lastBytes = rtChunks.reduce((a,c)=>a+c.downloaded,0);
    job.lastTime = Date.now();
    job.connBytes = new Map();
    job.connRate = new Map();

    // Interleave workers across connections so every adapter starts evenly.
    const streamsPerConn = plan.streamsPerConn;
    const slots = [];
    for (let s = 0; s < streamsPerConn; s++) {
      for (const c of conns) slots.push(c);
    }

    // Everything was already downloaded (e.g. the app quit while the file was
    // being built, or this is an old-format job with a preallocated file).
    const allComplete = rtChunks.length > 0 && rtChunks.every((c) => c.status === 'completed');
    if (allComplete) {
      if (fileSize(savePath) === totalSize) {
        removePartsDir(partsDir);
        db.updateDownload(id, { status: 'completed', downloaded: totalSize, error: null });
        emit('download:update', db.getDownload(id));
        return;
      }
      await assembleFile(job, id, savePath, totalSize, rtChunks);
      return;
    }

    try {
      await runChunks(job, id, savePath, totalSize, slots);
    } catch (e) {
      console.error('RUNCHUNKS ERR', e && e.stack);
      throw e;
    }

  } catch (e) {
    console.error('START ERR', e && e.stack);
    db.updateDownload(id, { status: 'failed', error: e.message });
    emit('download:update', db.getDownload(id));
    emit('download:error', { id, error: e.message });
  } finally {
    job.active = false;
  }
}

async function downloadSingle(job, id, savePath, totalSize) {
  // Single-stream downloads also land in a part file and are renamed into
  // place only once complete, so an interrupted transfer never leaves a
  // half-sized file with the final name.
  const partsDir = job.partsDir || ensurePartsDir(savePath, id);
  job.partsDir = partsDir;
  const partPath = partPathFor(partsDir, 0);
  const ws = fs.createWriteStream(partPath);
  const { res } = await request(job.url, {});
  if ((res.statusCode || 0) >= 400) {
    res.resume();
    try { ws.close(); } catch {}
    throw new Error(httpMessage(res.statusCode));
  }
  let downloaded = 0;
  res.on('data', (d) => {
    if (job.cancelled) { res.destroy(); return; }
    res.pause();
    (async () => {
      try {
        await acquireTokens(d.length, null);
        if (job.cancelled) { res.destroy(); return; }
        downloaded += d.length;
        ws.write(d);
        db.updateDownload(id, { downloaded });
        emitProgress(id, downloaded, totalSize || 0);
      } catch (e) {}
      if (!job.cancelled) res.resume();
    })();
  });
  await new Promise((resolve, reject) => {
    res.on('end', () => ws.end(() => resolve()));
    res.on('error', reject);
    ws.on('error', reject);
  });
  if (job.cancelled) {
    removePartsDir(partsDir);
    db.updateDownload(id, { status: 'cancelled' });
  } else {
    try { fs.rmSync(savePath, { force: true }); } catch {}
    fs.renameSync(partPath, savePath);
    removePartsDir(partsDir);
    db.updateDownload(id, { status: 'completed', downloaded: totalSize });
  }
  emit('download:update', db.getDownload(id));
}

async function runChunks(job, id, savePath, totalSize, slots) {
  const pending = job.chunks.filter(c => c.status !== 'completed');

  // Workers are tracked dynamically because the controller below adds and
  // removes streams mid-transfer.
  const running = new Set();
  const perSlot = new Map(); // connectionId -> active worker count
  if (!job.connBytes) job.connBytes = new Map(); // connectionId -> total bytes
  const ctl = { perSlot, budget: new Map() };
  const startWorker = (slot) => {
    perSlot.set(slot.id, (perSlot.get(slot.id) || 0) + 1);
    const p = workerLoop(slot, job, id, pending, ctl).finally(() => {
      perSlot.set(slot.id, Math.max(0, (perSlot.get(slot.id) || 1) - 1));
      running.delete(p);
    });
    running.add(p);
    return p;
  };
  // `slots` already contains one entry per starting stream (2 per adapter), so
  // the transfer is at a useful speed while the hill climb finds headroom.
  for (const slot of slots) startWorker(slot);

  const bytesDone = () => job.chunks.reduce((a, c) => a + (c.downloaded || 0), 0);

  // ---- Per-adapter stream controller ----
  // Each adapter is tuned independently with a slow hill climb: add one stream,
  // watch that adapter's own throughput, keep the stream if the link got faster
  // and take it back if it did not. This keeps a slow, cell-backed link from
  // dragging down a fast, steady one, and it holds each link at its own maximum
  // instead of chasing a single global target.
  const settings = db.getSettings();
  const connIds = Array.from(new Set(slots.map((s) => s.id)));
  const perConnCap = Math.max(1, Math.min(32, parseInt(settings.maxStreamsPerConnection, 10) || 32));
  const slotFor = (cid) => slots.find((s) => s.id === cid);

  const budget = ctl.budget;
  const state = new Map();
  for (const cid of connIds) {
    budget.set(cid, Math.max(1, perSlot.get(cid) || 1));
    state.set(cid, { prevBytes: job.connBytes.get(cid) || 0, rate: 0, probe: null, frozenUntil: 0, best: 0, fails: 0 });
  }
  const totalBudget = () => Array.from(budget.values()).reduce((a, b) => a + b, 0);
  const DEADLINE_MS = RAMP_WINDOW_MS * 3; // judge each probe over ~6s

  const ramp = setInterval(() => {
    if (job.cancelled || job.paused) return;
    if (!pending.some((c) => c.status === 'pending')) return;
    const now = Date.now();
    for (const cid of connIds) {
      const st = state.get(cid);
      const cur = job.connBytes.get(cid) || 0;
      const dt = (now - (st.at || (st.at = now))) / 1000;
      const mbps = dt > 0 ? ((cur - st.prevBytes) * 8 / 1e6) / dt : 0;
      if (now - (st.at || now) < DEADLINE_MS) continue; // not enough data yet
      st.prevBytes = cur;
      st.at = now;
      st.rate = mbps;
      if (mbps > st.best) st.best = mbps;
      if (mbps <= 0.5) continue; // link briefly idle: do not judge it

      // Judge the previous probe.
      if (st.probe) {
        const gain = st.probe.rate > 0 ? (mbps - st.probe.rate) / st.probe.rate : 0;
        const keep = gain > 0.03;
        if (!keep && budget.get(cid) > 1) {
          budget.set(cid, budget.get(cid) - 1);
          // Back off progressively: a link that has already plateaued should
          // not be disturbed every 20 seconds for the rest of the transfer.
          st.fails = (st.fails || 0) + 1;
          const wait = Math.min(300000, 20000 * Math.pow(2, st.fails - 1));
          st.frozenUntil = now + wait;
          console.log(`STREAM ${cid} revert to ${budget.get(cid)} ` +
            `(rate ${mbps.toFixed(0)} vs ${st.probe.rate.toFixed(0)} before, ` +
            `hold ${Math.round(wait / 1000)}s)`);
        } else {
          if (keep) st.fails = 0;
          console.log(`STREAM ${cid} keep ${budget.get(cid)} ` +
            `(rate ${mbps.toFixed(0)} vs ${st.probe.rate.toFixed(0)} before)`);
        }
        st.probe = null;
      }

      if (now < st.frozenUntil) continue;
      if (budget.get(cid) >= perConnCap) continue;
      if (totalBudget() >= MAX_TOTAL_STREAMS) continue;
      if ((perSlot.get(cid) || 0) >= budget.get(cid)) {
        budget.set(cid, budget.get(cid) + 1);
        st.probe = { rate: mbps, at: now };
        console.log(`STREAM ${cid} probe ${budget.get(cid)} (rate ${mbps.toFixed(0)} Mbps)`);
      }
    }
    // Bring the worker count up to each adapter's budget.
    for (const cid of connIds) {
      const slot = slotFor(cid);
      let guard = 0;
      while (slot && (perSlot.get(cid) || 0) < budget.get(cid) && guard++ < 32) startWorker(slot);
    }
  }, RAMP_WINDOW_MS);

  // progress ticker
  // Per-adapter speed for this download, so the download card can show what
  // each link is contributing without opening the Connections tab.
  const connName = new Map(slots.map((s) => [s.id, s.name]));
  if (!job.connRate) job.connRate = new Map();
  const connSnapshot = () => {
    const now = Date.now();
    const out = [];
    for (const cid of connIds) {
      const bytes = job.connBytes.get(cid) || 0;
      const st = job.connRate.get(cid);
      if (!st) { job.connRate.set(cid, { bytes, at: now, speed: 0 }); continue; }
      const dt = (now - st.at) / 1000;
      if (dt > 0) {
        const inst = Math.max(0, (bytes - st.bytes) / dt);
        st.speed = st.speed > 0 ? st.speed * 0.6 + inst * 0.4 : inst;
        st.bytes = bytes;
        st.at = now;
      }
      out.push({ id: cid, name: connName.get(cid) || cid, speed: st.speed });
    }
    return out;
  };

  const ticker = setInterval(() => {
    if (job.cancelled || job.paused) return;
    const downloaded = bytesDone();
    db.updateDownload(id, { downloaded });
    emitProgress(id, downloaded, totalSize, connSnapshot());
  }, 500);

  while (running.size > 0) {
    await Promise.race(Array.from(running));
  }
  clearInterval(ramp);
  clearInterval(ticker);

  if (job.cancelled) {
    // Keep the parts: Cancel stops the transfer, Remove deletes the data.
    db.updateDownload(id, { status: 'cancelled' });
    emit('download:update', db.getDownload(id));
    return;
  }

  const allDone = job.chunks.every(c => c.status === 'completed');
  if (allDone) {
    try {
      await assembleFile(job, id, savePath, totalSize, job.chunks);
    } catch (e) {
      console.error('ASSEMBLE ERR', e && e.stack);
      db.updateDownload(id, { status: 'failed', error: `could not build the final file: ${e.message}` });
      emit('download:update', db.getDownload(id));
    }
    return;
  }

  const downloaded = job.chunks.reduce((a, c) => a + (c.downloaded || 0), 0);
  db.updateDownload(id, {
    status: 'failed',
    downloaded,
    error: 'some ranges failed — the link may have expired (use Refresh link)'
  });
  emit('download:update', db.getDownload(id));
}

async function workerLoop(slot, job, id, pending, ctl) {
  while (true) {
    if (job.cancelled) return;
    // The per-adapter controller can shrink a link's budget when an extra
    // stream did not pay off. Retire surplus workers here, before they claim
    // another chunk, so the change takes effect without killing a transfer.
    if (ctl && (ctl.perSlot.get(slot.id) || 0) > (ctl.budget.get(slot.id) || 1)) return;
    // wait while paused
    while (job.paused && !job.cancelled) {
      await sleep(200);
    }
    // get next pending chunk assigned to this slot's connection
    let chunk = null;
    for (const c of pending) {
      if (c.status === 'pending' && c.connectionId === slot.id) { chunk = c; break; }
    }
    if (!chunk) {
      chunk = pending.find(c => c.status === 'pending');
      if (!chunk) {
        // if any still downloading, wait
        if (pending.some(c => c.status === 'downloading')) { await sleep(200); continue; }
        return;
      }
    }
    chunk.status = 'downloading';
    try {
      await downloadChunk(job, id, chunk, slot);
      chunk.status = 'completed';
      db.updateChunk(chunk.dbId, { downloaded: chunk.end - chunk.start + 1, status: 'completed' });
    } catch (e) {
      console.error('CHUNK ERR', chunk.idx, e && e.message);
      chunk.retries = (chunk.retries || 0) + 1;
      if (chunk.retries >= 5) {
        chunk.status = 'failed';
        db.updateChunk(chunk.dbId, { downloaded: chunk.downloaded || 0, status: 'failed' });
      } else {
        // keep partial progress; downloadChunk resumes from chunk.downloaded
        chunk.status = 'pending';
      }
      await sleep(1000);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Speed limiting (token buckets) ----
const buckets = { global: { tokens: 0, last: Date.now(), rate: 0 } };
const connBuckets = new Map();

// Settings/connection rows used to be read on every chunk of every transfer;
// cache them so the token bucket does not hit SQLite thousands of times a second.
let limitCache = { settings: null, conns: null, at: 0 };
function invalidateLimits() { limitCache.settings = null; limitCache.conns = null; limitCache.at = 0; }
function getLimits() {
  const now = Date.now();
  if (!limitCache.settings || now - limitCache.at > 1000) {
    limitCache.settings = db.getSettings();
    limitCache.conns = db.listConnections();
    limitCache.at = now;
  }
  return limitCache;
}

function getGlobalRateBytes() {
  const s = getLimits().settings || {};
  const kbps = parseInt(s.globalSpeedLimitKbps || '0', 10) || 0;
  return kbps > 0 ? (kbps * 1000) / 8 : 0;
}
function getConnRateBytes(connId) {
  if (!connId) return 0;
  const c = (getLimits().conns || []).find(x => x.id === connId);
  const kbps = c ? (parseInt(c.capKbps || 0, 10) || 0) : 0;
  return kbps > 0 ? (kbps * 1000) / 8 : 0;
}

async function acquireTokens(n, connId) {
  const gr = getGlobalRateBytes();
  const cr = getConnRateBytes(connId);
  if (gr <= 0 && cr <= 0) return;
  const now0 = Date.now();
  if (!buckets.global) buckets.global = { tokens: 0, last: now0, rate: gr };
  if (gr > 0) buckets.global.rate = gr;
  if (connId && cr > 0) {
    if (!connBuckets.has(connId)) connBuckets.set(connId, { tokens: 0, last: now0, rate: cr });
    connBuckets.get(connId).rate = cr;
  }
  while (true) {
    const now = Date.now();
    if (gr > 0) {
      const b = buckets.global;
      const dt = (now - b.last) / 1000;
      b.tokens += b.rate * dt;
      b.last = now;
    }
    if (connId && cr > 0) {
      const b = connBuckets.get(connId);
      const dt = (now - b.last) / 1000;
      b.tokens += b.rate * dt;
      b.last = now;
    }
    const globalOk = gr <= 0 || buckets.global.tokens >= n;
    const connOk = cr <= 0 || (connId && connBuckets.get(connId).tokens >= n);
    if (globalOk && connOk) {
      if (gr > 0) buckets.global.tokens -= n;
      if (cr > 0 && connId) connBuckets.get(connId).tokens -= n;
      return;
    }
    await sleep(20);
  }
}

async function downloadChunk(job, id, chunk, slot) {
  const conn = slot; // has localAddress
  const expected = chunk.end - chunk.start + 1;
  if (chunk.downloaded >= expected) { chunk.downloaded = expected; return; }
  const partPath = partPathFor(job.partsDir, chunk.idx);
  const { spawn } = require('child_process');
  const attempt = (iface) => new Promise((resolve, reject) => {
    // Resume from wherever this chunk reached, so a failed attempt is never
    // downloaded twice and byte accounting stays correct.
    const startByte = chunk.start + chunk.downloaded;
    const endByte = chunk.end;
    const headerFile = path.join(os.tmpdir(),
      `ud-hdr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const args = ['--silent', '--show-error', '--fail', '--location', '--max-redirs', '5',
      '--connect-timeout', '10', '--max-time', '300',
      '-D', headerFile, '-H', `Range: bytes=${startByte}-${endByte}`];
    if (iface) args.push('--interface', iface);
    args.push(job.url);
    // Each chunk owns one part file, so a stream never needs a file descriptor
    // for the whole download and no space is reserved for ranges not yet seen.
    let partFd;
    try {
      partFd = fs.existsSync(partPath) ? fs.openSync(partPath, 'r+') : fs.openSync(partPath, 'w+');
    } catch (e) {
      return reject(e);
    }
    let fdClosed = false;
    const closePart = () => {
      if (fdClosed) return;
      fdClosed = true;
      try { fs.closeSync(partFd); } catch {}
    };
    const proc = spawn('curl.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let pending = 0;
    let writeError = null;
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.on('data', (d) => {
      if (job.cancelled) { proc.kill(); return; }
      (async () => {
        pending++;
        try {
          await acquireTokens(d.length, slot.id);
          if (job.cancelled) { proc.kill(); return; }
          const pos = chunk.downloaded; // offset inside this chunk's part file
          chunk.downloaded += d.length; // reserve the position before awaiting
          const bytesWritten = await new Promise((resolve, reject) => {
            fs.write(partFd, d, 0, d.length, pos, (err, written) => err ? reject(err) : resolve(written));
          });
          if (bytesWritten !== d.length) throw new Error('short write to disk');
          if (!connSpeeds.has(slot.id)) connSpeeds.set(slot.id, { bytes: 0, speed: 0 });
          connSpeeds.get(slot.id).bytes += d.length;
          // Per-job, per-adapter accounting for the stream controller and for
          // the per-connection readout on the download card.
          job.connBytes.set(slot.id, (job.connBytes.get(slot.id) || 0) + d.length);
        } catch (e) {
          chunk.downloaded = Math.max(0, chunk.downloaded - d.length);
          writeError = e;
          try { proc.kill(); } catch {}
          reject(e);
        } finally {
          pending--;
        }
      })();
    });
    proc.on('close', (code) => {
      (async () => {
        while (pending > 0) await sleep(5);
        closePart();
        let headers = '';
        try { headers = fs.readFileSync(headerFile, 'utf8'); } catch {}
        try { fs.unlinkSync(headerFile); } catch {}
        if (job.cancelled) return resolve();
        if (writeError) return reject(writeError);
        const statusLine = (headers.split(/\r?\n/)[0] || '').trim();
        const statusMatch = /^HTTP\/\S+\s+(\d{3})/.exec(statusLine);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        if (code === 0) {
          // Verify the server really honoured the byte range.
          if (status === 200) return reject(new Error('server ignored Range (HTTP 200)'));
          const cr = /content-range:\s*bytes\s+(\d+)-(\d+)\//i.exec(headers);
          if (cr && parseInt(cr[1], 10) !== startByte) {
            return reject(new Error(`range mismatch: server sent ${cr[1]}, wanted ${startByte}`));
          }
          if (chunk.downloaded < expected) return reject(new Error('incomplete chunk'));
          return resolve();
        }
        if (chunk.downloaded >= expected) return resolve(); // server closed after full data
        if (status >= 400) return reject(new Error(httpMessage(status)));
        reject(new Error('curl exit ' + code + ' ' + stderr.trim()));
      })();
    });
    proc.on('error', (e) => { closePart(); reject(e); });
  });
  try {
    await attempt(conn.localAddress);
  } catch (e) {
    // fallback to the default interface (e.g. VPN/virtual adapter in the way)
    await attempt(null);
  }
}

function emitProgress(id, downloaded, total, conns) {
  const job = jobs.get(id);
  const speed = job ? computeSpeed(job, downloaded) : 0;
  emit('download:progress', { id, downloaded, total, speed, conns: conns || null });
}

function computeSpeed(job, downloaded) {
  const now = Date.now();
  const dt = (now - job.lastTime) / 1000;
  if (dt >= 1) {
    const db_ = downloaded - job.lastBytes;
    job.lastBytes = downloaded;
    job.lastTime = now;
    const sp = dt > 0 ? db_ / dt : 0;
    job._speed = sp;
    return sp;
  }
  return job._speed || 0;
}

async function pause(id) {
  const job = jobs.get(id);
  if (job) job.paused = true;
  db.updateDownload(id, { status: 'paused' });
  emit('download:update', db.getDownload(id));
}
async function resume(id) {
  const job = jobs.get(id);
  // Only un-pause when the transfer is really still running; after a failure
  // the worker loop has exited and the job has to be started again.
  if (job && job.chunks && job.chunks.length && job.active) {
    job.paused = false;
    db.updateDownload(id, { status: 'downloading' });
    emit('download:update', db.getDownload(id));
    return;
  }
  db.updateDownload(id, { status: 'downloading' });
  await start(id);
  emit('download:update', db.getDownload(id));
}
async function cancel(id) {
  const job = jobs.get(id);
  if (job) job.cancelled = true;
  db.updateDownload(id, { status: 'cancelled' });
  emit('download:update', db.getDownload(id));
}
async function remove(id) {
  const row = db.getDownload(id);
  const wasComplete = row && row.status === 'completed';
  await cancel(id);
  // Finished downloads are only unlisted; their file stays on disk. Partial
  // data from failed/cancelled/queued jobs is useless, so it is deleted.
  if (!wasComplete && row) {
    if (row.savePath) {
      try { fs.unlinkSync(row.savePath); } catch {}
      removePartsDir(partsDirFor(row.savePath, id));
    }
  }
  db.deleteDownload(id);
  jobs.delete(id);
  emit('download:removed', { id });
}

// ---- Refresh an expired download link ----
function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fetchBytes(url, start, end) {
  return new Promise((resolve, reject) => {
    request(url, { headers: { Range: `bytes=${start}-${end}` }, timeout: 30000 })
      .then(({ res }) => {
        const code = res.statusCode || 0;
        if (code >= 400) { res.resume(); return reject(new Error(httpMessage(code))); }
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () => resolve(Buffer.concat(bufs)));
        res.on('error', reject);
      })
      .catch(reject);
  });
}

// Read a completed range's bytes back from disk: the part file if this download
// still has one, otherwise the finished file (older, preallocated jobs).
function readChunkSample(id, savePath, chunk, n) {
  const part = partPathFor(partsDirFor(savePath, id), chunk.idx);
  let file = null, offset = 0;
  if (fileSize(part) >= n) { file = part; offset = 0; }
  else if (fileSize(savePath) >= chunk.start + n) { file = savePath; offset = chunk.start; }
  if (!file) return null;
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(file, 'r');
  try {
    const got = fs.readSync(fd, buf, 0, n, offset);
    return got === n ? buf : null;
  } finally {
    fs.closeSync(fd);
  }
}

// Point an interrupted download at a fresh link without losing what it already
// downloaded. The file is verified first (size + a byte-for-byte sample of a
// completed range), so a different file can never be spliced into the partial.
async function refreshLink(id, newUrl) {
  const row = db.getDownload(id);
  if (!row) throw new Error('download not found');
  const url = String(newUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('enter a valid http(s) link');
  if (row.status === 'downloading' || row.status === 'assembling') {
    throw new Error('pause the download before refreshing its link');
  }

  const info = await headInfo(url);
  if (!info.acceptRanges) throw new Error('this link does not support resuming (no range requests)');
  if (row.totalSize > 0 && info.size !== row.totalSize) {
    throw new Error(`different file: this link is ${humanSize(info.size)}, ` +
      `the partial download is ${humanSize(row.totalSize)}`);
  }

  const chunks = db.getChunks(id);
  const done = chunks.filter((c) => c.status === 'completed');
  if (done.length && row.savePath) {
    const c = done[Math.floor(done.length / 2)];
    const n = Math.min(65536, c.end - c.start + 1);
    const local = readChunkSample(id, row.savePath, c, n);
    if (local) {
      const fresh = await fetchBytes(url, c.start, c.start + n - 1);
      if (fresh.length < n || !fresh.subarray(0, n).equals(local)) {
        throw new Error('the new link serves different content — refusing to merge it into the existing file');
      }
    }
  }

  // Drop the cached job so resume() re-reads the URL from the database, but
  // keep its saveDir (the folder chosen when the download was added).
  const cached = jobs.get(id);
  if (cached) {
    cached.chunks = [];
    cached.paused = true;
    cached.cancelled = false;
  } else {
    jobs.delete(id);
  }
  db.updateDownload(id, { url, totalSize: info.size, status: 'paused', error: null });
  for (const c of chunks) if (c.status === 'failed') db.updateChunk(c.id, { status: 'pending' });
  const out = db.getDownload(id);
  emit('download:update', out);
  return { ...out, verified: true };
}

module.exports = { init, addJob, start, pause, resume, cancel, remove, refreshLink, invalidateLimits, planChunks, planRanges };
