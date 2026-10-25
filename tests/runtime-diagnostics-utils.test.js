import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRuntimeErrorCode, classifyGatewayDebugMessage } from '../lib/runtime-diagnostics-utils.js';

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
