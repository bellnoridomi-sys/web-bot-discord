export function isAccountTooNew(createdAt, minimumDays, now = Date.now()) {
  const days = Number(minimumDays);
  if (!Number.isFinite(days) || days <= 0) return false;
  const created = Number(createdAt);
  if (!Number.isFinite(created) || created <= 0) return true;
  return Number(now) - created < days * 24 * 60 * 60 * 1000;
}
