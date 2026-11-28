# Ultra Downloader

A fast, multi-connection download manager for Windows, built for large files.

Ultra Downloader splits a file into ranges and downloads them in parallel over
one or more network adapters, keeps partial progress in temporary part files,
and builds the finished file only once every piece has arrived. It is designed
to survive huge downloads, flaky links and expired file-host URLs without
starting over.

**Current version: 1.3.1**

---

## What's new in 1.3.1

- **Torrents now run in-process.** The embedded libtorrent engine is a native
  addon inside the app: no sidecar process, control port or token. All the
  torrent features from 1.3.0 are preserved, including per-adapter binding.
- **Browse for a local `.torrent` file.** A new **Browse** button on the
  **Torrents** tab lets you pick a `.torrent` file on your PC.
- Everything from 1.3.0 is still here: magnet and `.torrent` URL downloads,
  file selection, seeding, per-torrent limits, tracker updates, onboarding and
  the rest.

---

## What's new in 1.3.0

- **Torrent downloading is built in.** Add a magnet link or a `.torrent` URL on
  the **Torrents** tab, or open a magnet link or `.torrent` file from Windows.
  The embedded libtorrent engine handles peer discovery, DHT, trackers and
  piece verification.
- **Choose files before downloading.** **Files** on a torrent card lets you
  uncheck files whose pieces should not be fetched.
- **Seeding, pause, resume, remove and restart resume.** Seeding is on by
  default and continues after a download finishes. Pause, resume or remove a
  torrent from its card; torrents resume from their existing data after the
  app restarts.
- **Per-torrent upload and download limits.** Set each torrent's own caps in
  KB/s or MB/s from **Limits**; switching the unit keeps the entered speed the
  same. A per-torrent value of 0 inherits the global torrent limit.
- **Payload upload rate shown separately.** The card's upload rate is payload
  traffic; the total in parentheses adds protocol and wire overhead, so it can
  read higher while payload stays at or under the limit.
- **Update trackers.** Forces an immediate tracker announce and scrape;
  trackers still enforce their `min_interval`.
- **Low-upload compatibility.** Torrent limits count payload bytes only and the
  engine keeps fixed unchoke slots, so a small upload cap does not starve the
  download.
- **In-app two-slide onboarding.** The first installed launch shows a feature
  tour, then a **Start with Windows** choice. **No** leaves it off;
  **Settings → Start Ultra Downloader when Windows starts** changes it later.
  No native Start with Windows dialog opens.
- **Start with Windows is opt-in and starts hidden in the tray**, so downloads
  and the Firefox bridge are ready after you sign in.
- Everything from 1.2.0 is still here: the Firefox bridge and first-run prompt,
  the all-tabs update banner, the multi-connection download engine, the queue,
  resume and data-preserving updates.

---

## What's new in 1.2.0

- **Firefox extension support is enabled.** When Ultra Downloader is running,
  Firefox downloads are handed to the app instead of being saved by the
  browser.
- **The bridge is on by default** for both new installs and upgrades from
  1.1.0.
- **Direct links and extensionless file-host buttons** are supported.
- **First-run Firefox prompt.** The first time 1.2.0 starts, a native dialog
  offers to install the Firefox extension and opens the AMO page if you say Yes.
- **Settings → Firefox extension → Get Firefox extension** opens the same page
  later.
- If the app is not running, Firefox downloads normally.
- **Update banner on every tab.** As soon as a new release is found, a banner
  appears with **Download update**, **Install now** and **Dismiss** actions.
  Dismissing hides it for that version only.
- **No automatic update dialogs.** The banner is the notification; the
  confirmation dialogs appear only when you click **Download update** or
  **Install now**.
- **Updates are found while the app is running.** A Firebase Realtime Database
  signal (backed by a 30-minute check and a check when the window regains
  focus) triggers the banner without needing a restart.

---

## What's new in 1.1.0

- **Self-updater.** The app checks once at startup, and **Settings → Updates**
  has a **Check now** button. You are asked before an update is downloaded and
  asked again before it is installed.
- **No silent installs.** Closing the app never installs an update on its own.
  If you choose **Later**, the app keeps running and the update stays ready to
  install from Settings or the tray.
- **Updates preserve your data.** The installer closes active transfers cleanly;
  downloads, part files, settings and history are kept.
- The Firefox extension bridge is present in the code but **disabled in 1.1.0**.
  It is enabled in 1.2.0 once the signed extension is available on AMO.

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
2. Download `Ultra.Downloader.Setup.1.3.0.exe`.
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

The optional Firefox extension adds one action: when Ultra Downloader is
running, Firefox downloads are handed to the app instead of being saved by the
browser.

1. Install Ultra Downloader **1.2.0 or newer**.
2. On first launch, say **Yes** to the Firefox extension prompt (a native
   dialog), or use **Settings → Firefox extension → Get Firefox extension**.
   You can also load it temporarily with `npx web-ext run --source-dir extension`
   for development.
