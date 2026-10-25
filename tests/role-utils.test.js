import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReactionEmoji, isActiveReactionRolePanel, sanitizePollText, sanitizePollFooter, isRoleHigherThan } from '../lib/role-utils.js';
import { isAllowedOrigin } from '../lib/security-utils.js';
import { isOpenAkiTicket, parseAkiTicketTopic, ticketDeletionDelay, TICKET_RETENTION_MS, normalizeTicketType, ticketTypeLabel } from '../lib/ticket-utils.js';
import { normalizeMediaUrl } from '../lib/media-utils.js';
import { getLevelProgress, calculateMessageXp } from '../lib/community-utils.js';

const panel = { channel_id: '222222222222222222', message_id: '333333333333333333' };
const activeMessage = { channelId: panel.channel_id, id: panel.message_id };

test('normalizes variation selectors in emoji names', () => {
  assert.equal(normalizeReactionEmoji('📣️'), '📣');
  assert.equal(normalizeReactionEmoji('🎮'), '🎮');
});

test('accepts only the configured message in the configured channel', () => {
  assert.equal(isActiveReactionRolePanel(panel, activeMessage), true);
});

test('rejects another message even if its embed looks like a role panel', () => {
  assert.equal(isActiveReactionRolePanel(panel, { ...activeMessage, id: '444444444444444444' }), false);
});

test('rejects the configured message ID copied into another channel', () => {
  assert.equal(isActiveReactionRolePanel(panel, { ...activeMessage, channelId: '555555555555555555' }), false);
});

test('rejects missing or incomplete panel metadata', () => {
  assert.equal(isActiveReactionRolePanel(null, activeMessage), false);
  assert.equal(isActiveReactionRolePanel({ message_id: panel.message_id }, activeMessage), false);
  assert.equal(isActiveReactionRolePanel(panel, { id: panel.message_id }), false);
});


test('blocks the poll-based reaction-role escalation payload', () => {
  const roleId = '123456789012345678';
  const attackerName = 'Reaction Roles';
  const poll = {
    id: '666666666666666666',
    channelId: panel.channel_id,
    embeds: [{ footer: { text: 'Poll by ' + sanitizePollFooter(attackerName) },
      description: sanitizePollText('Pick me <@&' + roleId + '>') }]
  };
  assert.equal(poll.embeds[0].footer.text, 'Poll by Reaction Roles');
  assert.equal(poll.embeds[0].description.includes('<@&' + roleId + '>'), false);
  assert.equal(isActiveReactionRolePanel(panel, poll), false);
});
test('sanitizes role and mass mentions in poll text', () => {
  assert.equal(sanitizePollText('@everyone @here'), '@\u200beveryone @\u200bhere');
  assert.equal(sanitizePollText('<@123456789012345678> <@&123456789012345678>'),
    '<@\u200b123456789012345678> <@\u200b&123456789012345678>');
});
test('rejects missing, malformed, and foreign origins', () => {
  assert.equal(isAllowedOrigin('https://aki.example', 'https://aki.example/path'), true);
  assert.equal(isAllowedOrigin('https://evil.example', 'https://aki.example'), false);
  assert.equal(isAllowedOrigin(undefined, 'https://aki.example'), false);
  assert.equal(isAllowedOrigin('not a URL', 'https://aki.example'), false);
});
test('hierarchy helper requires actor highest role above target', () => {
  const role = position => ({
    position,
    comparePositionTo(other) { return Math.sign(this.position - other.position); }
  });
  const high = role(3), equal = role(3), low = role(1);
  assert.equal(isRoleHigherThan(high, low), true);
  assert.equal(isRoleHigherThan(high, equal), false);
  assert.equal(isRoleHigherThan(low, high), false);
  assert.equal(isRoleHigherThan(null, high), false);
});

test('closed ticket topic no longer blocks the owner from opening a new ticket', () => {
  const owner = '123456789012345678';
  const openTopic = 'aki-ticket-owner=' + owner;
  const closedTopic = openTopic + ';aki-ticket-status=closed;aki-ticket-closed-at=1700000000000';
  assert.equal(isOpenAkiTicket(openTopic, owner), true);
  assert.equal(isOpenAkiTicket(closedTopic, owner), false);
  assert.deepEqual(parseAkiTicketTopic(closedTopic), { ownerId: owner, status: 'closed', closedAt: 1700000000000 });
});
test('closed ticket retention timer is bounded by seven days', () => {
  const closedAt = 1_700_000_000_000;
  assert.equal(ticketDeletionDelay(closedAt, closedAt), TICKET_RETENTION_MS);
  assert.equal(ticketDeletionDelay(closedAt, closedAt + TICKET_RETENTION_MS), 0);
  assert.equal(ticketDeletionDelay(null), null);
});

