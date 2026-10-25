import test from 'node:test';
import assert from 'node:assert/strict';
import { getCommandRegistrationScopes } from '../lib/command-registration-utils.js';

test('global slash commands are always registered when a development guild is configured', () => {
  assert.deepEqual(getCommandRegistrationScopes('123456789012345678'), ['global', 'guild']);
});

test('global slash commands still register when no development guild is configured', () => {
  assert.deepEqual(getCommandRegistrationScopes(''), ['global']);
  assert.deepEqual(getCommandRegistrationScopes(undefined), ['global']);
});

test('invalid development guild IDs cannot suppress global command registration', () => {
  assert.deepEqual(getCommandRegistrationScopes('not-a-discord-id'), ['global']);
  assert.deepEqual(getCommandRegistrationScopes('123'), ['global']);
});
