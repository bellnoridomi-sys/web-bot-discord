export function getLevelProgress(totalXp) {
  const parsed = Number(totalXp);
  const xp = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  return { xp, level: Math.floor(xp / 100), progress: xp % 100, need: 100 };
}
export function calculateMessageXp(randomValue = Math.random(), min = 8, max = 14) {
  const lower = Math.max(1, Math.floor(Number(min) || 1));
  const upper = Math.max(lower, Math.floor(Number(max) || lower));
  const numeric = Number(randomValue);
  const random = Number.isFinite(numeric) ? Math.max(0, Math.min(0.999999999999, numeric)) : 0.5;
  return lower + Math.floor(random * (upper - lower + 1));
}
