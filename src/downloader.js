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
// Destination paths already claimed by a row, even before the file exists.
// Seeded from the database on startup and kept until the row is removed.
const reservedSavePaths = new Map(); // download id -> savePath

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

// Chunk retries: a flaky link gets several chances with growing delays before
// the whole job is declared failed. The part file keeps whatever arrived, so a
// retry only fetches the missing tail of that range.
const MAX_CHUNK_RETRIES = 5;
// Free space that is never allowed to be consumed: room for part-file writes,
// the assembly copy and Windows itself.
const DISK_RESERVE_BYTES = 128 * 1024 * 1024;

// Set by "Pause all": running transfers stop and queued ones stay parked until
// the user presses "Resume all".
let queuePaused = false;

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
  try {
    for (const r of db.listDownloads()) {
      if (r.savePath) reservedSavePaths.set(r.id, r.savePath);
    }
  } catch {}
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

function uniquePath(dir, name, id) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const taken = (p) => {
    if (fs.existsSync(p)) return true;
    // Another row (queued/running/failed) may not have created its file yet,
    // so also treat its future path as taken. Without this, two simultaneous
    // downloads of the same filename pick the same name and overwrite.
    const key = path.resolve(p).toLowerCase();
    for (const [otherId, otherPath] of reservedSavePaths) {
      if (otherId !== id && path.resolve(otherPath).toLowerCase() === key) return true;
    }
    return false;
  };
  let full = path.join(dir, name);
  if (!taken(full)) return full;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let i = 1;
  while (taken(path.join(dir, `${stem} (${i})${ext}`))) i++;
  return path.join(dir, `${stem} (${i})${ext}`);
}

// ---- On-disk layout -------------------------------------------------------
// Chunks are written to small part files inside a hidden per-download folder.
// The finished file is only built once every range is complete, so a 70 GB
// download occupies ~70 GB while it runs instead of reserving the full size
// up front and then filling it.
const PARTS_DIRNAME = '.ud-parts';

function partsDirFor(savePath, id) {
  // Settings may point the temporary chunk files at their own folder — handy
  // when the download drive is small. Empty means "next to the destination",
  // which keeps assembling a plain local copy.
  let base = '';
  try { base = String(db.getSettings().tempDir || '').trim(); } catch {}
  return path.join(base || path.dirname(savePath), PARTS_DIRNAME, String(id));
}
// Prefer the folder recorded on the row: it survives restarts and setting
// changes, so resume/cancel always find the parts that actually exist.
function partsDirForRow(row, id) {
  if (row && row.partsDir) return row.partsDir;
  return partsDirFor(row && row.savePath, id);
}
function partPathFor(dir, idx) { return path.join(dir, `${idx}.part`); }
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function ensurePartsDir(savePath, id) {
  return ensureDir(partsDirFor(savePath, id));
}
function removePartsDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  // Drop the shared .ud-parts folder once no download is using it.
  try {
    const parent = path.dirname(dir);
    if (path.basename(parent) === PARTS_DIRNAME && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  } catch {}
}
function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

// ---- Free-space checks -----------------------------------------------------
function volumeRoot(p) {
  try {
    const root = path.parse(path.resolve(p)).root;
    return process.platform === 'win32' ? root.toUpperCase() : root;
  } catch { return ''; }
}
function freeBytes(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const sf = fs.statfsSync(dir);
    return Number(sf.bavail) * Number(sf.bsize);
  } catch { return null; }
}
function sameVolume(a, b) {
  const ra = volumeRoot(a), rb = volumeRoot(b);
  return !!ra && ra === rb;
}

