export function normalizeTempVoiceRoomName(displayName, userId) {
  const name = String(displayName || 'member')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[@#<>:]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
  const suffix = String(userId || '').replace(/\D/g, '').slice(-4);
  return ('temp・' + (name || 'member') + (suffix ? '-' + suffix : '')).slice(0, 100);
}
export function normalizeVoiceUserLimit(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(0, Math.min(99, n));
}
