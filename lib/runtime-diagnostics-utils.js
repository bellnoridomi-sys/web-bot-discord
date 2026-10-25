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