test('normalizeMediaUrl accepts http(s) and rejects unsafe or excessive URLs', () => {
  assert.equal(normalizeMediaUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeMediaUrl(''), null);
  assert.throws(() => normalizeMediaUrl('javascript:alert(1)'), /http hoặc https/);
  assert.throws(() => normalizeMediaUrl('not a URL'), /không hợp lệ/);
  assert.throws(() => normalizeMediaUrl('https://example.com/' + 'a'.repeat(2050)), /quá dài/);
});
test('level progress is correct at boundaries and invalid XP values', () => {
  assert.deepEqual(getLevelProgress(0), { xp: 0, level: 0, progress: 0, need: 100 });
  assert.deepEqual(getLevelProgress(99), { xp: 99, level: 0, progress: 99, need: 100 });
  assert.deepEqual(getLevelProgress(100), { xp: 100, level: 1, progress: 0, need: 100 });
  assert.deepEqual(getLevelProgress(-2), { xp: 0, level: 0, progress: 0, need: 100 });
  assert.deepEqual(getLevelProgress('bad'), { xp: 0, level: 0, progress: 0, need: 100 });
});
test('message XP rolls are deterministic and bounded', () => {
  assert.equal(calculateMessageXp(0, 8, 14), 8);
  assert.equal(calculateMessageXp(0.999999, 8, 14), 14);
  assert.equal(calculateMessageXp(0.5, 8, 14), 11);
  assert.equal(calculateMessageXp(5, 8, 14), 14);
});

import { vouchDenialReason, formatAuditReason } from '../lib/moderation-utils.js';
test('vouch rules reject self-vouch and duplicate pairs', () => {
  assert.equal(vouchDenialReason('111111111111111111', '111111111111111111', false), 'self-vouch');
  assert.equal(vouchDenialReason('111111111111111111', '222222222222222222', true), 'duplicate-vouch');
  assert.equal(vouchDenialReason('111111111111111111', '222222222222222222', false), null);
});
test('audit reasons include actor and normalize line breaks within Discord limit', () => {
  assert.equal(formatAuditReason('Staff\nName', 'Repeated spam'), '[by Staff Name] Repeated spam');
  assert.ok(formatAuditReason('Moderator', 'x'.repeat(900), 512).length <= 512);
});

test('temporary ban expiry check handles future, due, and invalid timestamps', async () => {
  const { isExpiryDue } = await import('../lib/moderation-utils.js');
  assert.equal(isExpiryDue(2000, 1000), false);
  assert.equal(isExpiryDue(1000, 1000), true);
  assert.equal(isExpiryDue('bad', 1000), false);
  assert.equal(isExpiryDue(0, 1000), false);
});

import { parseDuration } from '../lib/duration-utils.js';
import { buildNativePollPayload } from '../lib/poll-utils.js';
import { parsePagination, csvCell } from '../lib/activity-utils.js';
import { isAccountTooNew } from '../lib/verification-utils.js';
import { drawUniqueWinners } from '../lib/giveaway-utils.js';
import { normalizeSuggestionText, isSuggestionVote, canReviewSuggestion } from '../lib/suggestion-utils.js';
import { SHOP_ITEMS, getShopItem, isSafeShopRole } from '../lib/shop-utils.js';
import { nextDailyStreak, dailyStreakReward, UTC_DAY_MS } from '../lib/economy-utils.js';
import { normalizeBlockedDomains, findBlockedDomain, isMassMention, isRaidJoinBurst } from '../lib/automod-utils.js';
test('parses human reminder durations and keeps numeric-second compatibility', () => {
  assert.equal(parseDuration('30m'), 1800);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1d'), 86400);
  assert.equal(parseDuration('5s'), 5);
  assert.equal(parseDuration(300), 300);
  assert.throws(() => parseDuration('2w'), /dạng 30m/);
  assert.throws(() => parseDuration('1s'), /từ 5/);
  assert.throws(() => parseDuration('8d'), /từ 5/);
});

test('ticket type selection rejects arbitrary values and maps safe labels', () => {
  assert.equal(normalizeTicketType('support'), 'support');
  assert.equal(normalizeTicketType('middleman'), 'middleman');
  assert.equal(normalizeTicketType('scam-report'), 'scam-report');
  assert.equal(normalizeTicketType('owner-admin'), null);
  assert.equal(ticketTypeLabel('scam-report'), 'Báo cáo scam');
});

test('native poll payload sanitizes role mentions and requires two distinct answers', () => {
  const payload = buildNativePollPayload({ question: 'Vote <@&123456789012345678>', options: ['One <@&123456789012345678>', 'Two'] });
  assert.equal(payload.poll.question.text.includes('<@&123456789012345678>'), false);
  assert.equal(payload.poll.answers[0].poll_media.text.includes('<@&123456789012345678>'), false);
  assert.equal(payload.poll.duration, 24);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.throws(() => buildNativePollPayload({ question: 'Only one', options: ['One'] }), /ít nhất hai/);
  assert.throws(() => buildNativePollPayload({ question: 'Duplicate', options: ['Same','same'] }), /không được trùng/);
});

test('warning escalation triggers only on positive multiples of the configured threshold', async () => {
  const { shouldEscalateWarnings } = await import('../lib/moderation-utils.js');
  assert.equal(shouldEscalateWarnings(3, 3), true);
  assert.equal(shouldEscalateWarnings(6, 3), true);
  assert.equal(shouldEscalateWarnings(4, 3), false);
  assert.equal(shouldEscalateWarnings(0, 3), false);
  assert.equal(shouldEscalateWarnings(3, 0), false);
  assert.equal(shouldEscalateWarnings(3, 2.5), false);
});

