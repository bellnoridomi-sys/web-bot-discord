import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReactionEmoji, isActiveReactionRolePanel, sanitizePollText, sanitizePollFooter, isRoleHigherThan } from '../lib/role-utils.js';
import { isAllowedOrigin } from '../lib/security-utils.js';

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
  const high = { comparePositionTo: () => 1 }, equal = { comparePositionTo: () => 0 }, low = { comparePositionTo: () => -1 };
  assert.equal(isRoleHigherThan(high, low), true);
  assert.equal(isRoleHigherThan(high, equal), false);
  assert.equal(isRoleHigherThan(low, high), false);
  assert.equal(isRoleHigherThan(null, high), false);
});
