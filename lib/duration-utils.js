const DURATION_MULTIPLIERS = Object.freeze({ s: 1, m: 60, h: 3600, d: 86400 });

export function parseDuration(value, minSeconds = 5, maxSeconds = 604800) {
  const raw = String(value ?? '').trim().toLowerCase();
  let seconds;
  if (/^[0-9]+$/.test(raw)) {
    seconds = Number(raw);
  } else {
    const match = raw.match(/^([0-9]+)\s*([smhd])$/);
    if (!match) throw new Error('Thời lượng phải theo dạng 30m, 2h, 1d hoặc số giây.');
    seconds = Number(match[1]) * DURATION_MULTIPLIERS[match[2]];
  }
  if (!Number.isSafeInteger(seconds) || seconds < minSeconds || seconds > maxSeconds) {
    throw new Error('Thời lượng phải từ ' + minSeconds + ' đến ' + maxSeconds + ' giây.');
  }
  return seconds;
}
