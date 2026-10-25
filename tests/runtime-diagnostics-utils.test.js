import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRuntimeErrorCode, classifyGatewayDebugMessage, classifyDiscordRestRoute, normalizeRateLimitDiagnostics } from '../lib/runtime-diagnostics-utils.js';

test('runtime diagnostics expose a safe error code rather than an error message', () => {
  assert.equal(safeRuntimeErrorCode({ code: 4014, message: 'raw token=secret-value' }), '4014');
  assert.equal(safeRuntimeErrorCode({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'secret=value' }), 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(safeRuntimeErrorCode({ status: 500, message: 'DATABASE_URL=private-url' }), '500');
  assert.equal(safeRuntimeErrorCode(new Error('private token string')), 'Error');
});

test('runtime diagnostics reject control characters and excessive error-code values', () => {
  assert.equal(safeRuntimeErrorCode({ code: 'bad\nsecret', status: 403 }), '403');
  assert.equal(safeRuntimeErrorCode({ code: 'x'.repeat(100), name: 'TypeError' }), 'TypeError');
  assert.equal(safeRuntimeErrorCode(null), 'UNKNOWN_ERROR');
});

test('gateway debug classifier returns safe stages and never raw websocket messages', () => {
  assert.equal(classifyGatewayDebugMessage('Preparing to connect to the gateway...'), 'connecting_gateway');
  assert.equal(classifyGatewayDebugMessage('Identifying as a bot'), 'identifying');
  assert.equal(classifyGatewayDebugMessage('Received Hello; starting heartbeats'), 'heartbeat');
  assert.equal(classifyGatewayDebugMessage('Resuming session'), 'resuming');
  assert.equal(classifyGatewayDebugMessage('Ready'), 'ready');
  assert.equal(classifyGatewayDebugMessage('token=DO_NOT_LOG'), null);
});

test('REST route diagnostics expose coarse route names without IDs or query strings', () => {
  assert.equal(classifyDiscordRestRoute('/gateway/bot'), 'gateway_bot');
  assert.equal(classifyDiscordRestRoute('/users/@me'), 'current_user');
  assert.equal(classifyDiscordRestRoute('/applications/123456789012345678/commands'), 'application_commands');
  assert.equal(classifyDiscordRestRoute('/guilds/123456789012345678/channels'), 'guild_resource');
  assert.equal(classifyDiscordRestRoute('/unknown?token=secret'), 'other');
});

test('rate-limit diagnostics retain scope, retry timing and safe route class only', () => {
  const timestamp = '2026-10-25T06:00:00.000Z';
  assert.deepEqual(normalizeRateLimitDiagnostics({
    route: '/gateway/bot',
    url: 'https://discord.com/api/v10/gateway/bot?token=secret',
    method: 'GET',
    scope: 'global',
    global: true,
    retryAfter: 12000.7,
    timeToReset: 13000
  }, timestamp), {
    route: 'gateway_bot',
    method: 'GET',
    scope: 'global',
    global: true,
    retryAfterMs: 12001,
    timeToResetMs: 13000,
    at: timestamp
  });
  assert.deepEqual(normalizeRateLimitDiagnostics({
    route: '/guilds/1/channels', scope: 'weird', retryAfter: -1
  }, timestamp), {
    route: 'guild_resource',
    method: 'UNKNOWN',
    scope: 'unknown',
    global: false,
    retryAfterMs: null,
    timeToResetMs: null,
    at: timestamp
  });
});
