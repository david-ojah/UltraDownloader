# Build the in-process torrent addon with MinGW-w64.
#
# The addon is a Node-API shared library (torrent_addon.node) linked against a
# static libtorrent build with encryption (OpenSSL) enabled. Electron's main
# process loads it directly; no child process or import library is involved.
#
# Prerequisites (see README.md):
#   - winlibs MinGW-w64 g++ 15.x at C:\tools\winlibs\mingw64\bin
#   - Boost 1.86 headers
#   - libtorrent 2.0.11 built with -Dencryption=ON -DBUILD_SHARED_LIBS=OFF
#   - OpenSSL 3.0 built for mingw64 as static libraries (-lssl -lcrypto)
#   - Node headers (node_api.h) from the node-gyp or Electron header cache
#
# Usage:
#   .\build.ps1
#   .\build.ps1 -LibtorrentRoot C:\src\libtorrent-rasterbar-2.0.11 `
#               -LibtorrentBuild C:\src\build-lt `
#               -BoostRoot C:\src\boost_1_86_0 `
#               -OpenSslRoot C:\src\openssl-mingw64
#
# Defaults can also be supplied through UD_LIBTORRENT_ROOT,
# UD_LIBTORRENT_BUILD, UD_BOOST_ROOT and UD_OPENSSL_ROOT. Set UD_NODE_INCLUDE
# to the directory that contains node_api.h to override header discovery.
#
# The output is resources\torrent\torrent_addon.node (git-ignored, built
# locally).

param(
  [string]$LibtorrentRoot = $(if ($env:UD_LIBTORRENT_ROOT) { $env:UD_LIBTORRENT_ROOT } else { 'C:\build\ud-torrent\libtorrent-rasterbar-2.0.11' }),
  [string]$LibtorrentBuild = $(if ($env:UD_LIBTORRENT_BUILD) { $env:UD_LIBTORRENT_BUILD } else { 'C:\build\ud-torrent\build-lt' }),
  [string]$BoostRoot = $(if ($env:UD_BOOST_ROOT) { $env:UD_BOOST_ROOT } else { 'C:\build\ud-torrent\boost_1_86_0' }),
  [string]$OpenSslRoot = $(if ($env:UD_OPENSSL_ROOT) { $env:UD_OPENSSL_ROOT } else { 'C:\build\ud-torrent\openssl-mingw64' }),
  [string]$NodeInclude = $(if ($env:UD_NODE_INCLUDE) { $env:UD_NODE_INCLUDE } else { '' }),
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$mingw = 'C:\tools\winlibs\mingw64\bin'
if (Test-Path (Join-Path $mingw 'g++.exe')) {
  $env:PATH = "$mingw;$env:PATH"
}
if (-not (Get-Command g++ -ErrorAction SilentlyContinue)) {
  throw 'g++ not found. Install winlibs MinGW or put it on PATH.'
}

$lib = Join-Path $LibtorrentBuild 'libtorrent-rasterbar.a'
if (-not (Test-Path $lib)) {
  throw "static libtorrent not found: $lib (build libtorrent with -DBUILD_SHARED_LIBS=OFF)"
}
if (-not (Test-Path (Join-Path $BoostRoot 'boost/version.hpp'))) {
  throw "Boost headers not found under $BoostRoot"
}
if (-not (Test-Path (Join-Path $LibtorrentRoot 'include/libtorrent/session.hpp'))) {
  throw "libtorrent headers not found under $LibtorrentRoot"
}

$sslLib = ''
foreach ($candidate in @((Join-Path $OpenSslRoot 'lib64'), (Join-Path $OpenSslRoot 'lib'))) {
  if (Test-Path (Join-Path $candidate 'libssl.a')) { $sslLib = $candidate; break }
}
if (-not $sslLib) {
  throw "static OpenSSL not found under $OpenSslRoot (build with 'perl Configure mingw64 no-shared')"
}

# Find node_api.h. The node-gyp cache matching the bundled Node is the normal
# source; header paths under the Electron caches are accepted as a fallback.
if (-not $NodeInclude) {
  $candidates = @()
  $localNodeGyp = Join-Path $env:LOCALAPPDATA 'node-gyp\Cache'
  if (Test-Path $localNodeGyp) {
    $candidates += Get-ChildItem $localNodeGyp -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'include\node' }
  }
  foreach ($root in @(
      (Join-Path $env:LOCALAPPDATA 'electron-gyp\Cache'),
      (Join-Path $env:USERPROFILE '.electron-gyp'),
      (Join-Path $env:USERPROFILE '.node-gyp')
    )) {
    if (-not (Test-Path $root)) { continue }
    $candidates += Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'include\node' }
  }
  $NodeInclude = $candidates | Where-Object { Test-Path (Join-Path $_ 'node_api.h') } | Select-Object -First 1
}
if (-not $NodeInclude -or -not (Test-Path (Join-Path $NodeInclude 'node_api.h'))) {
  throw 'node_api.h not found. Set UD_NODE_INCLUDE to a Node or Electron header directory (the folder containing node_api.h).'
}

