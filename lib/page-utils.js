export function normalizePage(value, totalItems, pageSize = 10) {
  const size = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 10)));
  const total = Math.max(0, Math.floor(Number(totalItems) || 0));
  const pages = Math.max(1, Math.ceil(total / size));
  const requested = Math.floor(Number.parseInt(String(value ?? '1'), 10) || 1);
  const page = Math.max(1, Math.min(pages, requested));
  return { page, pageSize: size, total, pages, offset: (page - 1) * size };
}
export function slicePage(items, pageValue, pageSize = 10) {
  const list = Array.isArray(items) ? items : [];
  const meta = normalizePage(pageValue, list.length, pageSize);
  return { ...meta, items: list.slice(meta.offset, meta.offset + meta.pageSize) };
}
