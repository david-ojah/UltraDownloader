const { app } = require('electron');

// Passed by the Windows login item so a sign-in launch stays in the tray.
const HIDDEN_ARG = '--hidden';

// The login item points at the running executable, so it only makes sense for
// an installed Windows build (development runs from the Electron binary).
function isSupported() {
  return process.platform === 'win32' && app.isPackaged;
}

function isEnabled() {
  try {
    return app.getLoginItemSettings({ path: process.execPath, args: [HIDDEN_ARG] }).openAtLogin;
  } catch {
    return false;
  }
}

function setEnabled(enabled) {
  if (!isSupported()) throw new Error('Start with Windows is only available in the installed Windows app.');
  app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: [HIDDEN_ARG] });
  // setLoginItemSettings does not report failures, so read the state back.
  if (isEnabled() !== !!enabled) throw new Error('Windows did not accept the Start with Windows setting.');
}

module.exports = { HIDDEN_ARG, isSupported, isEnabled, setEnabled };