// Refuse to start a transfer that cannot possibly fit. Downloads write chunks
// to the temp folder first and then build the final file next to the
// destination, so both volumes matter:
//   same volume      -> remaining data + room for one part during assembly
//   different volume -> remaining data on temp, one part on the destination
// A single-stream download only needs a rename (metadata), not a copy, unless
// the temp folder is on another volume — in that case the whole file has to be
// copied across.
function ensureDiskSpace({ savePath, partsDir, remaining, assemblePart, singleCopy }) {
  try { fs.mkdirSync(partsDir, { recursive: true }); } catch {}
  const destDir = path.dirname(savePath);
  const partsFree = freeBytes(partsDir);
  if (partsFree == null) return; // unmeasurable (some network shares) — let it try
  const remainingBytes = Math.max(0, Number(remaining) || 0);
  const reserve = DISK_RESERVE_BYTES;
  const same = sameVolume(partsDir, destDir);

  if (same) {
    const extra = singleCopy ? 0 : Math.max(0, Number(assemblePart) || 0);
    const need = remainingBytes + extra + reserve;
    if (partsFree < need) {
      throw new Error(`not enough free space — about ${humanSize(need)} is needed on ` +
        `${volumeRoot(partsDir) || 'the download drive'}, but only ${humanSize(partsFree)} is available`);
    }
    return;
  }

  const partsNeed = remainingBytes + reserve;
  if (partsFree < partsNeed) {
    throw new Error(`not enough free space for temporary files — about ${humanSize(partsNeed)} ` +
      `is needed on ${volumeRoot(partsDir) || 'the temporary drive'}, but only ${humanSize(partsFree)} is available`);
  }
  const destFree = freeBytes(destDir);
  const destNeed = (singleCopy ? remainingBytes : Math.max(0, Number(assemblePart) || 0)) + reserve;
  if (destFree != null && destFree < destNeed) {
    throw new Error(`not enough free space for the finished file — about ${humanSize(destNeed)} ` +
      `is needed on ${volumeRoot(destDir) || 'the download drive'}, but only ${humanSize(destFree)} is available`);
  }
}

function moveIntoPlace(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Temp folder on another drive: copy across, then drop the part.
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

// ---- Time accounting -------------------------------------------------------
// Only time actually spent fetching/building the file counts: pausing stops the
// clock and resuming starts it again, so a download parked overnight does not
// wreck its average speed.
function clockStart(job) {
  if (!job.activeSince) job.activeSince = Date.now();
}
function clockElapsed(job) {
  return (job.activeMs || 0) + (job.activeSince ? Date.now() - job.activeSince : 0);
}
function clockStop(job, id) {
  if (job.activeSince) {
    job.activeMs = (job.activeMs || 0) + (Date.now() - job.activeSince);
    job.activeSince = null;
  }
  if (id) db.updateDownload(id, { activeMs: Math.round(job.activeMs || 0) });
  return job.activeMs || 0;
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
    const takenMs = clockStop(job, null);
    db.updateDownload(id, {
      status: 'completed', downloaded: totalSize, error: null,
      activeMs: Math.round(takenMs), finishedAt: Date.now()
    });
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
  // Start it right away if a slot is free; otherwise it waits its turn.
  pumpQueue();
  return id;
}

// ---- Queue -----------------------------------------------------------------
// `maxConcurrentJobs` used to be a setting that nothing read: every link began
// downloading the moment it was added. The queue below is the single place that
// decides when a job may start, so the limit is honoured and extra links wait
// their turn instead of competing for bandwidth.
function maxConcurrentJobs() {
  const n = parseInt(db.getSettings().maxConcurrentJobs, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(10, n) : 3;
}

function activeJobCount() {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.active && !job.paused && !job.cancelled) n++;
  }
  return n;
}

function queueState() {
  let rows = [];
  try { rows = db.listDownloads(); } catch {}
  return {
    paused: queuePaused,
    active: rows.filter((r) => r.status === 'downloading' || r.status === 'assembling').length,
    queued: rows.filter((r) => r.status === 'queued').length,
    pausedJobs: rows.filter((r) => r.status === 'paused').length,
    max: maxConcurrentJobs()
  };
}

function emitQueueState() {
  emit('queue:update', queueState());
}

