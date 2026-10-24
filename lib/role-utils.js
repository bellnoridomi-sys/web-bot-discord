export function normalizeReactionEmoji(value) {
  return String(value || '').normalize('NFC').replace(/\uFE0F/g, '');
}

// The panel must match both the configured Discord message ID and its channel.
// Embed footers/descriptions are presentation only and must never grant privileges.
export function isActiveReactionRolePanel(panel, message) {
  return Boolean(
    panel?.message_id &&
    panel?.channel_id &&
    message?.id &&
    message?.channelId &&
    panel.message_id === message.id &&
    panel.channel_id === message.channelId
  );
}
