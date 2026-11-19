# Ultra Downloader — Firefox extension

A one-purpose Firefox extension: when Ultra Downloader is running, Firefox
downloads are handed to the app instead of being saved by the browser.

There is no popup, options page, history or analytics. If the app is not
running, the extension does nothing and Firefox downloads normally.

## Requirements

- Firefox 142 or newer
- Ultra Downloader 1.2.0 or newer, running (tray counts as running)
- Windows

## How it works

The extension has two complementary paths:

1. A content script intercepts clicks on direct download controls before
   Firefox sends the request. This is what handles file-host buttons such as
   AnkerGames' **Download Now**.
2. A background listener watches Firefox's download events as a fallback for
   buttons and scripts that start a download without an `<a>` click.

Both paths check whether Ultra Downloader is running on `127.0.0.1`. If it is,
the URL is added to the queue and Firefox's own copy is cancelled. If it is not,
Firefox downloads normally. The extension does not read page text, cookies or
history.

If the app rejects a download after Firefox's copy was cancelled, the extension
starts the download again in Firefox so it is not lost.

## Development

```powershell
# Temporary install in a Firefox profile
npx web-ext run --source-dir extension

# Lint and package
npx web-ext lint --source-dir extension
npx web-ext build --source-dir extension
```

## AMO review notes

- Add-on ID: `ultradownloader@david-ojah.github.io`
- Data collection: none. Declared with
  `browser_specific_settings.gecko.data_collection_permissions`.
- Permissions: `downloads` (to observe and cancel a download), `notifications`
  (to report a failed handoff), `<all_urls>` (the content script only inspects
  the clicked link and page path to recognise download controls), and
  `http://127.0.0.1/*` (the local bridge).
- The content script does not read page text, cookies or history. It only looks
  at the clicked anchor's href/label and the current page path.
- The extension requires the companion desktop app. A mock bridge is provided
  at `../tools/mock-bridge.js` for testing without installing the app:

  ```powershell
  node tools/mock-bridge.js
  ```

  It accepts the extension's requests and prints the URLs that would be added
  to the queue.
- If the app is unavailable, the Firefox download is not cancelled.