test('pagination is bounded and produces deterministic offsets', () => {
  assert.deepEqual(parsePagination('3','20'), { page: 3, limit: 20, offset: 40 });
  assert.deepEqual(parsePagination('-5','500'), { page: 1, limit: 50, offset: 0 });
});
test('CSV export quotes delimiters and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('plain, "quoted"'), '"plain, ""quoted"""');
  assert.equal(csvCell('=CMD()'), '"\'=CMD()"');
  assert.equal(csvCell('hello' + String.fromCharCode(10) + 'world'), '"hello world"');
});

test('account-age gate quarantines only when younger than configured threshold', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(isAccountTooNew(1000, 0, 1001), false);
  assert.equal(isAccountTooNew(1000, 2, 1000 + day), true);
  assert.equal(isAccountTooNew(1000, 2, 1000 + 2 * day), false);
  assert.equal(isAccountTooNew('invalid', 2, 1000 + day), true);
});

test('giveaway winner selection is unique, bounded, and supports reroll exclusions', () => {
  const entries = ['a','b','c','a','d'].map(user_id => ({ user_id }));
  assert.deepEqual(drawUniqueWinners(entries, 2, [], () => 0), ['b','c']);
  assert.deepEqual(drawUniqueWinners(entries, 3, ['a','b','c'], () => 0), ['d']);
  assert.equal(drawUniqueWinners(entries, 8, [], () => 0).length, 4);
});

test('suggestion state only allows valid votes and pending-to-review transitions', () => {
  assert.equal(normalizeSuggestionText('  Please add more channels  '), 'Please add more channels');
  assert.equal(normalizeSuggestionText('@everyone add channels').includes('@everyone'), false);
  assert.equal(isSuggestionVote('up'), true);
  assert.equal(isSuggestionVote('down'), true);
  assert.equal(isSuggestionVote('approve'), false);
  assert.equal(canReviewSuggestion('pending','approved'), true);
  assert.equal(canReviewSuggestion('pending','rejected'), true);
  assert.equal(canReviewSuggestion('approved','rejected'), false);
});

test('shop catalog uses positive prices and normalized item IDs', () => {
  assert.ok(SHOP_ITEMS.length >= 4);
  assert.equal(getShopItem('VIP')?.id, 'vip');
  assert.equal(getShopItem('not-a-real-item'), null);
  assert.ok(SHOP_ITEMS.every(item => Number.isInteger(item.price) && item.price > 0));
});
test('shop sells only unmanaged no-permission roles below bot', () => {
  const role = { id: '22', position: 2, managed: false, permissions: { bitfield: 0n } };
  assert.equal(isSafeShopRole(role, '1', 3), true);
  assert.equal(isSafeShopRole({ ...role, managed: true }, '1', 3), false);
  assert.equal(isSafeShopRole({ ...role, permissions: { bitfield: 8n } }, '1', 3), false);
  assert.equal(isSafeShopRole(role, '22', 3), false);
  assert.equal(isSafeShopRole({ ...role, position: 3 }, '1', 3), false);
});

test('daily streak is based on consecutive UTC dates and resets after a missed day', () => {
  const day = UTC_DAY_MS;
  assert.equal(nextDailyStreak(0, 0, day * 10), 1);
  assert.equal(nextDailyStreak(day * 10 + 100, 2, day * 11 + 200), 3);
  assert.equal(nextDailyStreak(day * 10 + 100, 6, day * 12 + 200), 1);
});
test('daily streak reward bonus grows and caps', () => {
  assert.equal(dailyStreakReward(1), 100);
  assert.equal(dailyStreakReward(2), 125);
  assert.equal(dailyStreakReward(7), 250);
  assert.equal(dailyStreakReward(30), 250);
});

test('blocked-domain matching checks host boundaries and parses user-configured domains', () => {
  const domains = normalizeBlockedDomains('*.scam.example, bad.test');
  assert.deepEqual(domains, ['scam.example', 'bad.test']);
  assert.equal(findBlockedDomain('Read https://sub.scam.example/path now', domains), 'scam.example');
  assert.equal(findBlockedDomain('https://not-scam.example/path', domains), null);
  assert.throws(() => normalizeBlockedDomains('bad domain'), /Domain không hợp lệ/);
});
test('mass mention detection catches everyone and excessive mention counts', () => {
  assert.equal(isMassMention({ content: 'hello @everyone' }, 5), true);
  assert.equal(isMassMention({ content: 'hello', mentions: { users: { size: 2 }, roles: { size: 1 } } }, 3), true);
  assert.equal(isMassMention({ content: 'hello', mentions: { users: { size: 1 }, roles: { size: 0 } } }, 3), false);
});
test('raid join burst triggers only after configured threshold within time window', () => {
  assert.equal(isRaidJoinBurst([0,1000,2000,3000],4000,10000,5), true);
  assert.equal(isRaidJoinBurst([1000,2000,3000],4000,1000,5), false);
});