3. Leave Ultra Downloader running (the window may be closed to the tray).
4. Click any download link, including file-host buttons whose URL has no file
   extension.

What happens:

- If Ultra Downloader is running, the download is handed to the app queue and
  Firefox's own copy is cancelled.
- If the app is not running, the extension does nothing and Firefox downloads
  the file normally.
- Direct download controls are intercepted before Firefox requests the file;
  Firefox download events are used as a fallback for buttons and scripts. The
  extension does not read page bodies, cookies or browsing history — only the
  clicked link's label and the current page path.

The extension has no popup, options page or history. It talks only to
`127.0.0.1`; no links or browsing data leave the PC. The bridge stays available
while Ultra Downloader is minimised or closed to the tray; it stops only when
the app is fully quit.

The Firefox extension prompt remains a native Windows dialog. The **Start with
Windows** choice is part of the separate in-app onboarding overlay.

---

## Torrents

Ultra Downloader downloads and seeds BitTorrent content with an embedded
libtorrent engine (`resources\torrent\torrent_addon.node`). The addon runs
inside the Electron main process; it opens no control port and starts no
separate process.

- Add a magnet link or a `.torrent` URL on the **Torrents** tab, or open a
  `.torrent` file or `magnet:` link from Windows — the installer registers both
  associations. A local `.torrent` file can also be picked with **Browse** on
  the **Torrents** tab.
- Each card shows progress, ETA, peers, seeds, rates, ratio, total wanted/done,
  all-time transfer, pieces, tracker, swarm counts, connections, distributed
  copies, active/seeding time and the effective speed limits. **Files** lets you
  uncheck files before their pieces are downloaded. **Update trackers** forces
  an immediate tracker announce and scrape; libtorrent still honours each
  tracker's `min_interval`, so clicking again too soon is rate-limited.
- **Limits** sets per-torrent upload and download caps in KB/s or MB/s (the
  settings card picks the default unit); switching the unit converts the entered
  values so the speed stays the same. **Peers** lists the connected peers with
  their IP, client, rates, progress and flags. A per-torrent value of 0 inherits
  the global torrent limit, and a global value of 0 means unlimited. Limits are
  kept across restarts.
- Seeding is **on by default** and continues after a download finishes. Pause a
  card (or **Pause all**) to stop seeding; **Stop seeding at ratio** ends it
  automatically.
- Torrents honour **Max active torrents** and, by default, bind to the adapters
  enabled on the **Connections** tab.
- libtorrent does not rate-limit peers on the local network by default, so a
  LAN peer can still transfer faster than the configured cap. Remote peers are
  always limited.
- Torrent upload limits apply to payload traffic, and the card's upload rate is
  the payload rate too. The total in parentheses includes protocol and wire
  overhead, so it can read higher than the cap while payload stays at or under
  it. Wire traffic may be slightly higher because TCP/IP overhead is excluded
  from the cap, and remote peers can still choke or refuse uploads based on
  reciprocity expectations.
- Only download and share content you have the right to. Ultra Downloader does
  not host, index or search for torrents.

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
| Check for updates at startup | On | Check once when the app starts. **Check now** is always available in Settings. |
| Start with Windows | Off | Launch hidden in the tray after you sign in. |
| Torrent download folder | empty | Where torrent files are written. Empty = the download folder. |
| Max active torrents | 2 | Torrents downloading at the same time. Seeding does not use a slot. |
| Torrent listening port | 6881 | TCP/UDP port used by the torrent engine. |
| Torrent limit unit | KB/s | Unit used by the torrent upload and download limits: KB/s or MB/s. 1 KB/s = 8 kbps; 1 MB/s = 8000 kbps. |
| Torrent upload limit | 0 (unlimited) | Upload speed cap for torrents, in the torrent limit unit. 0 means no limit. |
| Torrent download limit | 0 (unlimited) | Download speed cap for torrents, in the torrent limit unit. 0 means no limit. |
| Keep seeding | On | Continue seeding after a torrent finishes. |
| Stop seeding at ratio | 0 (never) | Stop seeding when uploaded/downloaded reaches this ratio. |
| Use enabled adapters | On | Bind the torrent engine to the adapters enabled on Connections. |

Settings are saved with **Save Settings**. Both folders are created and checked
when you save, so a typo is reported immediately. The update and startup
preferences save immediately when toggled. Per-torrent speed limits are set from
each torrent card's **Limits** dialog; 0 there inherits the global torrent limit.
The dialog starts in the global torrent limit unit. Changing either unit
selector (in Settings or in the dialog) converts the entered speeds to the new
unit, so the limit keeps its value.

---

## Troubleshooting

**"not enough free space"**
Free space on the drive shown, or point the Temporary files folder at a drive
with more room, then press **Retry**. Partial progress is preserved.

**"download link expired (HTTP 410)" / "access denied (HTTP 403)"**
The file host's link has expired. Use **Refresh link** with a fresh link to the
same file.

**The Firefox extension does not catch a download**
Check whether another download manager (IDM, EagleGet, etc.) is intercepting
Firefox downloads. If its browser integration is active, Firefox may never
start the download, so there is nothing for the extension to hand over. Disable
that integration and try again.

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

