import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRuntimeErrorCode } from '../lib/runtime-diagnostics-utils.js';

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
