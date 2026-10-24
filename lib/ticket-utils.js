export const TICKET_RETENTION_MS = 7 * 24 * 60 * 60_000;

export function parseAkiTicketTopic(topic) {
  const value = String(topic || '');
  const ownerId = value.match(/(?:^|;)aki-ticket-owner=(\d{17,20})(?:;|$)/)?.[1] || null;
  const status = value.match(/(?:^|;)aki-ticket-status=([a-z-]+)(?:;|$)/)?.[1] || 'open';
  const closedAtRaw = value.match(/(?:^|;)aki-ticket-closed-at=(\d+)(?:;|$)/)?.[1];
  const closedAt = closedAtRaw ? Number(closedAtRaw) : null;
  return { ownerId, status, closedAt: Number.isFinite(closedAt) ? closedAt : null };
}

export function isOpenAkiTicket(topic, ownerId) {
  const parsed = parseAkiTicketTopic(topic);
  return parsed.ownerId === String(ownerId) && parsed.status !== 'closed';
}

export function ticketDeletionDelay(closedAt, now = Date.now(), retentionMs = TICKET_RETENTION_MS) {
  const closed = Number(closedAt);
  if (!Number.isFinite(closed) || closed <= 0) return null;
  return Math.max(0, retentionMs - (now - closed));
}
