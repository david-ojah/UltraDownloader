const os = require('os');
const http = require('http');
const https = require('https');
const db = require('./db');

function listInterfaces() {
  const nets = os.networkInterfaces();
  const descMap = getAdapterDescriptions();
  const out = [];
  for (const [name, addrs] of Object.entries(nets)) {
    const desc = descMap[name] || '';
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4') continue;
      out.push({ name, address: a.address, family: a.family, description: desc, virtual: isVirtualName(name) || isVirtualName(desc) });
    }
  }
  return out;
}

let descCache = { map: null, at: 0 };

function getAdapterDescriptions() {
  // PowerShell is slow (~300-500 ms), and this now runs on a timer so new
  // adapters are picked up without a manual probe. Cache it.
  if (descCache.map && Date.now() - descCache.at < 60000) return descCache.map;
  const map = {};
  try {
    const { execSync } = require('child_process');
    const raw = execSync('powershell -NoProfile -Command "Get-NetAdapter | Select-Object Name,InterfaceDescription | ConvertTo-Json -Compress"', { timeout: 5000, windowsHide: true }).toString().trim();
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const a of arr) {
      if (a && a.Name) map[a.Name] = a.InterfaceDescription || '';
    }
  } catch (e) {
    // ignore
  }
  descCache = { map, at: Date.now() };
  return map;
}

// Heuristic: exclude obvious VPN/virtual adapters
function isVirtualName(name) {
  const n = (name || '').toLowerCase();
  return /vpn|tap|tun|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|teredo|isatap|cloudflare|warp/i.test(n);
}

async function list() {
  const ifaces = listInterfaces();
  // sync with db
  const existing = db.listConnections();
  const byId = new Map(existing.map(c => [c.id, c]));
  const result = [];
  for (const iface of ifaces) {
    const id = iface.address;
    let c = byId.get(id);
    if (!c) {
      c = { id, name: iface.name, localAddress: iface.address, interfaceIndex: 0, enabled: iface.virtual ? 0 : 1, capKbps: 0, lastSpeed: 0 };
      db.upsertConnection(c);
    } else {
      db.upsertConnection({ ...c, name: iface.name, localAddress: iface.address, enabled: iface.virtual ? 0 : c.enabled });
      if (iface.virtual) db.setConnectionEnabled(id, 0);
    }
    result.push(db.listConnections().find(x => x.id === id));
  }
  // remove stale
  const currentIds = new Set(ifaces.map(i => i.address));
  for (const c of existing) {
    if (!currentIds.has(c.id)) {
      // leave in db but mark? skip deletion to keep history
    }
  }
  const virtualIds = new Set(ifaces.filter(i => i.virtual).map(i => i.address));
  return db.listConnections().filter(c => currentIds.has(c.id) && !virtualIds.has(c.id));
}

function setEnabled(id, enabled) { db.setConnectionEnabled(id, enabled); }
function setCap(id, cap) { db.setConnectionCap(id, cap); }

function probeOne(conn) {
  return new Promise((resolve) => {
    const start = Date.now();
    const mod = (conn.localAddress.startsWith('10.') || conn.localAddress.startsWith('192.') || conn.localAddress.startsWith('172.')) ? http : https;
    // probe via a small endpoint
    const req = mod.get('http://httpbin.org/bytes/65536', { localAddress: conn.localAddress, timeout: 8000 }, (res) => {
      let bytes = 0;
      res.on('data', (d) => { bytes += d.length; });
      res.on('end', () => {
        const dur = (Date.now() - start) / 1000;
        const kbps = dur > 0 ? (bytes * 8) / (dur * 1000) : 0;
        db.prepare ? null : null;
        try { db.upsertConnection({ id: conn.id, name: conn.name, localAddress: conn.localAddress, interfaceIndex: conn.interfaceIndex, enabled: !!conn.enabled, capKbps: conn.capKbps, lastSpeed: kbps }); } catch {}
        resolve({ id: conn.id, ok: true, bytes, dur, kbps });
      });
    });
    req.on('error', (e) => resolve({ id: conn.id, ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ id: conn.id, ok: false, error: 'timeout' }); });
  });
}

async function probeAll() {
  const conns = await list();
  const enabled = conns.filter(c => c.enabled);
  const results = await Promise.all(enabled.map(probeOne));
  return results;
}

// IPv4 addresses that currently exist on this machine (cheap, no PowerShell).
function currentInterfaceAddresses() {
  const nets = os.networkInterfaces();
  const set = new Set();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4') continue;
      set.add(a.address);
    }
  }
  return set;
}

// helper to get enabled connections that are actually present right now.
// Stale rows (e.g. a Wi-Fi adapter that is disconnected) are ignored so we
// never bind curl to an IP the machine no longer owns.
function enabledConnections() {
  const current = currentInterfaceAddresses();
  return db.listConnections().filter(c => c.enabled && current.has(c.id));
}

module.exports = { list, setEnabled, setCap, probeAll, enabledConnections, currentInterfaceAddresses, isVirtualName };
