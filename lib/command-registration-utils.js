export function getCommandRegistrationScopes(guildId) {
  const scopes = ['global'];
  if (typeof guildId === 'string' && /^\d{17,20}$/.test(guildId)) scopes.push('guild');
  return scopes;
}
