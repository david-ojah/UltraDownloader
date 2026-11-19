const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const db = require('./src/db');
const connections = require('./src/connections');
const downloader = require('./src/downloader');
const bridge = require('./src/bridge');
const updater = require('./src/updater');

// The package version is kept semver-valid; displayVersion is an optional
// user-facing label for revisions such as 1.0.1R1.
const APP_VERSION_LABEL = require('./package.json').displayVersion || app.getVersion();

// Must be set early: Windows uses the AppUserModelID to resolve the Start Menu
// shortcut (and therefore the app name/icon) shown in toast notifications.
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.ultradownloader.app'); } catch {}
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}
function humanDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function logDeletion(entry) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
    fs.appendFileSync(path.join(dir, 'deleted.log'), line);
  } catch {}
}


let mainWindow = null;
let tray = null;
// Set when the user really quits (tray → Quit), so the close-to-tray handler
// lets the window go instead of hiding it forever.
let quitting = false;
let quitTimer = null;
// Declared before the before-quit handler is registered: a second launch calls
// app.quit() during module load, which fires that handler immediately.
let powerBlockerId = null;
app.on('before-quit', () => {
  quitting = true;
  try { bridge.stop(); } catch {}
  // Stop live transfers without changing their saved status: a later launch
  // sees them as interrupted and resumes from the part files.
  try { downloader.shutdown(); } catch {}
  if (powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId); } catch {}
    powerBlockerId = null;
  }
});

// ---- Single instance -------------------------------------------------------
// The app keeps running in the tray after its window closes, so a second launch
// must wake the existing copy instead of starting another background instance
// (each extra instance meant another tray icon and another process on the same
// database).
const singleInstanceLock = app.requestSingleInstanceLock();
const quitRequested = process.argv.includes('--quit');
if (!singleInstanceLock) app.quit();

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// Ask the running copy to close cleanly. Used by the installer/uninstaller via
// `Ultra Downloader.exe --quit`, and by the tray Quit item. A short delay lets
// in-flight part-file writes and the database finish before the process exits.
function requestGracefulQuit() {
  if (quitting) return;
  quitting = true;
  try { downloader.shutdown(); } catch {}
  if (quitTimer) clearTimeout(quitTimer);
  quitTimer = setTimeout(() => {
    quitTimer = null;
    try { app.quit(); } catch {}
  }, 1200);
}

app.on('second-instance', (event, argv) => {
  if (Array.isArray(argv) && argv.includes('--quit')) {
    requestGracefulQuit();
    return;
  }
  showWindow();
});

// ---- Runtime status (notifications, taskbar, tray, power) -----------------
const notifiedCompleted = new Set();
const liveSpeeds = new Map();

function notifyComplete(row) {
  if (!Notification.isSupported()) return;
  const bits = [humanSize(row.totalSize || row.downloaded || 0)];
  if (Number(row.activeMs) > 0) bits.push(humanDuration(row.activeMs));
  try {
    const n = new Notification({
      // The OS-level app label can fall back to "Electron", so put our name in
      // the title as well.
      title: 'Ultra Downloader — download complete',
      body: `${row.filename || 'Download'} · ${bits.join(' · ')}`,
      icon: path.join(__dirname, 'assets', 'icon.png')
    });
    n.on('click', () => {
      showWindow();
      if (row.savePath) {
        try { shell.showItemInFolder(row.savePath); } catch {}
      }
    });
    n.show();
  } catch {}
}

// Keep the taskbar, tray tooltip and sleep blocker in sync with the DB. Called
// from downloader events, so it also works while the window is hidden.
function updateRuntimeStatus() {
  let rows = [];
  try { rows = db.listDownloads(); } catch { return; }
  const active = rows.filter((r) => r.status === 'downloading' || r.status === 'assembling');
  let fraction = -1;
  if (active.length) {
    const total = active.reduce((a, r) => a + (Number(r.totalSize) || 0), 0);
    const done = active.reduce((a, r) => a + (
      r.status === 'assembling' ? (Number(r.totalSize) || 0) : (Number(r.downloaded) || 0)), 0);
    if (total > 0) fraction = Math.max(0, Math.min(1, done / total));
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setProgressBar(fraction); } catch {}
  }
  // A long download must not be cut off because Windows decided to sleep.
  if (active.length && powerBlockerId === null) {
    try { powerBlockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch { powerBlockerId = null; }
  } else if (!active.length && powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId); } catch {}
    powerBlockerId = null;
  }
  if (tray) {
    if (!active.length) {
      tray.setToolTip('Ultra Downloader — idle');
    } else {
      let speed = 0;
      for (const [id, v] of liveSpeeds) {
        if (active.some((r) => r.id === id)) speed += v;
      }
      const pct = fraction >= 0 ? ` · ${Math.round(fraction * 100)}%` : '';
      const rate = speed > 0 ? ` · ${humanSize(speed)}/s` : '';
      tray.setToolTip(`Ultra Downloader — ${active.length} active${pct}${rate}`);
    }
  }
}

