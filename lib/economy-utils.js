export const UTC_DAY_MS = 24 * 60 * 60 * 1000;

export function nextDailyStreak(lastDailyAt, currentStreak, now = Date.now()) {
  const previous = Number(lastDailyAt);
  const streak = Math.max(0, Math.floor(Number(currentStreak) || 0));
  if (!Number.isFinite(previous) || previous <= 0) return 1;
  const dayDiff = Math.floor(Number(now) / UTC_DAY_MS) - Math.floor(previous / UTC_DAY_MS);
  return dayDiff === 1 ? streak + 1 : 1;
}

export function dailyStreakReward(streak, baseReward = 100, bonusStep = 25, maxBonusDays = 6) {
  const days = Math.max(1, Math.floor(Number(streak) || 1));
  const base = Math.max(0, Math.floor(Number(baseReward) || 0));
  const step = Math.max(0, Math.floor(Number(bonusStep) || 0));
  const cap = Math.max(0, Math.floor(Number(maxBonusDays) || 0));
  return base + Math.min(Math.max(0, days - 1), cap) * step;
}
