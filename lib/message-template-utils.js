import { sanitizePollText } from './role-utils.js';

export const MESSAGE_TEMPLATE_KINDS = Object.freeze(['welcome','goodbye']);

export function normalizeMessageTemplate(kind, input = {}) {
  if (!MESSAGE_TEMPLATE_KINDS.includes(String(kind || ''))) throw new Error('Loại template không hợp lệ.');
  const cleanText = (value, max, fallback = '') => sanitizePollText(String(value ?? fallback).trim(), max).trim();
  const title = cleanText(input.title, 256);
  const message = cleanText(input.message, 4000);
  const imageUrl = String(input.image_url ?? input.imageUrl ?? '').trim();
  const buttonLabel = cleanText(input.button_label ?? input.buttonLabel, 80);
  const buttonUrl = String(input.button_url ?? input.buttonUrl ?? '').trim();
  if (!title) throw new Error('Tiêu đề embed không được để trống.');
  if (!message) throw new Error('Nội dung embed không được để trống.');
  const validateHttps = (value, fieldLabel) => {
    if (!value) return null;
    let url;
    try { url = new URL(value); } catch { throw new Error(fieldLabel + ' phải là URL HTTPS hợp lệ.'); }
    if (url.protocol !== 'https:' || !url.hostname) throw new Error(fieldLabel + ' phải dùng HTTPS.');
    return url.toString();
  };
  const safeImageUrl = validateHttps(imageUrl, 'URL ảnh');
  const safeButtonUrl = validateHttps(buttonUrl, 'URL nút');
  if (Boolean(buttonLabel) !== Boolean(safeButtonUrl)) throw new Error('Cần nhập cả nhãn và URL nút, hoặc để trống cả hai.');
  return { kind: String(kind), title, message, image_url: safeImageUrl, button_label: buttonLabel || null, button_url: safeButtonUrl };
}

export function renderMessageTemplate(template, userValue, serverValue) {
  const variable = value => sanitizePollText(String(value ?? ''), 100).replace(/\s+/g, ' ').trim();
  const user = variable(userValue) || 'thành viên';
  const server = variable(serverValue) || 'server';
  return {
    title: String(template?.title || '').replaceAll('{user}', user).replaceAll('{server}', server).slice(0,256),
    message: String(template?.message || '').replaceAll('{user}', user).replaceAll('{server}', server).slice(0,4000),
  };
}
