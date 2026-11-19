const fs = require('fs');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const db = require('./db');

const ADDON_URL = 'https://addons.mozilla.org/en-US/firefox/addon/ultra-downloader/';
const ADDON_API = process.env.UD_AMO_ADDON_API ||
  'https://addons.mozilla.org/api/v5/addons/addon/ultra-downloader/';
const FIREFOX_DOWNLOAD = 'https://www.mozilla.org/firefox/new/';

function findFirefox() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Mozilla Firefox', 'firefox.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Mozilla Firefox', 'firefox.exe'),
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
  ];
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

async function isExtensionPublic() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(ADDON_API, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.status === 'public';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function openExtensionPage() {
  const firefox = findFirefox();
  if (firefox) {
    try {
      spawn(firefox, [ADDON_URL], { detached: true, stdio: 'ignore' }).unref();
      return { opened: true, target: 'firefox' };
    } catch {}
  }
  try {
    shell.openExternal(ADDON_URL);
    return { opened: true, target: 'browser' };
  } catch {
    return { opened: false };
  }
}

async function promptIfNeeded(mainWindow, showWindow) {
  if (!app.isPackaged) return { prompted: false, reason: 'development' };
  if (String(db.getSettings().extensionPromptShown || '') === '1') {
    return { prompted: false, reason: 'already-seen' };
  }
  if (!(await isExtensionPublic())) {
    // Not approved yet, or offline: leave the flag unset and try next launch.
    return { prompted: false, reason: 'not-public' };
  }

  try { showWindow(); } catch {}
  const firefox = findFirefox();
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Firefox extension',
    message: firefox
      ? 'Install the Ultra Downloader Firefox extension?'
      : 'Install Firefox to use the Ultra Downloader extension?',
    detail: firefox
      ? 'Firefox downloads will be handed to Ultra Downloader instead of being saved by the browser. You can install it later from Settings.'
      : 'The extension requires Mozilla Firefox. Install Firefox first, then add the extension from Mozilla Add-ons.',
    buttons: firefox ? ['Yes', 'Not now'] : ['Get Firefox', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  db.setSettings({ extensionPromptShown: '1' });
  if (result.response !== 0) return { prompted: true, opened: false };

  if (!firefox) {
    try { shell.openExternal(FIREFOX_DOWNLOAD); } catch {}
    return { prompted: true, opened: true, target: 'firefox-download' };
  }
  return { ...openExtensionPage(), prompted: true };
}

module.exports = {
  findFirefox,
  isExtensionPublic,
  openExtensionPage,
  promptIfNeeded,
  ADDON_URL
};