# Build the native torrent engine (libtorrent + OpenSSL)
npm run build:torrent

# Run the app in development
npm start

# Build the Windows x64 installer
npm run dist
```

The torrent engine is an in-process N-API addon loaded by the Electron main
process, built against a static libtorrent with encryption (OpenSSL) enabled.
`npm run build:torrent` writes `resources\torrent\torrent_addon.node`; it is not
committed. Prerequisites and the full libtorrent/OpenSSL build recipe are in
[tools/torrent-engine/README.md](tools/torrent-engine/README.md). Run it before
`npm run dist`, because `extraResources` copies `resources\torrent` into the
installer.

The installer is written to `dist\Ultra.Downloader.Setup.<version>.exe`.
The updater metadata is written to `dist\latest.yml`.

The Firefox extension is plain JavaScript with no build step:

```powershell
# Run it in a temporary Firefox profile
npx web-ext run --source-dir extension

# Package it for AMO
npx web-ext build --source-dir extension
```

The app is built with Electron and uses the system `curl.exe` for range
requests. Node.js 20 or newer is recommended for building.

## Publishing an update

1. Increase `version` in `package.json`.
2. Run `npm run dist`.
3. Create the GitHub release for `v<version>`.
4. Upload **both**:
   - `dist\Ultra.Downloader.Setup.<version>.exe`
   - `dist\latest.yml`
5. Do not upload an older `latest.yml` to a newer release.

The installed app reads `latest.yml` from the latest public GitHub release. It
asks before downloading and asks again before installing.

### Release notifications

Running apps listen to a Firebase Realtime Database pointer at `app/latest`.
When a GitHub release is published, the **Update notification** workflow writes
its version there, so open apps check immediately instead of waiting for the
30-minute polling fallback. The GitHub feed still decides whether an update is
really available, so the pointer cannot cause a false banner.

The workflow needs the repository secret `FIREBASE_SERVICE_ACCOUNT` (a Firebase
service account JSON key). The public Firebase web config lives in
`src/firebase.js`; the database rules allow public reads of `app/latest` only
and deny all client writes.

---

## Project layout

```
main.js                 Electron main process: window, tray, IPC, notifications
preload.js              Safe IPC bridge exposed to the renderer
src/db.js               SQLite schema, settings and download rows
src/autostart.js        Start with Windows login-item helper
src/downloader.js       Queue, range engine, resume, assembly, retries, limits
src/connections.js      Network adapter detection and per-adapter settings
src/linkgrabber.js      Scans a web page for downloadable links
src/torrents.js         Torrent queue, state mapping and persistence
src/torrent-engine/     Addon client and adapter GUID helper
tools/torrent-engine/   Native addon source, build script and README
resources/torrent/      Built torrent_addon.node (local only, git-ignored)
renderer/index.html     App shell and tabs
renderer/renderer.js    Cards, queue state, settings UI
renderer/styles.css     Theme and layout
extension/              Firefox download-link extension (enabled in 1.2.0)
src/bridge.js           Loopback bridge for the extension
src/firefox.js          First-run extension prompt and AMO page launcher
src/firebase.js         Public Firebase config and app/latest listener
src/updater.js          Update checks, banner actions, polling and install prompts
scripts/publish-update.js  Writes the release version to Firebase from CI
.github/workflows/update-notify.yml  Release notification workflow
assets/                 App icon
```

---

## License

MIT. See [LICENSE](LICENSE).

---

## Version history

### 1.3.0
- Added built-in torrent downloading from magnet links and `.torrent` files,
  with file selection, seeding, pause/resume/remove and restart resume.
- Added per-torrent upload and download limits with a KB/s or MB/s selector.
- Added the payload upload rate separate from the total wire rate, an Update
  trackers action and low-upload compatibility settings.
- Added the two-slide in-app onboarding overlay with the feature tour and the
  Start with Windows choice. Start with Windows is opt-in and starts hidden in
  the tray.
- Retained all 1.2.0 features.

### 1.2.0
- Enabled the Firefox download bridge by default.
- Added migration so upgrades from 1.1.0 enable the bridge automatically.
- Added a first-run prompt to install the Firefox extension, plus a Settings
  button for later.
- Firefox downloads are queued in the running app; if the app is not running,
  Firefox handles them normally.
- Direct links and extensionless file-host download buttons are supported.
- Added an all-tabs update banner with Download, Install, Releases and Dismiss
  actions.
- Removed the automatic update-available and update-downloaded dialogs; the
  banner is the only notification and consent dialogs open on click.
- Added a Firebase Realtime Database notification plus a 30-minute fallback
  check and a check on window focus, so new releases are noticed without a
  restart.

### 1.1.0
- Added the self-updater with startup and manual checks.
- Prompts before downloading and before installing an update.
- Added `latest.yml` update metadata to the release process.
- The Firefox extension bridge is present but disabled until 1.2.0.
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
