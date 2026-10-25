export function safeRuntimeErrorCode(error) {
  const candidates = [error?.code, error?.status, error?.name];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)) return candidate;
  }
  return 'UNKNOWN_ERROR';
}
