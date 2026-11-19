# AMO listing copy

## Name

Ultra Downloader

## Summary

Hand Firefox downloads to the Ultra Downloader app.

## Description

Ultra Downloader is the companion Firefox extension for the Ultra Downloader
desktop app on Windows.

When Ultra Downloader is running, the extension hands a download to the app and
cancels Firefox's own copy. If the app is not running, nothing is intercepted
and Firefox downloads normally.

- Works with direct file links and file-host buttons whose URL has no file
  extension.
- No popup, options page, download history or analytics.
- The extension only talks to the app over loopback (`127.0.0.1`).
- Requires the Ultra Downloader desktop app, version 1.2.0 or newer.

## Category

Download Management

## Support site

https://github.com/david-ojah/UltraDownloader/issues

## Privacy policy

No data is collected, stored remotely or transmitted off the PC. See
`privacy.md`.

## License

MIT

## Notes for reviewers

- The extension has no standalone UI. It observes download controls and Firefox
  download events, then sends the URL to the local Ultra Downloader app.
- A mock bridge is included in the source package so the extension can be
  tested without installing the desktop app:
  `node tools/mock-bridge.js`
- Load the extension with `web-ext run --source-dir extension` or from
  `about:debugging`.
- Click a direct download link and confirm the mock bridge prints
  `Would add: <url>`.
- If the mock bridge is stopped, Firefox should perform the download normally.
