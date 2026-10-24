export function vouchDenialReason(authorId, targetId, alreadyVouched) {
  if (!authorId || !targetId) return 'invalid-user';
  if (String(authorId) === String(targetId)) return 'self-vouch';
  if (alreadyVouched) return 'duplicate-vouch';
  return null;
}
export function formatAuditReason(actorName, reason, maxLength = 512) {
  const clean = value => String(value ?? '').split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(9)).join(' ').trim();
  const actor = clean(actorName || 'unknown').slice(0, 80) || 'unknown';
  const detail = clean(reason || 'No reason') || 'No reason';
  const prefix = '[by ' + actor + '] ';
  return (prefix + detail).slice(0, Math.max(prefix.length, Math.min(512, Number(maxLength) || 512)));
}