if (-not $OutDir) {
  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
  $OutDir = Join-Path $repoRoot 'resources\torrent'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path $OutDir 'torrent_addon.node'
$stale = Join-Path $OutDir 'sidecar.exe'
if (Test-Path $stale) { Remove-Item -Force $stale }

# Encryption stays enabled: TORRENT_DISABLE_ENCRYPTION must not be defined, and
# the OpenSSL archives are linked so HTTPS trackers work.
$defines = @(
  '-DTORRENT_NO_DEPRECATE',
  # Must match the libtorrent static build's exported interface definitions.
  '-DTORRENT_USE_OPENSSL',
  '-DTORRENT_USE_LIBCRYPTO',
  '-DTORRENT_SSL_PEERS',
  '-DOPENSSL_NO_SSL2',
  '-DBOOST_ASIO_NO_DEPRECATED',
  '-DBOOST_EXCEPTION_DISABLE',
  '-DBOOST_ASIO_ENABLE_CANCELIO',
  '-DBOOST_ASIO_HAS_STD_CHRONO',
  '-DWIN32_LEAN_AND_MEAN',
  '-D_WIN32_WINNT=0x0A00'
)

# Node-API symbols are resolved from the host executable at load time, so no
# node.lib, .def file or delay-load hook is needed. -Wl,--kill-at keeps the
# exported napi_register_module_v1 name undecorated if the toolchain decorates
# stdcall symbols; on x64 it is a no-op. The explicit static libstdc++ and
# winpthread archives keep the addon free of MinGW runtime DLLs: the driver's
# own -lstdc++ is appended after user libraries, so it would otherwise pull in
# libwinpthread-1.dll.
& g++ -O2 -std=c++17 -shared -fPIC @defines `
  -DNAPI_VERSION=8 -DBUILDING_NODE_EXTENSION `
  "-I$NodeInclude" "-I$BoostRoot" "-I$(Join-Path $LibtorrentRoot 'include')" "-I$(Join-Path $OpenSslRoot 'include')" `
  (Join-Path $PSScriptRoot 'addon.cpp') `
  "-L$LibtorrentBuild" -ltorrent-rasterbar `
  "-L$sslLib" -lssl -lcrypto `
  -lbcrypt -lmswsock -lws2_32 -liphlpapi -lcrypt32 -luser32 -ladvapi32 -lgdi32 `
  -static-libgcc -static-libstdc++ '-Wl,--kill-at' `
  '-Wl,-Bstatic' -lstdc++ -lwinpthread '-Wl,-Bdynamic' -o $out

if ($LASTEXITCODE -ne 0) { throw "build failed with exit code $LASTEXITCODE" }
Write-Host "built $out with headers from $NodeInclude"
