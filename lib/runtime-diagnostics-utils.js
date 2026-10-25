export function safeRuntimeErrorCode(error) {
  const candidates = [error?.code, error?.status, error?.name];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)) return candidate;
  }
  return 'UNKNOWN_ERROR';
}

export function classifyGatewayDebugMessage(message) {
  const value = String(message || '').toLowerCase();
  if (/preparing to connect|connecting to (?:the )?gateway|opening websocket/.test(value)) return 'connecting_gateway';
  if (/identifying|sending identify/.test(value)) return 'identifying';
  if (/hello|heartbeat/.test(value)) return 'heartbeat';
  if (/resume|resuming/.test(value)) return 'resuming';
  if (/session invalid|invalidated/.test(value)) return 'invalidated';
  if (/closing|closed|disconnect/.test(value)) return 'closing';
  if (/ready/.test(value)) return 'ready';
  return null;
}

const RATE_LIMIT_SCOPES = new Set(['global', 'shared', 'user']);

export function classifyDiscordRestRoute(route) {
  const value = String(route || '').toLowerCase();
  if (value.includes('/gateway/bot') || value.includes('gatewaybot')) return 'gateway_bot';
  if (value.includes('/users/@me')) return 'current_user';
  if (value.includes('/applications/') && value.includes('/commands')) return 'application_commands';
  if (value.includes('/guilds/')) return 'guild_resource';
  return 'other';
}

export function normalizeRateLimitDiagnostics(info, timestamp = new Date().toISOString()) {
  const retryAfter = Number(info?.retryAfter);
  const timeToReset = Number(info?.timeToReset);
  const scope = RATE_LIMIT_SCOPES.has(info?.scope) ? info.scope : 'unknown';
  const method = typeof info?.method === 'string' && /^[A-Z]{3,10}$/.test(info.method) ? info.method : 'UNKNOWN';
  return {
    route: classifyDiscordRestRoute(info?.route || info?.url),
    method,
    scope,
    global: info?.global === true,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(Math.round(retryAfter), 86_400_000) : null,
    timeToResetMs: Number.isFinite(timeToReset) && timeToReset >= 0 ? Math.min(Math.round(timeToReset), 86_400_000) : null,
    at: timestamp
  };
}
