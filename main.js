const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const db = require('./src/db');
const connections = require('./src/connections');
const downloader = require('./src/downloader');


let mainWindow = null;
let tray = null;

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
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // No File/Edit/Window menu: removes full screen, zoom, reload and devtools
  // shortcuts from the app entirely.
  Menu.setApplicationMenu(null);
  db.init();
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
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
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
    { label: 'Show', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setToolTip('Ultra Downloader');
  tray.setContextMenu(menu);
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
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
ipcMain.handle('settings:set', async (e, s) => { const out = db.setSettings(s); downloader.invalidateLimits(); return out; });

ipcMain.handle('downloads:list', async () => db.listDownloads());
ipcMain.handle('downloads:add', async (e, url, opts) => downloader.addJob(url, opts));
ipcMain.handle('downloads:start', async (e, id) => downloader.start(id));
ipcMain.handle('downloads:pause', async (e, id) => downloader.pause(id));
ipcMain.handle('downloads:resume', async (e, id) => downloader.resume(id));
ipcMain.handle('downloads:cancel', async (e, id) => downloader.cancel(id));
ipcMain.handle('downloads:remove', async (e, id, opts = {}) => {
  const row = db.getDownload(id);
  if (!row) return { cancelled: true };
  // Finished downloads ask whether the file on disk should go too. Active
  // entries (failed/paused/cancelled) only ever remove their partial data.
  if (row.status === 'completed' && !opts.silent) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Remove from list', 'Delete file too', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Delete download',
      message: 'Remove this finished download?',
      detail: `${row.filename || row.savePath || 'This download'}\n\nRemove the entry only, or also delete the file from disk?`
    });
    if (choice.response === 2) return { cancelled: true };
    const deletedFile = choice.response === 1;
    await downloader.remove(id, { deleteFile: deletedFile });
    return { cancelled: false, deletedFile };
  }
  await downloader.remove(id, opts);
  return { cancelled: false, deletedFile: false };
});
ipcMain.handle('downloads:refreshLink', async (e, id, url) => downloader.refreshLink(id, url));

ipcMain.handle('shell:openPath', async (e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openFile', async (e, p) => shell.openPath(p));
ipcMain.handle('app:quit', async () => app.quit());
