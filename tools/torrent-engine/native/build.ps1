# Build the native torrent sidecar with MinGW-w64.
#
# The engine is a standalone JSON-over-HTTP process linked against a static
# libtorrent build with encryption (OpenSSL) enabled. The Node app never links
# libtorrent, so only this executable depends on the C++ toolchain.
#
# Prerequisites (see README.md):
#   - winlibs MinGW-w64 g++ 15.x at C:\tools\winlibs\mingw64\bin
#   - Boost 1.86 headers
#   - libtorrent 2.0.11 built with -Dencryption=ON -DBUILD_SHARED_LIBS=OFF
#   - OpenSSL 3.0 built for mingw64 as static libraries (-lssl -lcrypto)
#
# Usage:
#   .\build.ps1
#   .\build.ps1 -LibtorrentRoot C:\src\libtorrent-rasterbar-2.0.11 `
#               -LibtorrentBuild C:\src\build-lt `
#               -BoostRoot C:\src\boost_1_86_0 `
#               -OpenSslRoot C:\src\openssl-mingw64
#
# Defaults can also be supplied through UD_LIBTORRENT_ROOT,
# UD_LIBTORRENT_BUILD, UD_BOOST_ROOT and UD_OPENSSL_ROOT.
#
# The output is resources\torrent\sidecar.exe (git-ignored; built locally).

param(
  [string]$LibtorrentRoot = $(if ($env:UD_LIBTORRENT_ROOT) { $env:UD_LIBTORRENT_ROOT } else { 'C:\build\ud-torrent\libtorrent-rasterbar-2.0.11' }),
  [string]$LibtorrentBuild = $(if ($env:UD_LIBTORRENT_BUILD) { $env:UD_LIBTORRENT_BUILD } else { 'C:\build\ud-torrent\build-lt' }),
  [string]$BoostRoot = $(if ($env:UD_BOOST_ROOT) { $env:UD_BOOST_ROOT } else { 'C:\build\ud-torrent\boost_1_86_0' }),
  [string]$OpenSslRoot = $(if ($env:UD_OPENSSL_ROOT) { $env:UD_OPENSSL_ROOT } else { 'C:\build\ud-torrent\openssl-mingw64' }),
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

if (-not $OutDir) {
  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
  $OutDir = Join-Path $repoRoot 'resources\torrent'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path $OutDir 'sidecar.exe'

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

& g++ -O2 -std=c++17 @defines `
  "-I$BoostRoot" "-I$(Join-Path $LibtorrentRoot 'include')" "-I$(Join-Path $OpenSslRoot 'include')" `
  (Join-Path $PSScriptRoot 'sidecar.cpp') `
  "-L$LibtorrentBuild" -ltorrent-rasterbar `
  "-L$sslLib" -lssl -lcrypto `
  -lbcrypt -lmswsock -lws2_32 -liphlpapi -lcrypt32 -luser32 -ladvapi32 -lgdi32 `
  -static -o $out

if ($LASTEXITCODE -ne 0) { throw "build failed with exit code $LASTEXITCODE" }
Write-Host "built $out"
