import { sanitizePollText } from './role-utils.js';

export function normalizeTagName(value) {
  const name = String(value ?? '').normalize('NFKC').trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-+/g, '-').slice(0, 32);
  if (name.length < 2) throw new Error('Tên tag cần 2–32 ký tự (chữ, số, gạch ngang hoặc gạch dưới).');
  return name;
}

export function normalizeFaqKeyword(value) {
  const keyword = String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 60);
  if (keyword.length < 2) throw new Error('Từ khoá FAQ cần ít nhất 2 ký tự.');
  return keyword;
}

export function sanitizeCommunityContent(value, maxLength = 1500) {
  const content = sanitizePollText(String(value ?? '').trim(), maxLength);
  if (!content) throw new Error('Nội dung không được để trống.');
  return content;
}

export function findMatchingFaq(rules, messageContent) {
  const message = String(messageContent ?? '').normalize('NFKC').toLowerCase();
  return [...(rules || [])]
    .filter(rule => rule && String(rule.keyword || '').length >= 2 && message.includes(String(rule.keyword).toLowerCase()))
    .sort((a, b) => String(b.keyword).length - String(a.keyword).length)[0] || null;
}
