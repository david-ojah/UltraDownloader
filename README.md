# Ultra Downloader

A fast, multi-connection download manager for Windows, built for large files.

Ultra Downloader splits a file into ranges and downloads them in parallel over
one or more network adapters, keeps partial progress in temporary part files,
and builds the finished file only once every piece has arrived. It is designed
to survive huge downloads, flaky links and expired file-host URLs without
starting over.

**Current version: 1.1.0**

---

## What's new in 1.1.0

- **Firefox extension support.** A small companion extension sends download
  links to the running app. Clicking a direct download link queues it in Ultra
  Downloader instead of Firefox. If the app is not running, Firefox downloads
  it normally.
- **Loopback-only bridge.** The app listens on `127.0.0.1` and accepts only
  requests carrying the extension client header; normal web pages cannot add
  downloads.
- **No new download behaviour.** Extension-added links go through the same
  queue, folders, retries, disk checks and part-file handling as manually added
  links.

---

## What's new in 1.0.1R1

- **Cleaner uninstall and update.** The app is now asked to close before its
  files are removed. It stops active transfers, saves the active-time counters
  and lets pending part-file writes finish, then exits. If it does not close in
  time, the installer/uninstaller closes it forcefully.
- **Uninstalling keeps your data.** The uninstaller removes only the program,
  its shortcuts and its Windows uninstall entry. Downloads, part files, settings
  and download history are kept. Reinstalling brings the list back and can
  resume unfinished downloads.
