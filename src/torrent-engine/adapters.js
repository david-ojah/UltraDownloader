'use strict';

// Enumerates real IPv4 adapters and resolves their Windows GUIDs for the
// torrent engine. The virtual-adapter heuristic mirrors src/connections.js so
// the engine sees the same adapters the app considers usable.
//
// Returns: [{ name, address, guid }]

const os = require('os');
const { execFileSync } = require('child_process');

// Same heuristic as src/connections.js: exclude obvious VPN/virtual adapters.
function isVirtualName(name) {
  const n = (name || '').toLowerCase();
  return /vpn|tap|tun|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|teredo|isatap|cloudflare|warp/i.test(n);
}

function getWindowsAdapterInfo() {
  const map = new Map();
  try {
    const raw = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-NetAdapter | Select-Object Name,InterfaceGuid,InterfaceDescription,Status | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    ).trim();
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const a of list) {
      if (!a || !a.Name) continue;
      map.set(a.Name, {
        guid: a.InterfaceGuid || '',
        description: a.InterfaceDescription || '',
        status: a.Status || '',
      });
    }
  } catch (err) {
    // PowerShell can be unavailable or blocked; GUIDs are then simply empty.
    process.stderr.write(`[adapters] PowerShell adapter query failed: ${err.message}\n`);
  }
  return map;
}

async function listAdapters(options = {}) {
  const includeVirtual = options.includeVirtual === true;
  const includeLinkLocal = options.includeLinkLocal === true;
  const info = getWindowsAdapterInfo();
  const out = [];

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    const meta = info.get(name) || { guid: '', description: '', status: '' };
    for (const a of addrs || []) {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4 || a.internal) continue;
      if (!includeLinkLocal && a.address.startsWith('169.254.')) continue;
      if (!includeVirtual && (isVirtualName(name) || isVirtualName(meta.description))) continue;
      out.push({ name, address: a.address, guid: meta.guid, description: meta.description, status: meta.status });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  return out;
}

module.exports = { listAdapters, isVirtualName };

if (require.main === module) {
  listAdapters({ includeVirtual: true })
    .then((list) => {
      console.log(JSON.stringify(list, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
