const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const db = require('./src/db');
const connections = require('./src/connections');
const downloader = require('./src/downloader');

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
function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}


let mainWindow = null;
let tray = null;
// Set when the user really quits (tray → Quit), so the close-to-tray handler
// lets the window go instead of hiding it forever.
let quitting = false;
app.on('before-quit', () => { quitting = true; });

// ---- Single instance -------------------------------------------------------
// The app keeps running in the tray after its window closes, so a second launch
// must wake the existing copy instead of starting another background instance
// (each extra instance meant another tray icon and another process on the same
// database).
const singleInstanceLock = app.requestSingleInstanceLock();
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

app.on('second-instance', () => {
  showWindow();
});

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
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
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
  // No File/Edit/Window menu: removes full screen, zoom, reload and devtools
  // shortcuts from the app entirely.
  Menu.setApplicationMenu(null);
  db.init();
  logDeletion({ action: 'startup', downloads: db.listDownloads().length, finished: db.listDownloads().filter(d => d.status === 'completed').length });
  downloader.init(sendToRenderer);
  // Resume any downloads left mid-flight (including one that was interrupted
  // while its final file was being built).
  setTimeout(() => {
    try {
      const rows = db.listDownloads().filter(d => d.status === 'downloading' || d.status === 'assembling');
      for (const r of rows) downloader.resume(r.id).catch(() => {});
    } catch (e) {}
  }, 1500);
  createWindow();
  createTray();
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
  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setToolTip('Ultra Downloader');
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
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
  return out;
});

ipcMain.handle('downloads:list', async () => db.listDownloads());
ipcMain.handle('downloads:add', async (e, url, opts) => downloader.addJob(url, opts));
ipcMain.handle('downloads:start', async (e, id) => downloader.start(id));
ipcMain.handle('downloads:pause', async (e, id) => downloader.pause(id));
ipcMain.handle('downloads:resume', async (e, id) => downloader.resume(id));
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
ipcMain.handle('app:quit', async () => app.quit());
