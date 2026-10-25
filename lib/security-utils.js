export function isAllowedOrigin(origin, siteUrl) {
  if (typeof origin !== 'string' || !origin || typeof siteUrl !== 'string' || !siteUrl) return false;
  try { return new URL(origin).origin === new URL(siteUrl).origin; }
  catch { return false; }
}

export function websocketOriginFromSiteUrl(siteUrl) {
  try {
    const url = new URL(String(siteUrl || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return (url.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + url.host;
  } catch {
    return null;
  }
}
