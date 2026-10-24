import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReactionEmoji, isActiveReactionRolePanel } from '../lib/role-utils.js';

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
