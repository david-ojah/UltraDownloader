// Local bridge used by the Firefox extension. It listens on loopback only and
// accepts requests from Firefox extension origins, so a normal web page cannot
// add downloads to the queue.
const http = require('http');
const { URL } = require('url');

const DEFAULT_PORT = 17321;
const LAST_PORT = 17330;
const CLIENT_HEADER = 'x-ud-client';
const CLIENT_VALUE = 'ultra-downloader-firefox';
const MAX_BODY = 64 * 1024;
const DEBUG = process.env.UD_BRIDGE_DEBUG === '1';

let server = null;
let listeningPort = 0;

function isExtensionOrigin(origin) {
  return typeof origin === 'string' && /^moz-extension:\/\/[^/]+$/.test(origin);
}

function isLoopbackHost(host, port) {
  const value = String(host || '').toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-UD-Client',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
}

function sendJson(res, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (isExtensionOrigin(origin)) Object.assign(headers, corsHeaders(origin));
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

function isTorrentSource(value) {
  const v = String(value || '').trim();
  if (/^magnet:\?/i.test(v)) return true;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') &&
      !!u.hostname && /\.torrent$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function start(options = {}) {
  if (server) return Promise.resolve({ port: listeningPort });
  const addJob = options.addJob;
  const addTorrent = options.addTorrent;
  if (typeof addJob !== 'function') {
    return Promise.reject(new Error('bridge requires an addJob function'));
  }
  if (typeof addTorrent !== 'function') {
    return Promise.reject(new Error('bridge requires an addTorrent function'));
  }
  const version = String(options.version || '');
  const firstPort = Math.max(1, parseInt(options.port, 10) || DEFAULT_PORT);
  const lastPort = Math.max(firstPort, parseInt(options.lastPort, 10) || LAST_PORT);

  const handler = async (req, res) => {
    const origin = req.headers.origin || '';
    const port = req.socket.localPort;
    const pathname = String(req.url || '').split('?')[0];
    if (DEBUG) {
      console.log(`[bridge] ${req.method} ${pathname} origin=${origin} client=${req.headers[CLIENT_HEADER] || ''}`);
    }

    const clientOk = String(req.headers[CLIENT_HEADER] || '') === CLIENT_VALUE;
    const originOk = isExtensionOrigin(origin);

    if (!isLoopbackHost(req.headers.host, port)) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' }, origin);
    }

    if (req.method === 'OPTIONS') {
      if (origin && !originOk) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' }, origin);
      }
      if (originOk) res.writeHead(204, corsHeaders(origin));
      else res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    // Firefox extension fetches to loopback do not always send an Origin
    // header. In that case the custom client header is the gate: a web page
    // cannot set it without a CORS preflight, and a preflight always carries
    // its real Origin.
    if (!originOk && !(!origin && clientOk)) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' }, origin);
    }
    if (!clientOk) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' }, origin);
    }

    if (req.method === 'GET' && pathname === '/ping') {
      return sendJson(res, 200, {
        ok: true,
        name: 'Ultra Downloader',
        version,
        api: 1
      }, origin);
    }

    if (req.method === 'POST' && pathname === '/torrent') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message }, origin);
      }
      const url = String(body && body.url || '').trim();
      if (!isTorrentSource(url)) {
        return sendJson(res, 400, { ok: false, error: 'expected a magnet link or .torrent URL' }, origin);
      }
      try {
        const row = await addTorrent(url);
        return sendJson(res, 200, { ok: true, id: row && row.id }, origin);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message || 'could not add torrent' }, origin);
      }
    }

    if (req.method === 'POST' && pathname === '/add') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message }, origin);
      }
      const url = String(body && body.url || '').trim();
      if (!isHttpUrl(url)) {
        return sendJson(res, 400, { ok: false, error: 'expected an http(s) URL' }, origin);
      }
      try {
        const id = await addJob(url);
        return sendJson(res, 200, { ok: true, id }, origin);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message || 'could not add download' }, origin);
      }
    }

    return sendJson(res, 404, { ok: false, error: 'not found' }, origin);
  };

  return new Promise((resolve, reject) => {
    let attempt = firstPort;
    const tryListen = () => {
      const srv = http.createServer(handler);
      srv.once('error', (err) => {
        try { srv.close(); } catch {}
        if (err.code === 'EADDRINUSE' && attempt < lastPort) {
          attempt += 1;
          setImmediate(tryListen);
          return;
        }
        reject(err);
      });
      srv.listen(attempt, '127.0.0.1', () => {
        server = srv;
        listeningPort = srv.address().port;
        resolve({ port: listeningPort });
      });
    };
    tryListen();
  });
}

function stop() {
  if (!server) return;
  const srv = server;
  server = null;
  listeningPort = 0;
  try { srv.close(); } catch {}
}

module.exports = {
  start,
  stop,
  DEFAULT_PORT,
  LAST_PORT,
  CLIENT_HEADER,
  CLIENT_VALUE
};
