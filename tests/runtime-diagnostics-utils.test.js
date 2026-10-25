import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRuntimeErrorCode, classifyGatewayDebugMessage, classifyDiscordRestRoute, normalizeRateLimitDiagnostics, normalizeDiscordRestResponseDiagnostics, normalizeRetryAfterBodyValue, normalizeDiscordRestErrorBody } from '../lib/runtime-diagnostics-utils.js';

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


test('HTTP 429 diagnostics capture safe Retry-After and rate-limit scope headers', () => {
  const headers = new Headers({
    'Retry-After': '12.5',
    'X-RateLimit-Reset-After': '12.25',
    'X-RateLimit-Scope': 'global',
    'X-RateLimit-Global': 'true'
  });
  assert.deepEqual(normalizeDiscordRestResponseDiagnostics(
    { method: 'get', route: '/gateway/bot?token=secret' },
    { status: 429, headers },
    '2026-10-25T07:00:00.000Z'
  ), {
    status: 429,
    method: 'GET',
    route: 'gateway_bot',
    at: '2026-10-25T07:00:00.000Z',
    retryAfterMs: 12500,
    resetAfterMs: 12250,
    scope: 'global',
    global: true,
    contentType: 'unknown',
    edgeServer: 'unknown',
    cfRayPresent: false,
    cfMitigated: false
  });
});

test('HTTP diagnostics handle missing/invalid headers without exposing raw values', () => {
  assert.deepEqual(normalizeDiscordRestResponseDiagnostics(
    { method: 'POST', route: '/users/@me?token=secret' },
    { status: 429, headers: new Headers({ 'X-RateLimit-Scope': 'unexpected' }) },
    '2026-10-25T07:00:00.000Z'
  ), {
    status: 429,
    method: 'POST',
    route: 'current_user',
    at: '2026-10-25T07:00:00.000Z',
    retryAfterMs: null,
    resetAfterMs: null,
    scope: 'unknown',
    global: false,
    contentType: 'unknown',
    edgeServer: 'unknown',
    cfRayPresent: false,
    cfMitigated: false
  });
  assert.equal(normalizeRetryAfterBodyValue(3.25), 3250);
  assert.equal(normalizeRetryAfterBodyValue('bad'), null);
  assert.equal(normalizeRetryAfterBodyValue(-1), null);
});


test('429 error body diagnostics expose only safe, categorized metadata', () => {
  assert.deepEqual(normalizeDiscordRestErrorBody({
    message: 'You are being rate limited.',
    code: 20028,
    global: false,
    retry_after: 3507
  }), {
    bodyFormat: 'json',
    bodyMessageClass: 'rate_limited',
    discordErrorCode: 20028,
    bodyGlobal: false,
    bodyRetryAfterMs: 3507000
  });
  assert.deepEqual(normalizeDiscordRestErrorBody({
    message: 'Access denied due to Cloudflare restriction',
    code: '1015',
    global: true
  }), {
    bodyFormat: 'json',
    bodyMessageClass: 'possible_edge_restriction',
    discordErrorCode: 1015,
    bodyGlobal: true,
    bodyRetryAfterMs: null
  });
  assert.deepEqual(normalizeDiscordRestErrorBody('<html>blocked</html>'), {
    bodyFormat: 'non_json_or_unreadable',
    bodyMessageClass: 'unknown',
    discordErrorCode: null,
    bodyGlobal: null,
    bodyRetryAfterMs: null
  });
});
