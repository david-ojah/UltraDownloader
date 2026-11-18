// Mock Ultra Downloader bridge for extension development and AMO review.
// Run with: node tools/mock-bridge.js
const http = require('http');

const PORT = 17321;
const CLIENT = 'ultra-downloader-firefox';

http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const clientOk = req.headers['x-ud-client'] === CLIENT;
  const extensionOrigin = origin.startsWith('moz-extension://');

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (extensionOrigin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-UD-Client';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }
  if (!clientOk) {
    res.writeHead(403, headers);
    return res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
  }
  if (req.url === '/ping') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ ok: true, name: 'Mock Ultra Downloader', version: '1.1.0', api: 1 }));
  }
  if (req.url === '/add' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        console.log('Would add:', data.url);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true, id: 1 }));
      } catch {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      }
    });
    return;
  }
  res.writeHead(404, headers);
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Mock bridge on http://127.0.0.1:${PORT}`);
});
