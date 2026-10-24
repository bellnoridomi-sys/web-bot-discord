export function isAllowedOrigin(origin, siteUrl) {
  if (typeof origin !== 'string' || !origin || typeof siteUrl !== 'string' || !siteUrl) return false;
  try { return new URL(origin).origin === new URL(siteUrl).origin; }
  catch { return false; }
}
