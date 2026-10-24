export function normalizeReactionEmoji(value) {
  return String(value || '').normalize('NFC').replace(/\uFE0F/g, '');
}

// The panel must match both the configured Discord message ID and its channel.
// Embed footers/descriptions are presentation only and must never grant privileges.
export function isActiveReactionRolePanel(panel, message) {
  return Boolean(panel?.message_id && panel?.channel_id && message?.id && message?.channelId &&
    panel.message_id === message.id && panel.channel_id === message.channelId);
}
export function sanitizePollText(value, maxLength = 1000) {
  return String(value ?? '').replace(/<@([!&]?)(\d{17,20})>/g, '<@\u200b$1$2>')
    .replace(/@(everyone|here)/gi, '@\u200b$1').slice(0, maxLength);
}
export function sanitizePollFooter(value) {
  return sanitizePollText(String(value ?? 'Unknown').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(), 80);
}
export function isRoleHigherThan(actorHighestRole, targetHighestRole) {
  return Boolean(actorHighestRole && targetHighestRole &&
    typeof actorHighestRole.comparePositionTo === 'function' &&
    actorHighestRole.comparePositionTo(targetHighestRole) > 0);
}
