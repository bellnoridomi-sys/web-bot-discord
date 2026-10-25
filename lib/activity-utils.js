export function parsePagination(pageValue, limitValue, defaultLimit = 20, maxLimit = 50) {
  const page = Math.max(1, Number.parseInt(String(pageValue ?? '1'), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(String(limitValue ?? String(defaultLimit)), 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
}
