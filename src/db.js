const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const fs = require('fs');

let db = null;

function dbPath() {
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ultra.db');
}

function init() {
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT,
      localAddress TEXT,
      interfaceIndex INTEGER,
      enabled INTEGER DEFAULT 1,
      capKbps INTEGER DEFAULT 0,
      lastSpeed REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      filename TEXT,
      savePath TEXT,
      totalSize INTEGER DEFAULT 0,
      downloaded INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      connections INTEGER DEFAULT 1,
      createdAt INTEGER,
      updatedAt INTEGER,
      error TEXT,
      etag TEXT,
      lastModified TEXT,
      acceptRanges INTEGER DEFAULT 0,
      partsDir TEXT,
      activeMs INTEGER DEFAULT 0,
      finishedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      downloadId INTEGER,
      idx INTEGER,
      start INTEGER,
      end INTEGER,
      downloaded INTEGER DEFAULT 0,
      connectionId TEXT,
      status TEXT DEFAULT 'pending',
      FOREIGN KEY(downloadId) REFERENCES downloads(id) ON DELETE CASCADE
    );
  `);
  // Part files used to always live next to the destination file; the folder is
  // now configurable, so each download records where its own parts are kept.
  const cols = db.prepare('PRAGMA table_info(downloads)').all().map((c) => c.name);
  if (!cols.includes('partsDir')) {
    db.exec('ALTER TABLE downloads ADD COLUMN partsDir TEXT');
    const legacy = db.prepare('SELECT id, savePath FROM downloads WHERE savePath IS NOT NULL').all();
    const upd = db.prepare('UPDATE downloads SET partsDir=? WHERE id=?');
    db.transaction(() => {
      for (const r of legacy) upd.run(path.join(path.dirname(r.savePath), '.ud-parts', String(r.id)), r.id);
    })();
  }
  if (!cols.includes('activeMs')) db.exec('ALTER TABLE downloads ADD COLUMN activeMs INTEGER DEFAULT 0');
  // Time actually spent transferring (pauses excluded) and when it finished.
  if (!cols.includes('finishedAt')) db.exec('ALTER TABLE downloads ADD COLUMN finishedAt INTEGER');
  // default settings
  const defaults = {
    downloadDir: path.join(app.getPath('downloads'), 'UltraDownloader'),
    // Empty means "keep the temporary chunk files next to the download".
    tempDir: '',
    maxConcurrentJobs: '3',
    chunkSizeMB: '32',
    // Big chunks keep a TLS connection alive for ~a minute instead of ~1s,
    // which cuts handshake/TCP-slow-start churn on long transfers.
    maxChunkSizeMB: '512',
    targetStreams: '4',
    maxStreamsPerConnection: '32',
    maxConnectionsPerDownload: '4',
    globalSpeedLimitKbps: '0',
    speedUnit: 'mbps',
    // 1.1.0 ships the bridge code but keeps the browser feature disabled until
    // the signed Firefox extension is available.
    browserBridgeEnabled: '0',
    autoCheckUpdates: '1',
    updateSkipVersion: '',
    updateLastCheck: ''
  };
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);
  // One-off migration: earlier builds shipped a 64 MB chunk ceiling.
  if (!db.prepare("SELECT value FROM settings WHERE key='mig_chunk512'").get()) {
    db.prepare("UPDATE settings SET value='512' WHERE key='maxChunkSizeMB' AND value='64'").run();
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('mig_chunk512','1')").run();
  }
}

function getSettings() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
function setSettings(s) {
  const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction((obj) => { for (const [k, v] of Object.entries(obj)) up.run(k, String(v)); });
  tx(s);
  return getSettings();
}

function listDownloads() {
  return db.prepare('SELECT * FROM downloads ORDER BY id DESC').all();
}
function getDownload(id) { return db.prepare('SELECT * FROM downloads WHERE id=?').get(id); }
function createDownload(d) {
  const info = db.prepare(`INSERT INTO downloads(url,filename,savePath,totalSize,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)`)
    .run(d.url, d.filename, d.savePath, d.totalSize || 0, 'queued', Date.now(), Date.now());
  return info.lastInsertRowid;
}
function updateDownload(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = keys.map(k => `${k}=?`).join(',');
  try {
    db.prepare(`UPDATE downloads SET ${set}, updatedAt=? WHERE id=?`).run(...keys.map(k => patch[k]), Date.now(), id);
  } catch (e) {
    console.error('updateDownload err', id, JSON.stringify(patch), e.message);
    throw e;
  }
}
function deleteDownload(id) {
  db.prepare('DELETE FROM chunks WHERE downloadId=?').run(id);
  db.prepare('DELETE FROM downloads WHERE id=?').run(id);
}
function getChunks(downloadId) { return db.prepare('SELECT * FROM chunks WHERE downloadId=? ORDER BY idx').all(downloadId); }
function replaceChunks(downloadId, chunks) {
  db.prepare('DELETE FROM chunks WHERE downloadId=?').run(downloadId);
  const ins = db.prepare('INSERT INTO chunks(downloadId,idx,start,end,downloaded,connectionId,status) VALUES(?,?,?,?,?,?,?)');
  const tx = db.transaction((arr) => { for (const c of arr) ins.run(downloadId, c.idx, c.start, c.end, c.downloaded || 0, c.connectionId || null, c.status || 'pending'); });
  tx(chunks);
}
function updateChunk(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = keys.map(k => `${k}=?`).join(',');
  try {
    db.prepare(`UPDATE chunks SET ${set} WHERE id=?`).run(...keys.map(k => patch[k]), id);
  } catch (e) {
    console.error('updateChunk err', id, JSON.stringify(patch), e.message);
    throw e;
  }
}

function listConnections() { return db.prepare('SELECT * FROM connections').all(); }
function upsertConnection(c) {
  db.prepare(`INSERT INTO connections(id,name,localAddress,interfaceIndex,enabled,capKbps,lastSpeed) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, localAddress=excluded.localAddress, interfaceIndex=excluded.interfaceIndex`).run(
    c.id, c.name, c.localAddress, c.interfaceIndex, c.enabled ? 1 : 0, c.capKbps || 0, c.lastSpeed || 0);
}
function setConnectionEnabled(id, enabled) { db.prepare('UPDATE connections SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id); }
function setConnectionCap(id, cap) { db.prepare('UPDATE connections SET capKbps=? WHERE id=?').run(cap, id); }

module.exports = {
  init, getSettings, setSettings,
  listDownloads, getDownload, createDownload, updateDownload, deleteDownload,
  getChunks, replaceChunks, updateChunk,
  listConnections, upsertConnection, setConnectionEnabled, setConnectionCap
};
