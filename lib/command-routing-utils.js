const PRIVATE_COMMANDS = new Set([
  'warnings','role','warn','kick','ban','tempban','timeout','unban','untimeout','delwarn',
  'case','modlog','scam-add','scamcheck','legit','role-panel','ticket-setup','auto-voice',
  'vc-join','vc-leave','clear','remind','reminders','reminder-cancel','shop','buy','sell-setup',
  'xp-setup','automod-setup','suggest','suggest-setup','giveaway','giveaway-reroll','temp-voice-setup'
]);
export function keepsCommandResultPrivate(name) {
  return PRIVATE_COMMANDS.has(String(name || '').replace(/^\//,'').trim().toLowerCase());
}
export function summarizeCommandResult(payload) {
  if (typeof payload === 'string') return payload.slice(0,3500);
  if (!payload || typeof payload !== 'object') return 'Lệnh đã thực hiện thành công.';
  const embed = payload.embeds?.[0];
  const data = embed?.data || embed || {};
  const parts = [data.title, data.description, ...(data.fields || []).map(field => String(field.name || '') + ': ' + String(field.value || ''))].filter(Boolean);
  return (parts.join('\n') || 'Lệnh đã thực hiện thành công.').slice(0,3500);
}
