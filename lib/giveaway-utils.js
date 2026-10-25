export function drawUniqueWinners(entries, winnerCount, excluded = [], random = Math.random) {
  const count = Math.max(0, Math.min(100, Number.parseInt(String(winnerCount ?? 0), 10) || 0));
  const blocked = new Set((excluded || []).map(String));
  const pool = [...new Set((entries || []).map(entry => String(typeof entry === 'object' ? entry.user_id ?? entry.userId ?? '' : entry)).filter(Boolean))]
    .filter(id => !blocked.has(id));
  for (let i = pool.length - 1; i > 0; i--) {
    const value = Number(random());
    const unit = Number.isFinite(value) ? Math.max(0, Math.min(0.999999999, value)) : 0.5;
    const j = Math.floor(unit * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
