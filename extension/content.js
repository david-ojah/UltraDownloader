// Intercepts clicks that are clearly asking for a file, before Firefox sends a
// request. This is important on machines with another download manager's
// network driver installed: the app gets the URL directly and the browser (and
// the other driver) never sees the download.
const DOWNLOAD_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|exe|msi|iso|img|dmg|pkg|deb|rpm|apk|mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|flac|wav|aac|ogg|opus|pdf|epub|mobi|torrent|bin|dat|jar|crx|xpi)(?:$|[?#])/i;
// Endpoints that serve a file directly.
const DIRECT_DOWNLOAD_PATH = /\/(download-file|downloadfile|get-file|getfile|direct-download)(\/|$)/i;
// Pages that are already asking the user to download something.
const DOWNLOAD_PAGE_PATH = /\/(download|downloads|dl)(\/|$)/i;

function pageLooksLikeDownloadPage() {
  return DOWNLOAD_PAGE_PATH.test(String(window.location.pathname || ''));
}

function linkLabel(anchor) {
  return [
    anchor.textContent || '',
    anchor.getAttribute('aria-label') || '',
    anchor.getAttribute('title') || ''
  ].join(' ').trim().toLowerCase();
}

function isDownloadLink(anchor, event) {
  if (!anchor || event.button !== 0) return false;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
  const href = anchor.getAttribute('href');
  if (!href) return false;

  let url;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.href === window.location.href) return false;

  if (anchor.hasAttribute('download')) return true;
  if (DOWNLOAD_EXT.test(url.pathname)) return true;
  if (DIRECT_DOWNLOAD_PATH.test(url.pathname)) return true;

  // On a download page, the blue "Download Now" control often points at an
  // extensionless endpoint. Treat a download-labelled link as the file link
  // there, but not on ordinary article/game pages where it is just navigation.
  const label = linkLabel(anchor);
  return pageLooksLikeDownloadPage() && /\bdownload\b/.test(label);
}

function continueInBrowser(url) {
  try {
    window.location.assign(url);
  } catch {}
}

document.addEventListener('click', (event) => {
  if (event.defaultPrevented) return;
  const target = event.target;
  const anchor = target && target.closest ? target.closest('a[href]') : null;
  if (!isDownloadLink(anchor, event)) return;

  const url = anchor.href;
  event.preventDefault();
  event.stopImmediatePropagation();

  try {
    browser.runtime.sendMessage({ type: 'ud:add', url }).then((result) => {
      if (!result || !result.ok) continueInBrowser(url);
    }).catch(() => {
      continueInBrowser(url);
    });
  } catch {
    continueInBrowser(url);
  }
}, true);
