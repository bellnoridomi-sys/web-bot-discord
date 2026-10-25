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
