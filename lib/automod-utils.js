export function normalizeBlockedDomains(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[,\s;]+/);
  const domains = [];
  for (const item of source) {
    let candidate = String(item ?? '').trim().toLowerCase().replace(/^\*\./, '');
    if (!candidate) continue;
    let parsed;
    try { parsed = new URL(candidate.includes('://') ? candidate : 'https://' + candidate); }
    catch { throw new Error('Domain không hợp lệ: ' + candidate); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Domain chỉ được dùng http/https: ' + candidate);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!host.includes('.') || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) {
      throw new Error('Domain không hợp lệ: ' + candidate);
    }
    if (!domains.includes(host)) domains.push(host);
    if (domains.length > 50) throw new Error('Chỉ được cấu hình tối đa 50 domain.');
  }
  return domains;
}

export function findBlockedDomain(message, domains = []) {
  const blocked = [...new Set((domains || []).map(value => String(value).toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')))];
  const links = String(message ?? '').match(/https?:\/\/[^\s<>()]+/gi) || [];
  for (const link of links) {
    try {
      const host = new URL(link.replace(/[),.!?]+$/, '')).hostname.toLowerCase().replace(/\.$/, '');
      const domain = blocked.find(item => host === item || host.endsWith('.' + item));
      if (domain) return domain;
    } catch {}
  }
  return null;
}

export function isMassMention({ content = '', mentions = {} } = {}, maxMentions = 5) {
  const text = String(content).toLowerCase();
  if (mentions.everyone || /@everyone\b|@here\b/i.test(text)) return true;
  const total = Number(mentions.users?.size || 0) + Number(mentions.roles?.size || 0);
  return total >= Math.max(2, Number(maxMentions) || 5);
}

export function recentTimestamps(values, now, windowMs) {
  const cutoff = Number(now) - Math.max(1, Number(windowMs) || 1);
  return (values || []).map(Number).filter(value => Number.isFinite(value) && value >= cutoff && value <= Number(now));
}

export function isRaidJoinBurst(previousTimestamps, now, windowMs = 20000, threshold = 8) {
  return recentTimestamps(previousTimestamps, now, windowMs).length + 1 >= Math.max(2, Number(threshold) || 8);
}
