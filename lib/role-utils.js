export function normalizeReactionEmoji(value) {
  return String(value || '').normalize('NFC').replace(/\uFE0F/g, '');
}

export function parseReactionRoleBindingFromMessage(message, botUserId, emoji) {
  if (!message?.author?.id || !botUserId || message.author.id !== botUserId) return null;
  const embed = message.embeds?.find(item => String(item.footer?.text || '').includes('Reaction Roles'));
  if (!embed?.description) return null;
  const targetEmoji = normalizeReactionEmoji(emoji);
  if (!targetEmoji) return null;
  const line = embed.description.split('\n').find(item => normalizeReactionEmoji(item.trimStart()).startsWith(targetEmoji));
  const roleId = line?.match(/<@&(\d{17,20})>/)?.[1];
  return roleId ? { role_id: roleId } : null;
}