// Start as many queued downloads as the concurrency limit allows. Jobs that
// were paused mid-flight still have live (sleeping) workers, so the scheduler
// wakes those instead of starting a second worker loop for the same file.
function pumpQueue() {
  if (queuePaused) { emitQueueState(); return; }
  let guard = 0;
  while (guard++ < 100) {
    if (activeJobCount() >= maxConcurrentJobs()) break;
    const next = db.listDownloads()
      .filter((r) => r.status === 'queued')
      .sort((a, b) => a.id - b.id)[0];
    if (!next) break;
    const running = jobs.get(next.id);
    if (running && running.active) {
      running.paused = false;
      running.cancelled = false;
      clockStart(running);
      db.updateDownload(next.id, { status: 'downloading' });
      emit('download:update', db.getDownload(next.id));
      continue;
    }
    start(next.id).catch(() => {});
  }
  emitQueueState();
}

// User-initiated start/resume. If every slot is busy the download simply stays
// queued (and is picked up automatically when a slot frees).
function requestStart(id) {
  const row = db.getDownload(id);
  if (!row) return { started: false, error: 'download not found' };
  if (row.status === 'completed') return { started: false, completed: true };

  const running = jobs.get(id);
  if (running && running.active) {
    if (!running.paused) return { started: true };
    if (queuePaused || activeJobCount() >= maxConcurrentJobs()) {
      db.updateDownload(id, { status: 'queued' });
      emit('download:update', db.getDownload(id));
      emitQueueState();
      return { queued: true };
    }
    running.paused = false;
    running.cancelled = false;
    clockStart(running);
    db.updateDownload(id, { status: 'downloading' });
    emit('download:update', db.getDownload(id));
    pumpQueue();
    return { started: true };
  }

  if (queuePaused || activeJobCount() >= maxConcurrentJobs()) {
    db.updateDownload(id, { status: 'queued' });
    emit('download:update', db.getDownload(id));
    emitQueueState();
    return { queued: true };
  }
  start(id).catch(() => {});
  return { started: true };
}

// After a restart, anything that was mid-transfer goes back into the queue so
// the limit is honoured. Downloads that only needed their final file built are
// resumed immediately: that needs no network and no queue slot.
function autostart() {
  let rows = [];
  try { rows = db.listDownloads(); } catch { return; }
  for (const r of rows) {
    if (r.status === 'downloading') db.updateDownload(r.id, { status: 'queued' });
  }
  for (const r of rows) {
    if (r.status === 'assembling') start(r.id).catch(() => {});
  }
  pumpQueue();
}

// Stop every live transfer for an app exit. Unlike pauseAll(), this must not
// write a "paused" status: an installer update or a later reinstall should see
// the download as interrupted and resume it from the part files. Active time is
// flushed first so it survives the restart.
function shutdown() {
  queuePaused = true;
  for (const [id, job] of jobs.entries()) {
    if (!job.active || job.cancelled) continue;
    job.paused = true;
    try { clockStop(job, id); } catch {}
  }
}

function pauseAll() {
  queuePaused = true;
  let paused = 0;
  const seen = new Set();
  // Pause every live transfer, including jobs still resolving their HEAD
  // request (their row is still "queued" at that moment).
  for (const [id, job] of jobs.entries()) {
    if (!job.active || job.cancelled || job.paused) continue;
    const row = db.getDownload(id);
    if (!row || row.status === 'completed' || row.status === 'assembling') continue;
    job.paused = true;
    clockStop(job, id);
    db.updateDownload(id, { status: 'paused' });
    emit('download:update', db.getDownload(id));
    seen.add(id);
    paused++;
  }
  for (const r of db.listDownloads()) {
    if (r.status !== 'downloading' || seen.has(r.id)) continue;
    db.updateDownload(r.id, { status: 'paused' });
    emit('download:update', db.getDownload(r.id));
    paused++;
  }
  emitQueueState();
  return { paused, ...queueState() };
}

