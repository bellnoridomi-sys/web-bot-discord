export function checkCommandCooldown(cache, key, now = Date.now(), cooldownMs = 1200) {
  const duration = Number(cooldownMs);
  if (!Number.isFinite(duration) || duration <= 0) return { allowed: true, remainingMs: 0 };
  const current = Number(now);
  if (!Number.isFinite(current) || current < 0) return { allowed: false, remainingMs: duration };
  if (cache.has(key)) {
    const previous = Number(cache.get(key));
    const elapsed = current - previous;
    if (Number.isFinite(previous) && elapsed >= 0 && elapsed < duration) {
      return { allowed: false, remainingMs: Math.ceil(duration - elapsed) };
    }
  }
  cache.set(key, current);
  if (cache.size > 10000) {
    const threshold = current - Math.max(60000, duration * 5);
    for (const [entryKey, timestamp] of cache) if (Number(timestamp) < threshold) cache.delete(entryKey);
    while (cache.size > 12000) cache.delete(cache.keys().next().value);
  }
  return { allowed: true, remainingMs: 0 };
}

export function normalizeAutocompleteChoices(items, focusedValue, maxChoices = 25) {
  const query = String(focusedValue ?? '').trim().toLocaleLowerCase();
  const limit = Math.max(1, Math.min(25, Math.floor(Number(maxChoices) || 25)));
  const choices = [];
  for (const item of items || []) {
    const name = String(item?.name ?? item?.value ?? '').slice(0, 100);
    const value = String(item?.value ?? '').slice(0, 100);
    if (!value || !name.toLocaleLowerCase().includes(query)) continue;
    choices.push({ name, value });
    if (choices.length >= limit) break;
  }
  return choices;
}

export function formatReminderList(rows, maxTextLength = 150) {
  return (Array.isArray(rows) ? rows : []).map(row =>
    '#' + row.id + ' · <t:' + Math.floor(Number(row.execute_at) / 1000) + ':R> · ' +
    String(row.text || '').slice(0, maxTextLength)
  ).join('\n');
}
