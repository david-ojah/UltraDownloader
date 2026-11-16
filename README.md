# Ultra Downloader

Electron-based download manager for Windows 11 25H2+.

Features:
- Paste URLs (single or webpage) and extract candidate download links.
- Multi-connection downloads across the active network adapters, splitting files into byte ranges.
- Dynamic chunk sizing: the file is split into roughly `2 × connections` chunks and each
  connection runs 1–2 parallel range streams, so speed holds up whether 1 or several
  adapters are active. The final region of the file is split across all streams so no
  stream is left copying a lopsided tail on its own.
- Adaptive stream ramp: when the server throttles each connection (file lockers, proxies,
  CDNs with per-socket limits), extra streams are added automatically until throughput
  stops improving.
- Resume, pause, cancel, queue.
- Per-connection speed caps and probing.

## Run
```
npm install
npm start
```

## Notes
- VPN/proxy virtual adapters are excluded by default.
- Connections per download is configurable (default 4, UI max 8); the app never uses an
  adapter whose IP is no longer present.
- Chunk size is automatic (1 MB floor, "Max chunk size" cap); "Target parallel streams"
  controls how many range downloads run at once in total.
- Requires Node 20+.
