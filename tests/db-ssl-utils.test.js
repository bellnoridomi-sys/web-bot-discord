import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDatabaseSsl } from '../lib/db-ssl-utils.js';

test('auto mode skips optional TLS for the Render internal Postgres hostname only', () => {
  assert.equal(resolveDatabaseSsl({ host: 'dpg-cv123abc-a', isRender: true }), false);
});

test('auto mode keeps TLS certificate verification for external Render Postgres', () => {
  assert.deepEqual(resolveDatabaseSsl({
    host: 'dpg-cv123abc-a.oregon-postgres.render.com',
    isRender: true
  }), { rejectUnauthorized: true });
});

test('auto mode keeps TLS certificate verification for third-party databases on Render', () => {
  assert.deepEqual(resolveDatabaseSsl({
    host: 'db.example.net',
    isRender: true
  }), { rejectUnauthorized: true });
});

test('auto mode keeps TLS certificate verification outside Render', () => {
  assert.deepEqual(resolveDatabaseSsl({
    host: 'db.example.net',
    isRender: false
  }), { rejectUnauthorized: true });
});

test('local database auto mode preserves no-TLS behavior including bracketed IPv6 hosts', () => {
  assert.equal(resolveDatabaseSsl({ host: 'localhost', isRender: false }), false);
  assert.equal(resolveDatabaseSsl({ host: '127.0.0.1', isRender: false }), false);
  assert.equal(resolveDatabaseSsl({ host: '::1', isRender: false }), false);
  assert.equal(resolveDatabaseSsl({ host: '[::1]', isRender: false }), false);
});

test('explicit SSL modes are honored', () => {
  assert.equal(resolveDatabaseSsl({ host: 'dpg-cv123abc-a', isRender: true, mode: 'disable' }), false);
  assert.deepEqual(resolveDatabaseSsl({ host: 'dpg-cv123abc-a', isRender: true, mode: 'require' }), { rejectUnauthorized: false });
  assert.deepEqual(resolveDatabaseSsl({ host: 'dpg-cv123abc-a', isRender: true, mode: 'verify-full' }), { rejectUnauthorized: true });
  assert.throws(() => resolveDatabaseSsl({ mode: 'unknown-mode' }), /PGSSL_MODE/);
});

test('legacy PGSSL_REJECT_UNAUTHORIZED override remains explicit and scoped', () => {
  assert.deepEqual(resolveDatabaseSsl({
    host: 'db.example.net', isRender: true, rejectUnauthorized: 'false'
  }), { rejectUnauthorized: false });
  assert.equal(resolveDatabaseSsl({
    host: 'dpg-cv123abc-a', isRender: true, rejectUnauthorized: 'true'
  }).rejectUnauthorized, true);
});