function handleDownloaderEvent(channel, payload) {
  if (channel === 'download:progress') {
    if (payload && payload.id != null) liveSpeeds.set(payload.id, Number(payload.speed) || 0);
    updateRuntimeStatus();
    return;
  }
  if (channel === 'download:update') {
    const d = payload;
    if (!d) return;
    if (d.status !== 'downloading' && d.status !== 'assembling') liveSpeeds.delete(d.id);
    if (d.status === 'completed') {
      // Only notify once per download, even though completion is emitted by
      // both the assembly step and the final row update.
      if (!notifiedCompleted.has(d.id)) {
        notifiedCompleted.add(d.id);
        notifyComplete(d);
      }
    } else {
      notifiedCompleted.delete(d.id);
    }
    updateRuntimeStatus();
    return;
  }
  if (channel === 'download:removed') {
    if (payload) {
      liveSpeeds.delete(payload.id);
      notifiedCompleted.delete(payload.id);
    }
    updateRuntimeStatus();
    return;
  }
  if (channel === 'queue:update' || channel === 'download:assembling' || channel === 'download:error') {
    updateRuntimeStatus();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    title: 'Ultra Downloader',
    backgroundColor: '#061120',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1
    }
  });
  // One fixed size: no pinch zoom and no Ctrl +/- zoom.
  // setVisualZoomLevelLimits returns a promise and can reject if the render
  // frame is not ready yet; that is harmless, so ignore it and retry once the
  // page has loaded.
  const lockZoom = () => {
    try {
      const p = mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  };
  lockZoom();
  mainWindow.webContents.on('did-finish-load', lockZoom);
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if ((input.control || input.meta) && ['+', '=', '-', '_', '0'].includes(input.key)) {
      e.preventDefault();
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Closing the window hides it to the tray: the app keeps running (downloads
  // continue) and the next launch just brings the same window back.
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // A second launch has already asked to quit; never initialise a duplicate.
  if (!singleInstanceLock) return;
  // `--quit` with no running copy just exits without opening a window.
  if (quitRequested) {
    quitting = true;
    app.quit();
    return;
  }
  // No File/Edit/Window menu: removes full screen, zoom, reload and devtools
  // shortcuts from the app entirely.
  Menu.setApplicationMenu(null);
  db.init();
  logDeletion({ action: 'startup', downloads: db.listDownloads().length, finished: db.listDownloads().filter(d => d.status === 'completed').length });
  downloader.init((channel, payload) => {
    sendToRenderer(channel, payload);
    try { handleDownloaderEvent(channel, payload); } catch {}
  });
  // Firefox extension bridge: loopback-only and origin-gated. 1.1.0 ships the
  // code but keeps it off until the signed extension is available (1.2.0).
  if (String(db.getSettings().browserBridgeEnabled || '0') === '1') {
    bridge.start({
      addJob: (url) => downloader.addJob(url),
      version: APP_VERSION_LABEL
    }).then(({ port }) => {
      console.log(`Browser bridge listening on 127.0.0.1:${port}`);
    }).catch((e) => {
      console.error('Browser bridge failed to start:', e && e.message ? e.message : e);
    });
  } else {
    console.log('Browser bridge disabled (browserBridgeEnabled=0)');
  }
  // Anything left mid-flight goes back through the queue, so the concurrency
  // limit is honoured after a restart too.
  setTimeout(() => {
    try { downloader.autostart(); updateRuntimeStatus(); } catch (e) { console.error('autostart', e); }
  }, 1000);
  createWindow();
  createTray();
  updater.init({
    getWindow: () => mainWindow,
    showWindow,
    sendToRenderer: (channel, payload) => {
      sendToRenderer(channel, payload);
      if (channel === 'update:status') rebuildTrayMenu();
    },
    beforeInstall: () => {
      quitting = true;
      try { bridge.stop(); } catch {}
      try { downloader.shutdown(); } catch {}
    }
  });
  // Seed the signature, then poll so hot-plugged adapters show up on their own.
  pollConnections().then(() => setInterval(pollConnections, 5000));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) showWindow(); });
});

app.on('window-all-closed', () => {
  // keep running in tray
});

function createTray() {
  // minimal tray; icon optional
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
  } catch (e) {
    return;
  }
  tray.setToolTip('Ultra Downloader');
  rebuildTrayMenu();
  tray.on('double-click', () => showWindow());
}

function rebuildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: 'Show', click: () => showWindow() },
    { label: 'Check for updates', click: () => updater.check(true).catch(() => {}) }
  ];
  const st = updater.getStatus();
  if (st.state === 'ready') {
    items.push({
      label: st.version ? `Install update ${st.version}` : 'Install downloaded update',
      click: () => updater.install().catch(() => {})
    });
  }
  items.push({ type: 'separator' }, { label: 'Quit', click: () => requestGracefulQuit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Watch the adapter list so a newly connected interface (USB tethering, a
// hotspot, a second NIC) appears without the user pressing anything.
let connSignature = '';
async function pollConnections() {
  try {
    const list = await connections.list();
    const sig = list.map(c => `${c.id}:${c.enabled ? 1 : 0}:${c.name}`).join('|');
    if (sig !== connSignature) {
      connSignature = sig;
      downloader.invalidateLimits();
      sendToRenderer('connections:update', list);
    }
  } catch {}
}

// IPC
ipcMain.handle('connections:list', async () => connections.list());
ipcMain.handle('connections:setEnabled', async (e, id, enabled) => { connections.setEnabled(id, enabled); downloader.invalidateLimits(); });
ipcMain.handle('connections:setCap', async (e, id, cap) => { connections.setCap(id, cap); downloader.invalidateLimits(); });

ipcMain.handle('settings:get', async () => db.getSettings());
ipcMain.handle('settings:set', async (e, s) => {
  // Folders are created up front so a typo fails here with a readable message
  // instead of halfway through the first download.
  for (const key of ['downloadDir', 'tempDir']) {
    if (!(key in s)) continue;
    const value = String(s[key] == null ? '' : s[key]).trim();
    if (!value) { s[key] = ''; continue; }
    try {
      fs.mkdirSync(value, { recursive: true });
    } catch (err) {
      throw new Error(`cannot use "${value}" — ${err.message}`);
    }
    s[key] = value;
  }
  const out = db.setSettings(s);
  downloader.invalidateLimits();
  // Raising the concurrency limit should put waiting downloads to work now.
  downloader.pumpQueue();
  return out;
});

ipcMain.handle('downloads:list', async () => db.listDownloads());
ipcMain.handle('downloads:add', async (e, url, opts) => downloader.addJob(url, opts));
ipcMain.handle('downloads:start', async (e, id) => downloader.requestStart(id));
ipcMain.handle('downloads:pause', async (e, id) => downloader.pause(id));
ipcMain.handle('downloads:resume', async (e, id) => downloader.resume(id));
ipcMain.handle('downloads:pauseAll', async () => downloader.pauseAll());
ipcMain.handle('downloads:resumeAll', async () => downloader.resumeAll());
ipcMain.handle('downloads:queueState', async () => downloader.queueState());
ipcMain.handle('app:info', async () => ({ version: APP_VERSION_LABEL, name: app.getName() }));
ipcMain.handle('app:updateCheck', async () => updater.check(true));
ipcMain.handle('app:updateStatus', async () => updater.getStatus());
ipcMain.handle('app:updateInstall', async () => updater.install());
ipcMain.handle('app:updateOpenReleases', async () => updater.openReleases());
ipcMain.handle('downloads:cancel', async (e, id) => { const r = await downloader.cancel(id); logDeletion({ action: 'cancel', id, result: 'partial-data-removed' }); return r; });
ipcMain.handle('downloads:remove', async (e, id, opts = {}) => {
  const row = db.getDownload(id);
  if (!row) return { cancelled: true };
  // Finished downloads ask whether the file on disk should go too. Active
  // entries (failed/paused/cancelled) only ever remove their partial data.
  if (row.status === 'completed' && !opts.silent) {
    const size = row.totalSize ? ` (${humanSize(row.totalSize)})` : '';
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Remove from list', 'Delete file too', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Delete download',
      message: 'Remove this finished download?',
      detail: `${row.filename || row.savePath || 'This download'}${size}\n\nRemove the entry only, or also delete the file from disk?`
    });
    if (choice.response === 2) return { cancelled: true };
    const deletedFile = choice.response === 1;
    await downloader.remove(id, { deleteFile: deletedFile });
    if (deletedFile && row.savePath) {
      // Send the file to the Recycle Bin instead of deleting it permanently,
      // so a mistaken delete can still be undone.
      try { await shell.trashItem(row.savePath); logDeletion({ action: 'trash', id, filename: row.filename, path: row.savePath, size: row.totalSize, result: 'recycle-bin' }); }
      catch { try { fs.rmSync(row.savePath, { force: true }); logDeletion({ action: 'rmSync', id, filename: row.filename, path: row.savePath, size: row.totalSize, result: 'permanent' }); } catch (e) { logDeletion({ action: 'failed', id, filename: row.filename, path: row.savePath, error: String(e && e.message) }); } }
    } else {
      logDeletion({ action: 'unlist', id, filename: row.filename, path: row.savePath, size: row.totalSize, result: 'file-kept' });
    }
    return { cancelled: false, deletedFile };
  }
  await downloader.remove(id, opts);
  return { cancelled: false, deletedFile: false };
});
ipcMain.handle('downloads:refreshLink', async (e, id, url) => downloader.refreshLink(id, url));
ipcMain.handle('downloads:chooseFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:openPath', async (e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openFile', async (e, p) => shell.openPath(p));
ipcMain.handle('app:quit', async () => requestGracefulQuit());
