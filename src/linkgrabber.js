const http = require('http');
const https = require('https');
const { URL } = require('url');
const cheerio = require('cheerio');

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers, timeout: 15000 }, (res) => {
      // follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return fetchText(next, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, finalUrl: url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchHead(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'HEAD', headers, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return fetchHead(next, headers).then(resolve).catch(reject);
      }
      resolve({ status: res.statusCode, headers: res.headers, finalUrl: url });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|avi|m3u8|mpd|ts)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|aac|m4a|wav|ogg|flac)(\?|$)/i;
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|bz2)(\?|$)/i;
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|txt|csv)(\?|$)/i;

function classify(url, contentType = '') {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('video/') || VIDEO_EXT.test(url)) return 'video';
  if (ct.startsWith('audio/') || AUDIO_EXT.test(url)) return 'audio';
  if (ct.startsWith('application/zip') || ARCHIVE_EXT.test(url)) return 'archive';
  if (ct.startsWith('application/pdf') || DOC_EXT.test(url)) return 'document';
  return 'file';
}

async function fetchCandidates(pageUrl) {
  const { body, finalUrl, headers } = await fetchText(pageUrl);
  const $ = cheerio.load(body);
  const base = finalUrl;
  const candidates = new Map();

  function add(url, label, source) {
    if (!url) return;
    let abs;
    try { abs = new URL(url, base).href; } catch { return; }
    if (!/^https?:/i.test(abs)) return;
    if (candidates.has(abs)) return;
    candidates.set(abs, { url: abs, label: (label || '').trim().slice(0, 120), source });
  }

  // direct links with download attr or media extensions
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    const download = $(el).attr('download');
    const text = $(el).text();
    if (download || VIDEO_EXT.test(href) || AUDIO_EXT.test(href) || ARCHIVE_EXT.test(href) || DOC_EXT.test(href)) {
      add(href, text || download || href, 'link');
    }
  });

  $('video, audio').each((i, el) => {
    const src = $(el).attr('src');
    add(src, 'media', 'media');
    $(el).find('source').each((j, s) => add($(s).attr('src'), 'source', 'media'));
  });

  $('source[src]').each((i, el) => add($(el).attr('src'), 'source', 'media'));

  // meta og:video
  $('meta[property="og:video"], meta[property="og:video:url"], meta[name="twitter:player:stream"]').each((i, el) => {
    add($(el).attr('content'), 'og:video', 'meta');
  });

  // if the pasted URL itself is a direct file
  try {
    const u = new URL(pageUrl);
    if (VIDEO_EXT.test(u.pathname) || AUDIO_EXT.test(u.pathname) || ARCHIVE_EXT.test(u.pathname) || DOC_EXT.test(u.pathname)) {
      add(pageUrl, 'direct', 'direct');
    }
  } catch {}

  // Probe each candidate for size/content-type
  const list = Array.from(candidates.values());
  const probed = await Promise.all(list.map(async (c) => {
    try {
      const h = await fetchHead(c.url);
      const ct = h.headers['content-type'] || '';
      const size = parseInt(h.headers['content-length'] || '0', 10) || 0;
      const ar = /bytes/i.test(h.headers['accept-ranges'] || '');
      return { ...c, contentType: ct, size, acceptRanges: ar, kind: classify(c.url, ct) };
    } catch (e) {
      return { ...c, contentType: '', size: 0, acceptRanges: false, kind: classify(c.url, ''), error: e.message };
    }
  }));

  return { pageUrl: finalUrl, candidates: probed };
}

module.exports = { fetchCandidates, classify };
