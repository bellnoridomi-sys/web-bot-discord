import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReactionEmoji, parseReactionRoleBindingFromMessage } from '../lib/role-utils.js';

const botId = '999999999999999999';
const roleId = '123456789012345678';
const panel = {
  author: { id: botId },
  embeds: [{
    footer: { text: 'Aki Dev · Reaction Roles' },
    description: [
      'Thêm reaction emoji hoặc nhấn nút emoji tương ứng để nhận/gỡ role.',
      '👥 Muốn tự gán Member cho người mới, hãy chọn Member trong dashboard.',
      '📣 **Announcement Ping** — Thông báo (<@&123456789012345678>)',
      '🎉 **Event Ping** — Sự kiện (<@&123456789012345679>)'
    ].join('\n')
  }]
};

test('normalizes variation selectors in emoji names', () => {
  assert.equal(normalizeReactionEmoji('📣️'), '📣');
  assert.equal(normalizeReactionEmoji('🎮'), '🎮');
});

test('resolves a role id from a bot-authored reaction-role panel', () => {
  assert.deepEqual(parseReactionRoleBindingFromMessage(panel, botId, '📣'), { role_id: roleId });
  assert.deepEqual(parseReactionRoleBindingFromMessage(panel, botId, '📣️'), { role_id: roleId });
});

test('resolves separate role bindings from the correct emoji line', () => {
  assert.deepEqual(parseReactionRoleBindingFromMessage(panel, botId, '🎉'), { role_id: '123456789012345679' });
});

test('does not trust messages authored by users or other bots', () => {
  assert.equal(parseReactionRoleBindingFromMessage({ ...panel, author: { id: '111111111111111111' } }, botId, '📣'), null);
  assert.equal(parseReactionRoleBindingFromMessage(panel, null, '📣'), null);
});

test('ignores ordinary messages without a reaction-role footer', () => {
  const ordinary = { author: { id: botId }, embeds: [{ footer: { text: 'Aki Dev' }, description: '📣 (<@&123456789012345678>)' }] };
  assert.equal(parseReactionRoleBindingFromMessage(ordinary, botId, '📣'), null);
});

test('ignores emojis without a matching role id', () => {
  assert.equal(parseReactionRoleBindingFromMessage(panel, botId, '💬'), null);
});
