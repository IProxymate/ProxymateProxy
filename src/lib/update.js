/**
 * Проверка обновлений через GitHub Releases.
 *
 * Chrome не даёт расширениям, загруженным «в режиме разработчика», тихо
 * обновлять себя — это работает только для Chrome Web Store и для
 * force-install через политику. Поэтому здесь только проверка версии и
 * ссылка на релиз: установка новой версии всегда делается руками.
 */
export const REPO = 'IProxymate/ProxymateProxy';

function parseVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
}

/** latest новее current? Сравнение по числовым сегментам семвера. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store'
  });
  if (res.status === 404) throw new Error('Релизов пока нет');
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const data = await res.json();
  const zipAsset = (data.assets || []).find((a) => a.name.endsWith('.zip'));
  return {
    version: String(data.tag_name || '').replace(/^v/i, ''),
    url: data.html_url,
    zipUrl: zipAsset ? zipAsset.browser_download_url : data.zipball_url,
    publishedAt: data.published_at
  };
}

/** @returns {Promise<{current:string, latest:string, hasUpdate:boolean, url:string, zipUrl:string, publishedAt:string}>} */
export async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  const latest = await fetchLatestRelease();
  return {
    current,
    latest: latest.version,
    hasUpdate: isNewer(latest.version, current),
    url: latest.url,
    zipUrl: latest.zipUrl,
    publishedAt: latest.publishedAt
  };
}
