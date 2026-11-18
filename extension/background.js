// Minimal bridge client. The content script detects a download click and asks
// this background page to add it to the running Ultra Downloader.
const CLIENT_HEADER = 'X-UD-Client';
const CLIENT_VALUE = 'ultra-downloader-firefox';
const PORTS = [17321, 17322, 17323, 17324, 17325, 17326, 17327, 17328, 17329, 17330];
const TIMEOUT_MS = 1500;

let cachedPort = null;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function ping(port) {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/ping`, {
      headers: { [CLIENT_HEADER]: CLIENT_VALUE }
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data && data.ok && data.api === 1);
  } catch {
    return false;
  }
}

async function findBridge() {
  if (cachedPort && await ping(cachedPort)) return cachedPort;
  cachedPort = null;
  for (const port of PORTS) {
    if (await ping(port)) {
      cachedPort = port;
      return port;
    }
  }
  return null;
}

async function addUrl(url) {
  const port = await findBridge();
  if (!port) return { ok: false, reason: 'not-running' };
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: CLIENT_VALUE
      },
      body: JSON.stringify({ url })
    });
    if (!res.ok) {
      cachedPort = null;
      return { ok: false, reason: 'rejected', status: res.status };
    }
    const data = await res.json();
    return data && data.ok ? data : { ok: false, reason: 'rejected' };
  } catch {
    cachedPort = null;
    return { ok: false, reason: 'not-running' };
  }
}

function notify(message) {
  try {
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: 'Ultra Downloader',
      message
    });
  } catch {}
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'ud:add' || typeof message.url !== 'string') {
    return false;
  }
  addUrl(message.url).then(sendResponse).catch(() => {
    sendResponse({ ok: false, reason: 'not-running' });
  });
  return true;
});

browser.contextMenus.create({
  id: 'ud-add-link',
  title: 'Download with Ultra Downloader',
  contexts: ['link']
});

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'ud-add-link' || !info.linkUrl) return;
  addUrl(info.linkUrl).then((result) => {
    if (!result.ok) {
      notify(result.reason === 'not-running'
        ? 'Ultra Downloader is not running.'
        : 'Ultra Downloader could not add this link.');
    }
  });
});