- **Uninstall steps documented.** See [Uninstall](#uninstall) below.

---

## What's new in 1.0.1

- **The download queue actually works now.** `Max concurrent jobs` used to be a
  setting that nothing read. Downloads now start automatically, and extra links
  wait their turn. Added **Pause all** and **Resume all**.
- **Completion notifications.** A Windows notification appears when a download
  finishes; click it to open the folder. The taskbar shows overall progress and
  the tray tooltip shows active downloads and speed.
- **Disk-space checks before and during a download.** The app refuses to start a
  transfer that cannot fit, with a clear message instead of failing hours later.
  It also stops cleanly if free space runs low mid-transfer.
- **Automatic retries with backoff.** A failed range is retried several times
  with growing delays before the download is marked failed. Expired links
  (403/404/410) are not retried pointlessly.
- **The PC stays awake while downloading.** Windows no longer puts the machine
  to sleep in the middle of a long transfer.
- **No more filename collisions.** Two simultaneous downloads with the same
  filename now get `file.bin`, `file (1).bin`, and so on, instead of writing to
  the same destination.
- **Pause is immediate.** Pausing stops the active streams straight away and
  resumes from the exact byte where each range stopped.
- The version number is shown in the bottom-left corner.

---

## Requirements

- Windows 10 or Windows 11 (64-bit)
- `curl.exe` — included with Windows 10 1803 and later, and with Windows 11
- An internet connection

No account or background service is required. The Firefox extension is optional.

---

## Install

1. Open the **Releases** page of this repository.
2. Download `Ultra.Downloader.Setup.1.1.0.exe`.
3. Run the installer and choose an install folder.

The installer is currently **unsigned**, so Windows SmartScreen may show
"Windows protected your PC". Click **More info → Run anyway**.

The install is per-user (no administrator prompt) and creates a desktop
shortcut. Installing or updating the app **never touches your database or your
downloaded files**.

---

## Quick start

1. Copy a direct download link (`http://` or `https://`).
2. Paste it into the box at the top of the **Downloads** tab and press Enter.
3. The download starts automatically if a queue slot is free.
4. Finished downloads move to the **Finished** tab.

From a download card you can **Pause**, **Resume**, **Cancel**, **Refresh link**,
or open the destination folder. Finished cards can **Open** the file, **Show in
folder**, or **Remove** the entry.

> `Cancel` deletes the temporary part files for that download. `Remove` on a
> finished download asks whether to keep the file or delete it too.

---

## Firefox extension

The optional Firefox extension adds one action: clicking a direct download
link sends it to the running Ultra Downloader queue.

1. Install Ultra Downloader **1.1.0 or newer**.
2. Install the Firefox extension from its AMO listing, or load it temporarily
   with `npx web-ext run --source-dir extension` while developing.
3. Leave Ultra Downloader running (the window may be closed to the tray).
4. Click a link to a file such as `.zip`, `.rar`, `.7z`, `.exe`, `.msi`, `.iso`,
   `.mp4`, `.mkv` or `.pdf`.

What happens:

- If Ultra Downloader is running, the click is intercepted, the URL is added to
  the queue, and Firefox does not start its own download.
- If the app is not running, the extension does nothing and Firefox downloads
  the file normally.
- There is also a right-click fallback: **Download with Ultra Downloader** on
  any link. This helps with file hosts whose download URL has no file
  extension.

The extension has no popup, options page or history. It talks only to
`127.0.0.1`; no links or browsing data leave the PC. The bridge stays available
while Ultra Downloader is minimised or closed to the tray; it stops only when
the app is fully quit.

Known limits: downloads started by JavaScript, POST forms, redirects or
`blob:` URLs cannot be intercepted. The context-menu fallback covers the final
visible link where one exists.

---

## The queue

The queue keeps your connection from being split across every link at once.

- **Max concurrent jobs** (Settings, default 3) is the number of downloads that
  may run simultaneously.
- New links join the end of the queue and start automatically when a slot frees.
- **Pause all** stops the running transfers and holds the queue; links added
  while paused stay waiting. **Resume all** continues them.
- **Start now** on a queued card starts it immediately if a slot is free.
- Pausing a download frees its slot, so a queued download can take its place.
  Resuming the paused one puts it back in the queue if all slots are busy.
- After an app restart, anything that was mid-transfer is queued again and
  resumed from its part files. Downloads you paused yourself stay paused.

---

## Folders and temporary files

| Setting | What it is |
|---|---|
| **Download folder** | Where finished files are written. |
| **Temporary files folder** | Where part files are written while downloading. Empty means "next to the download". |

Part files live in a hidden folder:

```
<download or temp folder>/.ud-parts/<download id>/<chunk index>.part
```

The finished file is assembled into `<name>.ud-assembling` next to the
destination and then renamed into place. Each part is deleted as soon as its
bytes have been copied, so a download never reserves its full size up front and
never needs a second full copy on disk.

When a download starts, the app checks:

- free space for the remaining bytes in the temporary folder;
- room for one part file on the destination drive (for the assembly step);
- if the two folders are on different drives, both volumes are checked
  separately.

If the check fails, the download is marked failed with a message like:

> not enough free space — about 41.5 GB is needed on C:\, but only 12.0 GB is available

Free some space and press **Retry**. The partial data is kept.

---

## Expired links and resuming

File-host links often expire while a large download is paused or fails. The
partial bytes are not thrown away:

1. Click **Refresh link** on the paused/failed card.
2. Paste a fresh link for the same file.
3. The app verifies the new link by:
   - comparing the total file size, and
   - downloading a small sample of an already-completed range and comparing it
     byte-for-byte with what is on disk.
4. Only then does it resume from where the old link stopped.

If the new link points at a different file, the app refuses to merge it into
your partial download.

---

## Notifications, tray and power

- A **Download complete** notification appears when a file finishes. Clicking
  it opens the folder containing the file.
- The **taskbar icon** shows overall progress while downloads are active.
- The **tray tooltip** shows the number of active downloads, overall percent and
  current speed.
- Closing or minimising the window sends it to the **system tray**. Downloads
  keep running.
- Launching the app again while it is in the tray brings the existing window
  forward — it does not create a second instance.
- To exit completely, right-click the tray icon and choose **Quit**.
- While a transfer is active, the app asks Windows to keep the system awake so
  a long download is not interrupted by sleep.

---

## Uninstall

### From Windows Settings

1. Open **Settings → Apps → Installed apps**.
2. Search for **Ultra Downloader**.
3. Open its menu and choose **Uninstall**.

### From the Start menu

Right-click **Ultra Downloader** and choose **Uninstall**.

### Silently, from a terminal

```powershell
& "$env:LOCALAPPDATA\Programs\Ultra Downloader\Uninstall Ultra Downloader.exe" /currentuser /S
```

### What the uninstaller does

1. It asks the running app to close by launching
   `Ultra Downloader.exe --quit`.
2. The app stops active transfers, saves the active-time counters and lets
   pending part-file writes finish before exiting.
3. The uninstaller waits briefly. If the app is still running (or it is an older
   build that does not understand `--quit`), it closes it forcefully with
   `taskkill` and continues.
4. It removes the program files, the desktop and Start menu shortcuts, and the
   Windows uninstall entry.

### What is kept

Uninstalling **never** deletes your downloads or download history. These are
left untouched:

| Path | What it contains |
|---|---|
| Your download folder | Finished files, including files from the Finished tab |
| `.ud-parts` folders | Temporary parts of unfinished downloads |
| `%APPDATA%\ultra-downloader\ultra.db` | Download list, settings and resume data |
| `%APPDATA%\ultra-downloader\deleted.log` | Deletion and startup audit log |

If you reinstall the app later, the download list and settings are still there,
and unfinished downloads can resume from their part files.

To remove the history and settings too, delete
`%APPDATA%\ultra-downloader` after uninstalling. Do that only if you no longer
need the download list or resume data.

---

## Safety

- **Finished files are sent to the Recycle Bin** when you choose "Delete file
  too", so a mistaken delete can be undone.
- The delete dialog shows the file size before you confirm.
- **Cancel** deletes only that download's own partial data. It never touches
  other downloads.
- **`Clear finished`** only removes entries from the list — it never deletes
  files from disk.
- Every delete, trash, unlist, cancel and startup event is appended to:

  ```
  %APPDATA%\ultra-downloader\deleted.log
  ```

- The app and installer never delete files in your download folder during an
  update.
- The app stores its database at:

  ```
  %APPDATA%\ultra-downloader\ultra.db
  ```

  Keep a copy of this file if you want to preserve your download history.

---

## Settings reference

| Setting | Default | Description |
|---|---|---|
| Download folder | `Downloads\UltraDownloader` | Where finished files are saved. |
| Temporary files folder | empty | Where part files are stored. Empty = beside the download. |
| Max concurrent jobs | 3 | Downloads allowed to run at the same time. |
| Max chunk size (MB) | 512 | Upper bound for a range. Larger ranges mean fewer TLS handshakes. |
| Target parallel streams | 4 | Starting number of parallel streams per download. The app adjusts from there. |
| Max connections per download | 4 | Network adapters used for one download. |
| Max streams per adapter | 32 | Hard limit for streams on a single adapter. |
| Global speed limit | 0 (unlimited) | Total download speed cap. 0 means no limit. |
| Speed unit | Mbps | How speeds are displayed (Mbps or MB/s). |

Settings are saved with **Save Settings**. Both folders are created and checked
when you save, so a typo is reported immediately.

---

## Troubleshooting

**"not enough free space"**
Free space on the drive shown, or point the Temporary files folder at a drive
with more room, then press **Retry**. Partial progress is preserved.

**"download link expired (HTTP 410)" / "access denied (HTTP 403)"**
The file host's link has expired. Use **Refresh link** with a fresh link to the
same file.

**The app disappeared after I closed it**
It is still running in the tray, and downloads continue. Double-click the tray
icon, or launch the app again, to bring the window back. Use tray → **Quit** to
stop it completely.

**SmartScreen says "unknown publisher"**
The installer is not code-signed yet. Choose **More info → Run anyway**.

**A download is stuck at 0%**
Check that the link opens in a browser and that the file host allows direct
downloads. Some hosts require a fresh link; use **Refresh link**. The error text
on the card explains most failures (403, 404, timeout, etc.).

**A download was paused when Windows restarted**
Downloads interrupted by a crash or restart are queued automatically and resume
from their part files. Downloads you paused yourself stay paused until you press
**Resume**.

---

## Build from source

```powershell
# Install dependencies
npm install

# Run the app in development
npm start

# Build the Windows x64 installer
npm run dist
```

The installer is written to `dist\Ultra Downloader Setup <version>.exe`.

The Firefox extension is plain JavaScript with no build step:

```powershell
# Run it in a temporary Firefox profile
npx web-ext run --source-dir extension

# Package it for AMO
npx web-ext build --source-dir extension
```

The app is built with Electron and uses the system `curl.exe` for range
requests. Node.js 20 or newer is recommended for building.

---

## Project layout

```
main.js                 Electron main process: window, tray, IPC, notifications
preload.js              Safe IPC bridge exposed to the renderer
src/db.js               SQLite schema, settings and download rows
src/downloader.js       Queue, range engine, resume, assembly, retries, limits
src/connections.js      Network adapter detection and per-adapter settings
src/linkgrabber.js      Scans a web page for downloadable links
renderer/index.html     App shell and tabs
renderer/renderer.js    Cards, queue state, settings UI
renderer/styles.css     Theme and layout
extension/              Firefox download-link extension
src/bridge.js           Loopback bridge for the extension
assets/                 App icon
```

---

## Version history

### 1.1.0
- Added the Firefox download-link extension and its loopback-only bridge.
- Clicking a direct download link queues it in the running app; if the app is
  not running, Firefox handles the download normally.
- Added a right-click **Download with Ultra Downloader** fallback.
- No change to the download engine, queue, folders or data safety.

### 1.0.1R1
- Revision of 1.0.1.
- Installer and uninstaller now ask the app to close cleanly before removing or
  replacing files, with a forced close only as a fallback.
- Active transfers stop without being marked paused, so an update or reinstall
  resumes them from their part files.
- Uninstall documentation added, including exactly which data is preserved.

### 1.0.1
- Working download queue with `Max concurrent jobs`, Pause all / Resume all.
- Completion notifications, taskbar progress and tray status.
- Disk-space preflight and low-space guard.
- Automatic chunk retries with exponential backoff.
- System stays awake during transfers.
- Immediate pause and exact resume.
- Fixed destination filename collisions between simultaneous downloads.
- Version shown in the sidebar.

### 1.0.0
- Initial release: multi-connection downloads, per-adapter caps, temporary part
  files, resume, link refresh, finished tab, tray, single instance.
