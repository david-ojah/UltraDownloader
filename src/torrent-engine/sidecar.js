'use strict';

// Thin Node client for the native libtorrent HTTP sidecar.
//
// The engine itself is resources/torrent/sidecar.exe in the repo and
// <resources>/torrent/sidecar.exe in an installed app. This module owns the
// process lifecycle, generates the per-launch shared token and speaks the
// loopback JSON protocol:
//
//   const sidecar = new TorrentSidecar();
//   await sidecar.start();
//   await sidecar.setInterfaces(['192.168.0.91'], { guids: ['{...}'], port: 6881 });
//   await sidecar.startTorrent(torrentPath, saveDir);
//   await sidecar.getStatus(infoHash);
//   await sidecar.stop();

const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');

const DEV_EXE = path.join(__dirname, '..', '..', 'resources', 'torrent', 'sidecar.exe');

function resolveExePath() {
  // Packaged: electron-builder copies resources/torrent to <resources>/torrent.
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'torrent', 'sidecar.exe');
    if (fs.existsSync(packaged)) return packaged;
  }
  return DEV_EXE;
}

function httpJson(port, token, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ...payload, token });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-UD-Torrent-Token': token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`invalid sidecar response: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`sidecar request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

class TorrentSidecar {
  constructor(options = {}) {
    this.exePath = options.exePath || process.env.ULTRA_TORRENT_SIDECAR || resolveExePath();
    // A fresh token per process. The native sidecar refuses to start without
    // UD_TORRENT_TOKEN and rejects every RPC that does not present it.
    this.token = options.token || crypto.randomBytes(24).toString('hex');
    this.port = null;
    this.child = null;
    this.stdoutBuffer = '';
    this.stderrLines = [];
    this.stderrBuffer = '';
    this.exited = false;
    this.libtorrentVersion = '';
  }

  async start(timeoutMs = 15000) {
    if (this.child && !this.exited) return this.port;
    if (!fs.existsSync(this.exePath)) {
      throw new Error(
        `native sidecar not found at ${this.exePath}. Build it with npm run build:torrent (see tools/torrent-engine/README.md).`
      );
    }

    this.exited = false;
    this.child = spawn(this.exePath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, UD_TORRENT_TOKEN: this.token },
    });

    const child = this.child;
    // Never leave an orphaned engine behind if the app process exits without
    // reaching the graceful shutdown path.
    process.once('exit', () => {
      try { if (this.child && !this.exited) this.child.kill(); } catch {}
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer += chunk;
      const lines = this.stderrBuffer.split(/\r?\n/);
      this.stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > 500) this.stderrLines.shift();
      }
    });
    child.on('exit', () => {
      this.exited = true;
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`sidecar did not report a port within ${timeoutMs} ms`));
      }, timeoutMs);

      const onData = (chunk) => {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('SIDECAR_PORT=')) {
            this.port = Number(line.slice('SIDECAR_PORT='.length));
          } else if (line.startsWith('LIBTORRENT_VERSION=')) {
            this.libtorrentVersion = line.slice('LIBTORRENT_VERSION='.length);
          }
        }
        if (this.port) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(this.port);
        }
      };

      child.stdout.on('data', onData);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        if (!this.port) {
          clearTimeout(timer);
          reject(new Error(`sidecar exited before reporting a port (code ${code})`));
        }
      });
    });
  }

  async request(method, params = {}, timeoutMs) {
    if (!this.port) throw new Error('sidecar is not running');
    const response = await httpJson(this.port, this.token, { method, params }, timeoutMs);
    if (!response || response.ok !== true) {
      const message = response && response.error ? response.error : 'unknown sidecar error';
      const err = new Error(`${method} failed: ${message}`);
      err.response = response;
      throw err;
    }
    return response.result;
  }

  async ping() {
    return this.request('ping', {}, 5000);
  }

  async startTorrent(torrent, saveDir) {
    return this.request('startTorrent', { torrent, saveDir });
  }

  async getStatus(infoHash) {
    return this.request('status', { infoHash }, 10000);
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
    if (!this.child) return;
    const child = this.child;
    try {
      if (this.port) await this.request('stop', {}, 3000);
    } catch {
      // Process may already be gone; fall through to the kill path.
    }
    await new Promise((resolve) => {
      const finish = () => resolve();
      if (this.exited) return finish();
      const timer = setTimeout(() => {
        if (!this.exited) {
          try { child.kill(); } catch {}
        }
        finish();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        finish();
      });
    });
    if (this.child === child) this.child = null;
    this.port = null;
  }
}

module.exports = { TorrentSidecar, DEFAULT_EXE: DEV_EXE, resolveExePath };

if (require.main === module) {
  const args = process.argv.slice(2);
  const exeIndex = args.indexOf('--exe');
  const exePath = exeIndex >= 0 ? args[exeIndex + 1] : undefined;
  const sidecar = new TorrentSidecar({ exePath });
  sidecar
    .start()
    .then(async () => {
      const info = await sidecar.ping();
      console.log(`sidecar listening on 127.0.0.1:${sidecar.port} (libtorrent ${info.version})`);
      const shutdown = async () => {
        await sidecar.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
