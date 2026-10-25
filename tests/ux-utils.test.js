import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReminderList } from '../lib/ux-utils.js';

test('reminder list uses actual newlines and truncates long reminder text', () => {
  const body = formatReminderList([
    { id: 7, execute_at: 1_700_000_000_000, text: 'first' },
    { id: 8, execute_at: 1_700_000_060_000, text: 'x'.repeat(400) }
  ]);
  const lines = body.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(body.includes('\\n'), false);
  assert.equal(lines[0], '#7 · <t:1700000000:R> · first');
  assert.equal(lines[1].endsWith('x'.repeat(150)), true);
  assert.equal(formatReminderList(null), '');
});
