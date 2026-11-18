# Ultra Downloader — Firefox extension

A one-purpose Firefox extension: clicking a direct download link sends it to
the Ultra Downloader queue while the app is running.

There is no popup, options page, history or analytics. If the app is not
running, the extension does nothing and Firefox handles the download normally.

## Requirements

- Firefox 140 or newer
- Ultra Downloader 1.1.0 or newer, running (tray counts as running)
- Windows

## What it captures

- Direct links ending in common download extensions such as `.zip`, `.rar`,
  `.7z`, `.exe`, `.msi`, `.iso`, `.mp4`, `.mkv`, `.pdf`
- Links with a `download` attribute
- Any link through the right-click item **Download with Ultra Downloader**

It intentionally does not try to capture JavaScript-generated downloads, POST
forms, redirects or `blob:` URLs.

## How it talks to the app

The extension POSTs `{ "url": "..." }` to Ultra Downloader at
`http://127.0.0.1:17321/add`. The app listens on loopback only and requires the
`X-UD-Client: ultra-downloader-firefox` header. Requests from ordinary web
pages are rejected.

If the app is not running, the request fails quickly and the original Firefox
download continues.

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
- `<all_urls>` is used only by the content script to observe clicks on links.
  The extension does not read page content, cookies or history.
- The extension requires the companion desktop app. A mock bridge is provided
  at `../tools/mock-bridge.js` for testing without installing the app:

  ```powershell
  node tools/mock-bridge.js
  ```

  It accepts the extension's requests and prints the URLs that would be added
  to the queue.
- The content script prevents the browser download only after the app confirms
  the URL was queued. If the app is unavailable, it navigates to the original
  URL so Firefox downloads normally.
