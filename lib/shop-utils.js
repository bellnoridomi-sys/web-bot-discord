export const SHOP_ITEMS = Object.freeze([
  { id: 'vip', roleName: '💎 VIP', price: 250, description: 'Role VIP cộng đồng' },
  { id: 'gamer', roleName: '🎮 Gamer', price: 100, description: 'Role sở thích gaming' },
  { id: 'social', roleName: '💬 Social', price: 100, description: 'Role sở thích giao lưu' },
  { id: 'trader', roleName: '🛍️ Trader', price: 120, description: 'Role giao dịch' },
  { id: 'buyer', roleName: '🛒 Buyer', price: 100, description: 'Role người mua' },
  { id: 'seller', roleName: '📦 Seller', price: 150, description: 'Role người bán' }
]);
export function getShopItem(id) {
  return SHOP_ITEMS.find(item => item.id === String(id || '').trim().toLowerCase()) || null;
}
export function isSafeShopRole(role, everyoneRoleId, botHighestPosition) {
  if (!role || role.managed || role.id === everyoneRoleId) return false;
  if (Number(role.position) >= Number(botHighestPosition)) return false;
  const perms = role.permissions?.bitfield ?? role.permissions;
  try { return BigInt(perms ?? 0) === 0n; } catch { return false; }
}
