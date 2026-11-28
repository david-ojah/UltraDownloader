'use strict';

// Thin Node client for the in-process libtorrent N-API addon.
//
// The engine itself is resources/torrent/torrent_addon.node in the repo and
// <resources>/torrent/torrent_addon.node in an installed app. The addon is
// loaded into the Electron main process; there is no child process, port,
// token or HTTP handshake:
//
//   const engine = new TorrentEngine();
//   await engine.setInterfaces(['192.168.0.91'], { guids: ['{...}'], port: 6881 });
//   await engine.startTorrent(torrentPath, saveDir);
//   await engine.getStatus(infoHash);
//   await engine.stop();

const path = require('path');
const fs = require('fs');

function resolveAddonPath() {
  // Packaged: electron-builder copies resources/torrent to <resources>/torrent.
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'torrent', 'torrent_addon.node');
    if (fs.existsSync(packaged)) return packaged;
  }
  const dev = path.join(__dirname, '..', '..', 'resources', 'torrent', 'torrent_addon.node');
  if (!fs.existsSync(dev)) {
    throw new Error(
      `native torrent addon not found at ${dev}. Build it with npm run build:torrent (see tools/torrent-engine/README.md).`
    );
  }
  return dev;
}

class TorrentEngine {
  constructor(options = {}) {
    this.addonPath = options.addonPath || resolveAddonPath();
    this.addon = null;
    this.libtorrentVersion = '';
  }

  load() {
    if (this.addon) return this.addon;
    if (!fs.existsSync(this.addonPath)) {
      throw new Error(
        `native torrent addon not found at ${this.addonPath}. Build it with npm run build:torrent (see tools/torrent-engine/README.md).`
      );
    }
    const addon = require(this.addonPath);
    if (!addon || typeof addon.call !== 'function') {
      throw new Error(`native torrent addon at ${this.addonPath} does not export call()`);
    }
    this.addon = addon;
    if (addon.version) this.libtorrentVersion = String(addon.version);
    return addon;
  }

  async request(method, params = {}) {
    let response;
    try {
      response = await this.load().call(method, params);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      // The native layer already formats failures as "<method> failed: ...".
      if (message.startsWith(`${method} failed:`)) throw e;
      throw new Error(`${method} failed: ${message}`);
    }
    if (!response || response.ok !== true) {
      const message = response && response.error ? response.error : 'unknown native error';
      const err = new Error(`${method} failed: ${message}`);
      err.response = response;
      throw err;
    }
    return response.result;
  }

  async ping() {
    return this.request('ping', {});
  }

  async startTorrent(torrent, saveDir) {
    return this.request('startTorrent', { torrent, saveDir });
  }

  async getStatus(infoHash) {
    return this.request('status', { infoHash });
  }

  async setInterfaces(addresses, options = {}) {
    return this.request('setInterfaces', {
      addresses,
      guids: options.guids || [],
      port: options.port || 6881,
    });
  }

  async setFilePriorities(infoHash, priorities) {
    return this.request('setFilePriorities', { infoHash, priorities });
  }

  async setLimits(infoHash, uploadKbps, downloadKbps) {
    return this.request('setLimits', {
      infoHash: infoHash || '',
      uploadKbps: Number(uploadKbps) || 0,
      downloadKbps: Number(downloadKbps) || 0,
    });
  }

  async setSessionLimits(uploadKbps, downloadKbps) {
    return this.request('setSessionLimits', {
      uploadKbps: Number(uploadKbps) || 0,
      downloadKbps: Number(downloadKbps) || 0,
    });
  }

  async getPeerList(infoHash) {
    return this.request('peerList', { infoHash });
  }

  async updateTrackers(infoHash) {
    return this.request('updateTrackers', { infoHash });
  }

  async pauseTorrent(infoHash) {
    return this.request('pauseTorrent', { infoHash });
  }

  async resumeTorrent(infoHash) {
    return this.request('resumeTorrent', { infoHash });
  }

  async removeTorrent(infoHash, deleteFiles = false) {
    return this.request('removeTorrent', { infoHash, deleteFiles: !!deleteFiles });
  }

  async stop() {
    if (!this.addon) return;
    return this.request('stop', {});
  }
}

module.exports = { TorrentEngine, resolveAddonPath };
