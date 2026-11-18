// The extension watches Firefox downloads. When Ultra Downloader is running,
// the download is cancelled in Firefox and its URL is queued in the app. When
// the app is not running, Firefox keeps the download untouched.
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

async function addUrl(url, knownPort) {
  const port = knownPort || await findBridge();
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

// The content script intercepts download-page controls before Firefox sends a
// request. This listener hands the URL straight to the app, so another download
// manager's network driver never sees the request.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'ud:add' || typeof message.url !== 'string') {
    return false;
  }
  addUrl(message.url).then(sendResponse).catch(() => {
    sendResponse({ ok: false, reason: 'not-running' });
  });
  return true;
});

browser.downloads.onCreated.addListener(async (item) => {
  if (!item || !/^https?:\/\//i.test(item.url || '')) return;

  // Only take over when the app is already running.
  const port = await findBridge();
  if (!port) return;

  // Stop Firefox's copy before adding, so the file is not downloaded twice.
  try {
    await browser.downloads.cancel(item.id);
    await browser.downloads.erase({ id: item.id });
  } catch {
    // The browser download may already have finished. Leave it alone rather
    // than adding a duplicate.
    try {
      const [current] = await browser.downloads.search({ id: item.id });
      if (!current || current.state === 'complete') return;
    } catch {}
  }

  const result = await addUrl(item.url, port);
  if (!result.ok) {
    // The app accepted the connection but rejected the item. Put the download
    // back into Firefox instead of losing it.
    try {
      await browser.downloads.download({ url: item.url });
    } catch {}
    notify('Ultra Downloader could not add this download.');
  }
});
