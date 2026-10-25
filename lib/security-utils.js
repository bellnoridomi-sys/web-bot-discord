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

export function canControlGuild(actorId, guildOwnerId, permissions) {
  if (typeof actorId !== 'string' || !/^\d{17,20}$/.test(actorId)) return false;
  if (typeof guildOwnerId !== 'string' || !/^\d{17,20}$/.test(guildOwnerId)) return false;
  if (actorId === guildOwnerId) return true;
  try {
    const bits = BigInt(permissions ?? 0);
    const manageGuildOrAdministrator = (1n << 5n) | (1n << 3n);
    return (bits & manageGuildOrAdministrator) !== 0n;
  } catch {
    return false;
  }
}

export function isCurrentGuildMember(actorId, guildId, memberId, memberGuildId) {
  return typeof actorId === 'string' &&
    /^\d{17,20}$/.test(actorId) &&
    actorId === memberId &&
    typeof guildId === 'string' &&
    guildId === memberGuildId;
}
