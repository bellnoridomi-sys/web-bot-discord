export function normalizeMediaUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Media URL phải dùng http hoặc https.');
    if (url.toString().length > 2048) throw new Error('Media URL quá dài.');
    return url.toString();
  } catch (error) {
    if (error.message === 'Media URL phải dùng http hoặc https.' || error.message === 'Media URL quá dài.') throw error;
    throw new Error('Media URL không hợp lệ.');
  }
}
