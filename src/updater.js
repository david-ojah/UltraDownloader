const fs = require('fs');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const db = require('./db');

const RELEASES_URL = 'https://github.com/david-ojah/UltraDownloader/releases/latest';

let mainWindow = null;
let getWindow = () => mainWindow;
let showWindow = () => {};
let send = null;
let beforeInstall = null;
let initialized = false;
let checkInFlight = false;
let manualCheck = false;
let promptOpen = false;
let availableInfo = null;
let downloadedInfo = null;
let lastAutoCheck = 0;
let pollTimer = null;

// The Firebase listener can ask for a check at any time. This is the fallback
// path when that listener is offline, unavailable, or the release workflow
// failed to publish the version pointer.
const BACKGROUND_POLL_MS = 30 * 60 * 1000;
const FOCUS_CHECK_MIN_MS = 10 * 60 * 1000;

let status = {
  state: 'idle',
  message: 'No update check yet.',
  version: null,
  percent: 0,
  currentVersion: app.getVersion()
};

function logLine(text) {
  try {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'updater.log'),
      `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

function setStatus(patch) {
  status = { ...status, ...patch, currentVersion: app.getVersion() };
  try { send('update:status', status); } catch {}
  return status;
}

function getStatus() {
  return status;
}

function saveSetting(key, value) {
  try { db.setSettings({ [key]: value }); } catch {}
}

function dialogParent() {
  try { showWindow(); } catch {}
  const win = getWindow();
  return win && !win.isDestroyed() ? win : undefined;
}

async function askDownload(info) {
  const result = await dialog.showMessageBox(dialogParent(), {
    type: 'question',
    title: 'Update available',
    message: `Ultra Downloader ${info.version} is available.`,
    detail: 'Download the update now? Nothing will be installed until you confirm again.',
    buttons: ['Download', 'Not now', 'Skip this version'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (result.response === 0) {
    setStatus({ state: 'downloading', message: `Downloading ${info.version}…`, version: info.version, percent: 0 });
    // Do not await this: update-downloaded must be able to prompt as soon as
    // the download finishes.
    autoUpdater.downloadUpdate().catch((e) => {
      setStatus({ state: 'error', message: `Could not download the update: ${e.message}` });
      logLine(`download failed: ${e.stack || e.message}`);
    });
    return;
  }
  if (result.response === 2) {
    saveSetting('updateSkipVersion', info.version);
    setStatus({ state: 'skipped', message: `Version ${info.version} skipped.`, version: info.version });
    return;
  }
  setStatus({ state: 'available', message: `Version ${info.version} is available.`, version: info.version });
}

async function askInstall(info) {
  const result = await dialog.showMessageBox(dialogParent(), {
    type: 'question',
    title: 'Update ready',
    message: `Ultra Downloader ${info.version} has been downloaded.`,
    detail: 'Install it now? The app will close, install the update, and start again.',
    buttons: ['Install now', 'Later'],
    // Later is the default: a stray Enter or a click that lands while the
    // prompt replaces the download prompt must not install anything.
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (result.response === 0) {
    await install();
    return;
  }
  setStatus({ state: 'ready', message: `Version ${info.version} is ready to install.`, version: info.version });
}

async function install() {
  if (!downloadedInfo) {
    return { ok: false, error: 'No downloaded update is ready.' };
  }
  setStatus({ state: 'installing', message: 'Closing the app to install the update…', version: downloadedInfo.version });
  logLine(`installing ${downloadedInfo.version}`);
  try {
    if (beforeInstall) await beforeInstall();
  } catch (e) {
    logLine(`beforeInstall failed: ${e.message}`);
  }
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      logLine(`quitAndInstall failed: ${e.message}`);
      setStatus({ state: 'error', message: `Could not start the installer: ${e.message}` });
    }
  }, 1200);
  return { ok: true };
}

async function check(manual = false) {
  if (checkInFlight || promptOpen) return status;
  // Never let a background/poll/realtime check wipe out an update that is
  // already downloading or ready to install. Only an explicit "Check now"
  // may run in those states.
  if (!manual && ['downloading', 'ready', 'installing'].includes(status.state)) {
    return status;
  }
  manualCheck = !!manual;
  if (!app.isPackaged && !process.env.UD_UPDATE_URL) {
    if (manual) {
      await dialog.showMessageBox(dialogParent(), {
        type: 'info',
        title: 'Check for updates',
        message: 'Update checks are available in the installed app.',
        detail: 'Run the packaged installer to test updates.',
        buttons: ['OK']
      });
    }
    return setStatus({ state: 'idle', message: 'Update checks are available in the installed app.' });
  }

  checkInFlight = true;
  if (!manual) lastAutoCheck = Date.now();
  setStatus({ state: 'checking', message: 'Checking for updates…' });
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      setStatus({ state: 'idle', message: 'You are up to date.' });
    }
  } catch (e) {
    logLine(`check failed: ${e.stack || e.message}`);
    setStatus({ state: 'error', message: `Could not check for updates: ${e.message}` });
    if (manual) {
      await dialog.showMessageBox(dialogParent(), {
        type: 'error',
        title: 'Check for updates',
        message: 'Could not check for updates.',
        detail: e.message,
        buttons: ['OK']
      });
    }
  } finally {
    checkInFlight = false;
    saveSetting('updateLastCheck', String(Date.now()));
  }
  return status;
}

// Called on window focus and by the Firebase listener. Throttled so focus
// changes and duplicate realtime events cannot hammer the GitHub API.
function maybeCheck() {
  if (String(db.getSettings().autoCheckUpdates || '1') !== '1') return status;
  if (Date.now() - lastAutoCheck < FOCUS_CHECK_MIN_MS) return status;
  return check(false);
}

// Start the download from the banner. Consent still goes through the same
// dialog used by the startup flow.
async function download() {
  if (!availableInfo) return { ok: false, error: 'No update is available yet.' };
  if (promptOpen) return { ok: false, error: 'A dialog is already open.' };
  if (status.state === 'downloading' || status.state === 'ready') return { ok: true };
  promptOpen = true;
  try {
    await askDownload(availableInfo);
  } finally {
    promptOpen = false;
  }
  return { ok: true };
}

// Install from the banner or Settings. Consent always goes through the same
// "install now?" dialog; never install silently.
async function promptInstall() {
  if (!downloadedInfo) return { ok: false, error: 'No downloaded update is ready.' };
  if (promptOpen) return { ok: false, error: 'A dialog is already open.' };
  promptOpen = true;
  try {
    await askInstall(downloadedInfo);
  } finally {
    promptOpen = false;
  }
  return { ok: true };
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (String(db.getSettings().autoCheckUpdates || '1') !== '1') return;
    if (checkInFlight || promptOpen) return;
    if (['downloading', 'ready', 'installing', 'checking'].includes(status.state)) return;
    check(false).catch(() => {});
  }, BACKGROUND_POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

function openReleases() {
  try { shell.openExternal(RELEASES_URL); } catch {}
}

function init(options = {}) {
  if (initialized) return;
  initialized = true;
  mainWindow = options.mainWindow || null;
  getWindow = options.getWindow || (() => mainWindow);
  showWindow = options.showWindow || (() => {});
  send = options.sendToRenderer || (() => {});
  beforeInstall = options.beforeInstall || null;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = {
    info: (m) => logLine(`info: ${m}`),
    warn: (m) => logLine(`warn: ${m}`),
    error: (m) => logLine(`error: ${m}`),
    debug: (m) => logLine(`debug: ${m}`)
  };

  if (process.env.UD_UPDATE_URL) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.UD_UPDATE_URL });
    logLine(`using mock update feed ${process.env.UD_UPDATE_URL}`);
  }

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking', message: 'Checking for updates…' });
  });

  autoUpdater.on('update-available', async (info) => {
    availableInfo = info;
    const skip = String(db.getSettings().updateSkipVersion || '');
    if (!manualCheck && skip && skip === info.version) {
      setStatus({ state: 'skipped', message: `Version ${info.version} skipped.`, version: info.version });
      return;
    }
    if (promptOpen) return;
    promptOpen = true;
    setStatus({ state: 'available', message: `Version ${info.version} is available.`, version: info.version });
    try { await askDownload(info); } finally { promptOpen = false; }
  });

  autoUpdater.on('update-not-available', async (info) => {
    setStatus({ state: 'idle', message: 'You are up to date.', version: info && info.version });
    if (manualCheck) {
      await dialog.showMessageBox(dialogParent(), {
        type: 'info',
        title: 'Check for updates',
        message: 'You are up to date.',
        detail: `Ultra Downloader ${app.getVersion()} is the latest version.`,
        buttons: ['OK']
      });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    setStatus({
      state: 'downloading',
      message: `Downloading update… ${Math.round(p.percent || 0)}%`,
      version: availableInfo && availableInfo.version,
      percent: Math.round(p.percent || 0)
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    downloadedInfo = info;
    setStatus({ state: 'ready', message: `Version ${info.version} is ready to install.`, version: info.version, percent: 100 });
    if (promptOpen) return;
    promptOpen = true;
    // Let the download prompt's final click settle before showing another
    // modal in the same place.
    await new Promise((r) => setTimeout(r, 700));
    try { await askInstall(info); } finally { promptOpen = false; }
  });

  autoUpdater.on('error', (e) => {
    const message = (e && e.message) || String(e);
    logLine(`updater error: ${e && e.stack ? e.stack : message}`);
    setStatus({ state: 'error', message });
  });

  if (options.autoCheck !== false &&
      String(db.getSettings().autoCheckUpdates || '1') === '1') {
    setTimeout(() => { check(false).catch(() => {}); }, 5000);
  }

  startPolling();
}

module.exports = {
  init,
  check,
  maybeCheck,
  download,
  promptInstall,
  install,
  getStatus,
  openReleases
};
