const SNOWFLAKE = /^\d{17,20}$/;

export function normalizeIdList(value, limit = 50) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[,\s;]+/);
  const result = [];
  for (const item of source) {
    const id = String(item ?? '').trim().replace(/^<#|^<@&?|^<@!?|>$/g, '');
    if (!id) continue;
    if (!SNOWFLAKE.test(id)) throw new Error('Discord ID không hợp lệ: ' + id);
    if (!result.includes(id)) result.push(id);
    if (result.length > limit) throw new Error('Chỉ được cấu hình tối đa ' + limit + ' ID.');
  }
  return result;
}

export function normalizeRoleMultipliers(value) {
  const entries = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : String(value ?? '').split(/[,\n;]+/).filter(Boolean).map(item => {
        const parts = item.split(/[=:]/);
        if (parts.length !== 2) throw new Error('Hệ số role dùng dạng ROLE_ID=1.5, cách nhau bằng dấu phẩy.');
        return [parts[0].trim(), parts[1].trim()];
      });
  const result = {};
  for (const [rawId, rawMultiplier] of entries) {
    const id = String(rawId).trim();
    const multiplier = Number(rawMultiplier);
    if (!SNOWFLAKE.test(id)) throw new Error('Role ID không hợp lệ: ' + id);
    if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 3) throw new Error('Hệ số XP phải từ 0.5 đến 3.');
    result[id] = multiplier;
    if (Object.keys(result).length > 30) throw new Error('Chỉ được cấu hình tối đa 30 role có hệ số XP.');
  }
  return result;
}

export function normalizeLevelRewards(value) {
  const entries = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : String(value ?? '').split(/[,\n;]+/).filter(Boolean).map(item => {
        const parts = item.split(/[=:]/);
        if (parts.length !== 2) throw new Error('Role thưởng dùng dạng LEVEL=ROLE_ID, cách nhau bằng dấu phẩy.');
        return [parts[0].trim(), parts[1].trim()];
      });
  const result = {};
  for (const [rawLevel, rawRoleId] of entries) {
    const level = Number(rawLevel), roleId = String(rawRoleId).trim();
    if (!Number.isInteger(level) || level < 1 || level > 1000) throw new Error('Level thưởng phải là số nguyên từ 1 đến 1000.');
    if (!SNOWFLAKE.test(roleId)) throw new Error('Role thưởng có ID không hợp lệ: ' + roleId);
    result[String(level)] = roleId;
    if (Object.keys(result).length > 100) throw new Error('Chỉ được cấu hình tối đa 100 mốc thưởng level.');
  }
  return result;
}

export function shouldAwardXpMessage({ enabled = true, channelId, memberRoleIds = [], ignoredChannels = [], ignoredRoles = [] } = {}) {
  if (!enabled) return false;
  if (ignoredChannels.map(String).includes(String(channelId ?? ''))) return false;
  const ignored = new Set(ignoredRoles.map(String));
  return !memberRoleIds.some(id => ignored.has(String(id)));
}

export function applyRoleXpMultiplier(baseXp, memberRoleIds = [], multipliers = {}) {
  const base = Math.max(1, Math.min(100, Math.floor(Number(baseXp) || 1)));
  const valid = memberRoleIds.map(String).filter(id => Object.hasOwn(multipliers, id))
    .map(id => Number(multipliers[id])).filter(n => Number.isFinite(n) && n >= 0.5 && n <= 3);
  const multiplier = valid.length ? Math.max(...valid) : 1;
  return Math.max(1, Math.min(100, Math.round(base * multiplier)));
}

export function getEligibleLevelRewards(level, rewards = {}) {
  const current = Math.max(0, Number(level) || 0);
  return Object.entries(rewards)
    .filter(([required, roleId]) => Number(required) <= current && Number(required) >= 1 && SNOWFLAKE.test(String(roleId)))
    .sort((a,b) => Number(a[0]) - Number(b[0]))
    .map(([required, roleId]) => ({ level: Number(required), roleId: String(roleId) }));
}
