# Torrent engine (in-process libtorrent N-API addon)

Ultra Downloader's torrent support is a native Node-API addon,
`torrent_addon.node`, built against [libtorrent](https://www.libtorrent.org/)
2.0.11 with OpenSSL so HTTPS trackers and encrypted peers work. The Electron
main process loads it directly; there is no child process, loopback listener,
HTTP request or shared token. `src/torrent-engine/engine.js` wraps the addon and
`src/torrents.js` owns the queue and the `torrents` table.

Calls run on a libuv worker thread and enter libtorrent under one mutex, so the
addon behaves like the old single-threaded sidecar while keeping the UI
responsive during long operations such as binding interfaces.

## Build

Prerequisites on Windows x64:

- **winlibs MinGW-w64** (g++ 15.x) at `C:\tools\winlibs\mingw64`
- **CMake** and **Ninja** (`py -3 -m pip install cmake ninja`)
- **Boost 1.86 headers** — <https://archives.boost.io/release/1.86.0/source/boost_1_86_0.zip>
- **libtorrent 2.0.11 source** —
  <https://github.com/arvidn/libtorrent/releases/download/v2.0.11/libtorrent-rasterbar-2.0.11.tar.gz>
- **OpenSSL 3.0 source** —
  <https://github.com/openssl/openssl/releases/download/openssl-3.0.15/openssl-3.0.15.tar.gz>
- **Node headers** containing `node_api.h`. The node-gyp cache for the bundled
  Node (`%LOCALAPPDATA%\node-gyp\Cache\<version>\include\node`) is used
  automatically; an Electron header cache is used as a fallback. Set
  `UD_NODE_INCLUDE` to override the search.
- A **Unix-like Perl** for OpenSSL's Configure. Git for Windows' Perl works
  when the few missing core modules (`ExtUtils::MakeMaker`,
  `Locale::Maketext::Simple`, `Pod::Usage`) are on `PERL5LIB`; MSYS2's `perl`
  package is the simplest alternative. Strawberry Perl (native Windows) is
  rejected by OpenSSL's `mingw64` target.

The examples below use `C:\build\ud-torrent` as the working directory.

### 1. OpenSSL (static, no shared DLLs)

```powershell
$env:PATH = "C:\tools\winlibs\mingw64\bin;<perl-dir>;" + $env:PATH
cd C:\build\ud-torrent\openssl-3.0.15
perl Configure mingw64 no-shared no-tests --prefix=C:/build/ud-torrent/openssl-mingw64
mingw32-make -j8
mingw32-make install_sw
```

Use a forward-slash `--prefix`. A backslash path ends up in `ENGINESDIR` and
breaks the C string literals. The static archives are installed to
`lib64\libssl.a` and `lib64\libcrypto.a` on 64-bit Windows.

### 2. libtorrent (static, encryption on)

```powershell
$env:PATH = "C:\tools\winlibs\mingw64\bin;" + $env:PATH
cd C:\build\ud-torrent
cmake -S libtorrent-rasterbar-2.0.11 -B build-lt -G Ninja `
  -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ `
  -DBUILD_SHARED_LIBS=OFF `
  -DBOOST_ROOT=C:/build/ud-torrent/boost_1_86_0 -DBoost_NO_SYSTEM_PATHS=ON `
  -Dencryption=ON -Ddeprecated-functions=OFF `
  -Dbuild_tests=OFF -Dbuild_examples=OFF -Dpython-bindings=OFF `
  -DOPENSSL_ROOT_DIR=C:/build/ud-torrent/openssl-mingw64 `
  -DOPENSSL_USE_STATIC_LIBS=TRUE
cmake --build build-lt -j 8
```

`-Dencryption=ON` must report OpenSSL as found. A build with
`-Dencryption=OFF` cannot announce to HTTPS trackers and must not be shipped.

### 3. torrent_addon.node

```powershell
# From the repository root. Defaults match the layout above:
#   C:\build\ud-torrent\libtorrent-rasterbar-2.0.11
#   C:\build\ud-torrent\build-lt
#   C:\build\ud-torrent\boost_1_86_0
#   C:\build\ud-torrent\openssl-mingw64
npm run build:torrent
```

The script also accepts explicit paths or environment variables:

```powershell
.\tools\torrent-engine\native\build.ps1 `
  -LibtorrentRoot C:\src\libtorrent-rasterbar-2.0.11 `
  -LibtorrentBuild C:\src\build-lt `
  -BoostRoot C:\src\boost_1_86_0 `
  -OpenSslRoot C:\src\openssl-mingw64 `
  -NodeInclude C:\src\node-headers\include\node
```

It writes `resources\torrent\torrent_addon.node` and removes a stale
`sidecar.exe` if one is still there. The file is git-ignored and is copied into
the installed app by electron-builder's `extraResources` as
`<resources>\torrent\torrent_addon.node`. Build it before `npm run dist`.

The link line is a shared library (`-shared -fPIC`) with `-lssl -lcrypto`,
static libtorrent, `-static-libgcc -static-libstdc++` and the same
`TORRENT_USE_OPENSSL` / `TORRENT_SSL_PEERS` defines libtorrent exports to its
consumers, so the addon and the static library share one ABI. No `node.lib`,
`.def` file or delay-load hook is used: `addon.cpp` resolves the `napi_*`
entry points from the host process with `GetProcAddress` when Electron loads
it.

## Addon API

`addon.call(method, params)` returns a Promise. It resolves with
`{ok: true, result}` and rejects with `Error("<method> failed: <error>")` when
the method returns a result error. The work runs off the JS thread and is
serialized by a mutex. `addon.version` reports the linked libtorrent version.

| Method | Params | Result |
| --- | --- | --- |
| `ping` | — | `{pong, version}` |
| `startTorrent` | `torrent` (magnet or `.torrent` path), `saveDir` | `{infoHash, name, isMagnet, saveDir}` |
| `status` | `infoHash` | progress, total and payload rates (`downKbps`, `upKbps`, `downloadPayloadKbps`, `uploadPayloadKbps`), peers/seeds, pieces, state, error, totals, ETA, all-time transfer, tracker, swarm counts, connections, limits, `files[]` |
| `setInterfaces` | `addresses[]`, `guids[]`?, `port`? | applied listen/outgoing interfaces or an error |
| `setFilePriorities` | `infoHash`, `priorities[]` | `{applied, files[]}` |
| `pauseTorrent` / `resumeTorrent` | `infoHash` | `{paused}` / `{resumed}` |
| `removeTorrent` | `infoHash`, `deleteFiles`? | `{removed, deletedFiles}` |
| `setLimits` | `infoHash`? (empty = all), `uploadKbps`, `downloadKbps` | `{applied, uploadKbps, downloadKbps}` |
| `setSessionLimits` | `uploadKbps`, `downloadKbps` | `{applied, uploadKbps, downloadKbps}` |
| `peerList` | `infoHash` | `{infoHash, peers[]}` with IP, client, rates, progress, flags, source, RTT |
| `updateTrackers` | `infoHash` | `{reannounced, scraped, infoHash}`; forces an announce and scrape, honouring tracker `min_interval` |
| `stop` | — | `{stopped}` and the libtorrent session is destroyed |

Limits are in kilobits per second. Per-torrent `setLimits` values at or below 0
mean unlimited (`-1` bytes/s in libtorrent); `setSessionLimits` values at or
below 0 mean unlimited (`0` in the settings pack). libtorrent does not rate
limit peers on the local network by default, so LAN peers may exceed a cap.

Multiple torrents are tracked in one session, keyed by info hash. Interface
binding is IP-based (`addr:port` listeners plus outgoing source addresses) with
a throwaway GUID probe; if Windows refuses GUID binding, the addon falls back
to IP and records the reason in `guidAttempt`. Bind interfaces before adding
the first torrent — re-applying listen settings to a live session was
unreliable with libtorrent 2.0.11 on Windows.

## Legal

The engine is generic. Test with the official Ubuntu ISO torrent:

```
https://releases.ubuntu.com/24.04/ubuntu-24.04.5.1-desktop-amd64.iso.torrent
```

Only download and share content you have the right to.
