# Reviewer notes — Ultra Downloader

## What the extension does

The extension is a bridge between Firefox and the Ultra Downloader desktop app.

1. A content script recognises clicks on direct download controls.
2. The background page sends the URL to Ultra Downloader at
   `http://127.0.0.1:17321/add`.
3. If the app accepts it, Firefox's own download is cancelled.
4. If the app is not running, Firefox handles the download normally.

Firefox's `downloads` events are also watched as a fallback for downloads that
start without an anchor click.

## Testing without the desktop app

The source package includes a mock bridge:

```powershell
node tools/mock-bridge.js
```

It listens on `127.0.0.1:17321`, accepts the extension's client header, and
prints the URL it would add to the queue.

Then load the extension:

```powershell
npx web-ext run --source-dir extension
```

Open any page containing a link to a file, for example:

```html
<a href="https://example.com/file.zip">Download</a>
```

Click the link. The mock bridge should print:

```
Would add: https://example.com/file.zip
```

Stop the mock bridge and click the link again. Firefox should download the file
normally.

## Permissions

- `downloads` — observe and cancel the Firefox download after the app accepts
  the URL.
- `notifications` — report a failed handoff.
- `<all_urls>` — content script needs to recognise download controls on any
  site. It only checks the clicked link's `href`/label and the current page
  path, not page bodies, cookies or history.
- `http://127.0.0.1/*` — the local bridge.

## Data collection

None. No analytics, remote code, accounts or remote servers. See
`privacy.md`.
