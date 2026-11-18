// Intercepts plain left-clicks on direct download links. If Ultra Downloader is
// running, the link is added to its queue and Firefox does not download it. If
// the app is not running (or the request fails), the original download is
// allowed to continue in Firefox.
const DOWNLOAD_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|exe|msi|iso|img|dmg|pkg|deb|rpm|apk|mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|flac|wav|aac|ogg|opus|pdf|epub|mobi|torrent|bin|dat|jar|crx|xpi)(?:$|[?#])/i;

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
  if (anchor.hasAttribute('download')) return true;
  return DOWNLOAD_EXT.test(url.pathname);
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