function resumeAll() {
  queuePaused = false;
  let resumed = 0;
  for (const r of db.listDownloads()) {
    if (r.status !== 'paused') continue;
    db.updateDownload(r.id, { status: 'queued' });
    emit('download:update', db.getDownload(r.id));
    resumed++;
  }
  pumpQueue();
  return { resumed, ...queueState() };
}

async function start(id) {
  const row = db.getDownload(id);
  if (!row) return;
  let job = jobs.get(id);
  if (job && job.active) {
    // Never run two worker loops for one download (e.g. the user presses
    // Start twice, or the queue wakes a job that is already running).
    if (job.paused && !queuePaused && activeJobCount() < maxConcurrentJobs()) {
      job.paused = false;
      job.cancelled = false;
      clockStart(job);
      db.updateDownload(id, { status: 'downloading' });
      emit('download:update', db.getDownload(id));
    }
    return;
  }
  if (!job) {
    job = { id, url: row.url, saveDir: db.getSettings().downloadDir, paused: false, cancelled: false, chunks: [], startedAt: null };
    jobs.set(id, job);
  }
  job.diskLow = null;
  job.assemblePart = 0;
  job.singleCopy = false;
  job.url = row.url;
  job.paused = false;
  job.cancelled = false;
  job.active = true;
  // Carry the time already spent on this download into the new run.
  job.activeMs = Math.max(job.activeMs || 0, row.activeMs || 0);
  job.activeSince = null;
  clockStart(job);

  try {
    // Everything is already on disk (the app quit while the final file was
    // being built, for example). Build it without touching the network: the
    // link may be long dead by now.
    const existing = db.getChunks(id);
    if (existing.length > 0 && row.totalSize > 0 && row.savePath &&
        existing.every((c) => c.status === 'completed')) {
      job.partsDir = partsDirForRow(row, id);
      job.savePath = row.savePath;
      job.totalSize = row.totalSize;
      if (fileSize(row.savePath) === row.totalSize) {
        removePartsDir(job.partsDir);
        db.updateDownload(id, {
          status: 'completed', downloaded: row.totalSize, error: null,
          activeMs: Math.round(job.activeMs), finishedAt: row.finishedAt || Date.now()
        });
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
    const savePath = row.savePath || uniquePath(dir, filename, id);
    reservedSavePaths.set(id, savePath);
    const totalSize = info.size;
    const acceptRanges = info.acceptRanges;

    // The user may have pressed Pause while the HEAD request was in flight.
    // Honour it before any data is written, instead of overwriting the paused
    // state with "downloading" a moment later.
    if (job.paused && !job.cancelled) {
      db.updateDownload(id, { status: 'paused' });
      emit('download:update', db.getDownload(id));
      return;
    }

    db.updateDownload(id, { filename, savePath, totalSize, acceptRanges: acceptRanges ? 1 : 0, status: 'downloading', error: null });
    emit('download:update', db.getDownload(id));

    // Parts sit in the configured temporary folder (or next to the destination
    // when none is set). A resumed download keeps using the folder it already
    // wrote to, even if the setting was changed since.
    const partsDir = row.partsDir ? ensureDir(row.partsDir) : ensurePartsDir(savePath, id);
    job.partsDir = partsDir;
    // Pin the folder on the row so a later resume (even after the setting is
    // changed) still points at the part files that were really written.
    db.updateDownload(id, { partsDir });

    // Fail fast with a readable message instead of downloading for hours and
    // then running out of space. The assembly needs one extra part of
    // headroom on the destination volume.
    const doneBytes = db.getChunks(id).reduce((a, c) => a + (c.downloaded || 0), 0);
    const spaceSettings = db.getSettings();
    const maxPartBytes = Math.max(1, parseFloat(spaceSettings.maxChunkSizeMB) || 512) * 1024 * 1024;
    job.assemblePart = Math.min(totalSize, maxPartBytes);
    job.singleCopy = !acceptRanges;
    ensureDiskSpace({
      savePath,
      partsDir,
      remaining: Math.max(0, totalSize - doneBytes),
      assemblePart: job.assemblePart,
      singleCopy: job.singleCopy
    });

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
      // Fallback to a single stream; if the temp folder is on another drive,
      // the finished file is copied across, so check that space too.
      job.singleCopy = true;
      ensureDiskSpace({ savePath, partsDir, remaining: totalSize, assemblePart: 0, singleCopy: true });
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
    const message = (e && e.message) || String(e);
    if (job.cancelled) {
      // cancel() already set the final state and removed the partial data.
    } else if (job.paused) {
      db.updateDownload(id, { status: 'paused' });
      emit('download:update', db.getDownload(id));
    } else {
      db.updateDownload(id, { status: 'failed', error: message });
      emit('download:update', db.getDownload(id));
      emit('download:error', { id, error: message });
    }
  } finally {
    // Freeze the clock for whatever stopped the transfer (done, paused, failed
    // or cancelled); the stored total only ever holds active transfer time.
    clockStop(job, id);
    job.active = false;
    // A finished/failed job frees its queue slot; let the next link start.
    setTimeout(() => { try { pumpQueue(); } catch {} }, 0);
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
  let streamError = null;
  let lastSpaceCheck = 0;
  const checkSpace = () => {
    if (job.diskLow) throw job.diskLow;
    const now = Date.now();
    if (now - lastSpaceCheck < 5000) return;
    lastSpaceCheck = now;
    const free = freeBytes(partsDir);
    if (free != null && free < DISK_RESERVE_BYTES) {
      job.diskLow = new Error(`not enough free space on ${volumeRoot(partsDir) || 'the temporary drive'} — free some space, then click Retry`);
      throw job.diskLow;
    }
  };
  res.on('data', (d) => {
    if (job.cancelled || job.diskLow) { try { res.destroy(); } catch {} return; }
    res.pause();
    (async () => {
      try {
        checkSpace();
        await acquireTokens(d.length, null);
        while (job.paused && !job.cancelled && !job.diskLow) await sleep(200);
        if (job.cancelled || job.diskLow) { try { res.destroy(); } catch {} return; }
        downloaded += d.length;
        ws.write(d);
        db.updateDownload(id, { downloaded });
        emitProgress(id, downloaded, totalSize || 0);
      } catch (e) {
        streamError = streamError || e;
        try { res.destroy(); } catch {}
      }
      if (!job.cancelled && !job.diskLow) res.resume();
    })();
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (settled) return; settled = true; fn(value); };
    res.on('end', () => ws.end(() => done(resolve)));
    res.on('error', (e) => done(reject, e));
    res.on('close', () => {
      if (job.cancelled) { try { ws.end(); } catch {} done(resolve); }
      else if (!res.complete) done(reject, new Error('connection closed before the file finished'));
    });
    ws.on('error', (e) => done(reject, e));
  });
  if (streamError) throw streamError;
  if (job.diskLow) throw job.diskLow;
  if (job.cancelled) {
    try { ws.end(); } catch {}
    removePartsDir(partsDir);
    db.updateDownload(id, { status: 'cancelled' });
  } else {
    try { fs.rmSync(savePath, { force: true }); } catch {}
    moveIntoPlace(partPath, savePath);
    removePartsDir(partsDir);
    const takenMs = clockStop(job, null);
    db.updateDownload(id, {
      status: 'completed', downloaded: totalSize,
      activeMs: Math.round(takenMs), finishedAt: Date.now()
    });
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

  // Low-space guard. Preflight only knows the size at the start; another
  // program can fill the drive while a big transfer runs. Stop cleanly (keeping
  // the parts) instead of letting every stream fail with a raw ENOSPC.
  let lastSpaceCheck = 0;
  const spaceThreshold = () => {
    const same = sameVolume(job.partsDir || partsDirFor(savePath, id), path.dirname(savePath));
    return DISK_RESERVE_BYTES + (same ? (job.assemblePart || 0) : 0);
  };
  const spaceCheck = () => {
    if (job.diskLow) return;
    const now = Date.now();
    if (now - lastSpaceCheck < 5000) return;
    lastSpaceCheck = now;
    const dir = job.partsDir || partsDirFor(savePath, id);
    const free = freeBytes(dir);
    if (free != null && free < spaceThreshold()) {
      job.diskLow = new Error(`not enough free space on ${volumeRoot(dir) || 'the temporary drive'} — free some space, then click Retry`);
    }
  };

  const ticker = setInterval(() => {
    if (job.cancelled || job.paused) return;
    spaceCheck();
    const downloaded = bytesDone();
    // Keep the running clock in the database too: if the app is killed, resume
    // continues from the last tick instead of starting the timer over.
    db.updateDownload(id, { downloaded, activeMs: Math.round(clockElapsed(job)) });
    emitProgress(id, downloaded, totalSize, connSnapshot());
  }, 500);

  while (running.size > 0) {
    await Promise.race(Array.from(running));
  }
  clearInterval(ramp);
  clearInterval(ticker);

  if (job.cancelled) {
    // Cancel discards the partial transfer: delete the temp parts and any
    // partial destination file now that the streams have stopped.
    removePartsDir(job.partsDir || partsDirFor(savePath, id));
    try { fs.rmSync(savePath, { force: true }); } catch {}
    db.updateDownload(id, { status: 'cancelled', downloaded: 0 });
    emit('download:update', db.getDownload(id));
    return;
  }

  if (job.diskLow) {
    const downloaded = bytesDone();
    db.updateDownload(id, { status: 'failed', downloaded, error: job.diskLow.message });
    emit('download:update', db.getDownload(id));
    emit('download:error', { id, error: job.diskLow.message });
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

function isRetryableError(e) {
  const status = e && e.httpStatus;
  if (!status) return true; // network reset, timeout, short read, ...
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

async function workerLoop(slot, job, id, pending, ctl) {
  while (true) {
    if (job.cancelled || job.diskLow) return;
    // The per-adapter controller can shrink a link's budget when an extra
    // stream did not pay off. Retire surplus workers here, before they claim
    // another chunk, so the change takes effect without killing a transfer.
    if (ctl && (ctl.perSlot.get(slot.id) || 0) > (ctl.budget.get(slot.id) || 1)) return;
    // wait while paused
    while (job.paused && !job.cancelled && !job.diskLow) {
      await sleep(200);
    }
    if (job.cancelled || job.diskLow) return;
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
      if (job.diskLow) { chunk.status = 'pending'; return; }
      if (job.paused) { chunk.status = 'pending'; continue; }
      chunk.retries = (chunk.retries || 0) + 1;
      if (chunk.retries > MAX_CHUNK_RETRIES || !isRetryableError(e)) {
        chunk.status = 'failed';
        db.updateChunk(chunk.dbId, { downloaded: chunk.downloaded || 0, status: 'failed' });
      } else {
        // Keep partial progress; downloadChunk resumes from chunk.downloaded.
        // Growing delays give a flaky link time to recover without hammering
        // it, and the jitter avoids every stream retrying in lockstep.
        chunk.status = 'pending';
        const wait = Math.min(30000, 1000 * Math.pow(2, chunk.retries - 1));
        await sleep(wait + Math.floor(Math.random() * 500));
      }
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
      if (job.cancelled || job.diskLow || job.paused) { proc.kill(); return; }
      (async () => {
        pending++;
        try {
          await acquireTokens(d.length, slot.id);
          if (job.cancelled || job.diskLow || job.paused) { proc.kill(); return; }
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
          if (e && e.code === 'ENOSPC') {
            job.diskLow = new Error(`not enough free space on ${volumeRoot(job.partsDir) || 'the temporary drive'} — free some space, then click Retry`);
          }
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
        if (job.diskLow) return reject(job.diskLow);
        if (job.paused) return reject(Object.assign(new Error('paused'), { paused: true }));
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
        if (status >= 400) {
          const err = new Error(httpMessage(status));
          err.httpStatus = status;
          return reject(err);
        }
        reject(new Error('curl exit ' + code + ' ' + stderr.trim()));
      })();
    });
    proc.on('error', (e) => { closePart(); reject(e); });
  });
  try {
    await attempt(conn.localAddress);
  } catch (e) {
    // Stop-conditions are not worth a second attempt on another interface.
    if (job.cancelled || job.paused || job.diskLow || (e && e.paused)) throw e;
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
  const row = db.getDownload(id);
  if (!row || row.status === 'assembling' || row.status === 'completed') return { paused: false };
  const job = jobs.get(id);
  if (job) {
    job.paused = true;
    // Stop the clock the moment the user pauses, not when the streams drain.
    clockStop(job, id);
  }
  db.updateDownload(id, { status: 'paused' });
  emit('download:update', db.getDownload(id));
  // A paused job no longer occupies a queue slot; let the next link start.
  if (!queuePaused) pumpQueue(); else emitQueueState();
  return { paused: true };
}
async function resume(id) {
  const row = db.getDownload(id);
  if (!row) return { started: false };
  const job = jobs.get(id);
  if (job && job.active && !job.paused) {
    db.updateDownload(id, { status: 'downloading' });
    emit('download:update', db.getDownload(id));
    return { started: true };
  }
  // The queue decides whether there is room; if not, the job waits as queued.
  return requestStart(id);
}
async function cancel(id) {
  const job = jobs.get(id);
  const row = db.getDownload(id);
  if (job) {
    job.cancelled = true;
    clockStop(job, id);
  }
  db.updateDownload(id, { status: 'cancelled' });
  emit('download:update', db.getDownload(id));
  // A running worker loop cleans up after its streams stop. When nothing is
  // running (failed, queued, or paused before an app restart) delete the
  // partial data here so Cancel never leaves chunks behind. Completed rows are
  // never touched by cancel.
  if ((!job || !job.active) && row && row.status !== 'completed' && row.savePath) {
    try { fs.rmSync(row.savePath, { force: true }); } catch {}
    removePartsDir(partsDirForRow(row, id));
  }
  // The slot was free already if nothing was running; a running job frees it
  // from start()'s finally block once its streams have drained.
  if (!job || !job.active) pumpQueue(); else emitQueueState();
}
async function remove(id, opts = {}) {
  const row = db.getDownload(id);
  const wasComplete = row && row.status === 'completed';
  await cancel(id);
  if (row && row.savePath) {
    // Partial data from failed/cancelled/queued downloads is useless without
    // the download, so it is removed outright. Finished files are never
    // touched here: when the user asks to delete one, main.js moves it to the
    // Recycle Bin so a mistaken delete stays recoverable.
    if (!wasComplete) {
      try { fs.rmSync(row.savePath, { force: true }); } catch {}
    }
    removePartsDir(partsDirForRow(row, id));
  }
  db.deleteDownload(id);
  jobs.delete(id);
  reservedSavePaths.delete(id);
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
function readChunkSample(row, chunk, n) {
  const part = partPathFor(partsDirForRow(row, row.id), chunk.idx);
  let file = null, offset = 0;
  if (fileSize(part) >= n) { file = part; offset = 0; }
  else if (fileSize(row.savePath) >= chunk.start + n) { file = row.savePath; offset = chunk.start; }
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
    const local = readChunkSample(row, c, n);
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
  emitQueueState();
  return { ...out, verified: true };
}

module.exports = {
  init, addJob, start, pause, resume, cancel, remove, refreshLink,
  requestStart, pumpQueue, autostart, pauseAll, resumeAll, shutdown, queueState,
  invalidateLimits, planChunks, planRanges
};
