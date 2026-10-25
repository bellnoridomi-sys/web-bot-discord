import { sanitizePollText } from './role-utils.js';

export function normalizeSaleSubmission(input = {}) {
  const clean = (value, max) => sanitizePollText(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
  const title = clean(input.title, 100);
  const price = clean(input.price, 80);
  const description = String(input.description ?? '').replace(/\r/g, '').trim();
  const safeDescription = sanitizePollText(description, 1600);
  const contact = clean(input.contact, 120);
  if (title.length < 3) throw new Error('Tiêu đề đăng bán cần ít nhất 3 ký tự.');
  if (!price) throw new Error('Hãy nhập giá hoặc ghi “Thương lượng”.');
  if (safeDescription.length < 10) throw new Error('Mô tả cần ít nhất 10 ký tự.');
  if (contact.length > 120) throw new Error('Thông tin liên hệ quá dài.');
  return { title, price, description: safeDescription, contact };
}

export function canPostSale(lastPostedAt, now, cooldownMinutes) {
  const last = Number(lastPostedAt) || 0;
  const current = Number(now);
  const minutes = Math.max(0, Number(cooldownMinutes) || 0);
  if (!Number.isFinite(current) || current < 0 || last < 0) return { allowed: false, nextAt: null };
  const nextAt = last + minutes * 60_000;
  return last === 0 || current >= nextAt ? { allowed: true, nextAt: current } : { allowed: false, nextAt };
}

export function normalizeSaleCooldownMinutes(value, fallback = 30) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5, Math.min(1440, Math.floor(n)));
}
